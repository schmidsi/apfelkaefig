import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  parsePluginList,
  PluginError,
  pluginMarkerBlocks,
  resolvePluginId,
  withPlugin,
} from "./plugins.ts";

const CTX = { workspaceDir: "/tmp/webapp" };

Deno.test("resolvePluginId canonicalizes 1Password aliases", () => {
  assertEquals(resolvePluginId("1password"), "1password");
  assertEquals(resolvePluginId("1pw"), "1password");
  assertEquals(resolvePluginId("op"), "1password");
});

Deno.test("resolvePluginId canonicalizes telegram alias", () => {
  assertEquals(resolvePluginId("telegram"), "telegram");
  assertEquals(resolvePluginId("tg"), "telegram");
});

Deno.test("parsePluginList rejects duplicate canonical ids", () => {
  assertThrows(
    () => parsePluginList("1password,op"),
    PluginError,
    "duplicate plugin '1password'",
  );
});

Deno.test("withPlugin enables 1Password config and secrets", () => {
  const config = withPlugin({ version: 1 }, "1password", CTX);
  assertEquals(config.plugins?.["1password"], { enabled: true });
  assertEquals(config.secrets?.onepassword, true);
});

Deno.test("withPlugin preserves unrelated config", () => {
  const config = withPlugin(
    {
      version: 1,
      env: { TZ: "UTC" },
      secrets: { onepassword: false },
    },
    "1password",
    CTX,
  );
  assertEquals(config.env, { TZ: "UTC" });
  assertEquals(config.secrets?.onepassword, true);
});

Deno.test("withPlugin enables Crit config, image, and port", () => {
  const config = withPlugin({ version: 1 }, "crit", CTX);
  assertEquals(config.plugins?.crit, {
    enabled: true,
    agentIntegration: "claude-code",
    installMethod: "pinned-release",
    version: "v0.13.0",
    port: 3247,
  });
  assertEquals(config.image, { dockerfile: ".devcontainer/Dockerfile" });
  assertEquals(config.env, {
    CRIT_HOST: "0.0.0.0",
    CRIT_PORT: "3247",
  });
  assertEquals(config.ports, [{
    hostIp: "127.0.0.1",
    host: 3247,
    container: 3247,
    protocol: "tcp",
  }]);
});

Deno.test("pluginMarkerBlocks returns 1Password guidance block", () => {
  const config = withPlugin({ version: 1 }, "1password", CTX);
  const blocks = pluginMarkerBlocks(config);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].path, "CLAUDE.md");
  assertEquals(blocks[0].startMarker, "<!-- akf plugin: 1password start -->");
});

Deno.test("pluginMarkerBlocks returns Crit guidance block", () => {
  const config = withPlugin({ version: 1 }, "crit", CTX);
  const blocks = pluginMarkerBlocks(config);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].path, "CLAUDE.md");
  assertEquals(blocks[0].startMarker, "<!-- akf plugin: crit start -->");
});

Deno.test("withPlugin telegram defaults to instance storage with derived volumes", () => {
  const config = withPlugin({ version: 1 }, "telegram", CTX);
  const tg = config.plugins?.telegram!;
  assertEquals(tg.storage, "instance");
  assertEquals(tg.userIsolation, false);
  assertEquals(tg.repo, "https://github.com/gskril/telegram-cli.git");
  assert(/^[a-f0-9]{40}$/.test(tg.sha), "sha is 40-char hex");
  assertEquals(config.image, { dockerfile: ".devcontainer/Dockerfile" });

  const mounts = config.mounts ?? [];
  assertEquals(mounts.length, 2);
  assertEquals(mounts[0].type, "volume");
  assertEquals(mounts[0].target, "/home/node/.config/telegram-cli");
  assert(mounts[0].source.startsWith("tg-webapp-"), `expected tg-webapp-… got ${mounts[0].source}`);
  assertEquals(mounts[1].type, "volume");
  assertEquals(mounts[1].target, "/home/node/.local/state/telegram-cli");
});

Deno.test("withPlugin telegram instance mode hashes the absolute path", () => {
  const a = withPlugin({ version: 1 }, "telegram", { workspaceDir: "/tmp/a/webapp" });
  const b = withPlugin({ version: 1 }, "telegram", { workspaceDir: "/tmp/b/webapp" });
  // Same basename, different parent → different volume names so clones don't share.
  assert(a.mounts![0].source !== b.mounts![0].source, "instance mode must differ across paths");
});

Deno.test("withPlugin telegram named mode uses stable basename-derived names", () => {
  const config = withPlugin(
    { version: 1, plugins: { telegram: { enabled: true, storage: "named" } } } as never,
    "telegram",
    CTX,
  );
  assertEquals(config.mounts?.[0].source, "tg-webapp-config");
  assertEquals(config.mounts?.[1].source, "tg-webapp-state");
});

Deno.test("withPlugin telegram host mode renders bind mounts to /home/node", () => {
  const config = withPlugin(
    { version: 1, plugins: { telegram: { enabled: true, storage: "host" } } } as never,
    "telegram",
    CTX,
  );
  assertEquals(config.mounts?.[0], {
    type: "bind",
    source: "${localEnv:HOME}/.config/telegram-cli",
    target: "/home/node/.config/telegram-cli",
  });
  assertEquals(config.mounts?.[1].type, "bind");
});

Deno.test("withPlugin telegram userIsolation retargets mounts to /home/telegram", () => {
  const config = withPlugin(
    { version: 1, plugins: { telegram: { enabled: true, userIsolation: true } } } as never,
    "telegram",
    CTX,
  );
  assertEquals(config.mounts?.[0].target, "/home/telegram/.config/telegram-cli");
  assertEquals(config.mounts?.[1].target, "/home/telegram/.local/state/telegram-cli");
});

Deno.test("withPlugin telegram preserves unrelated mounts and is idempotent", () => {
  const base = {
    version: 1 as const,
    mounts: [{ source: "/host/src", target: "/x" }],
  };
  const once = withPlugin(base, "telegram", CTX);
  const twice = withPlugin(once, "telegram", CTX);
  assertEquals(twice.mounts?.length, 3);
  assertEquals(twice.mounts?.[0], { source: "/host/src", target: "/x" });
});
