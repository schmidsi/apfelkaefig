# apfelkäfig

Disposable dev sandboxes on Apple Silicon, safe to point coding agents at.

`akf init` drops a one-command Apple-`container` sandbox into any existing project folder — build
the image, launch Claude Code inside the micro-VM, and stop babysitting permission prompts. **The VM
is the sandbox**, so Claude runs with `--dangerously-skip-permissions` without risk to the host.

Status: pre-release (v0.1 MVP).

## Install

Not packaged yet. For now:

```bash
git clone https://github.com/ApfelKaefig/apfelkaefig
cd apfelkaefig
deno task compile
cp dist/akf /usr/local/bin/akf
```

## Use

```bash
cd ~/code/my-project
akf init      # augments the folder (non-destructive; idempotent)
./build.sh    # build the sandbox image (one-time)
./start.sh    # launch Claude Code inside the sandbox
```

`akf init` adds:

- `.devcontainer/Dockerfile` + `devcontainer.json` — image definition, also picked up by VSCode Dev
  Containers.
- `start.sh` — launches Apple `container` with your folder mounted at `/workspace`, `$HOME/.claude`
  mounted read-write, `$HOME/Downloads` read-only.
- `build.sh` — builds with Docker and shuttles the image through a local registry (workaround for
  Apple-`container` v0.9 build-time networking).
- Appends a marker-delimited block to `.gitignore` and `CLAUDE.md`.

Re-running `akf init` is a no-op.

## Requirements

- macOS on Apple Silicon
- [Apple `container`](https://github.com/apple/container) (tested on v0.9)
- Docker (only for `build.sh`, until Apple fixes the builder's DNS bug)

## Develop

```bash
deno task test     # unit tests for fs helpers
deno task dev init # run from source in the current folder
deno task compile  # build ./dist/akf
```

See `POSITIONING.md`, `ARCHITECTURE_EXPLORATION.md`, and `tasks/` for the design thinking.

## License

MIT
