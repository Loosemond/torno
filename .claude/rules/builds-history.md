---
paths:
  - "app/src/renderer/ui/AskToCommit.tsx"
  - "app/src/renderer/ui/AskToCommit.test.ts"
  - "app/src/main/history.ts"
  - "app/src/main/history.test.ts"
  - "app/src/main/buildlog.ts"
  - "app/src/main/buildlog.test.ts"
  - "app/src/main/git.ts"
  - "app/src/main/git.test.ts"
  - "app/src/main/meshes.ts"
  - "app/src/main/meshes.test.ts"
  - "app/src/shared/history.ts"
  - "app/src/shared/history.test.ts"
  - "app/src/shared/git.ts"
  - "app/src/shared/git.test.ts"
  - "app/src/renderer/ui/HistorySheet.tsx"
  - "app/src/renderer/ui/historyBits.ts"
  - "app/src/renderer/ui/historyBits.test.ts"
  - "app/src/renderer/ui/useHistory.ts"
  - "app/src/renderer/ui/useGit.ts"
  - "app/src/renderer/ui/GitText.tsx"
  - "app/src/renderer/viewport/ghosts.ts"
  - "app/src/renderer/viewport/ghosts.test.ts"
  - "app/src/renderer/viewport/earlier.ts"
  - "app/src/renderer/viewport/earlier.test.ts"
  - "app/src/renderer/state/landing.ts"
  - "app/e2e/history.spec.ts"
  - "app/e2e/git.spec.ts"
---

# Builds: identity, git, the history kept, ghosts and an earlier build

Moved as written from the folder `CLAUDE.md` files; each heading names the folder it came from, and paths are written as they were there (see "Rules by area" in the root `CLAUDE.md`).

## The page of objects (`app/src/main`)

- **git is read, never written** (`src/main/git.ts`, `shared/git.ts`; #62). `gitState(objectDir)` runs one `git status
  --porcelain=v2 --branch -z` by `execFile` (no shell) with `--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`, `core.fsmonitor=false`, no
  prompt, `GIT_DIR` and its kin taken out of the environment, 5 s (`GIT_TIMEOUT_MS`) and then killed, over the project's folder and
  the `common/` beside it (the paths of the work tree, found by `rev-parse --show-toplevel`), and drops what is under `.torno/`.
  It answers the commit, the branch and the files that differ (30 named at most, all counted), or null: no git, not a work tree,
  no answer in time. `git.test.ts` holds that the index's mtime, inode and size are as they were after a status on a stale entry.
  No other git command is run, none that writes: **torno never commits**; the person asks the agent to (the Marks panel offers the
  request). It reaches the window as `git.status(objectId)` (`gitStateRecently`: an answer is kept for a second, so a page of
  cards and the status line cost one run) and as `ObjectCard.git`.
- **A build has an identity** (`src/main/buildlog.ts`, #62). When a build lands, `BuildLog.record` finds `sourcesHash` (twelve hex of the
  SHA-256 of the `.py` files directly in the project's folder and in `common/`, and the files the build says it imported from
  elsewhere in the workspace, `Scene.uses` when the kernel gives it; each by its path and bytes), the commit (`gitState`) and whether files
  differ from it, keeps that in memory for the run (40 builds an object; `identity(id, revision)`, `buildIdentity` in `ipc.ts`) and
  adds a line to `.torno/builds.jsonl` (`revision`, `at`, `run`, `sources`, `head`, `dirty`): one write at a time, through
  `ownTorno` and `ensureIgnored(dir, ['builds.jsonl'])`, appended, or the last 500 lines written whole when it would pass that.
  `run` is the run of torno (random): a revision counts from 1 in every run, so a line of the file is a revision of *that* run alone.
  The hash is of the files as they are when the build lands; a save during a build builds again.
- **A history of builds** (`src/main/history.ts`, `shared/history.ts`; #56). `History.keep` (called from `ipc.ts` when a build lands, with the
  promise of `BuildLog.record`, so in the order builds landed) keeps each build that worked under `.torno/history/`, ignored through
  `ensureIgnored(dir, ['history/'])`: `index.json` (`{ next, entries }`, written whole and atomically), and per build `h41/scene.json` (the
  scene without `output`; its mesh was never in it), `h41/source/<path from the workspace>` (copies of the files `sourcesHash` goes by, read
  once with `readSources`; not copied, and the entry kept with `files: []`, when they hash otherwise than `BuildRecord.sources` says, or pass
  `MOST_FILE_BYTES` a file or `MOST_COPY_BYTES` a build) and `h41/thumb.png` (the card's picture, attached by `History.thumbnail` from
  `show:saveThumbnail` once `keepThumbnail` took it; at most `MOST_THUMB_BYTES`). The folder of a build is written before the index names it,
  so a crash leaves the index whole and at most a folder no index names, which the next change sweeps (only folders named `h<n>`). **An id
  is `h<n>`, counts on across runs and is never given twice** (`next`, and above any folder there: a lost index does not repeat one); a revision
  is of its run and is told beside it. A build made from the sources the newest entry was made from is not kept again. A build whose declared
  checks fail is kept and marked (`failing`). The newest 100 are kept besides every starred one (`HISTORY_KEPT`; `History.star`). The entry's
  verdicts are **as of then** (`dimensions` is set when the check that followed the build ends, `keepDimensions` in `ipc.ts`): never told as
  how the build stands now. One writer, one change at a time per object, `ownTorno(dir, 'history')` before every write and delete; nothing
  of it is ever copied back: torno never restores a file (the window asks the agent to).
  **Meshes for the ghost of a kept build** (`src/main/meshes.ts` `RecentMeshes`, `ws.meshes`): the scene and the blob of each build of
  this run, in memory only, never written; `MESH_BUDGET_BYTES` (64 MB) for all the objects, not counting the newest build of each, the
  oldest let go first. `history:list` says which kept builds still have theirs (`ghosts`), `history:ghost` hands them to the window
  (a build of this run only).

## What a build changed (`app/src/renderer`)

- When a build lands over another of the same object, `actions.applyScene` keeps the one before as `before`, and the
  status line (`ui/BuildStatus.tsx`, `state/landing.ts`) says which parts of the layout shown changed
  (`landing`, `landingText` of `shared/diff.ts`: `tub changed, lid same`), with the `diff` lines in its title; the
  one rule of what a part's change is is `partChanged` (another mesh, or another `loc`). Nothing of it for a first
  build, a build running or a failed one.
- The ghosts (`viewport/ghosts.ts`, `Viewport.setScene`): of each part that changed, its old edges in `--muted`
  (seen through the part) where it stood, and its new edges in the accent, for `GHOST_HOLD_MS` and then one fade of
  `GHOST_FADE_MS`, by `invalidate()` steps and by a clock of their own (never endless, never waiting on a frame).
  Any key or a press on the canvas, another layout, a section or an explode ends them at once; none is made with a
  section or an explode on, for a part switched off, or of another layout, and they are hidden for a picture
  (`hideGizmo` in the host of `PictureMaker`). Not a mark, in no mark colour. `__tornoTest.ghosts()` and
  `holdGhosts()` are for tests.
- The parts fade for a build only once it has run `FADE_AFTER_MS` (`fadeIn` of `shared/build.ts`, applied by
  `ViewportPane`); a failed build fades them at once; the pick lock does not wait.

## History of builds (`app/src/renderer`)

- `ui/HistorySheet.tsx` (#56), opened by **History** in the status line (`ui/BuildStatus.tsx`, `status-history`), has the error
  sheet's shape (`.sheet`, `data-sheet='history'`, `sheet.close`): a strip of cards (`ol.history-strip`, `button.history-card`,
  `data-build`), newest first, each with the picture kept with the build (`history.thumbnail`, an object URL revoked when
  the card goes), `nameOf` (`h41`, and `· r3` beside it only for a build of this run: a revision is of one run), `ago`, the
  change line and what it had then (`marksOf`: checks that failed, defects, dimensions that failed; all as of then). The chosen
  card's facts, **Show the source** (`history.source`, one copied file at a time, read only in a `pre`), **Star**
  (`history.star`, main's) and **Ask the agent to go back to this build**: the request is `goBackPrompt` (`ui/historyBits.ts`:
  the copies by their paths, "Change the files of … to match them", "Do not edit the copies"), put in the box of the session by
  `insertIntoSession`, or kept for a session the pane starts (`setFixRequest`), and never sent. The window reads the list
  (`useHistory`, `history.list`, again at `history:changed`) and writes nothing; nothing here restores a file or puts a build on
  screen. A build with no copies (too large, or changed while read) has both buttons off, with `NO_COPY` in the title.
- **An earlier build over the current one** (`viewport/earlier.ts` `Earlier`, `Viewport.setEarlier`): the sheet's "Show over the
  current build" sets `store.compare` (`actions.compareWith`), and `ViewportPane` asks main for that build's scene and meshes
  (`history.ghost`; only a build of this run whose meshes main still holds, `HistoryList.ghosts`) and draws its parts of the layout
  shown translucent (`EARLIER_SURFACE_OPACITY`) with their edges, in `--muted` (the colour of the old edges of the ghosts of a build that
  just landed, and no mark's; it follows the theme), at the places that build had them. For display only: no bounds tree, a
  ray finds nothing, it is hidden for a picture (`hideGizmo`), and nothing is measured, marked or written from it. It stays until
  put away ("Stop" in the status line, `.status-compare`) and is put away by another object, another layout, a section or an
  explode (the sheet's button is off while one is on, with the reason in its title). It is not the ghosts of a build that landed
  (`ghosts.ts`, a moment, edges only). `__tornoTest.earlier()` is for tests.
