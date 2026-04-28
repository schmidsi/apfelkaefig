# Base image — `ghcr.io/apfelkaefig/base`

The image consumed by `akf up` in drive-by mode (no project config) and as the implicit default for
tier-2 / tier-3 projects that don't override `image` in their `.apfelkaefig.json`.

## Contents

Minimal — Debian slim plus what every Claude session needs:

- `git`, `curl`, `jq`, `ripgrep`, `fd-find`, `tree`, `vim`, `unzip`
- `gh` (GitHub CLI)
- `op` (1Password CLI)
- `node` (Node.js, for `claude` and most npm-distributed coding agents)
- `claude` (Claude Code, installed as the `node` user so self-update works)

Codex, Gemini CLI, Python, and friends are deliberately BYO via a custom Dockerfile that starts
with:

```dockerfile
FROM ghcr.io/apfelkaefig/base
```

…and adds whatever else the project needs. Keeping the base small keeps the drive-by experience fast
and the dependency surface minimal.

## Versioning

Independent of the `akf` binary version. The image is built and pushed by
`.github/workflows/image.yml` on tags of the form `image-v*`. Each publication produces a digest
(`sha256:…`) that the next `akf` binary build embeds at compile time via `--env-file` so that every
`akf` binary boots exactly one known image.

Until the publishing pipeline lands, `AKF_BASE_IMAGE` overrides whatever `baseimage.ts` returns —
convenient for testing local builds.

## Building locally

```bash
docker build -t ghcr.io/apfelkaefig/base:dev image/
AKF_BASE_IMAGE=ghcr.io/apfelkaefig/base:dev akf up
```

## Why arm64-only

The whole point of apfelkäfig is being native to Apple Silicon — no Docker Desktop tax, no x86
emulation. The base is published as `linux/arm64` only. amd64 hosts can still build locally for
testing but won't be the supported distribution path.
