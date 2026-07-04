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

// How a preRun hook reshapes the `container run` invocation. Exclusive: two
// plugins returning overrides in one run is a plugin-author error.
export interface RunOverrides {
  // Replace the in-container command wholesale. A replacement also suppresses
  // all wrapCommand hooks (replacement beats wrapping — e.g. --serve's sshd
  // must not be tmux-wrapped).
  command?: string[];
  // Run as this user (`-u`).
  user?: string;
  // Force TTY allocation on/off.
  tty?: boolean;
  // On Ctrl+C, stop the container by its claimed name instead of signalling
  // the child — Apple `container`'s non-TTY signal relay drops SIGINT.
  stopByNameOnInterrupt?: boolean;
}

export type PreRunResult =
  | { action: "continue"; overrides?: RunOverrides }
  | { action: "exit"; code: number }
  // Hand the terminal over to `container <args>` instead of `container run`.
  | { action: "attach"; args: string[] };

export interface BuiltInPlugin {
  // Canonical id. Public plugins use their `plugins.{id}` config key; internal
  // plugins (enabled by core sugar, not by a config section) any unique name.
  id: string;
  aliases: string[];
  description: string;
  // JSON Schema fragment for this plugin's `plugins.{id}` config section.
  // `deno task gen-schema` assembles schema/v1.json from these; a golden test
  // fails when a fragment changed without regenerating. Required for public
  // (registry) plugins; internal plugins have no config section.
  configSchema?: Record<string, unknown>;
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
  // Exclusive: stable container name for this run, or undefined to make no
  // claim under the current ctx (e.g. ssh claims only in --serve mode). Two
  // non-undefined claims in one run → hard error.
  containerName?: (ctx: RunContext) => string | undefined;
}
