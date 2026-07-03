// `akf up` — canonical entry point. Resolves config, picks image, ensures
// it's available, and execs `container run …`.

import { builtInImage, materializeEmbeddedDockerfile } from "../lib/baseimage.ts";
import {
  buildExecArgs,
  buildRunArgs,
  containerIsRunning,
  containerVersion,
  ensureContainerSystem,
  ensureVolumes,
  imageExists,
  pullImage,
  realRunner,
  resolveImageRef,
  type Runner,
  sandboxContainerName,
  stopContainer,
} from "../lib/container.ts";
import { ConfigError, effective, resolveConfig, substitute } from "../lib/config.ts";
import { projectSlug } from "../lib/fs.ts";
import { TMUX_SESSION } from "../lib/schema.ts";
import { resolveOp, SecretsRequiredError, TruncatedTokenError } from "../lib/secrets.ts";
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
  run?: Runner;
}

const SSH_ENTRYPOINT = "/usr/local/bin/akf-sshd";

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

  // Ensure the container system is up before we query running containers or run.
  await ensureContainerSystem(run);

  // tmux multiplexing: when enabled, a second `akf up` from another terminal
  // should attach to the same running container rather than starting a new one.
  // (--serve runs sshd, not the agent, so it opts out.)
  const eff = effective(resolved);
  const tmuxEnabled = eff.tmux && !opts.serve;
  let sandboxName: string | undefined;
  if (tmuxEnabled) {
    sandboxName = sandboxContainerName(resolved.workspaceDir);
    if (await containerIsRunning(sandboxName, run)) {
      console.error(
        `akf up: attaching to running sandbox '${sandboxName}' ` +
          `(tmux session '${TMUX_SESSION}'; Ctrl+B c for a new window, Ctrl+B d to detach)…`,
      );
      const command = opts.positional.length > 0 ? opts.positional : eff.command;
      const execArgs = buildExecArgs(sandboxName, command);
      debugCmd(execArgs);
      return await spawnInteractive(execArgs);
    }
    // Clear a stopped orphan of the same name so `container run --name` below
    // doesn't collide. Safe: only reached when it isn't running.
    await run("container", ["rm", "-f", sandboxName], { stdout: "null", stderr: "piped" });
  }

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

  // Image presence check + recovery path. --rebuild forces the build/pull
  // path even when the image is cached — needed when the Dockerfile content
  // has changed (e.g. a bumped pinned SHA) but the tag has not.
  const needsRefresh = opts.rebuild || !(await imageExists(image.ref, run));
  if (needsRefresh) {
    if (image.needsBuild) {
      if (opts.rebuild) {
        console.error(`akf up: --rebuild — rebuilding '${image.ref}' from ${image.dockerfile}…`);
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

  // 1Password injection.
  let extraEnv: Record<string, string> | undefined;
  try {
    const token = await resolveOp({ explicit: resolved.config.secrets?.onepassword });
    if (token) extraEnv = { OP_SERVICE_ACCOUNT_TOKEN: token };
  } catch (err) {
    if (err instanceof SecretsRequiredError || err instanceof TruncatedTokenError) {
      console.error(`akf up: ${err.message}`);
      return 1;
    }
    throw err;
  }

  // --serve: run sshd in the foreground instead of the agent. Validate the ssh
  // plugin is enabled, read the authorized public key from the host, and inject
  // it as env for the entrypoint to install. The host key + port + persistence
  // come from the ssh plugin's config.
  let commandOverride: string[] | undefined;
  let userOverride: string | undefined;
  let tty: boolean | undefined;
  let serveName: string | undefined;
  if (opts.serve) {
    const ssh = resolved.config.plugins?.ssh;
    if (!ssh?.enabled) {
      console.error(
        "akf up: --serve requires the ssh plugin. Run `akf plugin add ssh` first.",
      );
      return 1;
    }
    const keyPath = substitute(ssh.authorizedKey, {
      workspaceFolder: resolved.workspaceDir,
      env: Deno.env.toObject(),
    });
    let pubKey: string;
    try {
      pubKey = (await Deno.readTextFile(keyPath)).trim();
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        console.error(
          `akf up: --serve: authorized key not found at ${keyPath}\n` +
            `       set 'plugins.ssh.authorizedKey' or create the key, then retry.`,
        );
        return 1;
      }
      throw err;
    }
    extraEnv = { ...extraEnv, AKF_SSH_AUTHORIZED_KEY: pubKey };
    commandOverride = [SSH_ENTRYPOINT];
    userOverride = "root";
    tty = false;
    serveName = `akf-serve-${projectSlug(resolved.workspaceDir)}`;
    // Clear an orphan from a previously force-killed --serve: Apple `container`
    // drops the SIGINT relay and leaves the VM running, which then holds the
    // host-key volume and bootstrapping a new box fails ("storage device
    // attachment is invalid"). Best-effort — non-existent name is fine.
    await run("container", ["rm", "-f", serveName], { stdout: "null", stderr: "piped" });
    console.error(
      `akf up: serving sshd — connect with:\n` +
        `         Host:     node@127.0.0.1\n` +
        `         Port:     ${ssh.port}\n` +
        `         Identity: the private key matching ${keyPath}\n` +
        `       logs follow; Ctrl+C to stop.`,
    );
  }

  const built = buildRunArgs({
    resolved,
    workspaceHostPath: resolved.workspaceDir,
    imageRef: image.ref,
    extraEnv,
    commandOverride,
    userOverride,
    tty,
    name: serveName ?? sandboxName,
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
  const onSig = () => {
    if (serveName) {
      // Non-TTY server: Apple `container`'s interactive signal relay drops the
      // SIGINT ("missing signal in xpc message"), so forwarding to `container
      // run` would leave the box running. Stop it by name from the host side
      // instead — that ends the run, and `--rm` cleans up.
      stopContainer(serveName, run).catch(() => {});
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

// Print the exact `container` invocation when AKF_DEBUG is set. Volume/mount
// bootstrap failures (e.g. "storage device attachment is invalid") are opaque
// without seeing the actual -v flags akf generated.
function debugCmd(args: string[]): void {
  if (Deno.env.get("AKF_DEBUG")) {
    console.error(`akf debug: container ${args.join(" ")}`);
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
