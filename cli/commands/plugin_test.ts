import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { addPluginToWorkspace } from "./plugin.ts";
import { runInit } from "./init.ts";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "akf-plugin-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("plugin add 1password creates config and marker block", async () => {
  await withTmpDir(async (dir) => {
    const result = await addPluginToWorkspace({ cwd: dir, plugin: "1pw" });
    assertEquals(result.pluginId, "1password");
    assertEquals(result.configChanged, true);

    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.plugins["1password"], { enabled: true });
    assertEquals(config.secrets.onepassword, true);

    const claude = await Deno.readTextFile(join(dir, "CLAUDE.md"));
    assert(claude.includes("<!-- akf plugin: 1password start -->"));
    assert(claude.includes("op read"));
  });
});

Deno.test("plugin add 1password is idempotent", async () => {
  await withTmpDir(async (dir) => {
    await addPluginToWorkspace({ cwd: dir, plugin: "1password" });
    const second = await addPluginToWorkspace({ cwd: dir, plugin: "op" });
    assertEquals(second.configChanged, false);
    assertEquals(second.markerStatuses, [{ path: "CLAUDE.md", status: "skipped-present" }]);
  });
});

Deno.test("plugin add preserves existing config fields", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      JSON.stringify({ version: 1, env: { TZ: "UTC" } }),
    );
    await addPluginToWorkspace({ cwd: dir, plugin: "1password" });
    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.env, { TZ: "UTC" });
    assertEquals(config.plugins["1password"].enabled, true);
  });
});

Deno.test("plugin add writes to discovered workspace root from subdir", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, ".git"));
    const subdir = join(dir, "packages", "app");
    await Deno.mkdir(subdir, { recursive: true });
    await addPluginToWorkspace({ cwd: subdir, plugin: "1password" });
    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.plugins["1password"].enabled, true);
    const claude = await Deno.readTextFile(join(dir, "CLAUDE.md"));
    assert(claude.includes("akf plugin: 1password"));
  });
});

Deno.test("plugin add refuses edited owned marker block", async () => {
  await withTmpDir(async (dir) => {
    await addPluginToWorkspace({ cwd: dir, plugin: "1password" });
    const claudePath = join(dir, "CLAUDE.md");
    await Deno.writeTextFile(
      claudePath,
      "<!-- akf plugin: 1password start -->\nuser edit\n<!-- akf plugin: 1password end -->\n",
    );
    await assertRejects(
      () => addPluginToWorkspace({ cwd: dir, plugin: "1password" }),
      Error,
      "differs from generated content",
    );
  });
});

Deno.test("init --plugins 1password writes plugin config", async () => {
  await withTmpDir(async (dir) => {
    await runInit({ cwd: dir, plugins: ["1password"] });
    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.plugins["1password"].enabled, true);
    assertEquals(config.secrets.onepassword, true);
  });
});
