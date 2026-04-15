# Plan: `akf init --minimal`

## Context

A second init surface for cases where the user wants to point an untrusted agent at a sandbox
*with no ambient access to their machine*. The regular `akf init` leans on "the VM is the sandbox"
and freely mounts `$WORKSPACE`, `$HOME/.claude` (RW), and `$HOME/Downloads` (RO). `--minimal`
flips the default: **nothing from the host is shared, and outbound network is allowlisted to
Anthropic endpoints only.**

Positioning: "I want to let this thing rip and I don't care if it burns down its own world."

## Decisions (2026-04-15 session)

1. **No host folder mounts.** Drop `-v $WORKSPACE`, `-v $HOME/.claude`, `-v $HOME/Downloads`.
   `/workspace` becomes tmpfs (ephemeral — nothing survives the run, by design).
2. **Claude auth.** The existing `-e ANTHROPIC_API_KEY` pass-through was already removed
   (commit TBD on the current branch). For `--minimal`, accept that the user must have
   `ANTHROPIC_API_KEY` set — we're not mounting `.claude/.credentials.json`. If the user has
   no API key, `--minimal` errors out with a clear message; the OAuth subscription path is
   intentionally excluded to keep zero files shared from host.
   - Open: revisit if enough users push back. A single-file bind of
     `~/.claude/.credentials.json:ro` would be the concession. Don't do it preemptively.
3. **Egress firewall, Anthropic-only.** iptables + ipset allowlist for `api.anthropic.com` and
   `statsig.anthropic.com`. Everything else `DROP`. No `sentry.io`, no GitHub, no npm/PyPI.
   Rationale: "minimal" speaks for itself.
4. **Known residual risk, accepted.** Prompt injection → server-side tool use (web search,
   `WebFetch`) → attacker-controlled URL is still an exfil channel. The firewall doesn't
   close that hole; nothing on our side can. Worth stating in the README section for `--minimal`.
5. **DNS tunneling, not mitigated.** Allow UDP/53 outbound to any resolver. Pinning DNS to the
   container gateway would tighten this, but (a) it's a sophisticated attack that isn't our main
   concern, and (b) point 4 above is a bigger hole anyway.

---

## 0. Spike: does Apple `container` v0.9 let iptables run inside the VM?

**Status:** iptables is not currently installed in `claude-sandbox`, so the first probe errored
with `failed to find target executable iptables`. That's expected, not a real failure.

Actual spike:

```bash
# add `iptables ipset dnsutils` to templates/.devcontainer/Dockerfile apt-get line
./build.sh
container run --rm -u root claude-sandbox iptables -L
container run --rm -u root claude-sandbox sh -c "iptables -A OUTPUT -j DROP && iptables -L OUTPUT"
container run --rm -u root claude-sandbox sh -c "ipset create test hash:net && ipset list"
```

What we need to learn:
- Does `iptables -L` work at all (kernel module loaded in the Apple VM kernel)?
- Can we actually add a rule (CAP_NET_ADMIN effectively present when `-u root`)?
- Does `ipset` work (requires the ipset kernel module)?

If any of these fail, the whole `--minimal` firewall plan needs a rethink (nftables? host-side
`pf`? give up on network isolation and rely only on the no-mounts story?). Do this spike first,
before writing anything else.

---

## 1. Image changes

Add to `templates/.devcontainer/Dockerfile`:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    iptables ipset dnsutils gosu \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh init-firewall.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/init-firewall.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

The `USER node` / `USER root` dance stays — container starts as root (default), entrypoint
handles the drop to `node` via `gosu`.

### `templates/.devcontainer/entrypoint.sh`

```bash
#!/bin/bash
set -e
if [ "${AKF_MINIMAL:-0}" = "1" ]; then
  /usr/local/bin/init-firewall.sh
fi
exec gosu node claude --dangerously-skip-permissions "$@"
```

### `templates/.devcontainer/init-firewall.sh`

```bash
#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

iptables -F; iptables -X
iptables -t nat -F; iptables -t nat -X
ipset destroy allowed-domains 2>/dev/null || true

# Loopback
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# DNS (accepted exfil risk)
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT

# Anthropic allowlist
ipset create allowed-domains hash:net
for d in api.anthropic.com statsig.anthropic.com; do
  ips=$(dig +short A "$d")
  [ -z "$ips" ] && { echo "firewall: cannot resolve $d" >&2; exit 1; }
  while read -r ip; do ipset add allowed-domains "$ip"; done <<<"$ips"
done

iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# Verify
curl -s --connect-timeout 3 https://example.com >/dev/null 2>&1 \
  && { echo "firewall: leak — example.com reachable" >&2; exit 1; } || true
curl -s --connect-timeout 5 https://api.anthropic.com >/dev/null 2>&1 \
  || { echo "firewall: api.anthropic.com unreachable" >&2; exit 1; }
echo "firewall: ok"
```

---

## 2. `start.sh` changes

Current `templates/start.sh` passes `-u node -w /workspace claude-sandbox claude
--dangerously-skip-permissions "$@"`. Once the image has an ENTRYPOINT that does both:

- Drop `-u node` (entrypoint drops with `gosu`).
- Drop the trailing `claude --dangerously-skip-permissions "$@"` (entrypoint runs it).
- Keep `"$@"` passed to the image so prompts still forward.

### `templates/start.sh` (normal mode, post-restructure)

```bash
exec container run -it --rm \
  --cpus 2 --memory 4G \
  -v "$WORKSPACE:/workspace" \
  -v "$HOME/.claude:/home/node/.claude" \
  --mount "type=bind,source=$HOME/Downloads,target=/home/node/Downloads,readonly" \
  -e CLAUDE_CONFIG_DIR=/home/node/.claude \
  -w /workspace \
  claude-sandbox "$@"
```

### `templates/start-minimal.sh` (new)

```bash
exec container run -it --rm \
  --cpus 2 --memory 4G \
  --tmpfs /workspace \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY required for --minimal}" \
  -e AKF_MINIMAL=1 \
  -w /workspace \
  claude-sandbox "$@"
```

Note the `:?` parameter expansion — fail fast with a clear message if the user forgot to export
an API key.

---

## 3. CLI changes

- `src/commands/init.ts`: accept `--minimal` flag. When set, emit `start-minimal.sh` instead of
  (or alongside?) `start.sh`.
  - Open: ship both by default (so users can try either)? Or only what was asked for? Lean
    "both" — the extra 30 lines of bash on disk are cheap and make the choice visible.
- `src/main.ts`: thread the flag through.
- `templates/CLAUDE.block.md`: mention the `start-minimal.sh` option and its guarantees
  (no mounts, Anthropic-only egress).
- `templates/gitignore.block`: no change — both scripts are scaffold-generated and should stay
  out of ignore.

---

## 4. Tests / verification

- Extend `src/commands/init_test.ts` (after it's created in `002`): run `runInit({ minimal: true })`
  against a tmpdir, assert `start-minimal.sh` lands with 0755.
- Add a manual-test recipe in README "Verifying `--minimal`": run `start-minimal.sh` and ask
  Claude "curl https://example.com" — it should fail; "what's your API endpoint" should succeed.

---

## 5. Docs

- README: new section "Two modes — normal vs minimal" with a one-paragraph table of what each
  shares/blocks. Link to this task file while it's still in draft; inline once merged.
- SKILL.md: update the manual-setup guide so the two `start.sh` variants are both documented.
- POSITIONING.md: brief addition — "strictest-by-default mode" is a differentiator vs.
  `emarc/claude-contained` and Docker Sandboxes.

---

## Open questions

- **Does `gosu` actually forward signals properly in Apple container?** `tini` might be needed
  as PID 1 if Ctrl-C gets eaten. Find out during the spike.
- **Should `--minimal` also disable `--dangerously-skip-permissions`?** The whole point of that
  flag was "the VM is the sandbox." With `--minimal`, the VM is still the sandbox but the
  threat model is paranoid — might want Claude Code's own permission prompts back on as a second
  layer. Probably not, but worth a conscious decision.
- **Is `--tmpfs /workspace` the right surface?** Alternative: use a named anonymous volume so
  files persist across `start-minimal.sh` invocations of the same "project." tmpfs is simpler
  and matches the "disposable" framing better. Default tmpfs; add a flag later if needed.

---

## Definition of done

- Spike done; `iptables`/`ipset` confirmed working in the image on Apple container v0.9.
- `akf init --minimal` emits a working `start-minimal.sh` alongside `build.sh` and `start.sh`.
- Running `./start-minimal.sh` inside a scratch dir:
  - comes up with an empty tmpfs `/workspace`,
  - has a working `claude` session authenticated via `ANTHROPIC_API_KEY`,
  - blocks `curl https://example.com` (firewall),
  - allows `curl https://api.anthropic.com`.
- README has a "Two modes" section.
