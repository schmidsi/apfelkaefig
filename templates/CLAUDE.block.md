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

`akf up` exports `AKF_SANDBOX=1` and `AKF_PROJECT_NAME=<basename>` inside the container — branch
on these in shell prompts, statuslines, or scripts to tell sandbox runs apart from the host.
Run `akf statusline` once on the host to drop a Claude Code statusline indicator into
`~/.claude/bin/`.

If you'd rather not depend on the `akf` binary, run `akf eject --bash` to write standalone
`build.sh` + `start.sh`, or `akf eject --devcontainer` to write a `.devcontainer/devcontainer.json`
that VS Code Dev Containers / Codespaces / Coder can pick up.
