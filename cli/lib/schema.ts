// TypeScript types matching schema/v1.json. Source of truth is the JSON Schema;
// these types are hand-maintained — keep them in sync.

export const SCHEMA_VERSION = 1;
export const SCHEMA_URL = "https://apfelkaefig.com/schema/v1.json";

export interface MountConfig {
  type?: "bind" | "volume";
  source: string;
  target: string;
  readonly?: boolean;
}

export interface ResourcesConfig {
  cpus?: number;
  memory?: string;
}

export interface SecretsConfig {
  onepassword?: boolean;
}

export interface PortConfig {
  hostIp?: string;
  host: number;
  container: number;
  protocol?: "tcp" | "udp";
}

export interface OnePasswordPluginConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface CritPluginConfig {
  enabled: boolean;
  agentIntegration: "claude-code";
  installMethod: "pinned-release";
  version: string;
  port: number;
  [key: string]: unknown;
}

export type TelegramStorage = "instance" | "named" | "host";

export interface TelegramPluginConfig {
  enabled: boolean;
  repo: string;
  sha: string;
  storage: TelegramStorage;
  userIsolation: boolean;
  configVolume?: string;
  stateVolume?: string;
  [key: string]: unknown;
}

export interface PluginConfigMap {
  "1password"?: OnePasswordPluginConfig;
  "crit"?: CritPluginConfig;
  "telegram"?: TelegramPluginConfig;
}

export type ImageConfig =
  | string
  | { dockerfile: string };

export interface ApfelkaefigConfig {
  $schema?: string;
  version: 1;
  image?: ImageConfig;
  mounts?: MountConfig[];
  env?: Record<string, string>;
  user?: string;
  workspaceFolder?: string;
  resources?: ResourcesConfig;
  command?: string | string[];
  secrets?: SecretsConfig;
  ports?: PortConfig[];
  plugins?: PluginConfigMap;
}

// Defaults applied when a field is unset in the resolved config.
export const DEFAULTS = {
  user: "node",
  // workspaceFolder default uses ${localWorkspaceFolderBasename} substitution.
  workspaceFolder: "/workspaces/${localWorkspaceFolderBasename}",
  command: ["claude", "--dangerously-skip-permissions"] as string[],
  resources: { cpus: 2, memory: "4G" } as Required<ResourcesConfig>,
} as const;

// Allowed top-level keys — used by the validator to reject typos.
export const ALLOWED_TOP_LEVEL_KEYS = new Set<string>([
  "$schema",
  "version",
  "image",
  "mounts",
  "env",
  "user",
  "workspaceFolder",
  "resources",
  "command",
  "secrets",
  "ports",
  "plugins",
]);
