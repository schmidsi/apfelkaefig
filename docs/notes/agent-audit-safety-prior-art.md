# Agent Audit & Safety — Prior Art Scan

> Market/prior-art research for the three workstreams in `agent-audit-safety.md`. Living document.
> Date: 2026-08-20. Compiled from web research (2025–2026 state); claims marked *(unverified)*
> came from single secondary sources.

**Headline:** every ingredient of all three layers exists somewhere, but no product — open or
closed — composes any layer completely, and nothing composes the layers together. The two
name-checks from the brain dump resolved: "Centaur" is real (**Paradigm's Centaur**, open-sourced
May 2026 — the closest single prior art for layer 1), and "Hermis" is **Hermes Agent** (Nous
Research, ~Feb 2026) — which, together with OpenClaw, confirms the "pet" anti-pattern for
layer 3.

---

## Layer 1 — Flight recorder

### Landscape

| Project | Source | What it is | Closeness |
|---|---|---|---|
| **Centaur** (Paradigm) — [repo](https://github.com/paradigmxyz/centaur), [announcement](https://www.paradigm.xyz/2026/05/open-sourcing-centaur-multiplayer-self-hosted-secure-agents) | Open (Apache-2.0) | Self-hosted secure agent runtime: per-thread sandbox containers, network firewall ("iron-proxy") logging every outbound request, LLM responses scanned/redacted for secret leaks, audit logs + execution state in Postgres. Agent-agnostic (Claude Code, Codex, Amp). | **High** — closest architectural match, but it's a whole Slack-native *runtime*, not a standalone recorder; no append-only guarantee; no thinking traces |
| **Anthropic Compliance API** — [docs](https://platform.claude.com/docs/en/manage-claude/compliance-sessions) | Closed, Enterprise-only | Full Claude Code / Claude session transcripts of all org users, exposed to compliance reviewers | **High** — literally the concept, but Anthropic-hosted, Claude-only, not yours |
| **Claude Code OTel export** — [docs](https://code.claude.com/docs/en/monitoring-usage) | Open protocol | Streams metrics/events (with opt-in full prompts + tool I/O, ~60KB truncation) to any OTLP collector — the natural multi-machine transport | **High** as transport; but instrumentation lives *inside* the agent process (env-var controlled), thinking not clearly exported, Claude-Code-only |
| **Invariant Explorer + Gateway** (→ Snyk) — [gateway](https://github.com/invariantlabs-ai/invariant-gateway) | Open | LLM-proxy capture into a security-oriented trace explorer; hosted Explorer shut down Jan 2026 *(unverified)* | **High** — the one security-forensics trace store; effectively wound down. The niche is open |
| **Coder Agent Boundaries/Firewall** — [blog](https://coder.com/blog/launch-dec-2025-agent-boundaries) | Core OSS + commercial | Process firewall around any agent CLI; HTTP audit stream to central control plane | **High** on boundary capture; network actions only, no transcripts |
| **Block Goose** — [repo](https://github.com/block/goose) | Open | Local SQLite session DB (full messages, tool calls, results) + optional OTel export | **Med** — confirms the hunch; per-machine, Goose-only, mutable, debugging framing |
| Langfuse / Arize Phoenix / AgentOps / Sentry agent monitoring / Helicone / LiteLLM | Mostly open | Self-hostable LLM observability: traces of LLM/tool calls, cost, evals, session replay | **Med** — could be the *storage backend*, but SDK-fed from inside the trust domain, eval/cost framing, mutable rows |
| claude-code-otel dashboards, claude-code-log, sniffly, **Omnara** — [Omnara](https://github.com/omnara-ai/omnara) | Open | Community tools rendering/centralizing Claude Code's local JSONL transcripts; Omnara streams live sessions to a central dashboard | **Med** — proves the raw material (incl. thinking blocks) exists locally; steering/monitoring UX, not forensic retention |
| Elastic / Monad / General Analysis "Claude Code → SIEM" guides | Patterns | Full-fidelity OTel piped into a SIEM for detection rules | **Med-High** — the exact *framing*, as DIY guides only |

### Gaps (what nobody ships)

1. **Append-only / tamper-evident storage.** All observability stores are mutable DB rows,
   deletable with credentials the agent's environment often holds. Hash-chained/WORM agent audit
   trails exist only as compliance write-ups and research prototypes (CapSeal, arXiv 2604.16762).
2. **Capture outside the agent's trust domain.** Nearly everything is in-agent SDK/exporter
   instrumentation a prompt-injected agent could suppress or falsify. Gateways see only LLM
   traffic; Coder sees only network actions. **Nobody combines boundary-level capture of both the
   LLM stream and executed tool/file/network actions into one forensic record.** For an akf
   micro-VM, capturing at the VM boundary is unoccupied ground.
3. **Thinking traces, centrally.** Local JSONL transcripts have them; no central pipeline
   preserves them except the closed Compliance API. 2026 incident post-mortems complain "logs
   show tool calls without the reasoning behind them."
4. **A standalone recorder.** Centaur bundles it in a runtime; Langfuse needs SDK adoption;
   Compliance API needs Anthropic Enterprise. A lightweight append-only sink that any agent's
   existing artifacts (JSONL, OTel, proxy logs) stream into does not exist.

---

## Layer 2 — Boundary filters

### Landscape

| Project | Source | Interception | Closeness |
|---|---|---|---|
| **coder/httpjail** — [repo](https://github.com/coder/httpjail) | Open (CC0) | Transparent TLS MITM (local CA, per-SNI certs) wrapping any process; JS/script rules outside the wrapped agent; request log | **High** — closest OSS *primitive* to the mechanism; no content redaction, process-level not VM-level |
| **Coder Boundary / Agent Firewall** — [repo](https://github.com/coder/boundary) | Core MIT + enterprise | Namespace jail + TLS-inject proxy around agent CLIs; allow/deny on method/domain/path; audit stream | **High** — same problem statement; no content inspection |
| **Anthropic sandbox-runtime + Claude Code web proxy** — [srt](https://github.com/anthropic-experimental/sandbox-runtime) | Open (preview) | OS sandbox + forced proxy; web version adds microVM + **credential-holding proxy** (secrets never enter the sandbox). Two published allowlist-bypass exfil writeups | **High** mechanism / **Med** features — domain allowlists only; the bypasses show hostname filtering isn't enough |
| **Docker Sandboxes** — [blog](https://www.docker.com/blog/docker-sandboxes-run-claude-code-and-other-coding-agents-unsupervised-but-safely/) | Closed | microVM, no direct network, host-side policy proxy, host-held credentials | **High** — apfelkäfig's exact topology, for Docker; domain-level only *(granularity unverified)* |
| **github/gh-aw-firewall** — [repo](https://github.com/github/gh-aw-firewall) | Open | Squid domain allowlist + **API-key sidecar so LLM keys never enter the agent container** (CI-focused) | **High** — same topology, prevention-by-construction for secrets |
| **Invariant Gateway/Guardrails/mcp-scan** (Snyk) | Open | Base-URL LLM/MCP proxy with a rich rules DSL (data-flow, tool restrictions, secret/PII detectors) + coupled trace explorer | **High** on rules; cooperative interception — an agent that ignores the base URL escapes it |
| **Pipelock** — [repo](https://github.com/luckyPipewrench/pipelock) | Open (young) | Mediating proxy (HTTP/WS/MCP), optional TLS MITM, secret-exfil/injection scanning, **mediator-signed action receipts** | **High** pitch; low maturity |
| LiteLLM (enterprise secret redaction, Presidio masking) / Portkey / Kong **AI PII Sanitizer** / Envoy AI Gateway (credential injection) / Cloudflare AI Gateway | Mixed | Cooperative gateways. Kong has the best redaction semantics: regex secrets (their example is a GitHub token), placeholder or synthetic replacement, **bidirectional with round-trip restoration** | **Med** — right filter capabilities, wrong enforcement tier |
| Docker MCP Gateway | Open | MCP-layer interceptors that inspect/modify/block tool calls, `--block-secrets` both directions | **Med** — modify-capable boundary + audit, MCP slice only |
| LLM Guard (archived 2026) / Presidio / NeMo Guardrails / Guardrails AI | Open | In-process detector/redaction libraries | **Low** as architectures, **high** as reusable detector logic |
| Prisma AIRS, Lakera (Check Point), Prompt Security (SentinelOne *(unverified)*), Zscaler/Netskope | Closed | Enterprise inline AI firewalls / SSE TLS-inspecting DLP with deployed CAs | Architecturally *is* the concept, at corporate-network scale, closed |

### Gaps

1. **MITM at a VM boundary.** OSS TLS-MITM wrappers are process jails on the host; the microVM
   products that sit at a real boundary all stop at domain allow/deny. "Host-side MITM proxy +
   CA injected into the guest image" as a composable component for local micro-VM sandboxes
   doesn't exist — on Apple `container` it's greenfield.
2. **Can't-bypass + content rewrite, together.** Redaction exists only in cooperative gateways
   or in-process libraries; enforcement-grade boundaries are content-blind. Nobody rewrites
   bodies (strip keys outbound, scrub inbound) at a boundary the agent can't route around. Hard
   unsolved detail: redaction inside **streamed SSE responses** where a secret straddles chunks.
3. **Filter = recorder.** No tool makes the boundary filter also the flight recorder (full
   capture, redaction-aware logging, replayable, from the same trusted component). Invariant
   came closest; Pipelock's signed receipts are the right instinct.
4. **Credential injection.** The strongest emerging adjacent pattern (Claude Code web,
   gh-aw-firewall, Envoy, Docker sbx): don't redact secrets — **never let them into the cage**,
   inject at the proxy. A boundary filter should do both directions: injection inbound,
   detection-based redaction outbound.

---

## Layer 3 — Cattle-not-pets governance

### Landscape

| Project | Source | Pattern covered | Closeness |
|---|---|---|---|
| GitOps + progressive delivery (ArgoCD, Flux, Argo Rollouts, Flagger) | Open (CNCF) | Declarative state in git, reconcilers, metric-gated auto-rollback | **High on mechanism, zero on agents** — the substrate the concept assumes |
| **GitHub Continuous AI + gh-aw** — [repo](https://github.com/github/gh-aw) | Open (MIT) | Agents in Actions: read-only by default, sandboxed, "safe outputs" — writes buffered/validated/applied in separate scoped jobs | **High** — strongest institutional "agent never mutates directly"; no deploy watching, rollback, or supervisor |
| PR-only cloud agents (Claude Code Actions, Codex cloud, Jules, Devin) | Mixed | Ticket → sandbox → PR → CI → human review | **Med** — a workflow convention, not an enforced invariant; no rollback |
| **Ralph Wiggum loop** (Huntley) — [repo](https://github.com/ghuntley/how-to-ralph-wiggum) | Open | Disposable agent process, repo + tests as sole persistent state and gate | **Med-High** — same philosophy, build-time only |
| **"Kitchen Loop"** (arXiv 2603.25697, Mar 2026) | Paper | Spec-driven self-evolving codebase; synthetic power-user; "Unbeatable Tests"; drift-control pause gates; 1,094 merged PRs claimed | **High** — closest academic articulation; pauses rather than rolls back; no code released |
| **OpenClaw** — [docs](https://docs.openclaw.ai) | Open | Always-on personal agent; state = mutable `~/.openclaw` pile; docs call restore "time travel" (credential desync, manual multi-step recovery); self-modification mutates live state | **The anti-pattern, verified.** Container guides say "containers are cattle" while the state stays the pet |
| **Hermes Agent** (Nous Research) — [repo](https://github.com/NousResearch/hermes-agent) | Open | Same shape: mutable `$HERMES_HOME` on one host; backup is a community add-on, not a design property | **Second data point for the anti-pattern** — this is the "Hermis" from the brain dump |
| HolmesGPT / kagent (CNCF) | Open | The supervisor half: read-only AI SRE investigation; agents-as-CRDs in git | **Med** — investigates but doesn't close the loop into the app's repo |
| OpenHands SDK | Open (MIT) | **Event-sources agent conversation state** (immutable events, rebuild by replay); resolver acts via PRs | **Med** — proves event-sourcing-for-replay in agent systems, applied to the wrong state |
| Ink & Switch "Malleable Software" (2025) | Essay | The vision for user-reshapeable software | **Med** — the *why*, silent on governance |
| **Val Town + Townie** — [docs](https://docs.val.town/guides/prompting/townie/) | Closed platform | **Closest dual-interface product**: real HTTP UIs + agent that reads/writes code, queries the app's SQLite and logs, schedules crons; every change auto-versioned with instant restore | **High** — dual UI+agent + rollback exist; changes apply live (no CI gate), rollback manual, data/schema not versioned with code |
| Replit Agent / Lovable / Bolt / Base44 | Closed | Chat-evolved apps with checkpoints; Replit/Base44 do agent-driven schema changes | **Med** — matching UX; direct deploys, schema rollback not atomic with code *(2026 specifics unverified)* |

### Gaps

**No named project, open or closed, combines:** declarative-only agent changes + CI gate +
auto-rollback + investigating supervisor. Per component:

1. **Event-sourced *app* state** is the most novel piece: everyone rolls back *code* while data
   sits stranded on the new schema. Event-sourcing the domain state is what makes
   "last-known-good" meaningful when the agent just changed the schema — validate migrations by
   replay, roll back atomically.
2. **Pipeline-only mutation** has the best coverage (gh-aw safe outputs) but only as CI-time
   convention — never as a governance invariant over a *deployed long-running* system. Nobody
   has published "OpenClaw/Hermes, but self-modifications are repo commits and the host is
   disposable."
3. **Rollback → investigate → re-attempt as a closed circuit**: rollback (Argo/Flagger) and
   investigation (HolmesGPT) exist separately; Harness is fusing them commercially for
   enterprise CD. The supervisor filing its post-mortem back as a repo artifact the authoring
   agent consumes is unbuilt.
4. **Dual UI + agent on one core**: only Val Town approximates it, without (1), (3), or a CI
   gate.

---

## Synthesis — what this means for the workstreams

1. **Layers 1 and 2 are one component.** The research confirms the design note's hunch from both
   directions: the recorder's biggest gap is capture *outside the agent's trust domain*, and the
   filter's biggest gap is *doubling as the recorder*. The differentiated artifact is a single
   host-side boundary proxy that records everything, enforces content-aware rules, redacts
   streams, and injects credentials — none of the ~30 surveyed tools does that combination, and
   on Apple `container` the lane is empty (as usual).
2. **Steal, don't build, the detectors.** Kong's round-trip placeholder replacement is the
   redaction semantic to copy; LLM Guard (archived) / detect-secrets / gitleaks are the detector
   rulesets; Presidio for PII. The hard novel engineering is streaming-safe redaction and
   tamper-evident (hash-chained) logs.
3. **Adopt credential injection as a first-class principle** alongside redaction: secrets that
   never enter the cage can't leak from it. Prior art: Claude Code web's token proxy,
   gh-aw-firewall's sidecar.
4. **Watch Centaur and Coder.** Centaur validates the demand and shares the philosophy but
   chose "opinionated runtime"; the akf angle is "composable component for the sandbox you
   already run." Coder's Boundary/httpjail are the closest OSS mechanism and could converge
   toward this.
5. **Layer 3 is a separate product with validated pieces and an unoccupied composition** —
   "GitOps for self-modifying personal software." Kitchen Loop and gh-aw are the intellectual
   neighbors to cite; OpenClaw and Hermes are the documented anti-pattern to position against;
   Val Town is the dual-interface UX benchmark. The novel technical claim is event-sourced app
   state making schema changes replayable and rollback atomic. This belongs in
   agent-orchestrator territory, not akf.

## Fork or contribute to Centaur? (assessed 2026-08-20)

**No fork, no build-on; tactical contributions at most.** From reading the repo:

- **Stack mismatch:** Rust control plane (`services/api-rs`) + Python + Postgres, deployed on
  Kubernetes (k3s minimum), per-conversation sandboxes under default-deny NetworkPolicies.
  Forking = operating their platform. Against akf's scope (Deno, Apple `container`, one Mac),
  that's adoption cost, not acceleration.
- **Inverted logging philosophy (decisive):** `iron-proxy` is a *pinned upstream image* wrapped
  by a Dockerfile/entrypoint/yaml — not separable code — and its logging contract **mandates
  redaction** (JSON logs must exclude request headers, credential values, upstream response
  bodies). Their threat model minimizes logs as a leak surface; ours treats the full log as the
  product. "Record everything" is a design inversion, not a contribution.
- **Health:** ~1.2k stars, 211 forks, 883 commits, active; org-driven toward "one shared team
  agent." Apache-2.0 per announcement (verify in-repo before vendoring anything).

**Do instead:** steal patterns (placeholder-credential swap, `docs/pages/security.mdx` threat
model, unmanaged-mode config seeding); contribute a small fix/doc PR while studying it if the
occasion arises; design the akf recorder's trace format for interop (OTel ingest) so
Centaur-style deployments become potential consumers. Their deliberate non-recording of content
is exactly our opening — same rhyme as Docker Sandboxes vs. Apple `container` in
`positioning.md`.

## Corrections to the design note

- "Centaur" (heard in the voice memo) = **Paradigm's Centaur**, not Sentry.
- "Hermis" = **Hermes Agent** by Nous Research — the pet critique in the note is accurate and
  now sourced (OpenClaw's own docs call restore "time travel"; Hermes backup is a community
  add-on).
