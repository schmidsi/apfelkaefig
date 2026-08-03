// `akf up` — canonical entry point. Resolves config, picks image, ensures
// it's available, and execs `container run …`.

import { isAbsolute, join } from "@std/path";
import { builtInImage, materializeEmbeddedDockerfile, sandboxStamp } from "../lib/baseimage.ts";
import {
  buildRunArgs,
  containerVersion,
  ensureContainerSystem,
  ensureVolumes,
  imageExists,
  imageStamp,
  listContainers,
  pullImage,
  realRunner,
  resolveImageRef,
  type Runner,
  stopContainer,
} from "../lib/container.ts";
import {
  akfCredentialsFile,
  checkCredentials,
  profileSlug,
  refreshCredentials,
  runAuthWizard,
} from "../lib/claude_creds.ts";
// substitute stays imported for the credential-profile resolution below; the
// serve path's own use moved into the ssh plugin (tasks/011 step 5).
import { ConfigError, effective, resolveConfig, substitute } from "../lib/config.ts";
import { migrateMaterializedConfig } from "../lib/migrate.ts";
import {
  type BuiltInPlugin,
  getPlugin,
  type PluginId,
  type RunContext,
  type RunOverrides,
} from "../lib/plugins.ts";
import { pluginOwningFlag } from "../lib/flags.ts";
import { tmuxPlugin } from "../plugins/tmux/plugin.ts";
import { SecretsRequiredError, TruncatedTokenError } from "../lib/secrets.ts";
import { runBuild } from "./build.ts";

export interface UpOptions {
  cwd: string;
  // Positional args after `up` — passed as the in-container command. Empty
  // means use the resolved config's command (or default).
  positional: string[];
  imageOverride?: string;
  // Force the image to be rebuilt (or re-pulled) even when it's already
  // cached in Apple `container`. Used to pick up Dockerfile changes after
  // bumping a pinned dependency, since the existence check would otherwise
  // skip the build entirely.
  rebuild?: boolean;
  // Run sshd in the foreground instead of the agent, so the desktop apps can
  // attach over SSH. Requires the `ssh` plugin. Ctrl+C stops it.
  serve?: boolean;
  // Force tmux multiplexing on regardless of config (`akf up --tmux`), so a
  // second `akf up` attaches to the running container. undefined defers to the
  // resolved config's `tmux`.
  tmux?: boolean;
  run?: Runner;
}

export async function runUp(opts: UpOptions): Promise<number> {
  const run = opts.run ?? realRunner;

  // Preflight — apple `container` is the bare minimum.
  if ((await containerVersion(run)) === null) {
    console.error(
      "akf up: Apple `container` not found. Install: https://github.com/apple/container",
    );
    return 1;
  }

  let resolved;
  try {
    resolved = await resolveConfig({
      cwd: opts.cwd,
      cliOverrides: {
        command: opts.positional.length > 0 ? opts.positional : undefined,
        image: opts.imageOverride,
      },
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`akf up: ${err.message}${err.path ? ` (${err.path})` : ""}`);
      return 1;
    }
    throw err;
  }

  for (const w of resolved.warnings) console.error(`warning: ${w}`);

  // Self-heal configs that predate resolve-time plugin transforms (tasks/011):
  // strip materialized entries the plugins now derive. Behavior is unchanged
  // either way (runtime dedupe), so a migration failure must never block up.
  if (resolved.source.kind === "apfelkaefig") {
    try {
      const migration = await migrateMaterializedConfig({
        configPath: resolved.source.path,
        workspaceDir: resolved.workspaceDir,
      });
      if (migration?.rewritten) {
        console.error(
          `akf up: updated .apfelkaefig.json — removed ${migration.removed.length} ` +
            `entr${migration.removed.length === 1 ? "y" : "ies"} now derived by plugins ` +
            `(backup: ${migration.backupPath})`,
        );
      } else if (migration) {
        console.error(
          `akf up: note — these .apfelkaefig.json entries are now derived by plugins ` +
            `and can be removed: ${migration.removed.join(", ")}`,
        );
      }
    } catch (err) {
      console.error(`warning: config migration check failed: ${(err as Error).message}`);
    }
  }

  // Ensure the container system is up before we query running containers or run.
  await ensureContainerSystem(run);

  // Run-hook plugins (tasks/011): every enabled config plugin participates,
  // plus the internal tmux plugin when the top-level `tmux` key or the --tmux
  // flag enables it. (--serve replaces the command wholesale, so it opts out
  // of tmux.)
  const eff = effective(resolved);
  const tmuxEnabled = (opts.tmux ?? eff.tmux) && !opts.serve;
  const runtimePlugins: BuiltInPlugin[] = Object.entries(resolved.config.plugins ?? {})
    .filter(([, pc]) => pc?.enabled)
    .map(([id]) => getPlugin(id as PluginId));
  // 1Password is implicit-on (inject when a token is present, even with no
  // config at all) — include its runtime hooks unless the config has an
  // explicit plugins.1password section, in which case the loop above decides.
  if (resolved.config.plugins?.["1password"] === undefined) {
    runtimePlugins.push(getPlugin("1password"));
  }
  if (tmuxEnabled) runtimePlugins.push(tmuxPlugin);

  const runCtx: RunContext = {
    config: resolved.config,
    workspaceDir: resolved.workspaceDir,
    command: eff.command,
    flags: { tmux: opts.tmux === true, serve: opts.serve === true },
    run,
  };

  // A plugin-declared flag only works when its owning plugin is active for
  // this run (e.g. --serve without the ssh plugin enabled).
  for (const [flag, on] of Object.entries(runCtx.flags)) {
    if (!on) continue;
    const owner = pluginOwningFlag(flag);
    if (owner && !runtimePlugins.includes(owner)) {
      console.error(
        `akf up: --${flag} requires the '${owner.id}' plugin. ` +
          `Run \`akf plugin add ${owner.id}\` first.`,
      );
      return 1;
    }
  }

  // containerName is exclusive — two non-undefined claims is a plugin-author
  // error. (A plugin may decline by returning undefined, e.g. ssh outside
  // --serve mode.)
  const nameClaims = runtimePlugins
    .map((p) => ({ id: p.id, name: p.containerName?.(runCtx) }))
    .filter((c) => c.name !== undefined);
  if (nameClaims.length > 1) {
    console.error(
      `akf up: plugins ${nameClaims.map((c) => `'${c.id}'`).join(" and ")} ` +
        `both claim the container name`,
    );
    return 1;
  }
  const sandboxName = nameClaims[0]?.name;

  // preRun in config order: validation, attach-vs-run branches, orphan
  // cleanup, run overrides (--serve's sshd entrypoint). Overrides are
  // exclusive across plugins.
  let overrides: RunOverrides | undefined;
  for (const plugin of runtimePlugins) {
    if (!plugin.preRun) continue;
    const result = await plugin.preRun(runCtx);
    if (result.action === "exit") return result.code;
    if (result.action === "attach") {
      debugCmd(result.args);
      return await spawnInteractive(result.args);
    }
    if (result.overrides) {
      if (overrides) {
        console.error(`akf up: plugin '${plugin.id}' overrides an already-overridden run`);
        return 1;
      }
      overrides = result.overrides;
    }
  }

  // Ensure the sandbox's own Claude login (see cli/lib/claude_creds.ts) before
  // anything slow: first `akf up` runs the one-time host-side login, later runs
  // detect expiry (refresh in place) or a dead credential (re-auth). Lineages
  // are per environment: the project's claudeConfigDir (work vs personal)
  // selects which sandbox login it uses.
  const runsClaude = eff.command[0] === "claude" || opts.serve === true;
  const slug = profileSlug(
    eff.claudeConfigDir
      ? substitute(eff.claudeConfigDir, {
        workspaceFolder: resolved.workspaceDir,
        env: Deno.env.toObject(),
      })
      : undefined,
  );
  const creds = await ensureClaudeCreds(runsClaude, slug, run);
  if (creds.abort !== undefined) return creds.abort;
  const claudeCredentialsFile = creds.path;

  // Resolve the built-in base image. When `image/Dockerfile` is embedded in
  // the binary, materialize it into a content-hashed cache dir so the builder
  // has a build context. AKF_BASE_IMAGE override skips the embedded path.
  const base = await builtInImage();
  let baseDockerfilePath: string | undefined;
  if (base.embedded) {
    baseDockerfilePath = await materializeEmbeddedDockerfile(base);
  }

  const image = resolveImageRef(resolved.config, resolved.workspaceDir, {
    ref: base.ref,
    dockerfile: baseDockerfilePath,
  });
  const isBuiltInBuild = resolved.config.image === undefined && image.needsBuild;
  // A project build (custom Dockerfile) uses a fixed tag, so `imageExists`
  // can't tell whether the cached image is current. Compare the stamp `akf
  // build` baked in against the one its inputs (base ref + Dockerfile) hash to
  // now; a mismatch means the image predates a base or Dockerfile change and
  // must be rebuilt — otherwise it silently runs stale (e.g. missing `tmux`).
  const isProjectBuild = image.needsBuild && !isBuiltInBuild;

  const exists = await imageExists(image.ref, run);
  let stale = false;
  if (exists && !opts.rebuild && isProjectBuild && image.dockerfile) {
    const dfPath = isAbsolute(image.dockerfile)
      ? image.dockerfile
      : join(resolved.workspaceDir, image.dockerfile);
    try {
      const expected = await sandboxStamp(base.ref, await Deno.readTextFile(dfPath));
      stale = (await imageStamp(image.ref, run)) !== expected;
    } catch {
      // Can't read the Dockerfile to compare — leave the cached image alone.
    }
  }

  // Image presence check + recovery path. --rebuild forces the build/pull
  // path even when the image is cached — needed when the Dockerfile content
  // has changed (e.g. a bumped pinned SHA) but the tag has not.
  const needsRefresh = opts.rebuild || stale || !exists;
  if (needsRefresh) {
    // A stale rebuild pulls fresh apt/curl layers; offline it fails and would
    // strand a previously-working `up`. Offer to run the cached image as-is.
    if (stale && !opts.rebuild && !(await online())) {
      console.error(
        `akf up: image '${image.ref}' is stale (built against a different base or an ` +
          `older ${image.dockerfile}), but you appear to be offline so a rebuild may fail.`,
      );
      if (!confirm("akf up: run the stale image anyway?")) {
        console.error("akf up: aborted. Reconnect and rerun, or `akf up --rebuild`.");
        return 1;
      }
      // User accepted the stale image: skip the refresh and run what's cached.
    } else {
      if (image.needsBuild) {
        if (opts.rebuild) {
          console.error(`akf up: --rebuild — rebuilding '${image.ref}' from ${image.dockerfile}…`);
        } else if (stale) {
          console.error(
            `akf up: image '${image.ref}' is stale — rebuilding from ${image.dockerfile} ` +
              `(base or Dockerfile changed since it was built)…`,
          );
        } else if (isBuiltInBuild) {
          console.error(
            `akf up: built-in base image '${image.ref}' not cached — building (one-time, takes a minute or two)…`,
          );
        } else {
          console.error(
            `akf up: image '${image.ref}' missing — building from ${image.dockerfile}…`,
          );
        }
        const buildCode = await runBuild({
          cwd: resolved.workspaceDir,
          dockerfile: image.dockerfile!,
          tag: image.ref,
          run,
          isBaseBuild: isBuiltInBuild,
        });
        if (buildCode !== 0) return buildCode;
      } else {
        console.error(
          opts.rebuild
            ? `akf up: --rebuild — re-pulling ${image.ref}…`
            : `akf up: pulling ${image.ref}…`,
        );
        const pullRes = await pullImage(image.ref, run);
        if (pullRes.code !== 0) {
          console.error(
            `akf up: failed to pull '${image.ref}'. If you're offline, run\n` +
              `         akf build --from-dockerfile <path>\n` +
              `       to use a locally-built image instead.`,
          );
          return pullRes.code;
        }
      }
    }
  }

  // Pre-create any named volumes referenced by the config so `container run`
  // doesn't 404 on the first reference.
  try {
    await ensureVolumes(resolved.config.mounts, run, {
      workspaceFolder: resolved.workspaceDir,
    });
  } catch (err) {
    console.error(`akf up: ${(err as Error).message}`);
    return 1;
  }

  // runtimeEnv hooks: env injected at run time (OP token, …), never persisted.
  let extraEnv: Record<string, string> | undefined;
  try {
    for (const plugin of runtimePlugins) {
      if (!plugin.runtimeEnv) continue;
      const env = await plugin.runtimeEnv(runCtx);
      if (Object.keys(env).length > 0) extraEnv = { ...extraEnv, ...env };
    }
  } catch (err) {
    if (err instanceof SecretsRequiredError || err instanceof TruncatedTokenError) {
      console.error(`akf up: ${err.message}`);
      return 1;
    }
    throw err;
  }

  // Apple `container` named volumes attach to one running VM at a time. If this
  // project mounts named volumes and another container off the same image is
  // already running, starting a new box fails with the opaque "storage device
  // attachment is invalid". Detect that up front and explain (tmux mode is the
  // fix; a leftover non-tmux box just needs removing). A plugin's own orphan
  // was already cleared by name in its preRun, so it won't trip this.
  if ((resolved.config.mounts ?? []).some((m) => m.type === "volume")) {
    const sameImage = (a: string, b: string) =>
      a.replace(/:latest$/, "") === b.replace(/:latest$/, "");
    const orphan = (await listContainers(run)).find(
      (c) => sameImage(c.image, image.ref) && c.id !== sandboxName,
    );
    if (orphan) {
      const shareHint = tmuxEnabled
        ? `         (it predates tmux mode, so this run can't attach to it.)\n`
        : `         • run \`akf up --tmux\` to share that box across terminals, or\n`;
      console.error(
        `akf up: another sandbox for this project is already running ` +
          `(${orphan.id}, image ${orphan.image}). It holds the project's shared ` +
          `named volumes, which attach to one container at a time. Either:\n` +
          shareHint +
          `         • stop it — \`container rm -f ${orphan.id}\` (or \`akf clean\`) — then retry.`,
      );
      return 1;
    }
  }

  // Let run-hook plugins wrap the agent command (tmux session, …), unless a
  // preRun override (--serve's sshd entrypoint) replaces it wholesale —
  // replacement beats wrapping.
  let commandOverride = overrides?.command;
  if (commandOverride === undefined) {
    let command = eff.command;
    for (const plugin of runtimePlugins) {
      if (plugin.wrapCommand) command = plugin.wrapCommand(command, runCtx);
    }
    if (command !== eff.command) commandOverride = command;
  }

  const built = buildRunArgs({
    resolved,
    workspaceHostPath: resolved.workspaceDir,
    imageRef: image.ref,
    extraEnv,
    commandOverride,
    entrypointOverride: overrides?.entrypoint,
    userOverride: overrides?.user,
    tty: overrides?.tty,
    name: sandboxName,
    claudeCredentialsFile,
  });

  debugCmd(built.args);

  // Forward SIGINT so the container exits cleanly. Deno's child inherits the
  // pty when we use stdin: "inherit"; spawning lets us also handle signals.
  const cmd = new Deno.Command("container", {
    args: built.args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const child = cmd.spawn();
  const stopByName = overrides?.stopByNameOnInterrupt ? sandboxName : undefined;
  const onSig = () => {
    if (stopByName) {
      // Non-TTY server (--serve): Apple `container`'s interactive signal relay
      // drops the SIGINT ("missing signal in xpc message"), so forwarding to
      // `container run` would leave the box running. Stop it by name from the
      // host side instead — that ends the run, and `--rm` cleans up.
      stopContainer(stopByName, run).catch(() => {});
      return;
    }
    try {
      child.kill("SIGINT");
    } catch (_) {
      // Already exited.
    }
  };
  Deno.addSignalListener("SIGINT", onSig);
  try {
    const status = await child.status;
    return status.code;
  } finally {
    try {
      Deno.removeSignalListener("SIGINT", onSig);
    } catch (_) { /* ignore */ }
  }
}

// Ensure the sandbox's Claude credential lineage is present and healthy.
// Returns the credential file to overlay-mount, or an abort exit code when
// auth is required but can't be completed here. Neither is also possible —
// a non-claude command with no stored login just runs without the overlay.
async function ensureClaudeCreds(
  runsClaude: boolean,
  slug: string,
  run: Runner,
): Promise<{ path?: string; abort?: number }> {
  const home = Deno.env.get("HOME");
  if (!home) return {};
  const check = await checkCredentials(home, { slug });
  if (check.state === "valid") return { path: check.path };

  if (check.state === "expired") {
    // A running sandbox holds the current refresh token in memory and rotates
    // the file itself; a host-side refresh would race it and can revoke the
    // token family. Only refresh when no akf box is up.
    const boxes = await listContainers(run);
    const akfBoxRunning = boxes.some(
      (b) => b.id.startsWith("akf-") || /apfelkaefig-base|-sandbox/.test(b.image),
    );
    if (akfBoxRunning) return { path: check.path };
    const r = await refreshCredentials(check.path);
    if (r === "refreshed") return { path: check.path };
    if (r === "unavailable") {
      console.error(
        "akf up: warning: the sandbox's Claude token is expired and couldn't be " +
          "refreshed from here — the sandbox will retry on its own.",
      );
      return { path: check.path };
    }
    // "auth-needed": the refresh token is dead — fall through to a new login.
    console.error("akf up: the sandbox's Claude login has expired (refresh rejected).");
  }

  if (!runsClaude) return {};
  if (!Deno.stdin.isTerminal()) {
    console.error(`akf up: the sandbox needs a Claude login — run \`akf auth\` first.`);
    return { abort: 1 };
  }
  console.error(
    check.state === "missing"
      ? `akf up: no sandbox Claude login for profile '${slug}' yet — running the one-time setup.`
      : `akf up: re-establishing the sandbox's Claude login ('${slug}').`,
  );
  if (!(await runAuthWizard(home, slug))) {
    console.error("akf up: login did not complete — run `akf auth` to retry.");
    return { abort: 1 };
  }
  return { path: akfCredentialsFile(home, slug) };
}

// Cheap reachability probe: can we reach the network at all? Used before a
// stale rebuild, whose apt/curl layers need connectivity — offline, we'd rather
// ask than fail. A short HEAD to a public anycast IP (no DNS) is enough; any
// error (timeout, no route, DNS down) counts as offline.
async function online(): Promise<boolean> {
  try {
    await fetch("https://1.1.1.1", { method: "HEAD", signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

// Env var names whose values are secrets and must never hit the debug log
// (e.g. the injected 1Password service-account token, an authorized SSH key).
const SECRET_ENV_RE = /TOKEN|SECRET|PASSWORD|CREDENTIAL|_KEY\b|AUTHORIZED_KEY/i;

// Mask the values of secret-bearing `-e KEY=VALUE` args so `AKF_DEBUG` can show
// the full invocation without leaking tokens. Only values of sensitive keys are
// redacted; everything else (mounts, benign env, the command) prints verbatim.
export function redactDebugArgs(args: string[]): string[] {
  return args.map((arg, i) => {
    if (args[i - 1] !== "-e") return arg;
    const eq = arg.indexOf("=");
    if (eq < 0) return arg;
    const key = arg.slice(0, eq);
    return SECRET_ENV_RE.test(key) ? `${key}=***` : arg;
  });
}

// Print the exact `container` invocation when AKF_DEBUG is set. Volume/mount
// bootstrap failures (e.g. "storage device attachment is invalid") are opaque
// without seeing the actual -v flags akf generated. Secret env values are
// masked (see redactDebugArgs).
function debugCmd(args: string[]): void {
  if (Deno.env.get("AKF_DEBUG")) {
    console.error(`akf debug: container ${redactDebugArgs(args).join(" ")}`);
  }
}

// Spawn `container <args>` with inherited stdio (interactive TTY) and forward
// SIGINT to the child. Used by the tmux attach path (`container exec`).
async function spawnInteractive(args: string[]): Promise<number> {
  const cmd = new Deno.Command("container", {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const child = cmd.spawn();
  const onSig = () => {
    try {
      child.kill("SIGINT");
    } catch (_) {
      // Already exited.
    }
  };
  Deno.addSignalListener("SIGINT", onSig);
  try {
    return (await child.status).code;
  } finally {
    try {
      Deno.removeSignalListener("SIGINT", onSig);
    } catch (_) { /* ignore */ }
  }
}
