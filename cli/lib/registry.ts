// Local docker registry on :5555 used as a shuttle for moving images from
// Docker (which can build) into Apple `container` (which has DNS bugs in v0.9
// during builds). Only used by `akf build` when a custom Dockerfile is in
// scope.

import type { Runner } from "./container.ts";
import { realRunner } from "./container.ts";

export const REGISTRY_NAME = "registry";
export const REGISTRY_HOST = "localhost:5555";
const REGISTRY_HOST_PORT = 5555;
const REGISTRY_INTERNAL_PORT = 5000;
const REGISTRY_IMAGE = "registry:2";

export async function isRegistryRunning(run: Runner = realRunner): Promise<boolean> {
  const r = await run("docker", ["inspect", "--format", "{{.State.Running}}", REGISTRY_NAME], {
    stdout: "piped",
    stderr: "null",
  });
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function startRegistry(run: Runner = realRunner): Promise<void> {
  if (await isRegistryRunning(run)) return;
  await run("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    REGISTRY_NAME,
    "-p",
    `${REGISTRY_HOST_PORT}:${REGISTRY_INTERNAL_PORT}`,
    REGISTRY_IMAGE,
  ]);
}

export async function stopRegistry(run: Runner = realRunner): Promise<void> {
  if (!(await isRegistryRunning(run))) return;
  await run("docker", ["stop", REGISTRY_NAME], { stdout: "null", stderr: "null" });
}
