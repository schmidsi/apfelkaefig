# TODO

What's not shipped yet. One line per item; detail lives in linked task files.

## Distribution

- Homebrew tap + formula (`apfelkaefig` installing `akf`)
- npm package `apfelkaefig` — see [`tasks/002_release.md`](tasks/002_release.md) §6
- ghcr.io base image publishing (`ghcr.io/schmidsi/apfelkaefig-base`) — see
  [`tasks/002_release.md`](tasks/002_release.md) §7

## Infrastructure

- GitHub Actions CI: `deno fmt --check`, `lint`, `check`, `test`, `compile` — see
  [`tasks/002_release.md`](tasks/002_release.md) §5
- Release workflow on `v*` tags (binary upload + npm publish)
- GitHub repo metadata: description, topics, homepage — one-shot `gh` command in
  [`tasks/002_release.md`](tasks/002_release.md) §3
- Social preview image (1280×640)

## Features

- Chrome CDP proxy bridge (`assets/chrome-bridge/`) — referenced by `SKILL.md` notes but not
  shipped; for v0.2.0 drop the dangling reference (see [`tasks/002_release.md`](tasks/002_release.md) §9)
- `CHANGELOG.md` — start on first tag
- Demo tape / GIF for README — see [`tasks/002_release.md`](tasks/002_release.md) §8
- `akf doctor`: confirm `container ≥ 1.0` gate runs as an `akf up` preflight — see
  [`tasks/002_release.md`](tasks/002_release.md) §4
- `--minimal` mode (resolve `ANTHROPIC_API_KEY` only via `op read`) — see
  [`tasks/003_minimal_mode.md`](tasks/003_minimal_mode.md)
