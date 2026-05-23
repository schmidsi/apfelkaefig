import { assertEquals, assertThrows } from "@std/assert";
import {
  parsePluginList,
  PluginError,
  pluginMarkerBlocks,
  resolvePluginId,
  withPlugin,
} from "./plugins.ts";

Deno.test("resolvePluginId canonicalizes 1Password aliases", () => {
  assertEquals(resolvePluginId("1password"), "1password");
  assertEquals(resolvePluginId("1pw"), "1password");
  assertEquals(resolvePluginId("op"), "1password");
});

Deno.test("parsePluginList rejects duplicate canonical ids", () => {
  assertThrows(
    () => parsePluginList("1password,op"),
    PluginError,
    "duplicate plugin '1password'",
  );
});

Deno.test("withPlugin enables 1Password config and secrets", () => {
  const config = withPlugin({ version: 1 }, "1password");
  assertEquals(config.plugins?.["1password"], { enabled: true });
  assertEquals(config.secrets?.onepassword, true);
});

Deno.test("withPlugin preserves unrelated config", () => {
  const config = withPlugin({
    version: 1,
    env: { TZ: "UTC" },
    secrets: { onepassword: false },
  }, "1password");
  assertEquals(config.env, { TZ: "UTC" });
  assertEquals(config.secrets?.onepassword, true);
});

Deno.test("withPlugin enables Crit config, image, and port", () => {
  const config = withPlugin({ version: 1 }, "crit");
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
  const config = withPlugin({ version: 1 }, "1password");
  const blocks = pluginMarkerBlocks(config);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].path, "CLAUDE.md");
  assertEquals(blocks[0].startMarker, "<!-- akf plugin: 1password start -->");
});

Deno.test("pluginMarkerBlocks returns Crit guidance block", () => {
  const config = withPlugin({ version: 1 }, "crit");
  const blocks = pluginMarkerBlocks(config);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].path, "CLAUDE.md");
  assertEquals(blocks[0].startMarker, "<!-- akf plugin: crit start -->");
});
