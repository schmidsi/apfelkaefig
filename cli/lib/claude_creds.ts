// Claude OAuth credential staging (macOS).
//
// On macOS, Claude Code keeps its OAuth token in the login Keychain and
// refreshes it there — each refresh rotates the refresh token and leaves the
// on-disk ~/.claude/.credentials.json stale (expired access token + a refresh
// token the server has since revoked). The sandbox mounts ~/.claude and reads
// that stale file, so Claude inside the box can't refresh and is forced to
// re-login.
//
// To avoid that, `akf up` reads the current credential straight from the
// Keychain and stages it in akf's cache dir; buildRunArgs then overlay-mounts
// just that one file onto the container's ~/.claude/.credentials.json. The
// user's ~/.claude is never written to.

import { join } from "@std/path";
import { realRunner, type Runner } from "./container.ts";

// Keychain service name Claude Code stores its credential under (generic
// password, account = the macOS username).
export const KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface StageOptions {
  home: string;
  // Test seams.
  os?: string;
  run?: Runner;
}

// Read the live Claude credential from the macOS Keychain and write it to
// $HOME/.cache/apfelkaefig/claude-credentials.json (mode 600), returning that
// path. Returns null on non-macOS, when no Keychain item exists, or when the
// item isn't valid JSON — callers then fall back to whatever ~/.claude carries.
export async function stageClaudeCredentials(opts: StageOptions): Promise<string | null> {
  const os = opts.os ?? Deno.build.os;
  if (os !== "darwin") return null;
  const run = opts.run ?? realRunner;

  const r = await run(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
    { stdout: "piped", stderr: "null" },
  );
  if (r.code !== 0) return null;
  const cred = r.stdout.trim();
  if (!cred) return null;
  try {
    JSON.parse(cred); // Guard against mounting a non-JSON blob over the token.
  } catch {
    return null;
  }

  const dir = join(opts.home, ".cache", "apfelkaefig");
  await Deno.mkdir(dir, { recursive: true });
  const path = join(dir, "claude-credentials.json");
  await Deno.writeFile(path, new TextEncoder().encode(cred), { mode: 0o600 });
  return path;
}
