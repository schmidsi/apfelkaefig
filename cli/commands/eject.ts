// `akf eject` — write self-contained artifacts so a project can run without
// the akf binary at runtime.
//
//   --devcontainer  Write .devcontainer/devcontainer.json (and Dockerfile,
//                   if image.dockerfile is set). Tier 2 → tier 3 promotion.
//   --bash          Write build.sh + start.sh that boot the same container
//                   without akf installed. Bakes the resolved config into
//                   the scripts.
//
// One-way. To come back, ask Claude to read the ejected files and rewrite a
// .apfelkaefig.json by hand.

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { writeIfMissing } from "../lib/fs.ts";
import { effective, resolveConfig, type ResolvedConfig } from "../lib/config.ts";
import { projectImageTag } from "../lib/container.ts";

// The embedded built-in Dockerfile, written into the project when ejecting
// without an explicit image. Same content as `image/Dockerfile`.
const EMBEDDED_BASE_DOCKERFILE_URL = new URL("../../image/Dockerfile", import.meta.url);

export type EjectTarget = "devcontainer" | "bash";

export interface EjectOptions {
  cwd: string;
  target: EjectTarget;
  // Overwrite existing files instead of skipping. Eject is one-way; users who
  // re-run with --force consciously stomp.
  force?: boolean;
}

export async function runEject(opts: EjectOptions): Promise<number> {
  const resolved = await resolveConfig({ cwd: opts.cwd });

  if (opts.target === "devcontainer") {
    return await ejectDevcontainer(opts, resolved);
  }
  return await ejectBash(opts, resolved);
}

async function ejectDevcontainer(
  opts: EjectOptions,
  resolved: ResolvedConfig,
): Promise<number> {
  const c = resolved.config;
  const e = effective(resolved);

  const dc: Record<string, unknown> = {
    name: "${localWorkspaceFolderBasename}",
    remoteUser: e.user,
    workspaceMount:
      `source=\${localWorkspaceFolder},target=${e.workspaceFolder},type=bind,consistency=delegated`,
    workspaceFolder: e.workspaceFolder,
    mounts: defaultMountStrings(e.user).concat((c.mounts ?? []).map(mountObjToString)),
  };

  if (typeof c.image === "string") {
    dc.image = c.image;
  } else if (c.image && typeof c.image === "object" && "dockerfile" in c.image) {
    dc.build = { dockerfile: relative(c.image.dockerfile) };
  } else {
    // Built-in case: ship the embedded Dockerfile so VS Code can build it.
    dc.build = { dockerfile: "Dockerfile" };
  }

  if (c.env && Object.keys(c.env).length > 0) {
    const containerEnv: Record<string, string> = {
      CLAUDE_CONFIG_DIR: `/home/${e.user}/.claude`,
    };
    for (const [k, v] of Object.entries(c.env)) containerEnv[k] = v;
    dc.containerEnv = containerEnv;
  } else {
    dc.containerEnv = { CLAUDE_CONFIG_DIR: `/home/${e.user}/.claude` };
  }

  if (c.secrets?.onepassword !== false) {
    dc.remoteEnv = { OP_SERVICE_ACCOUNT_TOKEN: "${localEnv:OP_SERVICE_ACCOUNT_TOKEN}" };
  }

  await ensureDir(join(opts.cwd, ".devcontainer"));
  const out = JSON.stringify(dc, null, 2) + "\n";
  const dcPath = join(opts.cwd, ".devcontainer/devcontainer.json");
  await writeOrForce(dcPath, out, opts.force);
  console.log(`  wrote ${rel(opts.cwd, dcPath)}`);

  if (typeof c.image === "string") {
    // Registry image — no Dockerfile to write.
  } else if (c.image && typeof c.image === "object" && "dockerfile" in c.image) {
    // Copy/keep the user's Dockerfile in place — nothing to do.
  } else {
    // Built-in case: copy the embedded base Dockerfile so VS Code can build it.
    const dockerfile = await Deno.readTextFile(EMBEDDED_BASE_DOCKERFILE_URL);
    const dfPath = join(opts.cwd, ".devcontainer/Dockerfile");
    if (await writeOrForce(dfPath, dockerfile, opts.force)) {
      console.log(`  wrote ${rel(opts.cwd, dfPath)}`);
    }
  }

  console.log("\nEjected to .devcontainer/. VS Code → Reopen in Container should pick it up.");
  return 0;
}

async function ejectBash(
  opts: EjectOptions,
  resolved: ResolvedConfig,
): Promise<number> {
  const c = resolved.config;
  const e = effective(resolved);

  const tag = projectImageTag(opts.cwd);

  // Three cases for "what image does start.sh launch?"
  //   1. config.image is a registry string → use it directly, no build.sh.
  //   2. config.image is { dockerfile } → use that Dockerfile, write build.sh.
  //   3. no image set (built-in) → write the embedded Dockerfile to
  //      .devcontainer/Dockerfile, use the project tag, write build.sh.
  let dockerfile: string | null = null;
  let imageRef: string;
  if (typeof c.image === "string") {
    imageRef = c.image;
  } else if (c.image && typeof c.image === "object" && "dockerfile" in c.image) {
    dockerfile = c.image.dockerfile;
    imageRef = tag;
  } else {
    const embedded = await Deno.readTextFile(EMBEDDED_BASE_DOCKERFILE_URL);
    const dfPath = join(opts.cwd, ".devcontainer/Dockerfile");
    await ensureDir(join(opts.cwd, ".devcontainer"));
    if (await writeOrForce(dfPath, embedded, opts.force)) {
      console.log(`  wrote ${rel(opts.cwd, dfPath)}`);
    }
    dockerfile = ".devcontainer/Dockerfile";
    imageRef = tag;
  }

  const startSh = renderStart({
    user: e.user,
    workspaceFolder: e.workspaceFolder,
    cpus: e.resources.cpus,
    memory: e.resources.memory,
    command: e.command,
    extraMounts: c.mounts ?? [],
    extraEnv: c.env ?? {},
    image: imageRef,
    onepasswordEnabled: c.secrets?.onepassword !== false,
  });

  const startPath = join(opts.cwd, "start.sh");
  await writeOrForce(startPath, startSh, opts.force, { mode: 0o755 });
  console.log(`  wrote ${rel(opts.cwd, startPath)}`);

  if (dockerfile) {
    const buildSh = renderBuild({ tag, dockerfile });
    const buildPath = join(opts.cwd, "build.sh");
    await writeOrForce(buildPath, buildSh, opts.force, { mode: 0o755 });
    console.log(`  wrote ${rel(opts.cwd, buildPath)}`);
  }

  console.log("\nEjected to bash scripts. ./start.sh boots the same sandbox without akf.");
  return 0;
}

interface StartTemplateInput {
  user: string;
  workspaceFolder: string;
  cpus: number;
  memory: string;
  command: string[];
  extraMounts: { source: string; target: string; readonly?: boolean }[];
  extraEnv: Record<string, string>;
  image: string;
  onepasswordEnabled: boolean;
}

function renderStart(t: StartTemplateInput): string {
  const lines: string[] = [];
  lines.push("#!/bin/bash");
  lines.push("# Self-contained sandbox launcher generated by `akf eject --bash`.");
  lines.push("# Boots the same image akf would, with no runtime dependency on akf.");
  lines.push("set -e");
  lines.push(`WORKSPACE="$(cd "$(dirname "$0")" && pwd)"`);
  lines.push(`WS_BASE="$(basename "$WORKSPACE")"`);
  lines.push("");
  lines.push("if ! container system status &>/dev/null; then");
  lines.push("  container system start");
  lines.push("fi");
  lines.push("");

  // Build mount + env arrays.
  lines.push("mount_flags=()");
  const wsFolder = t.workspaceFolder.replaceAll(
    "${localWorkspaceFolderBasename}",
    "$WS_BASE",
  );
  lines.push(`mount_flags+=(-v "$WORKSPACE:${wsFolder}")`);
  for (const m of defaultBindMountsFor(t.user)) {
    lines.push(`if [[ -e "${m.host}" ]]; then`);
    lines.push(
      `  mount_flags+=(-v "${m.host}:${m.target}${m.readonly ? ":ro" : ""}")`,
    );
    lines.push("fi");
  }
  for (const m of t.extraMounts) {
    const src = m.source.replaceAll(
      "${localWorkspaceFolder}",
      "$WORKSPACE",
    ).replaceAll("${localWorkspaceFolderBasename}", "$WS_BASE");
    const tgt = m.target.replaceAll(
      "${localWorkspaceFolder}",
      "$WORKSPACE",
    ).replaceAll("${localWorkspaceFolderBasename}", "$WS_BASE");
    const srcShell = src.replace(/\$\{localEnv:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}");
    lines.push(`if [[ -e "${srcShell}" ]]; then`);
    lines.push(
      `  mount_flags+=(-v "${srcShell}:${tgt}${m.readonly ? ":ro" : ""}")`,
    );
    lines.push("fi");
  }
  lines.push("");

  lines.push("env_flags=()");
  lines.push(`env_flags+=(-e "CLAUDE_CONFIG_DIR=/home/${t.user}/.claude")`);
  for (const [k, v] of Object.entries(t.extraEnv)) {
    const vShell = v.replace(/\$\{localEnv:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}")
      .replaceAll("${localWorkspaceFolder}", "$WORKSPACE")
      .replaceAll("${localWorkspaceFolderBasename}", "$WS_BASE");
    lines.push(`env_flags+=(-e "${k}=${vShell}")`);
  }
  if (t.onepasswordEnabled) {
    lines.push(
      `[[ -n "\${OP_SERVICE_ACCOUNT_TOKEN:-}" ]] && env_flags+=(-e "OP_SERVICE_ACCOUNT_TOKEN=$OP_SERVICE_ACCOUNT_TOKEN")`,
    );
  }
  lines.push("");

  const cmdShell = t.command.map(shellQuote).join(" ");
  lines.push(`exec container run -it --rm \\`);
  lines.push(`  --cpus ${t.cpus} --memory ${t.memory} \\`);
  lines.push(`  "\${mount_flags[@]}" \\`);
  lines.push(`  "\${env_flags[@]}" \\`);
  lines.push(`  -u ${shellQuote(t.user)} -w ${shellQuote(wsFolder)} \\`);
  lines.push(`  ${shellQuote(t.image)} \\`);
  lines.push(`  ${cmdShell} "$@"`);
  lines.push("");

  return lines.join("\n");
}

function renderBuild({ tag, dockerfile }: { tag: string; dockerfile: string }): string {
  return [
    "#!/bin/bash",
    "# Self-contained image builder generated by `akf eject --bash`.",
    "# Builds with Docker, shuttles via local registry into Apple `container`.",
    "set -e",
    "",
    `IMAGE_NAME=${shellQuote(tag)}`,
    `DOCKERFILE=${shellQuote(dockerfile)}`,
    'REGISTRY="localhost:5555"',
    "",
    'echo "Building image with Docker..."',
    'docker build -t "$IMAGE_NAME" -f "$DOCKERFILE" "$(dirname "$DOCKERFILE")"',
    "",
    'echo "Starting local registry..."',
    "docker run -d --rm --name registry -p 5555:5000 registry:2",
    "",
    'echo "Pushing to local registry..."',
    'docker tag "$IMAGE_NAME" "$REGISTRY/$IMAGE_NAME"',
    'docker push "$REGISTRY/$IMAGE_NAME"',
    "",
    'echo "Pulling into Apple Container..."',
    'container image pull --scheme http "$REGISTRY/$IMAGE_NAME"',
    'container image tag "$REGISTRY/$IMAGE_NAME" "$IMAGE_NAME"',
    "",
    'echo "Stopping registry..."',
    "docker stop registry",
    "",
    'echo "Done. Run ./start.sh to launch."',
    "",
  ].join("\n");
}

function defaultMountStrings(user: string): string[] {
  return [
    `source=\${localEnv:HOME}/.claude,target=/home/${user}/.claude,type=bind`,
    `source=\${localEnv:HOME}/Downloads,target=/home/${user}/Downloads,type=bind,readonly`,
    `source=\${localEnv:HOME}/Desktop,target=/home/${user}/Desktop,type=bind,readonly`,
  ];
}

function defaultBindMountsFor(
  user: string,
): { host: string; target: string; readonly: boolean }[] {
  return [
    { host: "$HOME/.claude", target: `/home/${user}/.claude`, readonly: false },
    { host: "$HOME/Downloads", target: `/home/${user}/Downloads`, readonly: true },
    { host: "$HOME/Desktop", target: `/home/${user}/Desktop`, readonly: true },
  ];
}

function mountObjToString(m: { source: string; target: string; readonly?: boolean }): string {
  const parts = [`source=${m.source}`, `target=${m.target}`, "type=bind"];
  if (m.readonly) parts.push("readonly");
  return parts.join(",");
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./@%+:=-]+$/.test(s)) return s;
  // Preserve $VAR expansion: if the only "unsafe" chars are $/{}, double-quote
  // it so the shell still interpolates. Otherwise single-quote to disable
  // interpolation entirely.
  if (/^[A-Za-z0-9_./@%+:=${}-]+$/.test(s)) {
    return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function rel(cwd: string, path: string): string {
  return path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

function relative(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

async function writeOrForce(
  path: string,
  contents: string,
  force: boolean | undefined,
  opts: { mode?: number } = {},
): Promise<boolean> {
  if (force) {
    await ensureDir(join(path, ".."));
    await Deno.writeTextFile(path, contents);
    if (opts.mode !== undefined) await Deno.chmod(path, opts.mode);
    return true;
  }
  const status = await writeIfMissing(path, contents, opts);
  if (status === "skipped-exists") {
    console.log(`  skipped ${rel(Deno.cwd(), path)} (exists; pass --force to overwrite)`);
    return false;
  }
  return true;
}
