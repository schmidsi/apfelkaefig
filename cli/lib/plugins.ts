import { type ApfelkaefigConfig, type PluginConfigMap, SCHEMA_URL } from "./schema.ts";
import {
  type BuiltInPlugin,
  type MarkerBlock,
  type PluginContext,
  type PluginDoctorCheck,
  type PreRunResult,
  type RunContext,
  type SetupStep,
} from "../plugins/types.ts";
import { onePasswordPlugin } from "../plugins/1password/plugin.ts";
import { critPlugin } from "../plugins/crit/plugin.ts";
import { sshPlugin } from "../plugins/ssh/plugin.ts";
import { telegramPlugin } from "../plugins/telegram/plugin.ts";

export type {
  BuiltInPlugin,
  MarkerBlock,
  PluginContext,
  PluginDoctorCheck,
  PreRunResult,
  RunContext,
  SetupStep,
};

export type PluginId = keyof PluginConfigMap;

const REGISTRY: Record<PluginId, BuiltInPlugin> = {
  "1password": onePasswordPlugin,
  "crit": critPlugin,
  "telegram": telegramPlugin,
  "ssh": sshPlugin,
};

const ALIASES = new Map<string, PluginId>();
for (const plugin of Object.values(REGISTRY)) {
  ALIASES.set(plugin.id, plugin.id as PluginId);
  for (const alias of plugin.aliases) ALIASES.set(alias, plugin.id as PluginId);
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
  ctx: PluginContext,
): ApfelkaefigConfig {
  const plugin = getPlugin(id);
  const existing = config.plugins?.[id] as Record<string, unknown> | undefined;
  const defaults = typeof plugin.defaultConfig === "function"
    ? plugin.defaultConfig(ctx)
    : plugin.defaultConfig;
  const pluginConfig = { ...defaults, ...(existing ?? {}), enabled: true };
  // Only the plugins section is written. The plugin's config effects (mounts,
  // ports, env, image) are applied at resolve time by applyPluginTransforms —
  // never materialized into .apfelkaefig.json (tasks/011).
  return {
    $schema: config.$schema ?? SCHEMA_URL,
    ...config,
    plugins: {
      ...(config.plugins ?? {}),
      [id]: pluginConfig,
    },
  };
}

// Apply enabled plugins' config transforms (mounts, ports, env, image) to an
// in-memory config, in config-file order. Runs on EVERY resolve; the result
// feeds `container run` args and is never written back to disk.
export function applyPluginTransforms(
  config: ApfelkaefigConfig,
  ctx: PluginContext,
): ApfelkaefigConfig {
  let out = config;
  for (const [id, pluginConfig] of Object.entries(config.plugins ?? {})) {
    if (!pluginConfig?.enabled) continue;
    const plugin = getPlugin(id as PluginId);
    out = plugin.transformConfig?.(out, pluginConfig as Record<string, unknown>, ctx) ?? out;
  }
  return out;
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

export function pluginSetupSteps(config: ApfelkaefigConfig): SetupStep[] {
  const steps: SetupStep[] = [];
  for (const [id, pluginConfig] of Object.entries(config.plugins ?? {})) {
    if (!pluginConfig?.enabled) continue;
    const plugin = getPlugin(id as PluginId);
    steps.push(...(plugin.setupSteps?.(pluginConfig as Record<string, unknown>) ?? []));
  }
  return steps;
}
