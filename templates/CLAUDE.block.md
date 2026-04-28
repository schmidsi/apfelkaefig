## Sandbox (apfelkäfig)

This folder is set up to run inside an Apple `container` micro-VM. Claude Code is launched with
`--dangerously-skip-permissions` — **the VM is the sandbox**, so the permission prompts are
redundant.

Launch:

```
akf up
```

Configuration lives in `.apfelkaefig.json`. The sandbox mounts this folder at
`/workspaces/<basename>`, `$HOME/.claude` read-write, and `$HOME/Downloads` and `$HOME/Desktop`
read-only.

If you'd rather not depend on the `akf` binary, run `akf eject --bash` to write standalone
`build.sh` + `start.sh`, or `akf eject --devcontainer` to write a `.devcontainer/devcontainer.json`
that VS Code Dev Containers / Codespaces / Coder can pick up.
