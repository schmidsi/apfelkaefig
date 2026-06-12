import { withTmpDir } from "../lib/test_util.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { runClean } from "./clean.ts";

Deno.test("clean: malformed config exits 1 instead of throwing", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      JSON.stringify({ version: 1, bogusKey: true }),
    );
    const code = await runClean({ cwd: dir });
    assertEquals(code, 1);
  });
});
