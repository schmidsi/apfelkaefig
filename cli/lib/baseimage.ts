// The built-in base image is ghcr.io/apfelkaefig/base, pinned by digest. The
// digest is supposed to be embedded at compile time so each binary boots a
// known image; until the image-publishing workflow lands, AKF_BASE_IMAGE
// overrides it (escape hatch for development) and the fallback uses :latest.
//
// `deno compile --env-file` can bake AKF_BASE_IMAGE into the binary at
// release time.

const BASE_IMAGE_REPO = "ghcr.io/apfelkaefig/base";

export function builtInBaseImage(): string {
  const override = Deno.env.get("AKF_BASE_IMAGE");
  if (override && override.length > 0) return override;
  // TODO(image-pipeline): replace with sha256 digest baked at compile time.
  return `${BASE_IMAGE_REPO}:latest`;
}

export function baseImageRepo(): string {
  return BASE_IMAGE_REPO;
}
