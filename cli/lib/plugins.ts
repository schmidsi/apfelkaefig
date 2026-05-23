import { type ApfelkaefigConfig, type PluginConfigMap, SCHEMA_URL } from "./schema.ts";
import { type BuiltInPlugin, type MarkerBlock, type PluginDoctorCheck } from "../plugins/types.ts";
import { onePasswordPlugin } from "../plugins/1password/plugin.ts";
import { critPlugin } from "../plugins/crit/plugin.ts";

export type { BuiltInPlugin, MarkerBlock, PluginDoctorCheck };

export type PluginId = keyof PluginConfigMap;

const REGISTRY: Record<PluginId, BuiltInPlugin> = {
  "1password": onePasswordPlugin,
  "crit": critPlugin,
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

export function pluginDockerfileBlocks(config: ApfelkaefigConfig): MarkerBlock[] {
  const blocks: MarkerBlock[] = [];
  for (const [id, pluginConfig] of Object.entries(config.plugins ?? {})) {
    if (!pluginConfig?.enabled) continue;
    const plugin = getPlugin(id as PluginId);
    blocks.push(...(plugin.dockerfileBlocks?.(pluginConfig as Record<string, unknown>) ?? []));
  }
  return blocks;
}

export async function pluginDoctorChecks(
  resolved: { config: ApfelkaefigConfig; workspaceDir: string },
): Promise<PluginDoctorCheck[]> {
  const checks: PluginDoctorCheck[] = [];
  for (const [id, pluginConfig] of Object.entries(resolved.config.plugins ?? {})) {
    if (!pluginConfig?.enabled) continue;
    const plugin = getPlugin(id as PluginId);
    checks.push(
      ...(await plugin.doctorChecks?.(resolved, pluginConfig as Record<string, unknown>) ?? []),
    );
  }
  return checks;
}

export function pluginPostApplyMessages(config: ApfelkaefigConfig): string[] {
  const messages: string[] = [];
  for (const [id, pluginConfig] of Object.entries(config.plugins ?? {})) {
    if (!pluginConfig?.enabled) continue;
    const plugin = getPlugin(id as PluginId);
    messages.push(...(plugin.postApplyMessages?.(pluginConfig as Record<string, unknown>) ?? []));
  }
  return messages;
}
