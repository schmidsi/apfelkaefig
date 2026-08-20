# Agent Audit & Safety — Layered System

> Session notes from a voice brain dump, organized. Living document. Date: 2026-08-20

The starting point: apfelkäfig works well for what it is — a cage. This note is about the more
holistic system around the cage, which could exist as an akf module or as a standalone thing.
Three layers fell out of the dump, ordered by build sequence: **record** everything, **filter**
what crosses the boundary, **govern** how systems change. Plus a threat model that motivates all
three.

> Prior-art scan for all three layers: [`agent-audit-safety-prior-art.md`](agent-audit-safety-prior-art.md)
> (2026-08-20). Short version: every ingredient exists, no product composes any layer completely,
> and layers 1+2 should probably be one component (the boundary filter *is* the recorder).

## Threat model

The worst cases for agentic systems — especially prompt-injected or otherwise rogue LLMs — in
rough order of severity:

1. **Irrecoverable damage.** Data is lost or something breaks *and we cannot intervene or
   reconstruct what happened*. The compounding failure isn't the breakage, it's the blindness.
2. **Data exfiltration.** Confidential data leaks out. Probably impossible to fully prevent, but
   it can be mitigated (layer 2) and at minimum reconstructed after the fact (layer 1).

The cage (apfelkäfig today) limits blast radius. The layers below add observability, boundary
enforcement, and recoverability.

## Layer 1 — Flight recorder (the MVP)

A system that logs **everything** the agent does:

- the full thinking process (the reasoning you usually don't see in the UI),
- every tool call — both *requested* and *executed*,
- all inputs / prompts, everything crossing the wire.

Shape:

- **A server, not a local file.** Spans multiple machines. Scales conceptually to a team /
  enterprise setup where everybody streams everything into one central store.
- **Append-only.** The point is forensics: if data leaked or something went wrong, the log is
  what lets us reconstruct the incident. (This also implies the agent must not be able to alter
  its own log — which is why it lives *outside* the cage.)

**Deliberately deferred: access control.** Real deployments have confidential data in the stream
(private keys, salaries, …) and would need per-record sensitivity / ACLs. For the MVP it's a
personal tool: store everything, whoever has access sees everything. Don't design the ACL system
now.

## Layer 2 — Boundary filters (outside the cage)

Once traffic is being recorded, the same interception point can *enforce*:

- Filters sit **outside the container**, inspecting the tool calls and prompts flowing between
  the caged agent and the LLM API servers.
- Rules are **imposed from the outside and unchangeable from the inside** — the agent (or a
  prompt injection riding on it) cannot see, modify, or disable them.
- Beyond block/allow: **replacement / redaction** — e.g. detect private-key-looking strings in
  outbound traffic and strip or substitute them before they leave.

This is the natural apfelkäfig extension: the cage already owns the network boundary; a
MITM-proxy plugin for LLM traffic is the obvious integration point (and the log of layer 1 is
just the passive mode of the same tap).

## Layer 3 — Cattle, not pets: self-changing systems with rollback

The wider systems-design idea, beyond a single sandbox session. Reference point: the Rancher-era
DevOps mantra *"treat your servers as cattle, not pets"* — never SSH in and mutate state by
hand, because you lose track of how the system reached its current state. Applied to agents:

- **The agent never mutates the running system directly** — e.g. it can never `apt install`
  into a live container. Ever.
- **All change goes through declarative, atomic config** (the Dockerfile, the app's own repo).
  The agent *is* allowed to change that config — it commits, pushes to the repository, a build
  triggers, tests run, and only a green build redeploys.
- **Rollback is first-class and cheap**, ideally automatic: if a deploy goes wrong, snap back to
  the last known-good state, then investigate from the flight recorder.

Motivating example: a self-modifying app — say a personal financial tracker with a chat UI,
where the app can change its own software. Event sourcing fits here (the app's state, like the
audit log, is an append-only stream you can replay), though that pulls further into application
architecture than the sandbox itself.

This is roughly the idea behind the existing **agent-orchestrator** repo: a supervisor that
watches what the projects are doing, and on failure rolls back and investigates.

## How the layers relate

```
record  →  filter  →  govern
(layer 1)  (layer 2)  (layer 3)
```

- Layer 1 is pure observation and is the prerequisite for everything else — build it first.
- Layer 2 reuses layer 1's interception point and adds policy.
- Layer 3 is a different altitude (deployment lifecycle, not session traffic) and probably lives
  in agent-orchestrator, not in akf — but it consumes layers 1 and 2 as its evidence and
  enforcement base.

## Module vs. standalone

Open. Tension:

- **akf module (plugin):** the cage already owns the boundary; a proxy/recorder plugin gets
  distribution and integration for free. Fits "minimal core, powerful plugins."
- **Standalone server:** the multi-machine / team story ("everybody streams into central
  storage") outgrows a single Mac's sandbox tool. Also useful to people who don't run akf.

Plausible resolution: the *tap* (interception, streaming) is an akf plugin; the *store* (server,
retention, query UI) is standalone. Undecided.

## Open questions

- Storage/transport for the flight recorder — what's the simplest thing that is append-only,
  multi-machine, and queryable? (Plain JSONL over HTTP? SQLite on a server? Actual event store?)
- Where exactly to tap: MITM TLS proxy on the container's egress vs. instrumenting the agent
  harness (Claude Code hooks etc.). Proxy is agent-agnostic; hooks see richer structure
  (thinking, tool schemas).
- Can filter rules be expressed simply enough to trust? (Regex/heuristic redaction gives false
  confidence for secrets — decide how honest to be about that.)
- Relationship to agent-orchestrator: does layer 3 fold into that repo, and does this note's
  system become its sensor layer?
- Name / scope: is this one product or three?
