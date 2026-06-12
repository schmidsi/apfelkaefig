import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { runClean } from "./clean.ts";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "akf-clean-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

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
