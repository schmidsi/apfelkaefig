// Regenerate the per-plugin sections of schema/v1.json from each plugin's
// configSchema fragment (tasks/011, decision 9). The rest of the schema stays
// hand-maintained; only properties.plugins.properties is build output. The
// golden test in cli/lib/plugins_test.ts fails when a fragment changed
// without rerunning this.
//
// Usage: deno task gen-schema

import { listPlugins } from "../cli/lib/plugins.ts";

const SCHEMA_PATH = new URL("../schema/v1.json", import.meta.url);

const schema = JSON.parse(await Deno.readTextFile(SCHEMA_PATH));
const fragments: Record<string, unknown> = {};
for (const plugin of listPlugins()) {
  if (!plugin.configSchema) {
    console.error(`gen-schema: plugin '${plugin.id}' has no configSchema fragment`);
    Deno.exit(1);
  }
  fragments[plugin.id] = plugin.configSchema;
}

const before = JSON.stringify(schema.properties.plugins.properties);
schema.properties.plugins.properties = fragments;
const out = `${JSON.stringify(schema, null, 2)}\n`;

await Deno.writeTextFile(SCHEMA_PATH, out);
console.log(
  before === JSON.stringify(fragments)
    ? "schema/v1.json plugin sections unchanged"
    : "schema/v1.json plugin sections regenerated",
);
