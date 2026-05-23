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

Deno.test("plugin add crit creates config, Dockerfile block, and guidance", async () => {
  await withTmpDir(async (dir) => {
    const result = await addPluginToWorkspace({ cwd: dir, plugin: "crit" });
    assertEquals(result.pluginId, "crit");
    assertEquals(result.configChanged, true);

    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.plugins.crit.version, "v0.13.0");
    assertEquals(config.image, { dockerfile: ".devcontainer/Dockerfile" });
    assertEquals(config.env.CRIT_HOST, "0.0.0.0");
    assertEquals(config.env.CRIT_PORT, "3247");
    assertEquals(config.ports, [{
      hostIp: "127.0.0.1",
      host: 3247,
      container: 3247,
      protocol: "tcp",
    }]);

    const dockerfile = await Deno.readTextFile(join(dir, ".devcontainer/Dockerfile"));
    assert(dockerfile.includes("# >>> akf plugin: crit"));
    assert(dockerfile.includes("crit-linux-$CRIT_ARCH"));
    assert(dockerfile.includes("CRIT_VERSION=v0.13.0"));

    const claude = await Deno.readTextFile(join(dir, "CLAUDE.md"));
    assert(claude.includes("akf up -- crit install claude-code"));
    assert(result.postApplyMessages.some((m) => m.includes("crit install claude-code")));
  });
});

Deno.test("plugin add crit is idempotent", async () => {
  await withTmpDir(async (dir) => {
    await addPluginToWorkspace({ cwd: dir, plugin: "crit" });
    const second = await addPluginToWorkspace({ cwd: dir, plugin: "crit" });
    assertEquals(second.configChanged, false);
    assertEquals(second.markerStatuses, [
      { path: ".devcontainer/Dockerfile", status: "skipped-present" },
      { path: "CLAUDE.md", status: "skipped-present" },
    ]);
  });
});

Deno.test("plugin add crit refuses edited Dockerfile owned block", async () => {
  await withTmpDir(async (dir) => {
    await addPluginToWorkspace({ cwd: dir, plugin: "crit" });
    const dockerfilePath = join(dir, ".devcontainer/Dockerfile");
    const dockerfile = await Deno.readTextFile(dockerfilePath);
    await Deno.writeTextFile(dockerfilePath, dockerfile.replace("crit --version", "echo edited"));
    await assertRejects(
      () => addPluginToWorkspace({ cwd: dir, plugin: "crit" }),
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

Deno.test("init --plugins crit writes plugin config", async () => {
  await withTmpDir(async (dir) => {
    await runInit({ cwd: dir, plugins: ["crit"] });
    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.plugins.crit.enabled, true);
    assertEquals(config.ports[0].host, 3247);
  });
});
