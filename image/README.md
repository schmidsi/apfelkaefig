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

Tracked in [`TODO.md`](../TODO.md). For now, the image builds locally on first `akf up` and that's
fine.

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

Codex, Gemini CLI, Python, and friends are deliberately BYO via a custom Dockerfile that extends
this base. Declare `ARG AKF_BASE` and start `FROM ${AKF_BASE}`; `akf build` injects
`AKF_BASE=apfelkaefig-base:<hash>` at build time (and builds the base first if Docker doesn't have
it cached yet), so you never hardcode the content-hashed tag. Then add whatever else the project
needs:

```dockerfile
ARG AKF_BASE
FROM ${AKF_BASE}

USER root
RUN apt-get update && apt-get install -y --no-install-recommends <extra-packages> \
 && rm -rf /var/lib/apt/lists/*
USER node
```

## Why arm64-only

The whole point of apfelkäfig is being native to Apple Silicon — no Docker Desktop tax, no x86
emulation. amd64 is not a supported target.
