# Apfelkäfig — Positioning & Naming

> Session notes from the naming + positioning brainstorm. Living document.
> Date: 2026-04-08

## Name

**Apfelkäfig** (German: "apple cage")

- ASCII spelling: `apfelkaefig`
- Pronunciation: roughly *AP-fel-KAY-figg*
- Origin: started from "Apple Cage" (sandbox/isolation metaphor for Apple's
  native `container` CLI), translated to French ("Cage de Pomme"), then German
  for the crunchy, brandable, slightly-absurd Kraftwerk/Kindergarten energy.
- The ambiguity in the German compound is a feature: it reads as both
  "cage *for* apples" (your code/agent inside) and "cage *made of* Apple"
  (built on Apple's container tech).

### Why this name
- Concrete, memorable, ownable (zero footprint anywhere — see Availability).
- Foreign-word charm in the tradition of Docker's "Moby", Vercel's fake-Latin,
  etc. A name you *learn*, with a satisfying click once explained.
- Neutral enough to carry both the dev-tool and agent-sandbox stories without
  dating the product to the 2026 agent hype cycle.

### Binary / CLI name (open question)
Leaning toward **`akf`** as the daily-driver binary, with `apfelkaefig` as the
package/brand name. Same pattern as `kubectl`/Kubernetes, `gh`/GitHub CLI.
Three keystrokes beats eleven. Not finalized.

## What it is

A sandboxed dev environment built on **Apple's native `container` CLI**
(Apple Silicon, lightweight VMs, much faster than Docker Desktop). Disposable,
hermetic dev shells that are *also* safe to point coding agents at.

### Positioning
**Dual-use, dev-first.** Don't pitch as "agent sandbox" only — that's a narrow
wedge that evaporates when Claude/Codex/Gemini ship better native sandboxing.
Pitch as:

> Disposable Mac dev environments. Safe enough for agents.

- **Primary audience:** Mac devs who want reproducible, disposable envs —
  Docker Desktop refugees, nix-curious folks, people burned by `brew` rot.
- **Killer demo:** point Claude Code / Codex / Gemini CLI at a fresh
  Apfelkäfig and let them rip without fear.
- **Defaults matter:** `apfelkaefig init && apfelkaefig shell` must feel
  first-class for a human; agent mode is one flag away, never the other way
  around.

### Taglines in the running
- *"Disposable Mac dev environments. Safe enough for agents."*
- *"A cage for your code — and your agents."*
- *"Hermetic dev shells on Apple Silicon."*
- *"Docker Sandboxes, native to Apple Silicon."* (head-on positioning)

## Competitive landscape (as of 2026-04)

### Agent-native sandboxing (the agents themselves)
- **Claude Code:** Native sandboxing since Oct 2025 via OS primitives —
  bubblewrap (Linux), Seatbelt (macOS). Process confinement, not VMs.
  April 2026 added apply-seccomp helper and `sandbox.failIfUnavailable`.
- **Codex CLI (OpenAI):** Own sandboxing profiles. Considered the
  "execution safety" leader in 2026 comparisons.
- **Gemini CLI (Google):** Process-level + Docker-based isolation.
  No Apple `container` integration.

### Wrapper / container sandboxes (the crowded space — all Docker, all cross-platform)
- **Docker Sandboxes** (March 2026): Docker's official entrant. Lightweight
  microVMs, dedicated Linux kernel per agent. Supports Claude Code, Gemini CLI,
  Codex, Copilot CLI, OpenCode, Kiro. Heavy on Mac (Docker Desktop overhead).
- Morph Docker Sandbox, libops/cli-sandbox, spieseba/docker-sandbox,
  zzev/aibox — all Docker-based multi-agent wrappers.

### Apple `container`-native (our actual lane — nearly empty)
- **emarc/claude-contained:** Only real overlap. Dual-mode script supporting
  both Docker and Apple `container`. Known limitation: no localhost port
  forwarding on the Apple path. **Read their code before we hit the same
  networking gotchas.**
- **ses.box reference post** (Feb 2026, Infralovers): DIY Dockerfile/script
  walkthrough. Not a packaged tool. Notes networking bugs in Apple `container`
  during image builds. <https://www.ses.box/posts/sandbox-claude-apple-container>

### Strategic implications
1. **Apple `container` as substrate is uncontested as a productized tool.**
   Docker/Anthropic/OpenAI/Google are all going cross-platform Linux/Docker.
   That's our moat — and exactly the overhead problem we exploit on Apple
   Silicon.
2. **Move now.** Apple `container` is pre-1.0 (v0.9, Feb 2026) with networking
   bugs. That's both opportunity and risk. First-mover with a real product
   wins the category before the big players notice.
3. **Polish and DX are the differentiators**, not the substrate choice.
4. **Position against Docker Sandboxes head-on.** Their March 2026 launch
   validates the category. Our pitch: same idea, native to Apple Silicon,
   no Docker Desktop tax.
5. **Watch emarc/claude-contained** — only direct competitor.

## Availability (checked 2026-04-08)

Clean across the board for both `apfelkäfig` and `apfelkaefig`:

- ✅ Google / web — zero results
- ✅ GitHub — no repos, orgs, users
- ✅ npm — no package
- ✅ PyPI / crates.io / Homebrew — no collisions
- ✅ X/Twitter — no indexed presence
- ✅ Domains — apfelkaefig.com **acquired**

## Assets claimed
- ✅ **apfelkaefig.com** (domain)
- ✅ **github.com/ApfelKaefig** (org)
- ⬜ npm `apfelkaefig` (stub to reserve)
- ⬜ X/Twitter `@apfelkaefig`
- ⬜ apfelkaefig.dev
- ⬜ PyPI `apfelkaefig` (stub)
- ⬜ Homebrew tap `apfelkaefig/tap` (no reservation needed)

## Open questions
- Final binary name (`akf` vs `apfelkaefig` vs `kaefig`)
- Implementation language (Rust? Go? Shell + something?)
- Repo structure: single `apfelkaefig/apfelkaefig` or split CLI / docs / etc.
- How to handle the Apple `container` networking bugs (port forwarding,
  build-time networking) — workarounds or upstream fixes?
