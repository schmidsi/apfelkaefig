// Thin wrapper around Apple `container`. Centralizes flag construction so the
// commands stay thin. Designed to be testable: pass a `runner` to substitute
// the subprocess; built-in `realRunner` shells out for real.

import { basename } from "@std/path";
import { type ApfelkaefigConfig, type MountConfig } from "./schema.ts";
import { effective, type ResolvedConfig, substitute } from "./config.ts";
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
  // Allocate a TTY (`-t`). Defaults to whether stdin is a terminal — matches
  // docker/podman. When false, Apple `container` 0.12 fails with a cryptic
  // ENODEV ("Operation not supported by device") if `-t` is forced anyway.
  tty?: boolean;
  // Replace the resolved config's command with a fixed argv. Used by
  // `akf up --serve` to run the sshd entrypoint instead of the agent.
  commandOverride?: string[];
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
      // Volume name is literal — no substitution, no host-path check. The
      // volume itself is created by ensureVolumes() before `container run`.
      pushMount(m.source, tgt, !!m.readonly);
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
    pushMountIfExists(pushMount, claudeSource, `/home/${e.user}/.claude`, false);
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
  args.push(input.imageRef);
  args.push(...(input.commandOverride ?? e.command));

  return {
    args,
    workspaceFolder: sub(e.workspaceFolder),
    user: e.user,
  };
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

// Expand a leading `~` or `~/` to the host home dir. Mid-path tildes are
// left alone — they're not a shell glob target here.
function expandHome(p: string, home: string): string {
  if (!home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  return p;
}

function pushMountIfExists(
  push: (src: string, tgt: string, readonly: boolean) => boolean,
  src: string,
  tgt: string,
  readonly: boolean,
): void {
  if (!pathExistsSync(src)) return;
  push(src, tgt, readonly);
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
): Promise<void> {
  if (!mounts) return;
  const seen = new Set<string>();
  for (const m of mounts) {
    if (m.type !== "volume") continue;
    if (seen.has(m.source)) continue;
    seen.add(m.source);
    const r = await run("container", ["volume", "create", m.source], {
      stdout: "null",
      stderr: "piped",
    });
    if (r.code !== 0 && !/exist/i.test(r.stderr)) {
      throw new Error(
        `failed to create volume '${m.source}' (exit ${r.code}): ${r.stderr.trim()}`,
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
