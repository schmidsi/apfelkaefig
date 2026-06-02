// `akf statusline` — installs the Claude Code statusline helper into
// ~/.claude/bin/. One-time, global setup (not per-project). The script
// itself branches on AKF_SANDBOX (injected by `akf up`) so the same
// settings.json works on host and inside any akf sandbox.

import { join } from "@std/path";
import { writeIfMissing } from "../lib/fs.ts";

const TEMPLATES_URL = new URL("../../templates/", import.meta.url);

const SETTINGS_SNIPPET =
  '"statusLine": { "type": "command", "command": "~/.claude/bin/akf-statusline" }';

export async function runStatusline(): Promise<number> {
  const home = Deno.env.get("HOME");
  if (!home) {
    console.error("akf statusline: $HOME is not set");
    return 1;
  }

  const script = await Deno.readTextFile(new URL("akf-statusline", TEMPLATES_URL));
  const target = join(home, ".claude", "bin", "akf-statusline");
  const status = await writeIfMissing(target, script, { mode: 0o755 });

  console.log();
  console.log(`  ~/.claude/bin/akf-statusline    ${status === "created" ? "created" : "skipped (exists)"}`);
  console.log();
  console.log("Add to ~/.claude/settings.json:");
  console.log(`  ${SETTINGS_SNIPPET}`);
  console.log();
  return 0;
}
