// Thin wrapper around Apple `container`. Centralizes flag construction so the
// commands stay thin. Designed to be testable: pass a `runner` to substitute
// the subprocess; built-in `realRunner` shells out for real.

import { basename } from "@std/path";
import { type ApfelkaefigConfig, DEFAULTS } from "./schema.ts";
import { effective, type ResolvedConfig, substitute } from "./config.ts";

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

  const args: string[] = ["run", "-it", "--rm"];
  args.push("--cpus", String(e.resources.cpus), "--memory", e.resources.memory);

  // Workspace mount.
  args.push("-v", `${input.workspaceHostPath}:${sub(e.workspaceFolder)}`);

  // Default mounts: ~/.claude RW, ~/Downloads RO, ~/Desktop RO. Skip when the
  // host source doesn't exist (mirrors the pre-refactor start.sh behavior).
  if (home) {
    pushMountIfExists(args, `${home}/.claude`, `/home/${e.user}/.claude`, false);
    pushMountIfExists(args, `${home}/Downloads`, `/home/${e.user}/Downloads`, true);
    pushMountIfExists(args, `${home}/Desktop`, `/home/${e.user}/Desktop`, true);
  }

  // Extra mounts from config.
  for (const m of c.mounts ?? []) {
    const src = sub(m.source);
    const tgt = sub(m.target);
    if (!pathExistsSync(src)) {
      console.error(`warning: skipping mount ${src} -> ${tgt} (source not found)`);
      continue;
    }
    const flag = m.readonly ? `${src}:${tgt}:ro` : `${src}:${tgt}`;
    args.push("-v", flag);
  }

  // Container env: CLAUDE_CONFIG_DIR by default + config env + extras.
  const envOut: Record<string, string> = {
    CLAUDE_CONFIG_DIR: `/home/${e.user}/.claude`,
    ...(c.env ?? {}),
    ...(input.extraEnv ?? {}),
  };
  for (const [k, v] of Object.entries(envOut)) {
    const resolved = sub(v);
    if (resolved === "" && !(k in (input.extraEnv ?? {}))) continue;
    args.push("-e", `${k}=${resolved}`);
  }

  args.push("-u", e.user, "-w", sub(e.workspaceFolder));
  args.push(input.imageRef);
  args.push(...e.command);

  return {
    args,
    workspaceFolder: sub(e.workspaceFolder),
    user: e.user,
  };
}

function pushMountIfExists(args: string[], src: string, tgt: string, readonly: boolean): void {
  if (!pathExistsSync(src)) return;
  args.push("-v", readonly ? `${src}:${tgt}:ro` : `${src}:${tgt}`);
}

function pathExistsSync(p: string): boolean {
  try {
    Deno.lstatSync(p);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    return false;
  }
}

// Per-project image tag derived from the workspace basename — preserves the
// fix from a96b899. Lowercased + non-alnum stripped to keep it a valid tag.
export function projectImageTag(workspaceHostPath: string): string {
  const base = basename(workspaceHostPath).toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const trimmed = base.replace(/^-+|-+$/g, "");
  return `${trimmed || "akf"}-sandbox`;
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

// Replace ApfelkaefigConfig defaults reference for export
export { DEFAULTS };

// --- container subcommand wrappers ---

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

export async function pullImageHttp(ref: string, run: Runner = realRunner): Promise<CmdResult> {
  return await run("container", ["image", "pull", "--scheme", "http", ref]);
}

export async function tagImage(
  src: string,
  dst: string,
  run: Runner = realRunner,
): Promise<CmdResult> {
  return await run("container", ["image", "tag", src, dst]);
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
