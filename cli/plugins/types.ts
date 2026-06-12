import type { ApfelkaefigConfig, PluginConfigMap } from "../lib/schema.ts";

export type PluginCheckSeverity = "ok" | "warn" | "fail" | "info";

export interface PluginDoctorCheck {
  label: string;
  severity: PluginCheckSeverity;
  detail?: string;
}

export interface MarkerBlock {
  path: string;
  startMarker: string;
  endMarker: string;
  contents: string;
}

export interface PluginContext {
  workspaceDir: string;
}

export interface SetupStep {
  command: string;
  description: string;
}

export interface PluginDoctorContext {
  config: ApfelkaefigConfig;
  workspaceDir: string;
}

export interface BuiltInPlugin {
  id: keyof PluginConfigMap;
  aliases: string[];
  description: string;
  // Validate this plugin's raw config object from .apfelkaefig.json. Throw a
  // plain Error with the user-facing message; the config layer wraps it in a
  // ConfigError carrying the source path. (Plugins can't throw ConfigError
  // directly — importing it from config.ts would create an import cycle.)
  validateConfig?: (config: Record<string, unknown>) => void;
  defaultConfig:
    | Record<string, unknown>
    | ((ctx: PluginContext) => Record<string, unknown>);
  applyConfig: (
    base: ApfelkaefigConfig,
    config: Record<string, unknown>,
    ctx: PluginContext,
  ) => ApfelkaefigConfig;
  markerBlocks: (config: Record<string, unknown>) => MarkerBlock[];
  dockerfileBlocks?: (config: Record<string, unknown>) => MarkerBlock[];
  doctorChecks?: (
    resolved: PluginDoctorContext,
    config: Record<string, unknown>,
  ) => Promise<PluginDoctorCheck[]>;
  // Interactive bootstrap commands the user must run once after the image
  // builds. Surfaced as numbered next-steps in `akf init` / `akf plugin add`.
  setupSteps?: (config: Record<string, unknown>) => SetupStep[];
  // Informational notes (storage mode explanations, etc). Pure prose, not commands.
  postApplyMessages?: (config: Record<string, unknown>) => string[];
}
