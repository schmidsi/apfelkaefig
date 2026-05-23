import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { findConfig, parseConfig } from "../lib/config.ts";
import { upsertBlock, type UpsertStatus } from "../lib/fs.ts";
import {
  getPlugin,
  listPlugins,
  pluginDockerfileBlocks,
  type PluginId,
  pluginMarkerBlocks,
  pluginPostApplyMessages,
  resolvePluginId,
  withPlugin,
} from "../lib/plugins.ts";
import { type ApfelkaefigConfig, SCHEMA_URL, SCHEMA_VERSION } from "../lib/schema.ts";

export interface PluginAddResult {
  configPath: string;
  pluginId: PluginId;
  configChanged: boolean;
  markerStatuses: Array<{ path: string; status: UpsertStatus }>;
  postApplyMessages: string[];
}

const STATUS_LABELS: Record<UpsertStatus, string> = {
  "created": "created",
  "appended": "appended",
  "updated": "updated",
  "skipped-present": "skipped (already present)",
};

export async function runPluginCommand(
  { cwd, args }: { cwd: string; args: string[] },
): Promise<number> {
  const [action, pluginArg] = args;
  if (!action || action === "help" || action === "--help") {
    printPluginUsage();
    return action ? 0 : 2;
  }

  if (action === "list") {
    for (const plugin of listPlugins()) {
      console.log(`${plugin.id.padEnd(14)} ${plugin.description}`);
    }
    return 0;
  }

  if (action === "explain") {
    if (!pluginArg) {
      console.error("akf plugin explain: plugin id required");
      return 2;
    }
    const id = resolvePluginId(pluginArg);
    const plugin = getPlugin(id);
    console.log(`${plugin.id}: ${plugin.description}`);
    if (plugin.aliases.length > 0) {
      console.log(`aliases: ${plugin.aliases.join(", ")}`);
    }
    return 0;
  }

  if (action === "add") {
    if (!pluginArg) {
      console.error("akf plugin add: plugin id required");
      return 2;
    }
    const result = await addPluginToWorkspace({ cwd, plugin: pluginArg });
    printAddResult(result);
    return 0;
  }

  console.error(`akf plugin: unknown action '${action}'`);
  printPluginUsage();
  return 2;
}

export async function addPluginToWorkspace(
  { cwd, plugin }: { cwd: string; plugin: string },
): Promise<PluginAddResult> {
  const pluginId = resolvePluginId(plugin);
  const found = await findConfig(cwd);
  const workspaceDir = found.dir;
  const configPath = found.apfelkaefig ?? join(workspaceDir, ".apfelkaefig.json");
  const before = await readConfigIfPresent(configPath);
  const after = withPlugin(before ?? { $schema: SCHEMA_URL, version: SCHEMA_VERSION }, pluginId);

  const beforeText = before ? renderConfig(before) : null;
  const afterText = renderConfig(after);
  const configChanged = beforeText !== afterText;
  if (configChanged) {
    await ensureDir(workspaceDir);
    await Deno.writeTextFile(configPath, afterText);
  }

  const markerStatuses = [];
  await ensureDockerfileBaseIfNeeded(workspaceDir, after);
  for (const block of pluginDockerfileBlocks(after)) {
    const path = join(workspaceDir, block.path);
    const status = await upsertBlock(path, block.startMarker, block.endMarker, block.contents);
    markerStatuses.push({ path: block.path, status });
  }
  for (const block of pluginMarkerBlocks(after)) {
    const path = join(workspaceDir, block.path);
    const status = await upsertBlock(path, block.startMarker, block.endMarker, block.contents);
    markerStatuses.push({ path: block.path, status });
  }

  return {
    configPath,
    pluginId,
    configChanged,
    markerStatuses,
    postApplyMessages: pluginPostApplyMessages(after),
  };
}

function printPluginUsage(): void {
  console.log(`Usage:
  akf plugin list
  akf plugin explain <id>
  akf plugin add <id>`);
}

function printAddResult(result: PluginAddResult): void {
  console.log();
  console.log(
    `  .apfelkaefig.json                 ${result.configChanged ? "updated" : "unchanged"}`,
  );
  for (const marker of result.markerStatuses) {
    console.log(`  ${marker.path.padEnd(34)} ${STATUS_LABELS[marker.status]}`);
  }
  for (const message of result.postApplyMessages) {
    console.log(`  note: ${message}`);
  }
  console.log();
  console.log(`Added plugin '${result.pluginId}'.`);
}

async function readConfigIfPresent(path: string): Promise<ApfelkaefigConfig | null> {
  try {
    return parseConfig(await Deno.readTextFile(path), path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

function renderConfig(config: ApfelkaefigConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

const EMBEDDED_BASE_DOCKERFILE_URL = new URL("../../image/Dockerfile", import.meta.url);

async function ensureDockerfileBaseIfNeeded(
  workspaceDir: string,
  config: ApfelkaefigConfig,
): Promise<void> {
  if (pluginDockerfileBlocks(config).length === 0) return;
  const dockerfilePath = join(workspaceDir, ".devcontainer/Dockerfile");
  try {
    await Deno.lstat(dockerfilePath);
    return;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await ensureDir(join(workspaceDir, ".devcontainer"));
  const base = await Deno.readTextFile(EMBEDDED_BASE_DOCKERFILE_URL);
  await Deno.writeTextFile(dockerfilePath, base.endsWith("\n") ? base : `${base}\n`);
}
