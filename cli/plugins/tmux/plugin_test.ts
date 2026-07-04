import { assert, assertEquals } from "@std/assert";
import { sandboxContainerName, TMUX_SESSION, tmuxPlugin, tmuxWrap } from "./plugin.ts";
import type { RunContext } from "../types.ts";
import type { Runner } from "../../lib/container.ts";

function ctx(run: Runner, workspaceDir = "/Users/me/proj"): RunContext {
  return {
    config: { version: 1 },
    workspaceDir,
    command: ["claude"],
    flags: { tmux: true },
    run,
  };
}

Deno.test("tmuxWrap: wraps a command in the shared akf session", () => {
  assertEquals(
    tmuxWrap(["claude", "--dangerously-skip-permissions"]),
    ["tmux", "new-session", "-A", "-s", TMUX_SESSION, "claude", "--dangerously-skip-permissions"],
  );
});

Deno.test("sandboxContainerName: slug plus path hash", () => {
  const name = sandboxContainerName("/Users/me/MyProj");
  assert(name.startsWith("akf-myproj-"), `unexpected name: ${name}`);
  assert(/^akf-myproj-[0-9a-f]{8}$/.test(name), `unexpected name: ${name}`);
  // Stable for the same path.
  assertEquals(name, sandboxContainerName("/Users/me/MyProj"));
});

Deno.test("sandboxContainerName: same basename, different paths → different names", () => {
  // Two projects that share a directory name must not attach to each other's
  // sandbox (or rm -f each other's stopped box).
  const a = sandboxContainerName("/Users/me/work/app");
  const b = sandboxContainerName("/Users/me/oss/app");
  assert(a !== b, "same-basename projects collided on container name");
});

Deno.test("wrapCommand delegates to tmuxWrap", () => {
  const noopRun: Runner = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
  assertEquals(
    tmuxPlugin.wrapCommand!(["claude"], ctx(noopRun)),
    ["tmux", "new-session", "-A", "-s", TMUX_SESSION, "claude"],
  );
});

Deno.test("preRun: attaches over container exec when the sandbox is running", async () => {
  const name = sandboxContainerName("/Users/me/proj");
  const run: Runner = (_cmd, args) => {
    assertEquals(args.slice(0, 2), ["list", "--format"]);
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify([{ id: name, image: "img", status: "running" }]),
      stderr: "",
    });
  };
  const result = await tmuxPlugin.preRun!(ctx(run));
  assert(result.action === "attach", `expected attach, got ${result.action}`);
  assertEquals(result.args[0], "exec");
  assertEquals(result.args[2], name);
  assert(result.args[5].includes("'tmux' 'new-session'"), `unexpected exec: ${result.args[5]}`);
});

Deno.test("preRun: clears a stopped orphan and continues when nothing runs", async () => {
  const calls: string[][] = [];
  const run: Runner = (_cmd, args) => {
    calls.push(args);
    // `container list` returns no running containers; `rm -f` succeeds.
    return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
  };
  const result = await tmuxPlugin.preRun!(ctx(run));
  assertEquals(result.action, "continue");
  const rm = calls.find((a) => a[0] === "rm");
  assertEquals(rm, ["rm", "-f", sandboxContainerName("/Users/me/proj")]);
});

Deno.test("containerName claims the stable sandbox name", () => {
  const noopRun: Runner = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
  assertEquals(
    tmuxPlugin.containerName!(ctx(noopRun)),
    sandboxContainerName("/Users/me/proj"),
  );
});
