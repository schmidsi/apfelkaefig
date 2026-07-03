// `akf up` flag ownership (tasks/011, decision 6). Plugins declare the boolean
// flags they own; core owns the rest. Lives outside plugins.ts so the internal
// tmux plugin (which imports container.ts → config.ts → plugins.ts) doesn't
// create an import cycle with the registry.

import type { BuiltInPlugin } from "../plugins/types.ts";
import { listPlugins } from "./plugins.ts";
import { tmuxPlugin } from "../plugins/tmux/plugin.ts";

// Internal plugins share the run-hook interface but are not user-addressable:
// no `plugins.{id}` config section, no `akf plugin add`, no schema entry.
// They are enabled by core sugar (tmux: top-level key / --tmux flag).
export const INTERNAL_PLUGINS: BuiltInPlugin[] = [tmuxPlugin];

// Boolean flags `akf up` owns itself. Plugin-declared flags must not collide
// with these or with each other.
const CORE_UP_FLAGS = ["rebuild", "serve", "image", "help", "h"];

// All `akf up` flags declared by plugins (public + internal), for the arg
// parser to accept generically.
export function allUpPluginFlags(): string[] {
  const flags: string[] = [];
  for (const p of [...listPlugins(), ...INTERNAL_PLUGINS]) flags.push(...(p.flags ?? []));
  return flags;
}

// Plugins are compiled in, so a flag collision is a developer error, not a
// user error: fail at module load, pinned by a unit test. Exported with
// parameters so the test can also exercise the failure path with fakes.
export function assertFlagUniqueness(
  plugins: Pick<BuiltInPlugin, "id" | "flags">[] = [...listPlugins(), ...INTERNAL_PLUGINS],
  coreFlags: string[] = CORE_UP_FLAGS,
): void {
  const seen = new Set(coreFlags);
  for (const p of plugins) {
    for (const f of p.flags ?? []) {
      if (seen.has(f)) {
        throw new Error(
          `plugin '${p.id}' declares flag '--${f}', already claimed by core or another plugin`,
        );
      }
      seen.add(f);
    }
  }
}
assertFlagUniqueness();
