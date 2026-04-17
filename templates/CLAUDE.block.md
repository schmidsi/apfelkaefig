## Sandbox (apfelkäfig)

This folder is set up to run inside an Apple `container` micro-VM. Claude Code is launched with
`--dangerously-skip-permissions` — **the VM is the sandbox**, so the permission prompts are
redundant.

Launch:

1. `./build.sh` — build the sandbox image (one-time; rebuild when the Dockerfile changes).
2. `./start.sh` — start Claude Code inside the sandbox.

The sandbox mounts this folder at `/workspace`, `$HOME/.claude` read-write, and `$HOME/Downloads`
and `$HOME/Desktop` read-only.
