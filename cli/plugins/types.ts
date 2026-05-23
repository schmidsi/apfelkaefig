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

export interface PluginDoctorContext {
  config: ApfelkaefigConfig;
  workspaceDir: string;
}

export interface BuiltInPlugin {
  id: keyof PluginConfigMap;
  aliases: string[];
  description: string;
  defaultConfig: Record<string, unknown>;
  applyConfig: (base: ApfelkaefigConfig, config: Record<string, unknown>) => ApfelkaefigConfig;
  markerBlocks: (config: Record<string, unknown>) => MarkerBlock[];
  dockerfileBlocks?: (config: Record<string, unknown>) => MarkerBlock[];
  doctorChecks?: (
    resolved: PluginDoctorContext,
    config: Record<string, unknown>,
  ) => Promise<PluginDoctorCheck[]>;
  postApplyMessages?: (config: Record<string, unknown>) => string[];
}
