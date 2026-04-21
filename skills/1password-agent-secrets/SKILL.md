---
name: 1password-agent-secrets
description: Set up secret management for AI agents and dev environments using a 1Password service account, macOS Keychain, and on-demand `op read`. Use when the user wants agents/scripts/containers to access secrets (API keys, email passwords, SSH keys, GitHub tokens) without hardcoding or writing them to disk, or when troubleshooting the 128-char macOS keychain truncation bug with service account tokens.
---

# 1Password Service Account Secrets for Agents

A layered pattern that lets agents, scripts, and containers fetch secrets at runtime without any secret ever resting on disk in plaintext.

```
1Password vault
  └─> service account (scoped, rotatable, auditable)
        └─> SA token in macOS Keychain (long-lived bootstrap)
              └─> shell env var OP_SERVICE_ACCOUNT_TOKEN (loaded per-session)
                    └─> forwarded into containers / subprocesses as env
                          └─> `op read 'op://Vault/Item/field'` at the moment the secret is needed
```

Why three layers: the SA token is the *only* secret that ever lives outside 1Password, and it only lives in the Keychain (encrypted at rest). Every other secret — email passwords, GitHub PATs, SSH keys, API keys — is pulled from 1Password on demand and exists only in process memory.

## When to use this skill

Trigger when the user asks to:
- Let an agent, CI job, or container access secrets programmatically
- Wire up `op` CLI with a service account
- Fix a cryptic `op` error like `failed to session.DecodeSACredentials` / `unexpected end of JSON input`
- Store a long token in macOS Keychain and it seems corrupted
- Give a Docker/Apple Container/devcontainer workload access to 1Password
- Replace hardcoded secrets or `.env` files with 1Password lookups

## Step 1 — Create the service account in 1Password

1. Sign in to 1Password web app → **Developer** → **Service Accounts** → **Create Service Account**.
2. Name it for the consumer (e.g. `claude-agent`, `ci-builder`, `home-lab`).
3. Grant **Read-only** access — service accounts should never write.
4. On the next screen, **select only the dedicated vault** (step 2). Do *not* grant access to your personal vault.
5. Copy the token (`ops_eyJ...`, ~850 chars). Shown once. If lost, rotate.

Rotation later: same UI → revoke → create new → update the Keychain entry (step 3).

## Step 2 — Create a dedicated vault for agent-accessible secrets

Keep a hard boundary between "human uses this" and "an agent can read this."

1. 1Password web → **Vaults** → **New Vault**. Name it `Agents` (or similar).
2. Grant the service account **Read** on this vault only.
3. Move or copy into it only the items the agent legitimately needs. Never the vault with your personal banking / identity items.
4. Use clear item names — they become part of the `op read` reference: `op://Agents/Fastmail Agent Password/password`.

Conventions that help:
- One item per consumer, not one item with many fields shared across consumers — simplifies revocation.
- Suffix items with "Agent" (`Fastmail Agent Password`, `GitHub Agent Token`) so it's obvious in the vault which credentials are agent-scoped.
- Store the matching username/URL on the item too — `op read` can pull any field.

## Step 3 — Store the SA token in macOS Keychain

The SA token is the bootstrap secret. Put it in Keychain so it's encrypted at rest and gated by the user session.

### The 128-character silent truncation bug

macOS `security add-generic-password` has two modes for specifying the password:

| Mode | Behavior |
|---|---|
| `-w VALUE` (inline) | Stores full value |
| `-w` (no value → interactive prompt) | **Silently truncates at 128 characters** |

A 1Password SA token is ~850 chars. The interactive prompt cuts it mid-JWT. No error is raised. Later, `op` fails with a cryptic downstream error:

```
failed to session.DecodeSACredentials
unexpected end of JSON input
```

— because the base64 JWT was chopped, so the decoded JSON is invalid. If you ever see this, suspect truncation first.

### Safe install command

Pass the token as an inline argument, but keep it out of shell history by routing it through a temp file and `xargs`:

```bash
# 1. Put the token in a temp file (gitignored; delete after)
printf 'ops_eyJ...your-token-here...' > /tmp/op-token

# 2. Pipe into `security` so the token is never typed on the command line
tr -d '\n' < /tmp/op-token \
  | xargs -0 security add-generic-password \
      -s op-agent-vault \
      -a service-account \
      -U \
      -w

# 3. Shred it
rm -P /tmp/op-token    # or: shred -u on Linux
```

Flags:
- `-s op-agent-vault` — service name (arbitrary label for lookup)
- `-a service-account` — account name (arbitrary label for lookup)
- `-U` — update in place if entry already exists (for rotation)
- `-w` — read the password from the argument `xargs` appends

Don't try `-X` (hex) as a workaround — it doubles the length and often blows past `xargs`' `ARG_MAX`.

### Verify

```bash
security find-generic-password -s op-agent-vault -a service-account -w | wc -c
```

Expect ~850. If you get exactly 128, you hit the bug — re-run step 3.

## Step 4 — Load at runtime without touching disk

In `~/.zshrc` (or `~/.bashrc`):

```bash
# 1Password service account token — sourced from Keychain at shell start
export OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password \
  -s op-agent-vault -a service-account -w 2>/dev/null)"
```

Properties:
- The token lives only in this shell's process memory.
- No `.env`, no dotfile contains the token.
- A filesystem-wide grep for `ops_eyJ` turns up nothing.
- Keychain access is gated by the user's login session — if someone steals the disk, they don't get the token.

`2>/dev/null` suppresses the error when the entry doesn't exist yet (useful before first-time setup).

Restart the shell (`exec zsh`) or `source ~/.zshrc` after editing.

## Step 5 — Forward into containers and subprocesses

The rule: forward only `OP_SERVICE_ACCOUNT_TOKEN`. Never forward the resolved secrets — let the container resolve them itself via `op read`. That way, if the container is compromised, only the short-term running secrets are exposed; the SA token can be revoked immediately in 1Password and all downstream access stops.

### Docker / Apple Container

```bash
container run -it --rm \
  -e OP_SERVICE_ACCOUNT_TOKEN="${OP_SERVICE_ACCOUNT_TOKEN}" \
  -v "$PWD:/workspace" -w /workspace \
  my-image
```

### devcontainer.json

```json
{
  "remoteEnv": {
    "OP_SERVICE_ACCOUNT_TOKEN": "${localEnv:OP_SERVICE_ACCOUNT_TOKEN}"
  }
}
```

### docker-compose.yml

```yaml
services:
  app:
    image: my-image
    environment:
      OP_SERVICE_ACCOUNT_TOKEN: ${OP_SERVICE_ACCOUNT_TOKEN}
```

### systemd user service

```ini
[Service]
Environment=OP_SERVICE_ACCOUNT_TOKEN=%E{OP_SERVICE_ACCOUNT_TOKEN}
ExecStart=...
```

### SSH into a remote host

`ssh -o SendEnv=OP_SERVICE_ACCOUNT_TOKEN user@host` plus `AcceptEnv OP_SERVICE_ACCOUNT_TOKEN` in the server's `sshd_config`. Only do this if the remote is trusted — forwarding the SA token gives that host full agent-vault access.

## Step 6 — Retrieve secrets at the point of use

Install `op` inside the container (Dockerfile):

```dockerfile
RUN ARCH=$(dpkg --print-architecture) && \
    curl -sSfo /tmp/op.zip "https://cache.agilebits.com/dist/1P/op2/pkg/v2.30.3/op_linux_${ARCH}_v2.30.3.zip" && \
    unzip -o /tmp/op.zip -d /usr/local/bin op && \
    rm /tmp/op.zip && chmod +x /usr/local/bin/op
```

(On macOS: `brew install 1password-cli`.)

With `OP_SERVICE_ACCOUNT_TOKEN` set, `op` is non-interactive — no sign-in, no biometrics, no Touch ID prompt.

### Reference syntax

```
op://<Vault>/<Item>/<field>
op://<Vault>/<Item>/<section>/<field>
```

Spaces in names are fine. The `--no-newline` flag is almost always what you want when piping into other tools.

### Examples

**Email (IMAP password) — Himalaya, mbsync, msmtp, fetchmail:**

```toml
# himalaya config.toml
backend.auth.type = "password"
backend.auth.cmd = "op read 'op://Agents/Fastmail Agent Password/password' --no-newline"
```

Most mail clients with a `passwordcmd` / `PassCmd` option work the same way (mutt, offlineimap, isync).

**GitHub personal access token — gh / git:**

```bash
# ~/.zshrc or container entrypoint
export GITHUB_TOKEN="$(op read 'op://Agents/GitHub Agent Token/token' --no-newline)"
# or for git pushes:
git config --global credential.helper '!f() { echo "username=git"; echo "password=$(op read op://Agents/GitHub\\ Agent\\ Token/token --no-newline)"; }; f'
```

**SSH private key — materialize on demand, delete after:**

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
op read 'op://Agents/GitHub SSH Key/private key' --no-newline > ~/.ssh/id_agent
chmod 600 ~/.ssh/id_agent
ssh-add ~/.ssh/id_agent
shred -u ~/.ssh/id_agent    # key now lives only in ssh-agent memory
```

Or feed directly into `ssh-add` without ever touching disk:

```bash
op read 'op://Agents/GitHub SSH Key/private key' | ssh-add -
```

**Generic API key as env var:**

```bash
export ANTHROPIC_API_KEY="$(op read 'op://Agents/Anthropic API Key/credential' --no-newline)"
```

**`op run` — inject multiple secrets into one subprocess:**

```bash
# .env-like file with op:// references (safe to commit — no actual secrets)
cat > .env.tpl <<'EOF'
ANTHROPIC_API_KEY=op://Agents/Anthropic API Key/credential
GITHUB_TOKEN=op://Agents/GitHub Agent Token/token
DATABASE_URL=op://Agents/Prod DB/connection string
EOF

op run --env-file=.env.tpl -- my-app
```

`op run` resolves the references, sets the env vars for the child process only, and redacts them from its stdout/stderr.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `failed to session.DecodeSACredentials` / `unexpected end of JSON input` | 128-char Keychain truncation | Step 3 — reinstall via `xargs`, not interactive prompt |
| `echo $OP_SERVICE_ACCOUNT_TOKEN` is empty in container | Host env not forwarded | Step 5 — add `-e OP_SERVICE_ACCOUNT_TOKEN` or `remoteEnv` |
| `op` asks for sign-in | SA token not set, or set but invalid | Verify host shell has it, and it forwards into the container |
| `op read` returns nothing | Service account lacks access to that vault/item | 1Password admin UI → grant SA read on vault |
| `op read` hangs | Service account token revoked/expired | Rotate token in 1Password, update Keychain (step 3 with `-U`) |
| Keychain entry exists but `find-generic-password` can't find it | Wrong `-s`/`-a` labels | `security dump-keychain | grep op-agent` to locate |

## Security properties this gives you

- **Zero secrets on disk** (except the SA token, which is inside an encrypted Keychain blob).
- **Revocable in one click** — revoking the SA in 1Password breaks *every* downstream consumer instantly.
- **Auditable** — 1Password logs every `op read` by service account.
- **Scoped** — SA only sees the `Agents` vault, never personal items.
- **Grep-safe** — a full-disk search for token prefixes (`ops_eyJ`, `ghp_`, `sk-ant-`) turns up nothing.
- **Rotatable without code changes** — rotating a secret in 1Password is a single edit; consumers pick it up on next `op read`.

## Anti-patterns to avoid

- ❌ Giving the service account access to your personal vault "for convenience"
- ❌ Resolving all secrets at boot and exporting them as env vars into a long-running process — this recreates the "secrets sitting in memory" problem across the whole process tree. Resolve at the point of use.
- ❌ Writing `op read` output to `.env` files "to cache it" — defeats the entire design
- ❌ Sharing the SA token across multiple agents/hosts — one compromise takes them all down; use one SA per consumer
- ❌ Forwarding resolved secrets instead of the SA token into containers — if the container is compromised you can't revoke cleanly
- ❌ Storing the SA token in a dotfile — use the Keychain
