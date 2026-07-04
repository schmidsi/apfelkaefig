import { assert, assertEquals, assertThrows } from "@std/assert";
import { allUpPluginFlags, assertFlagUniqueness } from "./flags.ts";
import {
  applyPluginTransforms,
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

// --- withPlugin: writes ONLY the plugins section (tasks/011) ---

Deno.test("withPlugin 1password writes only the plugins section", () => {
  const config = withPlugin({ version: 1 }, "1password", CTX);
  assertEquals(config.plugins?.["1password"], { enabled: true });
  // Config effects are resolve-time, never materialized.
  assertEquals(config.secrets, undefined);
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
  // Untouched: transforms happen at resolve time, not at add time.
  assertEquals(config.secrets?.onepassword, false);
});

Deno.test("withPlugin crit writes defaults but no image/env/ports", () => {
  const config = withPlugin({ version: 1 }, "crit", CTX);
  assertEquals(config.plugins?.crit, {
    enabled: true,
    agentIntegration: "claude-code",
    installMethod: "pinned-release",
    version: "v0.13.0",
    port: 3247,
  });
  assertEquals(config.image, undefined);
  assertEquals(config.env, undefined);
  assertEquals(config.ports, undefined);
});

Deno.test("withPlugin telegram writes defaults but no mounts", () => {
  const config = withPlugin({ version: 1 }, "telegram", CTX);
  const tg = config.plugins?.telegram!;
  assertEquals(tg.storage, "instance");
  assertEquals(tg.userIsolation, false);
  assertEquals(tg.repo, "https://github.com/gskril/telegram-cli.git");
  assert(/^[a-f0-9]{40}$/.test(tg.sha as string), "sha is 40-char hex");
  assertEquals(config.image, undefined);
  assertEquals(config.mounts, undefined);
});

// --- applyPluginTransforms: resolve-time config effects ---

Deno.test("transforms: 1password enables secrets.onepassword", () => {
  const config = applyPluginTransforms(withPlugin({ version: 1 }, "1password", CTX), CTX);
  assertEquals(config.secrets?.onepassword, true);
});

Deno.test("transforms: crit adds image, env, and port", () => {
  const config = applyPluginTransforms(withPlugin({ version: 1 }, "crit", CTX), CTX);
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

Deno.test("transforms: telegram instance storage derives per-path volumes", () => {
  const config = applyPluginTransforms(withPlugin({ version: 1 }, "telegram", CTX), CTX);
  assertEquals(config.image, { dockerfile: ".devcontainer/Dockerfile" });
  const mounts = config.mounts ?? [];
  assertEquals(mounts.length, 2);
  assertEquals(mounts[0].type, "volume");
  assertEquals(mounts[0].target, "/home/node/.config/telegram-cli");
  assert(mounts[0].source.startsWith("tg-webapp-"), `expected tg-webapp-… got ${mounts[0].source}`);
  assertEquals(mounts[1].type, "volume");
  assertEquals(mounts[1].target, "/home/node/.local/state/telegram-cli");
});

Deno.test("transforms: telegram instance mode hashes the absolute path", () => {
  const ctxA = { workspaceDir: "/tmp/a/webapp" };
  const ctxB = { workspaceDir: "/tmp/b/webapp" };
  const a = applyPluginTransforms(withPlugin({ version: 1 }, "telegram", ctxA), ctxA);
  const b = applyPluginTransforms(withPlugin({ version: 1 }, "telegram", ctxB), ctxB);
  // Same basename, different parent → different volume names so clones don't share.
  assert(a.mounts![0].source !== b.mounts![0].source, "instance mode must differ across paths");
});

Deno.test("transforms: telegram named mode uses stable basename-derived names", () => {
  const config = applyPluginTransforms(
    withPlugin(
      { version: 1, plugins: { telegram: { enabled: true, storage: "named" } } } as never,
      "telegram",
      CTX,
    ),
    CTX,
  );
  assertEquals(config.mounts?.[0].source, "tg-webapp-config");
  assertEquals(config.mounts?.[1].source, "tg-webapp-state");
});

Deno.test("transforms: telegram host mode renders bind mounts to /home/node", () => {
  const config = applyPluginTransforms(
    withPlugin(
      { version: 1, plugins: { telegram: { enabled: true, storage: "host" } } } as never,
      "telegram",
      CTX,
    ),
    CTX,
  );
  assertEquals(config.mounts?.[0], {
    type: "bind",
    source: "${localEnv:HOME}/.config/telegram-cli",
    target: "/home/node/.config/telegram-cli",
  });
  assertEquals(config.mounts?.[1].type, "bind");
});

Deno.test("transforms: telegram userIsolation retargets mounts to /home/telegram", () => {
  const config = applyPluginTransforms(
    withPlugin(
      { version: 1, plugins: { telegram: { enabled: true, userIsolation: true } } } as never,
      "telegram",
      CTX,
    ),
    CTX,
  );
  assertEquals(config.mounts?.[0].target, "/home/telegram/.config/telegram-cli");
  assertEquals(config.mounts?.[1].target, "/home/telegram/.local/state/telegram-cli");
});

Deno.test("transforms: preserve unrelated mounts and are idempotent", () => {
  const base = withPlugin(
    {
      version: 1 as const,
      mounts: [{ source: "/host/src", target: "/x" }],
    },
    "telegram",
    CTX,
  );
  const once = applyPluginTransforms(base, CTX);
  // Re-applying (e.g. a config that still carries materialized leftovers from
  // the pre-011 model) must not duplicate mounts.
  const twice = applyPluginTransforms(once, CTX);
  assertEquals(twice.mounts?.length, 3);
  assertEquals(twice.mounts?.[0], { source: "/host/src", target: "/x" });
});

Deno.test("transforms: disabled plugin is a no-op", () => {
  const config = applyPluginTransforms(
    { version: 1, plugins: { "1password": { enabled: false } } },
    CTX,
  );
  assertEquals(config.secrets, undefined);
});

// --- marker blocks ---

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

// --- plugin-owned `akf up` flags (tasks/011, decision 6) ---

Deno.test("plugin flags: real registry has no collisions", () => {
  // Throws on duplicates — the same check runs at module load, so this test
  // pins the invariant explicitly.
  assertFlagUniqueness();
  const flags = allUpPluginFlags();
  assertEquals(new Set(flags).size, flags.length, "duplicate plugin flags");
});

Deno.test("plugin flags: collision with a core flag is a developer error", () => {
  assertThrows(
    () => assertFlagUniqueness([{ id: "evil", flags: ["rebuild"] }], ["rebuild"]),
    Error,
    "plugin 'evil' declares flag '--rebuild'",
  );
});

Deno.test("plugin flags: collision between two plugins is a developer error", () => {
  assertThrows(
    () =>
      assertFlagUniqueness(
        [{ id: "a", flags: ["foo"] }, { id: "b", flags: ["foo"] }],
        [],
      ),
    Error,
    "plugin 'b' declares flag '--foo'",
  );
});

// --- schema generation golden test (tasks/011, decision 9) ---

import schemaJson from "../../schema/v1.json" with { type: "json" };
import { listPlugins } from "./plugins.ts";

Deno.test("schema/v1.json plugin sections match the plugins' configSchema fragments", () => {
  const generated: Record<string, unknown> = {};
  for (const plugin of listPlugins()) {
    assert(plugin.configSchema, `plugin '${plugin.id}' has no configSchema fragment`);
    generated[plugin.id] = plugin.configSchema;
  }
  const inFile = (schemaJson as {
    properties: { plugins: { properties: Record<string, unknown> } };
  }).properties.plugins.properties;
  // Byte-level equality of the JSON encodings — when this fails, a plugin's
  // fragment changed without regenerating: run `deno task gen-schema`.
  assertEquals(
    JSON.parse(JSON.stringify(inFile)),
    JSON.parse(JSON.stringify(generated)),
    "schema/v1.json is stale — run `deno task gen-schema`",
  );
});
