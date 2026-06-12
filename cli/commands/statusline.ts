// `akf statusline` — installs the Claude Code statusline helper into
// ~/.claude/bin/. Global setup (not per-project). The script itself branches
// on AKF_SANDBOX (injected by `akf up`) so the same settings.json works on
// host and inside any akf sandbox. The script is fully akf-owned (never
// user-merged), so re-running overwrites it — that's how newer releases
// propagate.

import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";

const TEMPLATES_URL = new URL("../../templates/", import.meta.url);

const SETTINGS_SNIPPET =
  '"statusLine": { "type": "command", "command": "~/.claude/bin/akf-statusline" }';

export type StatuslineStatus = "created" | "updated" | "up to date";

export async function installStatusline(home: string): Promise<StatuslineStatus> {
  const script = await Deno.readTextFile(new URL("akf-statusline", TEMPLATES_URL));
  const target = join(home, ".claude", "bin", "akf-statusline");

  let existing: string | null = null;
  try {
    existing = await Deno.readTextFile(target);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  if (existing === script) return "up to date";

  await ensureDir(dirname(target));
  await Deno.writeTextFile(target, script);
  await Deno.chmod(target, 0o755);
  return existing === null ? "created" : "updated";
}

export async function runStatusline(opts: { home?: string } = {}): Promise<number> {
  const home = opts.home ?? Deno.env.get("HOME");
  if (!home) {
    console.error("akf statusline: $HOME is not set");
    return 1;
  }

  const status = await installStatusline(home);

  console.log();
  console.log(`  ~/.claude/bin/akf-statusline    ${status}`);
  console.log();
  console.log("Add to ~/.claude/settings.json:");
  console.log(`  ${SETTINGS_SNIPPET}`);
  console.log();
  return 0;
}
