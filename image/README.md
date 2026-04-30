# Base image

The image consumed by `akf up` when a project does not override `image` in its config (drive-by
mode, tier-2 with no image set, tier-3 with no Dockerfile).

## Status (MVP)

The Dockerfile in this directory is **embedded into the `akf` binary at compile time** via
`deno compile --include ./image`. On first `akf up`, it is materialized into
`~/.cache/apfelkaefig/base/<hash>/Dockerfile` and built locally with Docker. The resulting image is
tagged `apfelkaefig-base:<hash>` where `<hash>` is the first 12 hex chars of the Dockerfile's
SHA-256. Cache invalidation is automatic when the Dockerfile changes and the binary is recompiled.

Docker is required on the host for this MVP path because Apple `container`'s builder has DNS bugs in
v0.9 that break the `apt-get` / `curl` steps below.

## Future: ghcr.io publishing

Eventually this image will be published to `ghcr.io/apfelkaefig/base`, with the `akf` binary
embedding a pinned `sha256:…` digest at compile time so drive-by users only need Apple `container`
(no Docker). That work is deferred until it pays for itself — for now, local build is fine.

When ghcr.io publishing lands:

- `image.yml` workflow builds + pushes on `image-v*` tags.
- `release.yml` reads the digest and bakes it into the binary via `--env-file`.
- `baseimage.ts` flips the default from "embedded" to "registry."
- `AKF_BASE_IMAGE` keeps working as a manual override.

## Override for development

`AKF_BASE_IMAGE=<ref>` skips the embedded path entirely and uses the given image ref. Convenient
when iterating on the Dockerfile or testing against a pre-built image:

```bash
docker build -t apfelkaefig-base:dev image/
AKF_BASE_IMAGE=apfelkaefig-base:dev akf up
```

## Contents

Minimal — Debian slim plus what every Claude session needs:

- `git`, `curl`, `jq`, `ripgrep`, `fd-find`, `tree`, `vim`, `unzip`
- `gh` (GitHub CLI)
- `op` (1Password CLI)
- `node` (Node.js, for `claude` and most npm-distributed coding agents)
- `claude` (Claude Code, installed as the `node` user so self-update works)

Codex, Gemini CLI, Python, and friends are deliberately BYO via a custom Dockerfile that starts
`FROM apfelkaefig-base:<hash>` (or, post-ghcr.io, `FROM ghcr.io/apfelkaefig/base`) and adds whatever
else the project needs.

## Why arm64-only

The whole point of apfelkäfig is being native to Apple Silicon — no Docker Desktop tax, no x86
emulation. amd64 is not a supported target.
