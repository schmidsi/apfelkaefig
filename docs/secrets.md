# Secrets inside the sandbox

Apfelkäfig ships with a wire-in for the [1Password service-account pattern][skill]: the image has
the `op` CLI, and the generated `start.sh` / `devcontainer.json` forward `OP_SERVICE_ACCOUNT_TOKEN`
from your host shell into the VM. Inside the sandbox, you (or an agent) resolve secrets on demand
with `op read` — nothing else needs to cross the boundary, and nothing is written to disk.

[skill]: ../skills/1password-agent-secrets/SKILL.md

## What's wired up

- **`op` CLI installed** in the image (`templates/.devcontainer/Dockerfile`).
- **`OP_SERVICE_ACCOUNT_TOKEN` forwarded** from host if set (`remoteEnv` in `devcontainer.json`,
  mirrored by `start.sh`'s `.remoteEnv` parser). If unset on the host, the forward is a no-op —
  nothing breaks.

That's the whole integration. Everything else — creating the service account, storing the token in
macOS Keychain, loading it into your shell — is covered by the standalone skill.

## Quick start (you already use 1Password)

1. Set up the SA token in Keychain and export `OP_SERVICE_ACCOUNT_TOKEN` in your shell — follow the
   [1password-agent-secrets skill][skill] if you haven't.
2. `./build.sh && ./start.sh` — the sandbox inherits the token automatically.
3. Inside the VM:

   ```bash
   # Quote the op:// path — vault names may contain spaces.
   export ANTHROPIC_API_KEY="$(op read 'op://<your-vault>/Anthropic API Key/credential' --no-newline)"
   export GITHUB_TOKEN="$(op read 'op://<your-vault>/GitHub Agent Token/token' --no-newline)"
   ```

   Or inline at the point of use:

   ```bash
   op run --env-file=.env.tpl -- my-app
   ```

## Using it without installing `akf`

The skill at [`skills/1password-agent-secrets/SKILL.md`](../skills/1password-agent-secrets/SKILL.md)
is self-contained — install it into `~/.claude/skills/1password-agent-secrets/` and Claude Code will
use the same pattern whether or not you ever touch `akf`. This repo just happens to be where it
lives; the two concerns (sandbox scaffold vs. secret pattern) are independent.

## Threat model notes

- The **SA token** is the only long-lived secret that crosses the VM boundary. If the sandbox is
  compromised, revoke the SA in 1Password and every downstream consumer is cut off instantly.
- Resolved secrets (API keys, tokens from `op read`) live only in the container's process memory.
  Don't export them into `.env` files — that defeats the pattern.
- The default sandbox (non-`--minimal`) lets agents reach the open internet. Data exfiltration is
  still possible for anything the process can see. Sandboxing limits local blast radius, not egress.
  See the README's Security model section.
- In `--minimal` mode (`akf init --minimal`, planned), the entrypoint resolves `ANTHROPIC_API_KEY`
  via `op read` as the _only_ auth path — no `.credentials.json` mount, no raw key in shell history.
  See `tasks/003_minimal_mode.md`.

## Not using 1Password?

- The `op` binary sits unused — ~20 MB in the image. Leaves the door open if you ever do.
- The `OP_SERVICE_ACCOUNT_TOKEN` forward is empty → nothing is set inside the VM.
- Use whatever you already use (direnv, `gpg`-encrypted dotfiles, `pass`, etc.). Nothing in the
  scaffold blocks you.
