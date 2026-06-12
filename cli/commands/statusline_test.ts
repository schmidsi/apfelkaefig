import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { installStatusline } from "./statusline.ts";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "akf-statusline-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("installStatusline: creates, then reports up to date, then updates stale script", async () => {
  await withTmpDir(async (home) => {
    const target = join(home, ".claude", "bin", "akf-statusline");

    assertEquals(await installStatusline(home), "created");
    const installed = await Deno.readTextFile(target);
    const info = await Deno.stat(target);
    assertEquals((info.mode ?? 0) & 0o777, 0o755);

    assertEquals(await installStatusline(home), "up to date");

    // Stale script from an older release gets overwritten, not frozen.
    await Deno.writeTextFile(target, "#!/bin/sh\necho old-release\n");
    assertEquals(await installStatusline(home), "updated");
    assertEquals(await Deno.readTextFile(target), installed);
  });
});
