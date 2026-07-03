import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { stageClaudeCredentials } from "./claude_creds.ts";
import type { CmdResult, Runner } from "./container.ts";
import { withTmpDir } from "./test_util.ts";

const CRED = JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: 1 } });

function runner(res: Partial<CmdResult>): Runner {
  return () => Promise.resolve({ code: 0, stdout: "", stderr: "", ...res });
}

Deno.test("stageClaudeCredentials: null on non-macOS", async () => {
  await withTmpDir(async (home) => {
    const path = await stageClaudeCredentials({ home, os: "linux", run: runner({ stdout: CRED }) });
    assertEquals(path, null);
  });
});

Deno.test("stageClaudeCredentials: writes the keychain credential mode 600 on macOS", async () => {
  await withTmpDir(async (home) => {
    const path = await stageClaudeCredentials({
      home,
      os: "darwin",
      run: runner({ stdout: CRED + "\n" }),
    });
    assertEquals(path, join(home, ".cache", "apfelkaefig", "claude-credentials.json"));
    assertEquals(await Deno.readTextFile(path!), CRED);
    assertEquals((await Deno.stat(path!)).mode! & 0o777, 0o600);
  });
});

Deno.test("stageClaudeCredentials: null when the keychain lookup fails", async () => {
  await withTmpDir(async (home) => {
    const path = await stageClaudeCredentials({
      home,
      os: "darwin",
      run: runner({ code: 44, stderr: "not found" }),
    });
    assertEquals(path, null);
  });
});

Deno.test("stageClaudeCredentials: null when the keychain value isn't JSON", async () => {
  await withTmpDir(async (home) => {
    const path = await stageClaudeCredentials({
      home,
      os: "darwin",
      run: runner({ stdout: "not-json" }),
    });
    assertEquals(path, null);
    // Nothing staged.
    assert(!(await pathExists(join(home, ".cache", "apfelkaefig", "claude-credentials.json"))));
  });
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}
