// Built-in base image resolution.
//
// MVP: the base image is built locally from `image/Dockerfile`, which is
// embedded into the binary at compile time via `deno compile --include`. The
// image tag is content-addressed (`apfelkaefig-base:<short-hash>`) so cache
// invalidation is automatic when the Dockerfile changes and the binary is
// recompiled.
//
// Registry-published base (so drive-by users need only Apple `container`, no
// Docker) is future work — see TODO.md. Until then, `AKF_BASE_IMAGE=<ref>`
// overrides the embedded path for development against a pre-built image.

import { join } from "@std/path";

export interface BuiltInImage {
  // Image tag/ref to run.
  ref: string;
  // Present when the image must be built from an embedded Dockerfile rather
  // than pulled from a registry. Holds the file content + a content hash so a
  // caller can materialize a build context on demand.
  embedded?: { content: string; hash: string };
}

const EMBEDDED_DOCKERFILE_URL = new URL("../../image/Dockerfile", import.meta.url);
const TAG_PREFIX = "apfelkaefig-base";

export async function builtInImage(): Promise<BuiltInImage> {
  const override = Deno.env.get("AKF_BASE_IMAGE");
  if (override && override.length > 0) return { ref: override };

  const content = await Deno.readTextFile(EMBEDDED_DOCKERFILE_URL);
  const hash = await shortHash(content);
  return { ref: `${TAG_PREFIX}:${hash}`, embedded: { content, hash } };
}

// Write the embedded Dockerfile into a content-hashed cache dir under
// $HOME/.cache/apfelkaefig/base/<hash>/Dockerfile and return its absolute
// path. Idempotent — safe to call before every build.
export async function materializeEmbeddedDockerfile(info: BuiltInImage): Promise<string> {
  if (!info.embedded) {
    throw new Error("materializeEmbeddedDockerfile called on non-embedded image");
  }
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("HOME not set; cannot locate cache dir");
  const dir = join(home, ".cache", "apfelkaefig", "base", info.embedded.hash);
  await Deno.mkdir(dir, { recursive: true });
  const path = join(dir, "Dockerfile");
  await Deno.writeTextFile(path, info.embedded.content);
  return path;
}

async function shortHash(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(buf).slice(0, 12);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
