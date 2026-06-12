// `akf clean` — teardown for drive-by users. Stops + removes any sandbox
// container for the current workspace, optionally removes the project image,
// optionally clears the akf cache dir.
//
// "Leave no trace" promise for tier-1 (drive-by) usage.

import { join } from "@std/path";
import {
  listContainers,
  projectImageTag,
  realRunner,
  rmContainer,
  rmImage,
  type Runner,
  stopContainer,
} from "../lib/container.ts";
import { ConfigError, resolveConfig } from "../lib/config.ts";
import { resolveImageRef } from "../lib/container.ts";
import { builtInImage } from "../lib/baseimage.ts";

export interface CleanOptions {
  cwd: string;
  removeImages?: boolean;
  removeAll?: boolean;
  run?: Runner;
}

export async function runClean(opts: CleanOptions): Promise<number> {
  const run = opts.run ?? realRunner;
  let resolved;
  try {
    resolved = await resolveConfig({ cwd: opts.cwd });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`akf clean: ${err.message}${err.path ? ` (${err.path})` : ""}`);
      return 1;
    }
    throw err;
  }
  const projectTag = projectImageTag(resolved.workspaceDir);
  const base = await builtInImage();
  const image = resolveImageRef(resolved.config, resolved.workspaceDir, { ref: base.ref });

  // Match containers by image — both the project tag (for ejected/built
  // images) and the active image ref.
  const matchRefs = new Set<string>([projectTag, image.ref]);
  const containers = await listContainers(run);
  const ours = containers.filter((c) => matchRefs.has(c.image));

  for (const c of ours) {
    console.error(`stopping ${c.id} (${c.image})`);
    await stopContainer(c.id, run);
    await rmContainer(c.id, run);
  }
  if (ours.length === 0) {
    console.error("no running sandbox containers for this workspace");
  }

  if (opts.removeImages || opts.removeAll) {
    if (image.needsBuild || image.ref === projectTag) {
      console.error(`removing image ${projectTag}`);
      await rmImage(projectTag, run);
    } else {
      console.error(`leaving built-in image cached: ${image.ref}`);
    }
  }

  if (opts.removeAll) {
    const home = Deno.env.get("HOME") ?? "";
    if (home) {
      const cache = join(home, ".cache/apfelkaefig");
      try {
        await Deno.remove(cache, { recursive: true });
        console.error(`removed cache dir ${cache}`);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          console.error(`warning: could not remove ${cache}: ${(err as Error).message}`);
        }
      }
    }
  }

  return 0;
}
