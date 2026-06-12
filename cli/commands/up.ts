// `akf up` — canonical entry point. Resolves config, picks image, ensures
// it's available, and execs `container run …`.

import { builtInImage, materializeEmbeddedDockerfile } from "../lib/baseimage.ts";
import {
  buildRunArgs,
  containerVersion,
  ensureContainerSystem,
  ensureVolumes,
  imageExists,
  pullImage,
  realRunner,
  resolveImageRef,
  type Runner,
} from "../lib/container.ts";
import { ConfigError, resolveConfig } from "../lib/config.ts";
import { resolveOp, SecretsRequiredError, TruncatedTokenError } from "../lib/secrets.ts";
import { runBuild } from "./build.ts";

export interface UpOptions {
  cwd: string;
  // Positional args after `up` — passed as the in-container command. Empty
  // means use the resolved config's command (or default).
  positional: string[];
  imageOverride?: string;
  // Force the image to be rebuilt (or re-pulled) even when it's already
  // cached in Apple `container`. Used to pick up Dockerfile changes after
  // bumping a pinned dependency, since the existence check would otherwise
  // skip the build entirely.
  rebuild?: boolean;
  run?: Runner;
}

export async function runUp(opts: UpOptions): Promise<number> {
  const run = opts.run ?? realRunner;

  // Preflight — apple `container` is the bare minimum.
  if ((await containerVersion(run)) === null) {
    console.error(
      "akf up: Apple `container` not found. Install: https://github.com/apple/container",
    );
    return 1;
  }

  let resolved;
  try {
    resolved = await resolveConfig({
      cwd: opts.cwd,
      cliOverrides: {
        command: opts.positional.length > 0 ? opts.positional : undefined,
        image: opts.imageOverride,
      },
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`akf up: ${err.message}${err.path ? ` (${err.path})` : ""}`);
      return 1;
    }
    throw err;
  }

  for (const w of resolved.warnings) console.error(`warning: ${w}`);

  // Resolve the built-in base image. When `image/Dockerfile` is embedded in
  // the binary, materialize it into a content-hashed cache dir so docker has
  // a build context. AKF_BASE_IMAGE override skips the embedded path.
  const base = await builtInImage();
  let baseDockerfilePath: string | undefined;
  if (base.embedded) {
    baseDockerfilePath = await materializeEmbeddedDockerfile(base);
  }

  const image = resolveImageRef(resolved.config, resolved.workspaceDir, {
    ref: base.ref,
    dockerfile: baseDockerfilePath,
  });
  const isBuiltInBuild = resolved.config.image === undefined && image.needsBuild;

  // Ensure container system is up.
  await ensureContainerSystem(run);

  // Image presence check + recovery path. --rebuild forces the build/pull
  // path even when the image is cached — needed when the Dockerfile content
  // has changed (e.g. a bumped pinned SHA) but the tag has not.
  const needsRefresh = opts.rebuild || !(await imageExists(image.ref, run));
  if (needsRefresh) {
    if (image.needsBuild) {
      if (opts.rebuild) {
        console.error(`akf up: --rebuild — rebuilding '${image.ref}' from ${image.dockerfile}…`);
      } else if (isBuiltInBuild) {
        console.error(
          `akf up: built-in base image '${image.ref}' not cached — building (one-time, takes a minute or two)…`,
        );
      } else {
        console.error(
          `akf up: image '${image.ref}' missing — building from ${image.dockerfile}…`,
        );
      }
      const buildCode = await runBuild({
        cwd: resolved.workspaceDir,
        dockerfile: image.dockerfile!,
        tag: image.ref,
        run,
        isBaseBuild: isBuiltInBuild,
      });
      if (buildCode !== 0) return buildCode;
    } else {
      console.error(
        opts.rebuild
          ? `akf up: --rebuild — re-pulling ${image.ref}…`
          : `akf up: pulling ${image.ref}…`,
      );
      const pullRes = await pullImage(image.ref, run);
      if (pullRes.code !== 0) {
        console.error(
          `akf up: failed to pull '${image.ref}'. If you're offline, run\n` +
            `         akf build --from-dockerfile <path>\n` +
            `       to use a locally-built image instead.`,
        );
        return pullRes.code;
      }
    }
  }

  // Pre-create any named volumes referenced by the config so `container run`
  // doesn't 404 on the first reference.
  try {
    await ensureVolumes(resolved.config.mounts, run);
  } catch (err) {
    console.error(`akf up: ${(err as Error).message}`);
    return 1;
  }

  // 1Password injection.
  let extraEnv: Record<string, string> | undefined;
  try {
    const token = await resolveOp({ explicit: resolved.config.secrets?.onepassword });
    if (token) extraEnv = { OP_SERVICE_ACCOUNT_TOKEN: token };
  } catch (err) {
    if (err instanceof SecretsRequiredError || err instanceof TruncatedTokenError) {
      console.error(`akf up: ${err.message}`);
      return 1;
    }
    throw err;
  }

  const built = buildRunArgs({
    resolved,
    workspaceHostPath: resolved.workspaceDir,
    imageRef: image.ref,
    extraEnv,
  });

  // Forward SIGINT so the container exits cleanly. Deno's child inherits the
  // pty when we use stdin: "inherit"; spawning lets us also handle signals.
  const cmd = new Deno.Command("container", {
    args: built.args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const child = cmd.spawn();
  const onSig = () => {
    try {
      child.kill("SIGINT");
    } catch (_) {
      // Already exited.
    }
  };
  Deno.addSignalListener("SIGINT", onSig);
  try {
    const status = await child.status;
    return status.code;
  } finally {
    try {
      Deno.removeSignalListener("SIGINT", onSig);
    } catch (_) { /* ignore */ }
  }
}
