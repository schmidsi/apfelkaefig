import { type ApfelkaefigConfig, type PluginConfigMap, SCHEMA_URL } from "./schema.ts";

export type PluginId = keyof PluginConfigMap;

export interface MarkerBlock {
  path: string;
  startMarker: string;
  endMarker: string;
  contents: string;
}

export interface BuiltInPlugin {
  id: PluginId;
  aliases: string[];
  description: string;
  defaultConfig: Record<string, unknown>;
  applyConfig: (base: ApfelkaefigConfig, config: Record<string, unknown>) => ApfelkaefigConfig;
  markerBlocks: (config: Record<string, unknown>) => MarkerBlock[];
}

const ONEPASSWORD_GUIDANCE = `## 1Password inside the sandbox

This project enables the akf 1Password plugin. The sandbox receives only
\`OP_SERVICE_ACCOUNT_TOKEN\`; resolve secrets on demand inside the sandbox with
\`op read\` instead of writing raw secret values to the repo or config.`;

const ONEPASSWORD_PLUGIN: BuiltInPlugin = {
  id: "1password",
  aliases: ["1pw", "op"],
  description: "Forward OP_SERVICE_ACCOUNT_TOKEN and document op read usage inside the sandbox.",
  defaultConfig: { enabled: true },
  applyConfig(base, config) {
    if (!config.enabled) return base;
    return {
      ...base,
      secrets: {
        ...(base.secrets ?? {}),
        onepassword: true,
      },
    };
  },
  markerBlocks(_config) {
    return [{
      path: "CLAUDE.md",
      startMarker: "<!-- akf plugin: 1password start -->",
      endMarker: "<!-- akf plugin: 1password end -->",
      contents: ONEPASSWORD_GUIDANCE,
    }];
  },
};

const REGISTRY: Record<PluginId, BuiltInPlugin> = {
  "1password": ONEPASSWORD_PLUGIN,
};

const ALIASES = new Map<string, PluginId>();
for (const plugin of Object.values(REGISTRY)) {
  ALIASES.set(plugin.id, plugin.id);
  for (const alias of plugin.aliases) ALIASES.set(alias, plugin.id);
}

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

export function listPlugins(): BuiltInPlugin[] {
  return Object.values(REGISTRY);
}

export function getPlugin(id: PluginId): BuiltInPlugin {
  return REGISTRY[id];
}

export function resolvePluginId(id: string): PluginId {
  const canonical = ALIASES.get(id.trim().toLowerCase());
  if (!canonical) {
    throw new PluginError(
      `unknown plugin '${id}'. Supported plugins: ${listPlugins().map((p) => p.id).join(", ")}`,
    );
  }
  return canonical;
}

export function parsePluginList(input: string): PluginId[] {
  const raw = input.split(",").map((p) => p.trim());
  if (raw.some((p) => p.length === 0)) {
    throw new PluginError("plugin list contains an empty entry");
  }
  const out: PluginId[] = [];
  const seen = new Set<PluginId>();
  for (const id of raw) {
    const canonical = resolvePluginId(id);
    if (seen.has(canonical)) {
      throw new PluginError(`duplicate plugin '${canonical}'`);
    }
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

export function withPlugin(
  config: ApfelkaefigConfig,
  id: PluginId,
): ApfelkaefigConfig {
  const plugin = getPlugin(id);
  const existing = config.plugins?.[id] as Record<string, unknown> | undefined;
  const pluginConfig = { ...plugin.defaultConfig, ...(existing ?? {}), enabled: true };
  const next: ApfelkaefigConfig = {
    $schema: config.$schema ?? SCHEMA_URL,
    ...config,
    plugins: {
      ...(config.plugins ?? {}),
      [id]: pluginConfig,
    },
  };
  return plugin.applyConfig(next, pluginConfig);
}

export function pluginMarkerBlocks(config: ApfelkaefigConfig): MarkerBlock[] {
  const blocks: MarkerBlock[] = [];
  for (const [id, pluginConfig] of Object.entries(config.plugins ?? {})) {
    if (!pluginConfig?.enabled) continue;
    const plugin = getPlugin(id as PluginId);
    blocks.push(...plugin.markerBlocks(pluginConfig as Record<string, unknown>));
  }
  return blocks;
}
