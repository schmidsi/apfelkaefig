import { join } from "@std/path";
import {
  appendBlockIfAbsent,
  type AppendStatus,
  writeIfMissing,
  type WriteStatus,
} from "../lib/fs.ts";
import { GITIGNORE_MARKERS, MARKDOWN_MARKERS } from "../lib/markers.ts";

const TEMPLATES_URL = new URL("../../templates/", import.meta.url);

async function readTemplate(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, TEMPLATES_URL));
}

async function hasContainerCli(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("container", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    const { success } = await cmd.output();
    return success;
  } catch {
    return false;
  }
}

interface Report {
  label: string;
  status: WriteStatus | AppendStatus;
}

const STATUS_LABELS: Record<WriteStatus | AppendStatus, string> = {
  "created": "created",
  "skipped-exists": "skipped (exists)",
  "appended": "appended",
  "skipped-present": "skipped (already present)",
};

export async function runInit({ cwd }: { cwd: string }): Promise<void> {
  const reports: Report[] = [];

  if (!(await hasContainerCli())) {
    console.error(
      "warning: `container` CLI not found on PATH. Install Apple Container (https://github.com/apple/container) before running ./start.sh.",
    );
  }

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

  console.log();
  for (const r of reports) {
    console.log(`  ${r.label.padEnd(34)} ${STATUS_LABELS[r.status]}`);
  }
  console.log();

  const anyWork = reports.some((r) => r.status === "created" || r.status === "appended");
  if (anyWork) {
    console.log("Next steps:");
    console.log("  1. ./build.sh          # build the sandbox image (one-time)");
    console.log("  2. ./start.sh          # launch Claude Code inside the sandbox");
  } else {
    console.log("Nothing to do — this folder is already set up for akf.");
  }
}
