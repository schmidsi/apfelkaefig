import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { appendBlockIfAbsent, writeIfMissing } from "./fs.ts";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "akf-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("writeIfMissing creates a file when absent", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "new/nested/file.txt");
    const status = await writeIfMissing(path, "hello");
    assertEquals(status, "created");
    assertEquals(await Deno.readTextFile(path), "hello");
  });
});

Deno.test("writeIfMissing skips when file exists", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "existing.txt");
    await Deno.writeTextFile(path, "original");
    const status = await writeIfMissing(path, "new");
    assertEquals(status, "skipped-exists");
    assertEquals(await Deno.readTextFile(path), "original");
  });
});

Deno.test("writeIfMissing honors mode", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "script.sh");
    await writeIfMissing(path, "#!/bin/sh\n", { mode: 0o755 });
    const info = await Deno.stat(path);
    assertEquals((info.mode ?? 0) & 0o777, 0o755);
  });
});

Deno.test("appendBlockIfAbsent creates file when missing", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "CLAUDE.md");
    const status = await appendBlockIfAbsent(path, "<!-- s -->", "<!-- e -->", "body");
    assertEquals(status, "created");
    assertEquals(await Deno.readTextFile(path), "<!-- s -->\nbody\n<!-- e -->\n");
  });
});

Deno.test("appendBlockIfAbsent appends to existing file without marker", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, ".gitignore");
    await Deno.writeTextFile(path, "node_modules/\n.env\n");
    const status = await appendBlockIfAbsent(path, "# >>> a >>>", "# <<< a <<<", ".akf/");
    assertEquals(status, "appended");
    const contents = await Deno.readTextFile(path);
    assertEquals(
      contents,
      "node_modules/\n.env\n\n# >>> a >>>\n.akf/\n# <<< a <<<\n",
    );
  });
});

Deno.test("appendBlockIfAbsent appends correctly when file has no trailing newline", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, ".gitignore");
    await Deno.writeTextFile(path, "node_modules/");
    await appendBlockIfAbsent(path, "# >>> a >>>", "# <<< a <<<", ".akf/");
    const contents = await Deno.readTextFile(path);
    assertEquals(contents, "node_modules/\n\n# >>> a >>>\n.akf/\n# <<< a <<<\n");
  });
});

Deno.test("appendBlockIfAbsent is idempotent when marker already present", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "CLAUDE.md");
    const original = "# Project\n\n<!-- s -->\nold body\n<!-- e -->\n";
    await Deno.writeTextFile(path, original);
    const status = await appendBlockIfAbsent(path, "<!-- s -->", "<!-- e -->", "new body");
    assertEquals(status, "skipped-present");
    assertEquals(await Deno.readTextFile(path), original);
  });
});

Deno.test("appendBlockIfAbsent handles empty existing file", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, ".gitignore");
    await Deno.writeTextFile(path, "");
    const status = await appendBlockIfAbsent(path, "# >>> a >>>", "# <<< a <<<", ".akf/");
    assertEquals(status, "appended");
    assertEquals(await Deno.readTextFile(path), "# >>> a >>>\n.akf/\n# <<< a <<<\n");
  });
});
