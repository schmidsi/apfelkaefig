// TypeScript types matching schema/v1.json. Source of truth is the JSON Schema;
// these types are hand-maintained — keep them in sync.

export const SCHEMA_VERSION = 1;
export const SCHEMA_URL = "https://apfelkaefig.com/schema/v1.json";

// Volume names follow Apple `container`'s convention — alphanumeric start,
// then alphanumerics plus `_`, `.`, `-`. Substitutions are rejected because
// volumes are referenced by literal name, not by interpolated path.
export const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

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

export interface SshPluginConfig {
  enabled: boolean;
  authorizedKey: string;
  port: number;
  hostKeyVolume?: string;
  [key: string]: unknown;
}

export interface PluginConfigMap {
  "1password"?: OnePasswordPluginConfig;
  "crit"?: CritPluginConfig;
  "telegram"?: TelegramPluginConfig;
  "ssh"?: SshPluginConfig;
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
  // When true, `akf up` runs the command inside a shared tmux session ("akf")
  // so a second `akf up` from another terminal attaches to the same running
  // container instead of starting a new one. Default: false.
  tmux?: boolean;
  secrets?: SecretsConfig;
  ports?: PortConfig[];
  plugins?: PluginConfigMap;
  // Overrides the host source path of the ~/.claude mount. Supports `~` and
  // ${localEnv:VAR} substitutions. Default: `${HOME}/.claude`.
  claudeConfigDir?: string;
}

// Defaults applied when a field is unset in the resolved config.
export const DEFAULTS = {
  user: "node",
  // workspaceFolder default uses ${localWorkspaceFolderBasename} substitution.
  workspaceFolder: "/workspaces/${localWorkspaceFolderBasename}",
  command: ["claude", "--dangerously-skip-permissions"] as string[],
  resources: { cpus: 2, memory: "4G" } as Required<ResourcesConfig>,
  tmux: false,
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
  "tmux",
  "secrets",
  "ports",
  "plugins",
  "claudeConfigDir",
]);
