# Plan: 009 — Drop Docker, build images with Apple `container build`

## Context

`akf build` currently shells out to **`docker build`** and then shuttles the resulting image into
Apple `container` through a throwaway local registry. The only reason for this detour is documented
in the code itself:

- `cli/commands/build.ts:1-3` — *"Builds a custom image with Docker (Apple `container`'s builder
  has DNS bugs in v0.9), shuttles it through a local registry, and pulls into Apple `container`."*
- `cli/lib/registry.ts:1-4` — *"Local docker registry on :5555 used as a shuttle for moving images
  from Docker (which can build) into Apple `container` (which has DNS bugs in v0.9 during builds)."*

That DNS bug was the entire justification for the Docker dependency. **It is fixed in Apple
`container` 1.0.0.**

### Verification already done (2026-06-13, on `container CLI 1.0.0 (build ee848e3)`)

A deliberately DNS-heavy build was run through Apple's own builder and succeeded end to end:

```dockerfile
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /dev/null https://deb.debian.org/debian/dists/bookworm/Release && echo "DNS+HTTPS OK"
```

```
container build -t akf-dns-test:latest -f Dockerfile .
```

- `apt-get update` (DNS → `deb.debian.org`) ✅
- package install ✅
- explicit `curl https://…` → printed `DNS+HTTPS OK` ✅
- exported OCI image, exit 0, image landed directly in `container`'s store ✅

The repo already assumes 1.0+ as of commit `19f5140` (`fix(doctor): require Apple container >= 1.0`).
So the DNS workaround is dead weight. This task removes Docker from the build path entirely.

### Why this is a net simplification

`container build -t <tag> -f <dockerfile> <context>` produces an image **directly in `container`'s
image store**. Docker and `container` no longer have separate stores to bridge, so the entire
**registry shuttle disappears**:

- no `docker build`
- no local `registry:2` container on :5555
- no `docker tag` / `docker push` / `container image pull --scheme http` / `container image tag`
- no Docker daemon preflight

## Out of scope

- **Removing the `registry.ts` module wholesale** only if nothing else imports it — verify with grep
  (see Implementation). If `akf build` was the sole consumer, delete it; otherwise just stop calling
  it from `build.ts`.
- **ghcr.io publishing / base-image distribution.** Still deferred (`TODO.md`). The built-in base
  image keeps being built locally on first `akf up`; this task only swaps the builder, not the
  distribution story.
- **`--scheme http` / `pullImage` plumbing for the non-build pull path.** `akf up`'s pull-an-existing-
  image branch (`up.ts` `pullImage(image.ref)`) is unrelated and stays as-is.
- **Buildkit builder lifecycle management.** `container build` auto-starts the `buildkit` helper
  container on demand (confirmed: builder was `stopped` before the test build and came up
  automatically). Do not add explicit `container builder start/stop` calls.

## Design

### New build flow (replaces lines 67–164 of `cli/commands/build.ts`)

1. Resolve `dockerfile`, `tag`, `buildContext` — **unchanged** (lines 36–65).
2. **Delete the Docker preflight** (lines 67–84). Optionally add a light `container` preflight only
   if one doesn't already exist upstream in `akf up` / `main` (it does — `ensureContainerSystem`
   runs in `up.ts`; `akf build` invoked directly can rely on `container build` surfacing its own
   error). Keep it simple: no new preflight.
3. **Base-image AKF_BASE injection** (lines 86–118) — keep the *logic*, swap the *tooling*:
   - presence probe: `docker image inspect <base.ref>` → use the existing
     `imageExists(base.ref, run)` helper from `cli/lib/container.ts` (it runs
     `container image inspect`).
   - base build when missing: `docker build -t <base.ref> -f <basePath> <dir>` →
     `container build -t <base.ref> -f <basePath> <dir>`.
   - keep `--build-arg AKF_BASE=<base.ref>` injection for project builds.
4. **Project build** (lines 120–133): `docker build -t <tag> -f <dockerfilePath> <buildContext>`
   → `container build -t <tag> -f <dockerfilePath> <buildContext>` (with `...baseBuildArgs`).
5. **Delete the registry shuttle entirely** (lines 135–162): no `startRegistry`, no
   `docker tag/push`, no `pullImageHttp`, no `tagImage`, no `stopRegistry`. The image is already in
   `container`'s store after step 4.
6. Final success log + `return 0`.

`BuildOptions.noCleanup` becomes meaningless (it only governed the registry). Remove the field and
its references, or keep it as an accepted-but-ignored no-op if any caller passes it — grep shows
callers in `main.ts:156` and `up.ts:99`; check whether either passes `noCleanup` (they don't appear
to) and drop it.

### Argument-order note

`container build` flags (verified against `container build --help` on 1.0.0):
`-t/--tag` is **not** a documented flag name in the help output's options list, but `-t` worked in
the verification run. Use `-t <tag>` and `-f <path>` and a positional `<context-dir>`. If `-t`
proves unstable, the help lists `-l/--label` and `-o/--output type=oci`; the canonical tag form is
`container build --tag <ref>`. **Confirm the exact tag flag** with `container build --help` before
finalizing (the agent runs in a sandbox that may have `container` available; if not, default to
`-t` which is verified working).

## Implementation

### `cli/commands/build.ts`

- Rewrite the header comment (lines 1–3) to describe the new flow: *"Builds a custom image with
  Apple `container build` directly into `container`'s image store. No Docker, no registry shuttle —
  the v0.9 builder DNS bug that required them is fixed in container 1.0."*
- Update imports: drop `dockerStatus`, `pullImageHttp`, `tagImage`, `realRunner`-adjacent registry
  imports; drop `REGISTRY_HOST, startRegistry, stopRegistry` from `../lib/registry.ts`. Keep
  `projectImageTag`, `realRunner`, `Runner`, and add `imageExists` from `../lib/container.ts`.
- Replace `docker` invocations per the Design section.
- Remove `noCleanup` from `BuildOptions` if unused by callers.

### `cli/lib/registry.ts`

- Grep first: `grep -rn "registry" cli/ | grep -iv test`. If `build.ts` was the only importer,
  **delete the file** and remove `cli/lib/registry_test.ts` if one exists. If anything else imports
  it, leave it and just remove the `build.ts` usage.

### `cli/lib/container.ts`

- `dockerStatus` / `DockerStatus` (lines ~327–337): after `build.ts` and `doctor.ts` stop using it,
  grep for remaining references. If none, delete `dockerStatus`, the `DockerStatus` type, and the
  `// --- docker preflight ---` section.
- `pullImageHttp` (line ~277): if `build.ts` was its only caller, delete it. (`pullImage` — the
  plain pull used by `up.ts` — **stays**.)
- `tagImage` (line ~281): if `build.ts` was its only caller, delete it. Otherwise keep.
- Verify each deletion with `grep -rn "<name>" cli/` before removing.

### `cli/commands/doctor.ts` (lines ~106–143)

The `docker` health check is now obsolete. Replace it with a `container`-builder-oriented check or
drop it:

- The `dockerNeeded` block (project Dockerfile in scope OR built-in base needs building) currently
  reports a `docker` check. Since building no longer needs Docker, **remove the `docker` check
  entirely** (both the `dockerNeeded` and `else` branches that push a `label: "docker"` check).
- Optional replacement: a `builder` check that confirms `container` can build — but `container
  build` auto-manages its builder, so the existing `container` / `container system` checks in doctor
  already cover readiness. Prefer **deletion over a new check** unless doctor currently has nothing
  asserting `container` is usable (it does — see the version/`>=1.0` check from commit `19f5140`).
- Remove the now-unused `dockerStatus` import from `doctor.ts:6`.

### `cli/commands/build_test.ts`

This test file is written entirely around `docker` calls and must be reworked:

- The `recorder()` helper keys off `cmd === "docker"` for the base-inspect probe and the registry
  `inspect` probe. Update it: the base presence probe is now
  `cmd === "container" && args[0] === "image" && args[1] === "inspect"`; the registry probe is gone.
- `dockerBuilds()` helper → `containerBuilds()` filtering
  `c.cmd === "container" && c.args[0] === "build"`.
- Test 1 (`injects AKF_BASE build-arg for project builds`): assert the `container build` call for
  `proj-sandbox` carries `--build-arg AKF_BASE=<base.ref>`, and that the present base is not rebuilt.
- Test 2 (`skips AKF_BASE injection when building the base itself`): assert no `--build-arg` and no
  image-inspect probe on `isBaseBuild: true`.
- Test 3 (`builds the base first when Docker lacks it` → rename to `…when container lacks it`):
  drive `baseInContainer: false`, assert base `container build` precedes the project
  `container build`.
- Add a regression assertion that **no `docker` command and no registry interaction** occurs:
  `assert(!calls.some(c => c.cmd === "docker"))` and
  `assert(!calls.some(c => c.cmd === "container" && c.args[0] === "push"))`.

### Grep sweep for stragglers

```
grep -rn "docker" cli/ --include='*.ts' | grep -iv '_test.ts'
grep -rni "registry" cli/
grep -rn "REGISTRY_HOST\|startRegistry\|stopRegistry\|pullImageHttp\|dockerStatus\|tagImage" cli/
```

Resolve every hit: either it's genuinely unrelated (e.g. a plugin string, `schema.ts` doc text) or
it's dead and should go. Note `cli/lib/schema.ts`, `cli/commands/eject.ts`, `cli/commands/init.ts`,
`cli/plugins/*` matched "docker" in the original sweep — most are `.devcontainer`/Dockerfile-path
references that are **legitimate and must stay**. Read each before touching.

## Docs

- `cli/commands/build.ts` header comment (done above).
- `README.md` / `USAGE`: remove any "requires Docker Desktop" prerequisite tied to custom
  Dockerfiles. Search for "Docker" in `README.md` and `docs/`.
- `CLAUDE.md` build line ("Build: `deno task compile`") is unaffected (that's the Deno binary build,
  not the image build) — leave it.

## Tests

- `deno task test` must pass (the reworked `build_test.ts` plus everything else).
- `deno task lint` / `deno task fmt --check` if those tasks exist (check `deno.json`).
- Manual smoke (only if the executing sandbox can reach a nested `container` — it may not; nested
  virtualization inside an apfelkäfig micro-VM is not guaranteed). If runnable on the host instead:
  1. `akf build --from-dockerfile <a Dockerfile that does apt-get install>` → exits 0, image in
     `container image ls`.
  2. `akf up` in a project with `image.dockerfile` set → builds via `container build`, launches.
  3. Confirm no `registry` container is ever created: `container ls -a` shows none named `registry`,
     and `docker ps` (if Docker is even installed) shows nothing spawned by akf.

## Edge cases

- **First-ever build pulls the buildkit helper.** `container build` lazily pulls
  `ghcr.io/apple/container-builder-shim/builder:<ver>` the first time. This needs network. It's a
  one-time cost analogous to the old "pull registry:2". No code needed, but the first-build log will
  show a builder pull — don't mistake it for an error.
- **`-o/--output` default is `type=oci`.** That's what lands the image in the store; don't override
  `-o` or the image may not be tagged into `container`'s store.
- **Build context vs. Dockerfile path.** Preserve the existing split: `-f <dockerfilePath>` plus the
  positional `<buildContext>` (= `dirname(dockerfilePath)`), exactly as the Docker version did.
- **`AKF_BASE` build-arg semantics are identical** between `docker build` and `container build`
  (`--build-arg key=val`). No change needed to templates that `ARG AKF_BASE` / `FROM ${AKF_BASE}`.
- **Don't regress the `akf up` non-build pull path.** `pullImage` (plain `container image pull`) is
  used when the config points at a *registry image*, not a Dockerfile. Leave it untouched.

## Rollout

1. Branch (`git checkout -b 009-container-native-build`).
2. Implement `build.ts` rewrite + helper deletions + doctor edit + test rework.
3. `deno task test` green.
4. Commit autonomously (per repo convention, `simon+agent` identity, `commit.gpgsign=false`).
5. The change is **safe to ship without a deprecation window**: Docker was an internal
   implementation detail of `akf build`, never a user-facing contract. Users on container ≥ 1.0
   (already required by doctor) get a strictly simpler path; the only observable difference is that
   Docker Desktop is no longer needed.
