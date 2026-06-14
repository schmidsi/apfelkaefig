// `akf build` — replaces the per-project build.sh. Builds a custom image with
// Apple `container build` directly into `container`'s image store. No Docker, no
// registry shuttle — the v0.9 builder DNS bug that required them is fixed in
// container 1.0.

import { dirname, isAbsolute, resolve } from "@std/path";
import { imageExists, projectImageTag, realRunner, type Runner } from "../lib/container.ts";
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

  // Expose the built-in base to the project build as the AKF_BASE build-arg so
  // a custom Dockerfile can `ARG AKF_BASE` / `FROM ${AKF_BASE}` instead of
  // hardcoding the content-hashed base tag (which changes when the base does).
  // When the base isn't in `container`'s store yet — e.g. a project that has
  // only ever used a custom Dockerfile, so the drive-by base build never ran —
  // build it first so the project's FROM resolves.
  const baseBuildArgs: string[] = [];
  if (!opts.isBaseBuild) {
    const base = await builtInImage();
    if (base.embedded) {
      if (!(await imageExists(base.ref, run))) {
        const basePath = await materializeEmbeddedDockerfile(base);
        console.error(`akf build: base image '${base.ref}' not in container — building it first…`);
        const baseBuild = await run("container", [
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
  const build = await run("container", [
    "build",
    "-t",
    tag,
    "-f",
    dockerfilePath,
    ...baseBuildArgs,
    buildContext,
  ]);
  if (build.code !== 0) {
    console.error("akf build: container build failed");
    return build.code;
  }

  console.error(`akf build: done. Image '${tag}' is ready for Apple \`container\`.`);
  return 0;
}
