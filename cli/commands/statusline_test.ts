import { withTmpDir } from "../lib/test_util.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { installStatusline } from "./statusline.ts";

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
