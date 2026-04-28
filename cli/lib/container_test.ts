import { assert, assertEquals } from "@std/assert";
import { buildRunArgs, projectImageTag, resolveImageRef } from "./container.ts";
import type { ResolvedConfig } from "./config.ts";

function resolved(
  partial: Partial<ResolvedConfig["config"]> = {},
  dir = "/Users/me/proj",
): ResolvedConfig {
  return {
    source: { kind: "defaults", dir },
    workspaceDir: dir,
    config: { version: 1, ...partial },
    warnings: [],
  };
}

Deno.test("projectImageTag derives from workspace basename", () => {
  assertEquals(projectImageTag("/Users/me/Apfelkäfig"), "apfelk-fig-sandbox");
  assertEquals(projectImageTag("/Users/me/MyProj"), "myproj-sandbox");
  assertEquals(projectImageTag("/"), "akf-sandbox");
});

Deno.test("resolveImageRef: built-in default when image unset", () => {
  const r = resolveImageRef({ version: 1 }, "/p", "ghcr.io/apfelkaefig/base@sha256:abc");
  assertEquals(r.ref, "ghcr.io/apfelkaefig/base@sha256:abc");
  assertEquals(r.needsBuild, false);
});

Deno.test("resolveImageRef: string image passes through", () => {
  const r = resolveImageRef({ version: 1, image: "node:22" }, "/p", "default");
  assertEquals(r.ref, "node:22");
  assertEquals(r.needsBuild, false);
});

Deno.test("resolveImageRef: dockerfile triggers build with project tag", () => {
  const r = resolveImageRef(
    { version: 1, image: { dockerfile: ".devcontainer/Dockerfile" } },
    "/Users/me/myproj",
    "default",
  );
  assertEquals(r.ref, "myproj-sandbox");
  assertEquals(r.needsBuild, true);
  assertEquals(r.dockerfile, ".devcontainer/Dockerfile");
});

Deno.test("buildRunArgs: minimal defaults", () => {
  const out = buildRunArgs({
    resolved: resolved({}),
    workspaceHostPath: "/Users/me/proj",
    imageRef: "ghcr.io/apfelkaefig/base",
    homeDir: "/nonexistent-home",
  });
  assert(out.args[0] === "run");
  assertEquals(out.user, "node");
  assertEquals(out.workspaceFolder, "/workspaces/proj");
  // Workspace mount appears.
  const idx = out.args.indexOf("/Users/me/proj:/workspaces/proj");
  assert(idx > 0, "workspace mount missing");
  // Default command appended at the end.
  const tail = out.args.slice(-3);
  assertEquals(tail, [
    "ghcr.io/apfelkaefig/base",
    "claude",
    "--dangerously-skip-permissions",
  ]);
});

Deno.test("buildRunArgs: custom command + extra env", () => {
  const out = buildRunArgs({
    resolved: resolved({ command: ["bash"] }),
    workspaceHostPath: "/Users/me/proj",
    imageRef: "img",
    homeDir: "/nonexistent",
    extraEnv: { OP_SERVICE_ACCOUNT_TOKEN: "tok" },
  });
  assertEquals(out.args.slice(-2), ["img", "bash"]);
  // Token forwarded.
  const envIdx = out.args.findIndex((a) => a === "OP_SERVICE_ACCOUNT_TOKEN=tok");
  assert(envIdx > 0, "token not forwarded");
});

Deno.test("buildRunArgs: respects user + workspaceFolder overrides", () => {
  const out = buildRunArgs({
    resolved: resolved({ user: "alice", workspaceFolder: "/code" }),
    workspaceHostPath: "/Users/me/proj",
    imageRef: "img",
    homeDir: "/nonexistent",
  });
  assertEquals(out.user, "alice");
  assertEquals(out.workspaceFolder, "/code");
  // -u alice -w /code
  const u = out.args.indexOf("-u");
  assertEquals(out.args[u + 1], "alice");
  const w = out.args.indexOf("-w");
  assertEquals(out.args[w + 1], "/code");
});

Deno.test("buildRunArgs: applies resources caps", () => {
  const out = buildRunArgs({
    resolved: resolved({ resources: { cpus: 4, memory: "8G" } }),
    workspaceHostPath: "/Users/me/proj",
    imageRef: "img",
    homeDir: "/nonexistent",
  });
  const cpus = out.args.indexOf("--cpus");
  assertEquals(out.args[cpus + 1], "4");
  const mem = out.args.indexOf("--memory");
  assertEquals(out.args[mem + 1], "8G");
});
