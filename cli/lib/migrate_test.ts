import { withTmpDir } from "./test_util.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { migrateMaterializedConfig } from "./migrate.ts";

const CRIT = {
  enabled: true,
  agentIntegration: "claude-code",
  installMethod: "pinned-release",
  version: "v0.13.0",
  port: 3247,
};

async function write(dir: string, config: unknown): Promise<string> {
  const path = join(dir, ".apfelkaefig.json");
  await Deno.writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

Deno.test("migrate: strips materialized crit env + ports, writes backup", async () => {
  await withTmpDir(async (dir) => {
    const configPath = await write(dir, {
      version: 1,
      env: { CRIT_HOST: "0.0.0.0", CRIT_PORT: "3247" },
      ports: [{ hostIp: "127.0.0.1", host: 3247, container: 3247, protocol: "tcp" }],
      plugins: { crit: CRIT },
    });
    const result = await migrateMaterializedConfig({ configPath, workspaceDir: dir });
    assert(result, "expected a migration");
    assertEquals(result.rewritten, true);
    assertEquals(
      result.removed.sort(),
      ["env.CRIT_HOST", "env.CRIT_PORT", "ports[3247]"],
    );
    const onDisk = JSON.parse(await Deno.readTextFile(configPath));
    assertEquals(onDisk.env, undefined);
    assertEquals(onDisk.ports, undefined);
    assertEquals(onDisk.plugins.crit.port, 3247);
    // Backup preserves the original.
    const backup = JSON.parse(await Deno.readTextFile(`${configPath}.bak`));
    assertEquals(backup.ports.length, 1);
  });
});

Deno.test("migrate: keeps user entries, removes only derived ones", async () => {
  await withTmpDir(async (dir) => {
    const configPath = await write(dir, {
      version: 1,
      env: { CRIT_HOST: "0.0.0.0", CRIT_PORT: "3247", TZ: "UTC" },
      ports: [
        { hostIp: "127.0.0.1", host: 3247, container: 3247, protocol: "tcp" },
        { host: 8080, container: 80 },
      ],
      mounts: [{ source: "/host/data", target: "/data" }],
      plugins: { crit: CRIT },
    });
    const result = await migrateMaterializedConfig({ configPath, workspaceDir: dir });
    assert(result);
    const onDisk = JSON.parse(await Deno.readTextFile(configPath));
    assertEquals(onDisk.env, { TZ: "UTC" });
    assertEquals(onDisk.ports, [{ host: 8080, container: 80 }]);
    assertEquals(onDisk.mounts, [{ source: "/host/data", target: "/data" }]);
  });
});

Deno.test("migrate: strips derived secrets.onepassword, keeps explicit opt-out", async () => {
  await withTmpDir(async (dir) => {
    const configPath = await write(dir, {
      version: 1,
      secrets: { onepassword: true },
      plugins: { "1password": { enabled: true } },
    });
    const result = await migrateMaterializedConfig({ configPath, workspaceDir: dir });
    assert(result);
    assertEquals(result.removed, ["secrets.onepassword"]);
    const onDisk = JSON.parse(await Deno.readTextFile(configPath));
    assertEquals(onDisk.secrets, undefined);

    // Explicit opt-out never matches the derived value.
    const optOut = await write(dir, {
      version: 1,
      secrets: { onepassword: false },
      plugins: { "1password": { enabled: true } },
    });
    assertEquals(await migrateMaterializedConfig({ configPath: optOut, workspaceDir: dir }), null);
  });
});

Deno.test("migrate: JSONC configs are reported, never rewritten", async () => {
  await withTmpDir(async (dir) => {
    const configPath = join(dir, ".apfelkaefig.json");
    const text = `{
  // my carefully written comment
  "version": 1,
  "ports": [{ "hostIp": "127.0.0.1", "host": 3247, "container": 3247, "protocol": "tcp" }],
  "plugins": { "crit": ${JSON.stringify(CRIT)} }
}
`;
    await Deno.writeTextFile(configPath, text);
    const result = await migrateMaterializedConfig({ configPath, workspaceDir: dir });
    assert(result);
    assertEquals(result.rewritten, false);
    assertEquals(result.removed, ["ports[3247]"]);
    // Untouched, comment intact.
    assertEquals(await Deno.readTextFile(configPath), text);
  });
});

Deno.test("migrate: clean config is a no-op", async () => {
  await withTmpDir(async (dir) => {
    const configPath = await write(dir, { version: 1, plugins: { crit: CRIT } });
    assertEquals(await migrateMaterializedConfig({ configPath, workspaceDir: dir }), null);
    // No backup file appears on a no-op.
    let backupExists = true;
    try {
      await Deno.lstat(`${configPath}.bak`);
    } catch {
      backupExists = false;
    }
    assertEquals(backupExists, false);
  });
});

Deno.test("migrate: config without plugins is a no-op", async () => {
  await withTmpDir(async (dir) => {
    const configPath = await write(dir, {
      version: 1,
      ports: [{ host: 8080, container: 80 }],
    });
    assertEquals(await migrateMaterializedConfig({ configPath, workspaceDir: dir }), null);
  });
});
