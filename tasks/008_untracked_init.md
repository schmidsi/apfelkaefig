# Plan: 008 — `akf init --untracked`

## Context

When you're working on someone else's repo (`gskril/telegram-cli`, an open-source project you don't
own, a corporate monorepo where you can't add personal tooling), you still want a hermetic sandbox —
just without polluting the project with `.apfelkaefig.json`, `.devcontainer/`, or a marker block in
`CLAUDE.md`.

Today `akf init` always writes those files into the project tree as visible-to-git changes.
`--untracked` is opt-in mode that keeps the files on disk but hides them from git via
`.git/info/exclude`, git's per-clone untracked-paths list.

This is **not** the default. The default stays "fully co-located, fully visible" because that's the
right behavior for repos you own or where you want the sandbox checked in.

## Out of scope

- Out-of-tree config storage (`~/.apfelkaefig/<encoded-path>/...`) — explicitly rejected as too
  magic and fragile to path renames.
- Auto-detecting "this is a foreign repo" and switching modes — too much magic. The user passes the
  flag.
- A sister `--untracked` flag for `akf plugin add` — instead, plugin-add detects whether
  `.git/info/exclude` already has the akf marker block and continues in that mode automatically.

---

## Design

### CLI

```bash
akf init --untracked                              # tier 2, hidden from git
akf init --advanced --untracked                   # tier 3, hidden from git
akf init --bash --untracked                       # bash eject, hidden from git
akf init --untracked --plugins telegram           # with plugins
```

### Preflight

- Require the cwd (or its ancestor up to the first `.git`) to be a git repo. If not, hard error:
  `akf init --untracked requires a git repo`.
- Use `git rev-parse --git-common-dir` (not `--git-dir`) so worktrees of the same clone share one
  exclude file. The exclude lives in the shared `.git/info/` rather than the worktree-specific
  `.git/worktrees/<name>/info/`. Files on disk remain per-worktree; only the ignore pattern is
  shared.

### What's written

Same payload as a normal `akf init`, with three differences:

| Artifact                            | Default `akf init`                 | `--untracked`                                       |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------- |
| `.apfelkaefig.json`                 | written, visible                   | written, hidden via exclude                         |
| `.devcontainer/*` (advanced/bash)   | written, visible                   | written, hidden via exclude                         |
| `.gitignore` marker block           | appended to project's `.gitignore` | **not written** — entries go to `.git/info/exclude` |
| `CLAUDE.md` marker block            | appended                           | **not written**                                     |
| `start.sh` / `build.sh` (bash mode) | written, visible                   | written, hidden via exclude                         |
| `.git/info/exclude` akf block       | not touched                        | created/updated                                     |

The reasoning for skipping `CLAUDE.md`: it's almost always a tracked file in foreign repos, and
appending to it would either show up as a diff (defeats the flag) or require gymnastics to mask.
Users who want Claude guidance about the sandbox set it in `~/.claude/CLAUDE.md` (global) or paste
into the in-sandbox prompt.

### `.git/info/exclude` block format

Marker-managed, idempotent, same pattern as the host `.gitignore` block today. Existing
`cli/lib/fs.ts` `upsertBlock` and `cli/lib/markers.ts` markers generalize cleanly.

```
# >>> akf >>>
/.apfelkaefig.json
/.devcontainer/
# (plus whatever lines would have gone into .gitignore — sandbox cache,
#  node_modules-shaped junk, etc. — copied from templates/gitignore.block)
# <<< akf <<<
```

Paths are repo-root-relative (leading slash) so the rule doesn't accidentally match files of the
same name in subdirectories.

### Plugin-add detection

When `addPluginToWorkspace` writes a new path (`.devcontainer/Dockerfile` via
`ensureDockerfileBaseIfNeeded`, plugin marker blocks against `CLAUDE.md`), it needs to decide
whether to:

1. Write to `CLAUDE.md` (default) or skip (untracked).
2. Add the path to `.git/info/exclude` or not.

Detection: read `<git-common-dir>/info/exclude`. If it has the akf marker block, we're in untracked
mode — skip CLAUDE.md writes and append any new paths (e.g. `.devcontainer/Dockerfile`) to the
exclude block.

This avoids a `"mode": "untracked"` field in `.apfelkaefig.json`. The exclude file itself is the
source of truth for "are we hiding things from git here."

### Eject

`akf eject --devcontainer` and `akf eject --bash` in an untracked workspace also write to the
exclude block. Same detection mechanism.

`akf eject` in a fully-untracked project is a strange move (the whole point of eject is to make the
project standalone, which presumes you want the artifacts committed). Print a warning:
`you're in --untracked mode; eject artifacts are
also hidden from git. Use 'akf init' without --untracked to commit them.`

---

## Implementation

### `cli/lib/git.ts` (new)

```ts
// Resolve the directory `.git/info/exclude` should live in.
// Returns null when not inside a git repo.
export async function gitCommonDir(cwd: string): Promise<string | null>;

// Idempotently append marker-managed paths to .git/info/exclude.
export async function ensureExcluded(
  gitCommonDir: string,
  paths: string[],
): Promise<"created" | "updated" | "skipped-present">;

// Detect whether the current workspace was initialized with --untracked
// by reading the akf marker block from .git/info/exclude.
export async function isUntrackedMode(cwd: string): Promise<boolean>;
```

### `cli/commands/init.ts`

- Accept `untracked: boolean` in `runInit` options. Dispatched from `main.ts` by parsing
  `--untracked` as a boolean flag.
- Preflight: when `untracked`, require git repo.
- Skip `.gitignore` and `CLAUDE.md` writes when `untracked`.
- After all in-tree writes, build the path list and call `ensureExcluded`.

### `cli/commands/plugin.ts`

- In `addPluginToWorkspace`, call `isUntrackedMode(cwd)` once.
- If true: skip CLAUDE.md upsert; after writing any new on-disk paths, append them to the exclude
  block.

### `cli/commands/eject.ts`

- Same `isUntrackedMode` check.
- After writing eject artifacts, append them to the exclude block.
- Warn if untracked-mode eject is being performed.

---

## Tests

`cli/lib/git_test.ts`:

- `gitCommonDir` returns the right dir in a fresh git init, a subdir, and inside a worktree
  (common-dir, not worktree-dir).
- `gitCommonDir` returns null outside a git repo.
- `ensureExcluded` creates / updates / leaves the marker block alone idempotently.
- `isUntrackedMode` returns true after `ensureExcluded` and false before.

`cli/commands/init_test.ts` (new or existing):

- `akf init --untracked` in a fresh `git init` repo: files exist on disk; `git status --porcelain`
  returns empty.
- `akf init --untracked` outside a git repo: errors out cleanly.
- `akf init --untracked --plugins telegram`: telegram's `.devcontainer/Dockerfile` is also in the
  exclude block.
- Re-running `akf init --untracked` is idempotent against the exclude block.
- `CLAUDE.md` and project `.gitignore` are not modified in untracked mode.

`cli/commands/plugin_test.ts`:

- `akf plugin add` after a `--untracked` init does not modify `CLAUDE.md` and adds new on-disk paths
  (e.g. `.devcontainer/Dockerfile`) to the exclude block.
- Same plugin add after a normal init behaves as today.

---

## Edge cases

- **Switching modes.** If a user runs `akf init` (no flag) and later wants `--untracked`, they have
  to delete the on-disk files and the marker blocks in `.gitignore` / `CLAUDE.md` first. We could
  detect and offer guidance:
  `looks like you already ran 'akf init' in tracked mode here; run 'akf clean
  --files' or delete the marker blocks first.`
  Defer the auto-migration story.
- **`git clean -dfx`.** Files in `.git/info/exclude` are still on the filesystem and `-x` blows them
  away. Document this in the user-facing notes. Same caveat as any local-only build artifact.
- **`.gitignore` already has the akf block from a prior tracked init.** Then `akf init --untracked`
  is re-running in tracked-init's territory. Error or warn. Don't silently switch modes.
- **Submodule / git-worktree linked clone.** `git rev-parse --git-common-dir` handles both
  correctly. Worth covering with tests.

---

## Rollout

One PR: the helper module, the flag, plugin-add detection, eject detection, the tests. Single
feature, single landing — small enough.

No schema changes. No `.apfelkaefig.json` changes. No new templates.
