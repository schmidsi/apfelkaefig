# Architecture Exploration (2026-04-12)

## Language: Deno + TypeScript

`deno compile` produces self-contained executables (~58MB on macOS ARM as of Deno 1.41+).
Cross-compilation supported via `--target` for macOS x64/ARM, Linux x64, Windows x64. npm packages
and web workers work inside compiled binaries.

Homebrew story is clean: formula downloads a pre-built binary, no runtime dependency needed.

Binary size (~58MB) is comparable to other dev CLIs (`kubectl` ~50MB, `gh` ~40MB).

## Two Usage Modes

### Mode 1 — Ephemeral (`akf run`)

```bash
akf run --expose 3000 "npm install && npm run dev"
akf run "cargo test"
```

Spins up a disposable container, runs the command, forwards ports, tears down. No project setup
needed. The "just try it" entry point.

### Mode 2 — Project (`akf init` / `akf start`)

```bash
akf init                 # scaffolds Dockerfile, start.sh, .claude/ config
akf start                # boots the persistent dev container
akf start "fix the bug"  # boots and sends a prompt
```

Evolved version of the `create-claude-in-an-apple` scaffolder — now a subcommand of `akf` rather
than a standalone npx package. Both modes share the same container-management core.

## `.claude` Exposure Levels

Three tiers of host `.claude` directory exposure inside containers:

| Level         | What's exposed                           | Trade-off                                               |
| ------------- | ---------------------------------------- | ------------------------------------------------------- |
| **full**      | Entire `~/.claude/`                      | Convenient, but leaks cross-project memories & settings |
| **selective** | Auth credentials + cloud MCP configs     | Agent can use tools, no cross-project bleed             |
| **minimal**   | Nothing; help user `claude login` inside | Cleanest isolation, most friction                       |

### Selective mode (proposed default)

Mount into the container:

- Auth credentials / login tokens
- Cloud/remote MCP server configs (not local file-path MCPs that won't resolve inside the container)
- Possibly global settings (filtered)

Explicitly exclude:

- `~/.claude/projects/` (cross-project memories, per-project settings)
- Local MCP configs pointing to host file paths

Exposed as a flag: `--claude-access=full|selective|minimal`

Proposed defaults:

- `akf run` (ephemeral) defaults to `minimal`
- `akf start` (project) defaults to `selective`

## Shared Core

Both modes share the same underlying machinery:

- **Container lifecycle**: build, run, stop, rm (wrapping Apple `container` CLI)
- **Mount assembly**: workspace, Downloads (RO), `.claude` (per exposure level)
- **Port forwarding**: `--expose` flag for mapping container ports
- **CDP proxy**: Node TCP proxy on :9223 that rewrites Host headers so container can drive host
  Chrome via `host.docker.internal:9223` (crown jewel from original scaffold)

## Reference: "full" exposure shape

The sandbox layout we're generalizing from demonstrates the "full" exposure approach:

- Mounts entire `~/.claude` read-write into `/home/node/.claude`
- Forwards credentials as env vars (e.g. `ANTHROPIC_API_KEY`, 1Password service account tokens)
- Uses `container run` with 2 CPUs, 4GB RAM
- Builds via Docker first, pushes to local registry on `localhost:5555`, then pulls into Apple
  Container (workaround for build-time networking bug)
- Runs `claude --dangerously-skip-permissions`

## Open Questions

1. **`.claude` directory structure** — what files contain auth vs. memories vs. MCP configs? Needed
   to design selective mount correctly.
2. **Image building strategy** — continue the Docker-build → local-registry workaround, or has Apple
   Container fixed build-time networking in newer versions?
3. **`akf doctor`** — minimum `container` version pinning, prerequisite checks.
4. **CDP proxy packaging** — currently a Node.js script; rewrite in Deno for the compiled binary, or
   keep as a bundled script?
