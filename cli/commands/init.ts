// `akf init` — set up the current folder for akf.
//
// Default (tier 2): writes .apfelkaefig.json + the .gitignore / CLAUDE.md
// marker blocks. The folder is now akf-native.
//
// --advanced (tier 3): also writes .devcontainer/Dockerfile +
// devcontainer.json so VS Code Dev Containers / Codespaces / Coder pick it up.
//
// --bash (legacy): writes self-contained build.sh + start.sh +
// .devcontainer/. Equivalent to `akf eject --bash` on a fresh repo. Useful as
// a v0.1 → v0.2 migration aid.

import { join } from "@std/path";
import {
  appendBlockIfAbsent,
  type AppendStatus,
  writeIfMissing,
  type WriteStatus,
} from "../lib/fs.ts";
import { GITIGNORE_MARKERS, MARKDOWN_MARKERS } from "../lib/markers.ts";
import { addPluginToWorkspace, formatSetupStep, type PluginAddResult } from "./plugin.ts";

export type InitMode = "default" | "advanced" | "bash";

const TEMPLATES_URL = new URL("../../templates/", import.meta.url);

async function readTemplate(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, TEMPLATES_URL));
}

interface Report {
  label: string;
  status: WriteStatus | AppendStatus;
}

const STATUS_LABELS: Record<WriteStatus | AppendStatus | "updated", string> = {
  "created": "created",
  "skipped-exists": "skipped (exists)",
  "appended": "appended",
  "skipped-present": "skipped (already present)",
  "updated": "updated",
};

export async function runInit(
  { cwd, mode = "default", plugins = [], statusline = false }: {
    cwd: string;
    mode?: InitMode;
    plugins?: string[];
    statusline?: boolean;
  },
): Promise<void> {
  const reports: Report[] = [];

  if (mode === "default" || mode === "advanced") {
    const config = await readTemplate("apfelkaefig.json");
    reports.push({
      label: ".apfelkaefig.json",
      status: await writeIfMissing(join(cwd, ".apfelkaefig.json"), config),
    });
  }

  if (mode === "advanced" || mode === "bash") {
    const dockerfile = await readTemplate(".devcontainer/Dockerfile");
    reports.push({
      label: ".devcontainer/Dockerfile",
      status: await writeIfMissing(join(cwd, ".devcontainer/Dockerfile"), dockerfile),
    });

    const devcontainer = await readTemplate(".devcontainer/devcontainer.json");
    reports.push({
      label: ".devcontainer/devcontainer.json",
      status: await writeIfMissing(join(cwd, ".devcontainer/devcontainer.json"), devcontainer),
    });
  }

  if (mode === "bash") {
    const startSh = await readTemplate("start.sh");
    reports.push({
      label: "start.sh",
      status: await writeIfMissing(join(cwd, "start.sh"), startSh, { mode: 0o755 }),
    });

    const buildSh = await readTemplate("build.sh");
    reports.push({
      label: "build.sh",
      status: await writeIfMissing(join(cwd, "build.sh"), buildSh, { mode: 0o755 }),
    });
  }

  // Always: gitignore + CLAUDE.md marker blocks.
  const gitignoreBlock = await readTemplate("gitignore.block");
  reports.push({
    label: ".gitignore",
    status: await appendBlockIfAbsent(
      join(cwd, ".gitignore"),
      GITIGNORE_MARKERS.start,
      GITIGNORE_MARKERS.end,
      gitignoreBlock,
    ),
  });

  // Optional global install of the statusline helper into ~/.claude/bin/.
  // ~/.claude is mounted RW from host into the sandbox, so a single script
  // serves both contexts; AKF_SANDBOX (injected by `akf up`) drives the branch.
  let statuslineInstalled = false;
  if (statusline) {
    const home = Deno.env.get("HOME");
    if (!home) {
      console.error("akf init: --statusline requires $HOME to be set");
    } else {
      const script = await readTemplate("akf-statusline");
      const target = join(home, ".claude", "bin", "akf-statusline");
      const status = await writeIfMissing(target, script, { mode: 0o755 });
      reports.push({ label: "~/.claude/bin/akf-statusline", status });
      statuslineInstalled = status === "created";
    }
  }

  const claudeBlock = await readTemplate("CLAUDE.block.md");
  reports.push({
    label: "CLAUDE.md",
    status: await appendBlockIfAbsent(
      join(cwd, "CLAUDE.md"),
      MARKDOWN_MARKERS.start,
      MARKDOWN_MARKERS.end,
      claudeBlock,
    ),
  });

  const pluginReports: PluginAddResult[] = [];
  for (const plugin of plugins) {
    pluginReports.push(await addPluginToWorkspace({ cwd, plugin }));
  }

  console.log();
  for (const r of reports) {
    console.log(`  ${r.label.padEnd(34)} ${STATUS_LABELS[r.status]}`);
  }
  for (const p of pluginReports) {
    console.log(`  plugin:${p.pluginId}`.padEnd(36) + " configured");
    for (const marker of p.markerStatuses) {
      console.log(`  ${marker.path.padEnd(34)} ${STATUS_LABELS[marker.status]}`);
    }
  }
  console.log();

  const anyWork = reports.some((r) => r.status === "created" || r.status === "appended") ||
    pluginReports.some((p) =>
      p.configChanged || p.markerStatuses.some((m) => m.status !== "skipped-present")
    );
  if (!anyWork) {
    console.log("Nothing to do — this folder is already set up for akf.");
    return;
  }

  const setupSteps = pluginReports.flatMap((p) => p.setupSteps);
  const notes = pluginReports.flatMap((p) => p.postApplyMessages);
  if (statuslineInstalled) {
    notes.push(
      'Statusline script installed. Add to ~/.claude/settings.json:\n' +
        '    "statusLine": { "type": "command", "command": "~/.claude/bin/akf-statusline" }',
    );
  }

  console.log("Next steps:");
  if (mode === "bash") {
    let i = 1;
    for (const step of setupSteps) {
      console.log(`  ${i++}. ${formatSetupStep(step)}`);
    }
    console.log(`  ${i++}. ./build.sh              # build the sandbox image (one-time)`);
    console.log(`  ${i}. ./start.sh              # launch Claude Code inside the sandbox`);
  } else if (setupSteps.length > 0) {
    let i = 1;
    for (const step of setupSteps) {
      console.log(`  ${i++}. ${formatSetupStep(step)}`);
    }
    console.log(`  ${i}. akf up                              # launch Claude in the sandbox`);
  } else {
    console.log("  akf up                 # launch the sandbox");
    if (mode === "advanced") {
      console.log("                         # or open in VS Code → Reopen in Container");
    }
  }

  if (notes.length > 0) {
    console.log();
    console.log("Notes:");
    for (const message of notes) {
      console.log(`  ${message}`);
    }
  }
}
