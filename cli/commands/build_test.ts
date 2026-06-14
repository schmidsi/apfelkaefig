import { assert, assertEquals } from "@std/assert";
import { runBuild } from "./build.ts";
import { builtInImage } from "../lib/baseimage.ts";
import type { CmdResult, Runner } from "../lib/container.ts";

// A runner that records every invocation and returns success by default.
// `baseInContainer` controls whether `container image inspect <base>` reports
// the built-in base as already present (code 0) or missing (code 1).
function recorder(opts?: { baseInContainer?: boolean }) {
  // Make the embedded-base path deterministic regardless of the dev's env.
  Deno.env.delete("AKF_BASE_IMAGE");
  const baseInContainer = opts?.baseInContainer ?? true;
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Runner = (cmd, args) => {
    calls.push({ cmd, args });
    let res: CmdResult = { code: 0, stdout: "", stderr: "" };
    if (cmd === "container" && args[0] === "image" && args[1] === "inspect") {
      res = { code: baseInContainer ? 0 : 1, stdout: "", stderr: "" };
    }
    return Promise.resolve(res);
  };
  return { run, calls };
}

const containerBuilds = (calls: { cmd: string; args: string[] }[]) =>
  calls.filter((c) => c.cmd === "container" && c.args[0] === "build");

// No Docker and no registry shuttle should ever be touched.
function assertNoDockerOrRegistry(calls: { cmd: string; args: string[] }[]) {
  assert(!calls.some((c) => c.cmd === "docker"), "no docker command should run");
  assert(
    !calls.some((c) => c.cmd === "container" && c.args[0] === "push"),
    "no registry push should run",
  );
}

Deno.test("runBuild injects AKF_BASE build-arg for project builds", async () => {
  const { run, calls } = recorder({ baseInContainer: true });
  const code = await runBuild({
    cwd: "/tmp/proj",
    dockerfile: "/tmp/proj/.devcontainer/Dockerfile",
    tag: "proj-sandbox",
    run,
  });
  assertEquals(code, 0);

  const base = await builtInImage();
  const projBuild = containerBuilds(calls).find((b) => b.args.includes("proj-sandbox"));
  assert(projBuild, "project container build call missing");
  const i = projBuild!.args.indexOf("--build-arg");
  assert(i >= 0, "no --build-arg on project build");
  assertEquals(projBuild!.args[i + 1], `AKF_BASE=${base.ref}`);
  // Base already present → it must not be rebuilt.
  assert(
    !containerBuilds(calls).some((b) => b.args.includes(base.ref)),
    "present base should not be rebuilt",
  );
  assertNoDockerOrRegistry(calls);
});

Deno.test("runBuild skips AKF_BASE injection when building the base itself", async () => {
  const { run, calls } = recorder({ baseInContainer: true });
  const code = await runBuild({
    cwd: "/tmp/base",
    dockerfile: "/tmp/base/Dockerfile",
    tag: "apfelkaefig-base:test",
    run,
    isBaseBuild: true,
  });
  assertEquals(code, 0);
  assert(
    containerBuilds(calls).every((b) => !b.args.includes("--build-arg")),
    "base build must not inject AKF_BASE",
  );
  assert(
    !calls.some((c) => c.cmd === "container" && c.args[0] === "image" && c.args[1] === "inspect"),
    "base build must not probe for a base image",
  );
  assertNoDockerOrRegistry(calls);
});

Deno.test("runBuild builds the base first when container lacks it", async () => {
  const { run, calls } = recorder({ baseInContainer: false });
  const code = await runBuild({
    cwd: "/tmp/proj",
    dockerfile: "/tmp/proj/.devcontainer/Dockerfile",
    tag: "proj-sandbox",
    run,
  });
  assertEquals(code, 0);

  const base = await builtInImage();
  const builds = containerBuilds(calls);
  const baseIdx = builds.findIndex((b) => b.args.includes(base.ref));
  const projIdx = builds.findIndex((b) => b.args.includes("proj-sandbox"));
  assert(baseIdx >= 0, "base build call missing");
  assert(projIdx >= 0, "project build call missing");
  assert(baseIdx < projIdx, "base must be built before the project image");
  assertNoDockerOrRegistry(calls);
});
