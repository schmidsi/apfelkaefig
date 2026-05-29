// `akf build` — replaces the per-project build.sh. Builds a custom image with
// Docker (Apple `container`'s builder has DNS bugs in v0.9), shuttles it
// through a local registry, and pulls into Apple `container`.

import { dirname, isAbsolute, resolve } from "@std/path";
import {
  dockerStatus,
  projectImageTag,
  pullImageHttp,
  realRunner,
  type Runner,
  tagImage,
} from "../lib/container.ts";
import { REGISTRY_HOST, startRegistry, stopRegistry } from "../lib/registry.ts";
import { ConfigError, resolveConfig } from "../lib/config.ts";
import { builtInImage, materializeEmbeddedDockerfile } from "../lib/baseimage.ts";

export interface BuildOptions {
  cwd: string;
  // Explicit dockerfile path (relative to cwd) and tag — set when called
  // from `akf up`'s auto-build path. When not provided, `akf build` resolves
  // them from the active config or --from-dockerfile flag.
  dockerfile?: string;
  tag?: string;
  fromDockerfile?: string;
  noCleanup?: boolean;
  run?: Runner;
  // Set when building the built-in base image itself. Suppresses AKF_BASE
  // injection (the base is `FROM debian`, not an extension of itself).
  isBaseBuild?: boolean;
}

export async function runBuild(opts: BuildOptions): Promise<number> {
  const run = opts.run ?? realRunner;

  let dockerfile = opts.dockerfile ?? opts.fromDockerfile;
  let tag = opts.tag;

  if (!dockerfile) {
    let resolved;
    try {
      resolved = await resolveConfig({ cwd: opts.cwd });
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`akf build: ${err.message}${err.path ? ` (${err.path})` : ""}`);
        return 1;
      }
      throw err;
    }
    const img = resolved.config.image;
    if (typeof img === "object" && img && "dockerfile" in img) {
      dockerfile = img.dockerfile;
      tag ??= projectImageTag(resolved.workspaceDir);
    } else {
      console.error(
        "akf build: no Dockerfile in config. Pass --from-dockerfile <path> or set " +
          "image.dockerfile in .apfelkaefig.json.",
      );
      return 1;
    }
  }

  tag ??= projectImageTag(opts.cwd);
  const dockerfilePath = isAbsolute(dockerfile) ? dockerfile : resolve(opts.cwd, dockerfile);
  const buildContext = dirname(dockerfilePath);

  // Preflight Docker before invoking `docker build` so we can emit a useful
  // suggestion instead of the raw socket error from the docker CLI.
  const ds = await dockerStatus(run);
  if (ds === "missing") {
    console.error(
      "akf build: docker not found on PATH. Install Docker Desktop:\n" +
        "           https://docs.docker.com/desktop/install/mac-install/",
    );
    return 1;
  }
  if (ds === "daemon-down") {
    console.error(
      "akf build: Docker is installed but the daemon isn't running.\n" +
        "           Start it with:  open -a Docker\n" +
        "           Then retry the same command.",
    );
    return 1;
  }

  // Expose the built-in base to the project build as the AKF_BASE build-arg so
  // a custom Dockerfile can `ARG AKF_BASE` / `FROM ${AKF_BASE}` instead of
  // hardcoding the content-hashed base tag (which changes when the base does).
  // When the base isn't in Docker's store yet — e.g. a project that has only
  // ever used a custom Dockerfile, so the drive-by base build never ran — build
  // it first so the project's FROM resolves.
  const baseBuildArgs: string[] = [];
  if (!opts.isBaseBuild) {
    const base = await builtInImage();
    if (base.embedded) {
      const baseInDocker = await run("docker", ["image", "inspect", base.ref], {
        stdout: "null",
        stderr: "null",
      });
      if (baseInDocker.code !== 0) {
        const basePath = await materializeEmbeddedDockerfile(base);
        console.error(`akf build: base image '${base.ref}' not in Docker — building it first…`);
        const baseBuild = await run("docker", [
          "build",
          "-t",
          base.ref,
          "-f",
          basePath,
          dirname(basePath),
        ]);
        if (baseBuild.code !== 0) {
          console.error("akf build: base image build failed");
          return baseBuild.code;
        }
      }
    }
    baseBuildArgs.push("--build-arg", `AKF_BASE=${base.ref}`);
  }

  console.error(`akf build: building '${tag}' from ${dockerfilePath}`);
  const dockerBuild = await run("docker", [
    "build",
    "-t",
    tag,
    "-f",
    dockerfilePath,
    ...baseBuildArgs,
    buildContext,
  ]);
  if (dockerBuild.code !== 0) {
    console.error("akf build: docker build failed");
    return dockerBuild.code;
  }

  console.error("akf build: starting local registry on :5555");
  await startRegistry(run);

  const remoteRef = `${REGISTRY_HOST}/${tag}`;
  console.error(`akf build: pushing to ${remoteRef}`);
  await run("docker", ["tag", tag, remoteRef]);
  const dockerPush = await run("docker", ["push", remoteRef]);
  if (dockerPush.code !== 0) {
    console.error("akf build: docker push to local registry failed");
    if (!opts.noCleanup) await stopRegistry(run);
    return dockerPush.code;
  }

  console.error("akf build: pulling into Apple `container`");
  const pull = await pullImageHttp(remoteRef, run);
  if (pull.code !== 0) {
    console.error("akf build: container pull from local registry failed");
    if (!opts.noCleanup) await stopRegistry(run);
    return pull.code;
  }
  await tagImage(remoteRef, tag, run);

  if (!opts.noCleanup) {
    console.error("akf build: stopping registry");
    await stopRegistry(run);
  } else {
    console.error("akf build: leaving registry running (--no-cleanup)");
  }

  console.error(`akf build: done. Image '${tag}' is ready for Apple \`container\`.`);
  return 0;
}
