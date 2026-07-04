import { withTmpDir } from "../lib/test_util.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { addPluginToWorkspace, syncPluginBlocks } from "./plugin.ts";
import { runInit } from "./init.ts";

Deno.test("plugin add 1password creates config and marker block", async () => {
  await withTmpDir(async (dir) => {
    const result = await addPluginToWorkspace({ cwd: dir, plugin: "1pw" });
    assertEquals(result.pluginId, "1password");
    assertEquals(result.configChanged, true);

    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.plugins["1password"], { enabled: true });
    // Config effects (secrets) resolve at runtime, never materialized (tasks/011).
    assertEquals(config.secrets, undefined);

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

Deno.test("plugin add overwrites an edited owned marker block (machine-owned)", async () => {
  await withTmpDir(async (dir) => {
    await addPluginToWorkspace({ cwd: dir, plugin: "1password" });
    const claudePath = join(dir, "CLAUDE.md");
    await Deno.writeTextFile(
      claudePath,
      "<!-- akf plugin: 1password start -->\nuser edit\n<!-- akf plugin: 1password end -->\n",
    );
    const result = await addPluginToWorkspace({ cwd: dir, plugin: "1password" });
    assertEquals(result.markerStatuses, [{ path: "CLAUDE.md", status: "updated" }]);
    const claude = await Deno.readTextFile(claudePath);
    assert(claude.includes("op read"), "generated content not restored");
    assert(!claude.includes("user edit"), "hand edit survived inside owned block");
    assert(claude.includes("machine-owned by akf"), "ownership note missing");
  });
});

Deno.test("plugin add crit creates config, Dockerfile block, and guidance", async () => {
  await withTmpDir(async (dir) => {
    const result = await addPluginToWorkspace({ cwd: dir, plugin: "crit" });
    assertEquals(result.pluginId, "crit");
    assertEquals(result.configChanged, true);

    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.plugins.crit.version, "v0.13.0");
    // Image/env/ports resolve at runtime from the plugins section (tasks/011).
    assertEquals(config.image, undefined);
    assertEquals(config.env, undefined);
    assertEquals(config.ports, undefined);

    const dockerfile = await Deno.readTextFile(join(dir, ".devcontainer/Dockerfile"));
    assert(dockerfile.includes("# >>> akf plugin: crit"));
    assert(dockerfile.includes("crit-linux-$CRIT_ARCH"));
    assert(dockerfile.includes("CRIT_VERSION=v0.13.0"));

    const claude = await Deno.readTextFile(join(dir, "CLAUDE.md"));
    assert(claude.includes("akf up -- crit install claude-code"));
    assert(result.setupSteps.some((s) => s.command.includes("crit install claude-code")));
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

Deno.test("plugin add crit overwrites an edited Dockerfile owned block", async () => {
  await withTmpDir(async (dir) => {
    await addPluginToWorkspace({ cwd: dir, plugin: "crit" });
    const dockerfilePath = join(dir, ".devcontainer/Dockerfile");
    const dockerfile = await Deno.readTextFile(dockerfilePath);
    await Deno.writeTextFile(dockerfilePath, dockerfile.replace("crit --version", "echo edited"));
    const result = await addPluginToWorkspace({ cwd: dir, plugin: "crit" });
    assertEquals(result.markerStatuses[0], { path: ".devcontainer/Dockerfile", status: "updated" });
    const restored = await Deno.readTextFile(dockerfilePath);
    assert(restored.includes("crit --version"), "generated content not restored");
    assert(!restored.includes("echo edited"), "hand edit survived inside owned block");
  });
});

Deno.test("plugin sync re-renders the Dockerfile block after a config edit (sha bump)", async () => {
  await withTmpDir(async (dir) => {
    await addPluginToWorkspace({ cwd: dir, plugin: "telegram" });
    const configPath = join(dir, ".apfelkaefig.json");
    const newSha = "a".repeat(40);
    const config = JSON.parse(await Deno.readTextFile(configPath));
    config.plugins.telegram.sha = newSha;
    await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2));

    const code = await syncPluginBlocks({ cwd: dir });
    assertEquals(code, 0);
    const dockerfile = await Deno.readTextFile(join(dir, ".devcontainer/Dockerfile"));
    assert(
      dockerfile.includes(`TELEGRAM_CLI_SHA=${newSha}`),
      "sync did not propagate the bumped sha into the Dockerfile block",
    );
  });
});

Deno.test("plugin sync without a config errors cleanly", async () => {
  await withTmpDir(async (dir) => {
    assertEquals(await syncPluginBlocks({ cwd: dir }), 1);
  });
});

Deno.test("init --plugins 1password writes plugin config", async () => {
  await withTmpDir(async (dir) => {
    await runInit({ cwd: dir, plugins: ["1password"] });
    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.plugins["1password"].enabled, true);
    assertEquals(config.secrets, undefined);
  });
});

Deno.test("init --plugins crit writes plugin config", async () => {
  await withTmpDir(async (dir) => {
    await runInit({ cwd: dir, plugins: ["crit"] });
    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.plugins.crit.enabled, true);
    assertEquals(config.plugins.crit.port, 3247);
  });
});

Deno.test("plugin add telegram writes config, Dockerfile block, and volume mounts", async () => {
  await withTmpDir(async (dir) => {
    const result = await addPluginToWorkspace({ cwd: dir, plugin: "tg" });
    assertEquals(result.pluginId, "telegram");
    assertEquals(result.configChanged, true);

    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.plugins.telegram.enabled, true);
    assertEquals(config.plugins.telegram.storage, "instance");
    // Mounts and image resolve at runtime from the plugins section (tasks/011).
    assertEquals(config.image, undefined);
    assertEquals(config.mounts, undefined);

    const dockerfile = await Deno.readTextFile(join(dir, ".devcontainer/Dockerfile"));
    assert(dockerfile.includes("# >>> akf plugin: telegram"));
    assert(dockerfile.includes("https://github.com/gskril/telegram-cli.git"));
    assert(dockerfile.includes("npm install -g pnpm@"));
    // Apple container's named-volume mount overrides image-time ownership,
    // so the plugin shadows the CLI with a sudo-chown wrapper.
    assert(dockerfile.includes("/usr/local/bin/telegram-real"));
    assert(dockerfile.includes("akf-telegram-init.sh"));
    assert(dockerfile.includes("/etc/sudoers.d/akf-telegram"));

    const claude = await Deno.readTextFile(join(dir, "CLAUDE.md"));
    assert(claude.includes("telegram setup"));
    assert(result.setupSteps.some((s) => s.command === "akf up -- telegram setup"));
    assert(result.setupSteps.some((s) => s.command === "akf up -- telegram auth"));
    assert(result.postApplyMessages.some((m) => m.includes("storage='instance'")));
  });
});

Deno.test("plugin add telegram is idempotent", async () => {
  await withTmpDir(async (dir) => {
    await addPluginToWorkspace({ cwd: dir, plugin: "telegram" });
    const second = await addPluginToWorkspace({ cwd: dir, plugin: "telegram" });
    assertEquals(second.configChanged, false);
    assertEquals(second.markerStatuses, [
      { path: ".devcontainer/Dockerfile", status: "skipped-present" },
      { path: "CLAUDE.md", status: "skipped-present" },
    ]);
  });
});

Deno.test("plugin add telegram with userIsolation renders sudo wrapper block", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".apfelkaefig.json"),
      JSON.stringify({
        version: 1,
        plugins: {
          telegram: {
            enabled: true,
            repo: "https://github.com/gskril/telegram-cli.git",
            sha: "95612b198c449f3768756f7e5ecd075fe6330b07",
            storage: "instance",
            userIsolation: true,
          },
        },
      }),
    );
    await addPluginToWorkspace({ cwd: dir, plugin: "telegram" });
    const dockerfile = await Deno.readTextFile(join(dir, ".devcontainer/Dockerfile"));
    assert(dockerfile.includes("useradd -r -m -d /home/telegram"));
    assert(dockerfile.includes("sudo -u telegram"));
    assert(dockerfile.includes("/etc/sudoers.d/akf-telegram"));
    const config = JSON.parse(await Deno.readTextFile(join(dir, ".apfelkaefig.json")));
    assertEquals(config.mounts, undefined);
  });
});
