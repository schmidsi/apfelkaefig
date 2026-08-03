// Thin wrapper around Apple `container`. Centralizes flag construction so the
// commands stay thin. Designed to be testable: pass a `runner` to substitute
// the subprocess; built-in `realRunner` shells out for real.

import { basename } from "@std/path";
import { type ApfelkaefigConfig, type MountConfig } from "./schema.ts";
import { effective, type ResolvedConfig } from "./config.ts";
import { expandHome, substitute } from "./substitute.ts";
import { pathExistsSync, projectSlug } from "./fs.ts";

export type CmdResult = { code: number; stdout: string; stderr: string };

export type Runner = (
  cmd: string,
  args: string[],
  opts?: {
    stdin?: "inherit" | "null";
    stdout?: "inherit" | "piped" | "null";
    stderr?: "inherit" | "piped" | "null";
  },
) => Promise<CmdResult>;

export const realRunner: Runner = async (cmd, args, opts = {}) => {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdin: opts.stdin ?? "inherit",
      stdout: opts.stdout ?? "inherit",
      stderr: opts.stderr ?? "inherit",
    }).output();
    return {
      code: out.code,
      stdout: opts.stdout === "piped" ? new TextDecoder().decode(out.stdout) : "",
      stderr: opts.stderr === "piped" ? new TextDecoder().decode(out.stderr) : "",
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Binary missing on PATH — surface as a non-zero exit so callers
      // can present a useful message rather than a stack trace.
      return { code: 127, stdout: "", stderr: `${cmd}: not found` };
    }
    throw err;
  }
};

export interface RunFlagsInput {
  resolved: ResolvedConfig;
  // The host workspace path. When nothing was committed to the repo, this is
  // the cwd; for tier 2 / tier 3, it's the dir holding the config file.
  workspaceHostPath: string;
  imageRef: string;
  // Extra env added by the command layer (e.g. injected OP token).
  extraEnv?: Record<string, string>;
  // Override the default home dir (test seam).
  homeDir?: string;
  // Host path to a fresh Claude OAuth credential (staged from the macOS
  // Keychain by up.ts). When set and ~/.claude is mounted, it's overlay-mounted
  // onto the container's ~/.claude/.credentials.json so the sandbox inherits the
  // host's live login instead of a stale on-disk token.
  claudeCredentialsFile?: string;
  // Allocate a TTY (`-t`). Defaults to whether stdin is a terminal — matches
  // docker/podman. When false, Apple `container` 0.12 fails with a cryptic
  // ENODEV ("Operation not supported by device") if `-t` is forced anyway.
  tty?: boolean;
  // Replace the resolved config's command with a fixed argv. Used by
  // `akf up --serve` to run the sshd entrypoint instead of the agent.
  commandOverride?: string[];
  // Override the image ENTRYPOINT (`--entrypoint`). `akf up --serve` sets this
  // to run the sshd entrypoint directly, bypassing a base-image entrypoint that
  // would otherwise drop root to the agent user and break the sshd bootstrap.
  entrypointOverride?: string;
  // Replace the resolved config's user (`-u`). `akf up --serve` runs as root so
  // sshd can bind :22 and authenticate the login as the agent user.
  userOverride?: string;
  // Assign a stable container name (`--name`). `akf up --serve` sets this so it
  // can clear an orphan on startup and tear the box down by name on Ctrl+C —
  // Apple `container`'s interactive signal relay is unreliable, so we can't rely
  // on forwarding SIGINT to `container run`.
  name?: string;
}

// Compute the argv for `container run …` minus the leading `container run`.
export function buildRunArgs(
  input: RunFlagsInput,
): { args: string[]; workspaceFolder: string; user: string } {
  const e = effective(input.resolved);
  const c: ApfelkaefigConfig = input.resolved.config;
  const home = input.homeDir ?? Deno.env.get("HOME") ?? "";
  const subCtx = { workspaceFolder: input.workspaceHostPath, env: Deno.env.toObject() };
  const sub = (s: string) => substitute(s, subCtx);

  const wantTty = input.tty ?? stdinIsTerminal();
  const args: string[] = ["run", "--rm", wantTty ? "-it" : "-i"];
  if (input.name) args.push("--name", input.name);
  args.push("--cpus", String(e.resources.cpus), "--memory", e.resources.memory);
  for (const p of c.ports ?? []) {
    const proto = p.protocol ?? "tcp";
    const hostIp = p.hostIp ? `${p.hostIp}:` : "";
    args.push("-p", `${hostIp}${p.host}:${p.container}/${proto}`);
  }

  // Track emitted mount targets so we don't pass duplicate `-v` for the same
  // path — Apple `container`'s virtiofs rejects that with EBUSY (errno 16).
  const emittedTargets = new Set<string>();
  const pushMount = (src: string, tgt: string, readonly: boolean): boolean => {
    if (emittedTargets.has(tgt)) return false;
    args.push("-v", readonly ? `${src}:${tgt}:ro` : `${src}:${tgt}`);
    emittedTargets.add(tgt);
    return true;
  };

  // Workspace mount.
  pushMount(input.workspaceHostPath, sub(e.workspaceFolder), false);

  // Extra mounts from config first — explicit user intent wins over defaults
  // when targets collide (e.g. devcontainer.json that already maps ~/.claude).
  for (const m of c.mounts ?? []) {
    const tgt = sub(m.target);
    if (m.type === "volume") {
      // Volume name: no host-path check. akf-native configs forbid ${...} in
      // volume sources (so sub() is a no-op there); devcontainer.json is allowed
      // ${devcontainerId} etc., which sub() resolves. Must match the name
      // ensureVolumes() created before `container run`.
      pushMount(sub(m.source), tgt, !!m.readonly);
      continue;
    }
    const src = sub(m.source);
    if (!pathExistsSync(src)) {
      console.error(`warning: skipping mount ${src} -> ${tgt} (source not found)`);
      continue;
    }
    pushMount(src, tgt, !!m.readonly);
  }

  // Default mounts. ~/.claude is always RW (login + history persistence).
  // Downloads/Desktop are tier-2/tier-3 conveniences only — drive-by mode
  // (no config) skips them so an ad-hoc `akf up` in a random dir doesn't
  // expose the user's Desktop. Sources that don't exist are silently skipped.
  const isDriveBy = input.resolved.source.kind === "defaults";
  if (home) {
    const claudeSource = expandHome(sub(e.claudeConfigDir ?? `${home}/.claude`), home);
    const claudeMounted = pushMountIfExists(
      pushMount,
      claudeSource,
      `/home/${e.user}/.claude`,
      false,
    );
    // Overlay a fresh OAuth credential on top of the mounted ~/.claude. On
    // macOS Claude Code refreshes its token into the Keychain, leaving the
    // on-disk ~/.claude/.credentials.json stale (expired + rotated refresh
    // token) — so the sandbox is forced to re-login. up.ts stages the current
    // Keychain credential to a file and we shadow just that one path with it,
    // without writing to the user's ~/.claude. Must follow the dir mount so it
    // wins for that path.
    if (claudeMounted && input.claudeCredentialsFile) {
      pushMount(input.claudeCredentialsFile, `/home/${e.user}/.claude/.credentials.json`, false);
    }
    if (!isDriveBy) {
      pushMountIfExists(pushMount, `${home}/Downloads`, `/home/${e.user}/Downloads`, true);
      pushMountIfExists(pushMount, `${home}/Desktop`, `/home/${e.user}/Desktop`, true);
    }
  }

  // Container env: defaults + config env + extras. User config (c.env) wins
  // over defaults so AKF_* and CLAUDE_CONFIG_DIR can be overridden.
  // AKF_SANDBOX is the canonical "running inside akf" signal — scripts (like
  // ~/.claude/bin/akf-statusline) can branch on it instead of probing hostnames.
  // AKF_CLAUDE_PROFILE labels a non-default claudeConfigDir (`~/.claude-work`
  // → "WORK") so the statusline can show which Claude profile is active.
  const profile = e.claudeConfigDir ? claudeProfileLabel(sub(e.claudeConfigDir)) : "";
  const envOut: Record<string, string> = {
    CLAUDE_CONFIG_DIR: `/home/${e.user}/.claude`,
    AKF_SANDBOX: "1",
    AKF_PROJECT_NAME: basename(input.workspaceHostPath),
    ...(profile ? { AKF_CLAUDE_PROFILE: profile } : {}),
    ...(c.env ?? {}),
    ...(input.extraEnv ?? {}),
  };
  for (const [k, v] of Object.entries(envOut)) {
    const resolved = sub(v);
    if (resolved === "" && !(k in (input.extraEnv ?? {}))) continue;
    args.push("-e", `${k}=${resolved}`);
  }

  args.push("-u", input.userOverride ?? e.user, "-w", sub(e.workspaceFolder));
  // `--entrypoint` must precede the image ref. Set by `akf up --serve` so the
  // sshd entrypoint runs directly instead of through a base-image entrypoint
  // that drops privileges (which would defeat `-u root`).
  if (input.entrypointOverride !== undefined) {
    args.push("--entrypoint", input.entrypointOverride);
  }
  args.push(input.imageRef);
  // commandOverride replaces the resolved config's command — used by
  // `akf up --serve` (sshd entrypoint) and by run-hook plugins that wrap the
  // agent command (e.g. tmux; see cli/plugins/tmux/plugin.ts).
  const command = input.commandOverride ?? e.command;
  args.push(...command);

  return {
    args,
    workspaceFolder: sub(e.workspaceFolder),
    user: e.user,
  };
}

// True when a container with the given name is currently running.
export async function containerIsRunning(
  name: string,
  run: Runner = realRunner,
): Promise<boolean> {
  const list = await listContainers(run);
  return list.some((c) => c.id === name);
}

// Build `container exec` argv (minus the leading `container`) to run a command
// inside an already-running sandbox.
//
// Unlike `container run`, Apple `container exec` does NOT apply the image's
// `ENV PATH`, so a bare binary name fails with "failed to find target
// executable" even when it's installed (same PATH-stripping the ssh plugin
// works around for `claude`). Route through `/bin/sh -c` with an explicit PATH
// that covers the usual install locations so the binary resolves regardless.
const EXEC_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin";

export function buildExecArgs(
  name: string,
  command: string[],
  opts: { tty?: boolean } = {},
): string[] {
  const wantTty = opts.tty ?? stdinIsTerminal();
  const inner = `PATH="${EXEC_PATH}:$PATH" exec ${command.map(shQuote).join(" ")}`;
  return ["exec", wantTty ? "-it" : "-i", name, "/bin/sh", "-c", inner];
}

// Minimal POSIX shell single-quote: wrap in '…' and escape embedded quotes.
// Enough for the agent command tokens we pass through the exec shell.
function shQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

// Derive a short uppercase profile label from a custom claudeConfigDir:
// `~/.claude-work` → "WORK". Falls back to the dot-stripped basename for
// dirs that don't follow the `.claude-*` pattern.
export function claudeProfileLabel(dir: string): string {
  const name = basename(dir);
  const stripped = name.startsWith(".claude-")
    ? name.slice(".claude-".length)
    : name.replace(/^\./, "");
  return stripped.toUpperCase();
}

function pushMountIfExists(
  push: (src: string, tgt: string, readonly: boolean) => boolean,
  src: string,
  tgt: string,
  readonly: boolean,
): boolean {
  if (!pathExistsSync(src)) return false;
  return push(src, tgt, readonly);
}

function stdinIsTerminal(): boolean {
  try {
    return Deno.stdin.isTerminal();
  } catch {
    return false;
  }
}

// Per-project image tag derived from the workspace basename — preserves the
// fix from a96b899.
export function projectImageTag(workspaceHostPath: string): string {
  return `${projectSlug(workspaceHostPath)}-sandbox`;
}

// Resolve which image to run given the config + the built-in default. The
// built-in is either a registry ref (pulled when missing) or an embedded
// Dockerfile (built locally when missing). Returns the tag/ref the runner
// should use plus a hint about how to obtain it.
export function resolveImageRef(
  config: ApfelkaefigConfig,
  workspaceHostPath: string,
  builtIn: { ref: string; dockerfile?: string },
): { ref: string; needsBuild: boolean; dockerfile?: string } {
  if (config.image === undefined) {
    return {
      ref: builtIn.ref,
      needsBuild: builtIn.dockerfile !== undefined,
      dockerfile: builtIn.dockerfile,
    };
  }
  if (typeof config.image === "string") return { ref: config.image, needsBuild: false };
  return {
    ref: projectImageTag(workspaceHostPath),
    needsBuild: true,
    dockerfile: config.image.dockerfile,
  };
}

// --- container subcommand wrappers ---

// Idempotently create any named volumes referenced by `mounts[].type=volume`.
// Apple `container volume create` errors on a re-create; we treat any non-zero
// exit whose stderr mentions "exist" as success so akf up stays idempotent.
export async function ensureVolumes(
  mounts: MountConfig[] | undefined,
  run: Runner = realRunner,
  subCtx?: { workspaceFolder: string; env?: Record<string, string | undefined> },
): Promise<void> {
  if (!mounts) return;
  const seen = new Set<string>();
  for (const m of mounts) {
    if (m.type !== "volume") continue;
    // Resolve devcontainer.json variables (${devcontainerId}, …) so the created
    // volume name matches the one buildRunArgs() passes to `-v`.
    const name = subCtx ? substitute(m.source, subCtx) : m.source;
    if (seen.has(name)) continue;
    seen.add(name);
    const r = await run("container", ["volume", "create", name], {
      stdout: "null",
      stderr: "piped",
    });
    if (r.code !== 0 && !/exist/i.test(r.stderr)) {
      throw new Error(
        `failed to create volume '${name}' (exit ${r.code}): ${r.stderr.trim()}`,
      );
    }
  }
}

export async function ensureContainerSystem(run: Runner = realRunner): Promise<void> {
  const status = await run("container", ["system", "status"], { stdout: "null", stderr: "null" });
  if (status.code !== 0) {
    await run("container", ["system", "start"]);
  }
}

export async function imageExists(ref: string, run: Runner = realRunner): Promise<boolean> {
  const r = await run("container", ["image", "inspect", ref], {
    stdout: "null",
    stderr: "null",
  });
  return r.code === 0;
}

// Label key `akf build` stamps onto project sandbox images (see sandboxStamp).
export const STAMP_LABEL = "com.apfelkaefig.stamp";

// Read the content stamp baked into a cached image, or null when the image is
// missing, unreadable, or predates stamping. Apple `container image inspect`
// surfaces build labels under variants[].config.config.Labels.
export async function imageStamp(ref: string, run: Runner = realRunner): Promise<string | null> {
  const r = await run("container", ["image", "inspect", ref], {
    stdout: "piped",
    stderr: "null",
  });
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    const variants = entry?.variants;
    for (const v of Array.isArray(variants) ? variants : []) {
      const labels = v?.config?.config?.Labels;
      if (labels && typeof labels[STAMP_LABEL] === "string") return labels[STAMP_LABEL];
    }
    return null;
  } catch {
    return null;
  }
}

export async function containerVersion(run: Runner = realRunner): Promise<string | null> {
  const r = await run("container", ["--version"], { stdout: "piped", stderr: "null" });
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

export async function pullImage(ref: string, run: Runner = realRunner): Promise<CmdResult> {
  return await run("container", ["image", "pull", ref]);
}

export async function listContainers(
  run: Runner = realRunner,
): Promise<{ id: string; image: string; status: string }[]> {
  const r = await run("container", ["list", "--format", "json"], {
    stdout: "piped",
    stderr: "null",
  });
  if (r.code !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((c: Record<string, unknown>) => ({
      id: String(c.id ?? c.ID ?? ""),
      image: String(c.image ?? c.Image ?? ""),
      status: String(c.status ?? c.Status ?? ""),
    }));
  } catch {
    return [];
  }
}

export async function stopContainer(id: string, run: Runner = realRunner): Promise<CmdResult> {
  return await run("container", ["stop", id], { stdout: "null", stderr: "null" });
}

export async function rmContainer(id: string, run: Runner = realRunner): Promise<CmdResult> {
  return await run("container", ["rm", id], { stdout: "null", stderr: "null" });
}

export async function rmImage(ref: string, run: Runner = realRunner): Promise<CmdResult> {
  return await run("container", ["image", "rm", ref], { stdout: "null", stderr: "null" });
}
