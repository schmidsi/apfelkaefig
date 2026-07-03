import type { ApfelkaefigConfig } from "../lib/schema.ts";
// Type-only import — erased at compile time, so no runtime cycle with
// container.ts (which imports config.ts → plugins.ts → this file).
import type { Runner } from "../lib/container.ts";

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

// Context handed to run-lifecycle hooks by `akf up` (tasks/011).
export interface RunContext {
  // Resolved config with all plugin transforms already applied.
  config: ApfelkaefigConfig;
  workspaceDir: string;
  // The in-container command (CLI positionals or the config default).
  command: string[];
  // This run's plugin-declared flags, parsed from `akf up`.
  flags: Record<string, boolean>;
  run: Runner;
}

export type PreRunResult =
  | { action: "continue" }
  | { action: "exit"; code: number }
  // Hand the terminal over to `container <args>` instead of `container run`.
  | { action: "attach"; args: string[] };

export interface BuiltInPlugin {
  // Canonical id. Public plugins use their `plugins.{id}` config key; internal
  // plugins (enabled by core sugar, not by a config section) any unique name.
  id: string;
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
  // Apply this plugin's config effects (mounts, ports, env, image) to an
  // in-memory config. Runs at resolve time on EVERY invocation; the result is
  // used for `container run` args and never written to .apfelkaefig.json.
  transformConfig?: (
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

  // --- run-lifecycle hooks (tasks/011) ---

  // Boolean `akf up` flags this plugin owns. Plugins are compiled in, so a
  // collision with core flags or another plugin is a developer error — caught
  // at registry construction and pinned by a unit test.
  flags?: string[];
  // Validation, banners, attach-vs-run branches, orphan cleanup. Runs before
  // image resolution, in config-file order.
  preRun?: (ctx: RunContext) => Promise<PreRunResult>;
  // Env injected into the container at run time (secrets, keys). Never
  // persisted anywhere; merged across plugins in config-file order.
  runtimeEnv?: (ctx: RunContext) => Promise<Record<string, string>>;
  // Compose-wrap the in-container command. Applied in config-file order.
  wrapCommand?: (command: string[], ctx: RunContext) => string[];
  // Exclusive: stable container name for this run. Two claimants → hard error.
  containerName?: (ctx: RunContext) => string;
}
