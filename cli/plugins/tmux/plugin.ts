// tmux multiplexing as an INTERNAL plugin (tasks/011, decision 4): users
// enable it via the top-level `tmux: true` config key or `akf up --tmux` —
// never via a `plugins.tmux` section. It shares the run-hook interface with
// the public plugins so `akf up` has one mechanism, but it is not in the
// public registry: no `akf plugin add tmux`, no schema entry, no config.
//
// Behavior: the first `akf up` starts the container with the agent command
// wrapped in a shared tmux session; a second `akf up` from another terminal
// finds the running box by name and attaches to the same session via
// `container exec` instead of starting a new container (which would fail —
// Apple `container` named volumes attach to one running VM at a time).

import { buildExecArgs, containerIsRunning } from "../../lib/container.ts";
import { djb2Hex, projectSlug } from "../../lib/fs.ts";
import type { BuiltInPlugin } from "../types.ts";

// tmux session name shared by all `akf up` sessions for a container. `-A` on
// new-session attaches to it if it exists, so the initial `container run` and
// later `container exec` invocations converge on one session.
export const TMUX_SESSION = "akf";

// Wrap a command so it runs inside the shared session. `-A` attaches to the
// session if it already exists (ignoring the trailing command).
export function tmuxWrap(command: string[]): string[] {
  return ["tmux", "new-session", "-A", "-s", TMUX_SESSION, ...command];
}

// Stable per-project container name so a second `akf up` can find the running
// box and exec into it. Includes a path hash so two projects sharing a
// basename cannot attach to each other's sandbox (or rm -f each other's
// stopped box) — same disambiguation the telegram plugin uses for its
// instance volumes.
export function sandboxContainerName(workspaceHostPath: string): string {
  return `akf-${projectSlug(workspaceHostPath)}-${djb2Hex(workspaceHostPath)}`;
}

export const tmuxPlugin: BuiltInPlugin = {
  id: "tmux",
  aliases: [],
  description:
    "Share one sandbox across terminals via a tmux session (top-level `tmux: true` / `akf up --tmux`).",
  defaultConfig: {},
  markerBlocks: () => [],
  flags: ["tmux"],
  containerName(ctx) {
    return sandboxContainerName(ctx.workspaceDir);
  },
  wrapCommand(command) {
    return tmuxWrap(command);
  },
  async preRun(ctx) {
    const name = sandboxContainerName(ctx.workspaceDir);
    if (await containerIsRunning(name, ctx.run)) {
      console.error(
        `akf up: attaching to running sandbox '${name}' ` +
          `(tmux session '${TMUX_SESSION}'; Ctrl+B c for a new window, Ctrl+B d to detach)…`,
      );
      return { action: "attach", args: buildExecArgs(name, tmuxWrap(ctx.command)) };
    }
    // Clear a stopped orphan of the same name so `container run --name`
    // doesn't collide. Safe: only reached when it isn't running.
    await ctx.run("container", ["rm", "-f", name], { stdout: "null", stderr: "piped" });
    return { action: "continue" };
  },
};
