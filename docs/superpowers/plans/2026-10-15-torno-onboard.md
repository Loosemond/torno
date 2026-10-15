# A new object, by onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The person can make a new object in torno: a page where they say what it is and give what they have (photos, a doodle, 3D scans, other objects of the workspace as references, each with a note), and "Create" makes the object's folder from torno's own template, opens it, and starts a Claude Code chat whose first prompt carries all of it.

**Architecture:** An onboarding page in the window (like the page of objects, in place of the viewport) holds a draft in the store: name, description, and reference items. Files come to main only as paths from main's own dialog or from a drop (`webUtils.getPathForFile`, as scans do); a doodle comes as PNG bytes. "Create" is one bridge call: main checks the name, makes `<workspace>/<name>/` (new; never an existing folder), writes the template model, `brief.md` and `reference/` (copies of the photos, the doodle), refreshes the workspace, then the window opens the object, main imports the scans through the existing scan import, starts a chat session, and sends the first prompt (`onboardPrompt`: text plus up to 6 images, long edge 1280 px).

**Tech Stack:** as torno (Electron 44, React 19, Zustand, TypeScript, vitest, Playwright; kernel Python 3.12, build123d). No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md` (workspace, objects, sessions, scans) and the chat plan `docs/superpowers/plans/2026-10-15-torno-chat.md` (the chat this starts). The owner asked (2026-10-15): "an onboarding process for a new object, where you describe, you can give photos, or 3d scans, or even doodle something, or other objects, or even reference other objects from torno, and once ready, this starts a session with all of this information"; starting files: always torno's own template.

## Global Constraints

Everything in the root `CLAUDE.md` and the folder `CLAUDE.md` files holds, with one exception this plan adds and documents:

- **Writing in the workspace.** Torno may create ONE new folder `<workspace>/<name>/` when the person presses "Create" on the onboarding page, and write inside it the template model, `brief.md`, `reference/` and `.torno/`. Never into a folder that exists already (the create fails, nothing is written), never outside that new folder, never following a link. Everything else of "never write inside a user workspace except under `<object>/.torno/`" stands.
- The owner works on this desktop: every Electron launch in tests sets `TORNO_TEST=1`; never `--ozone-platform=headless`, `page.screenshot()`, the clipboard. Tests never run the real `claude`/`copilot` (fake agent). Never touch `/home/luisgonc/objects` or `Downloads`. No new npm dependency, no `pnpm add/install`, `uv run --no-sync` only, never `uv sync`. Stage explicit paths, never `git add -A`/`git stash`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Test first. Keys only through `shared/keys.ts`. UI: tokens, sentence case, numbers/refs monospace, no endless animation, not nerv's look.
- A path the window sends is never trusted for writing: files to copy come as paths the window got from a drop or that main's dialog gave; main reads them (regular files only, size-capped) and writes only under the new folder.
- Images for the agent: long edge at most 2000 px, default 1280.

## Design

### The page

"New object" is a button at the foot of the Objects list (left column) and on the page of objects; on a workspace with no objects the welcome offers it too. It opens the onboarding page in place of the viewport (Escape or "Cancel" closes it; a draft with anything in it asks first: "Discard this new object?").

From the top, one column, calm:
1. **Name** — a field; the folder's name. Rule (as the kernel and workspace already require of an object folder): letters, digits, `.`, `-`, `_`, starting with a letter or digit; at most 64; not an existing folder of the workspace; not `common`, `tests`, `out`, `docs`, `tools`, `reference`, nor a Python keyword or a name that starts with `.`. Said under the field as the person types ("A folder `x` is there already").
2. **What is it?** — a text area: what it is for, what it must fit or hold, sizes known, how it will be made (placeholder: "A clip that holds a 6 mm cable to the edge of a desk, printed in PETG…").
3. **What you have** — a list of items, each a card with a thumbnail, a caption line ("Note for Claude") and remove:
   - **Photo** — "Add photos…" (main's dialog, images: png, jpg, jpeg, webp) or dropped on the page. Up to 12, each at most 25 MB.
   - **Doodle** — "Draw…" opens a drawing sheet: a white board (theme-aware ink) 1200 × 800, pen (two widths), eraser, undo, clear, "Done"; the result is a PNG kept in the draft (the board can be reopened and changed while the draft lives). Up to 6 doodles.
   - **3D scan** — "Add a scan…" (main's dialog, the formats scan import takes) or dropped (by extension). Up to 4. Imported into the new object after it is created, by the existing import.
   - **Another object** — "Refer to an object…": a menu of the workspace's objects with their thumbnails; the caption says how it relates ("mounts on this", "same style as"). Up to 8.
4. **Create** (primary; enabled when the name is valid and the description is not empty) — and a quiet line saying what will happen: "Creates `<workspace>/<name>/`, opens it and starts Claude Code with all of this." "Cancel".

The draft lives in the window's store for the workspace (not on disk) until created or discarded; closing the window with a draft asks (`closingWhy`).

### What "Create" does (main, `objects:create`)

1. Validate the name again (main's rule is the one source; the window's message comes from the same `shared/` function). Refuse with a plain reason.
2. `mkdir <ws>/<name>` without `recursive` (fails if it exists), then check with `lstat` that it is a real directory inside the workspace root.
3. Write, each through `writeFileAtomic`:
   - `<name>/<module>.py`, where `<module>` is the name with `-` and `.` turned into `_` (a Python module name): **torno's template** (below).
   - `<name>/brief.md`: the description; then "## References", one line per item: the file under `reference/` and its note; scans by their source path and note; other objects as `../<object>/` and their note. This is the record of the onboarding for later sessions.
   - `<name>/reference/photo-1.jpg`, …, `doodle-1.png`, … : photos copied (regular file, ≤ 25 MB, never a link), doodles from their bytes (≤ 8 MB, PNG signature checked).
4. Answer with the new object's id once the workspace listing has it (the workspace refresh that a new `.py` brings).

Then the window opens the object (as a click in the list does), and calls `objects.onboard(objectId, draftId)`: main imports each scan (existing `scans:import` path, by the path the drop/dialog gave), starts a Claude Code chat session (the new object has no `agent.json`: Claude Code, chat), and sends the first prompt. If the agent's command is missing or the start fails, the object is still made and open, and the composer holds the prompt text for the person to send when they can (the window says why).

### The template (torno's own)

A model the kernel loads as it is (`Params` + `assembly(p)` returning a dict of parts) that builds in well under a second: one part, a 20 mm cube with 1 mm fillets named `placeholder`, and a module docstring that says it is a placeholder to be replaced, pointing at `brief.md` and `reference/`. A kernel test builds the template text through the real loader.

### The first prompt (`onboardPrompt`, `main/onboard.ts`)

Text, then image blocks:

```
This is a new object, <name>, made in torno just now. What it is, in the person's words:

<description>

What they gave (all of it is also in brief.md; files are in reference/):
- reference/photo-1.jpg: <note>        (attached below)
- reference/doodle-1.png: <note>       (attached below)
- Scan S1 "<file>": <note>. It is imported into this object, not aligned yet; read it with the scan tools.
- ../<other>/ (another object of this workspace: <parts, its size from its last build, or "not built in this run">): <note>

<name>.py is torno's placeholder (a 20 mm cube). Read brief.md, look at what was given, ask what you need to know, then replace the placeholder with the real model.
```

Images: the photos and doodles in order, then the thumbnails (`.torno/thumb.png`) of referenced objects that have one, at most 6 images in all, each scaled to a long edge of 1280 px (PNG or JPEG kept as it is if already within). Images beyond 6 are named in the text as "not attached: read reference/<file>". The text uses `toolName` for any tool it names (none required). The torno context hook still adds its own context to this prompt as to any other.

## Review Focus

1. **The name**: a name that exists, differs only in case on a case-insensitive filesystem, has a slash, `..`, a leading dot, unicode lookalikes, or is a Python keyword — refused with a reason; nothing is written.
2. **Partial failure**: a photo unreadable mid-create, a full disk — the folder is either whole or removed (create into `<ws>/.<name>.torno-new-<random>` then rename to `<ws>/<name>`; on failure remove the temp folder), and the person is told.
3. **Paths from the window**: a dropped symlink, a directory, a FIFO, a 2 GB file — refused, never followed or read whole.
4. **The session start fails** (no `claude`, trust question for a folder with `.claude/` above it): the object is made and open; the prompt is not lost.
5. **The draft**: survives switching objects and the page of objects while the window lives; asks before it is thrown away; is dropped when the workspace changes (asking first).

---

### Task 1: Main — creating the object

**Files:** Create `app/src/shared/objectName.ts` (+ test), `app/src/main/objects/create.ts` (+ test), `app/src/main/objects/template.ts` (+ test), `kernel/tests/test_template.py` (builds the template text through the real loader; the template text is read from a file the test can reach: put it in `app/src/main/objects/template.py.txt` imported as raw text by Vite, or generate it from a shared string and write a copy the kernel test reads — choose the simplest that keeps one source). Modify `app/src/main/ipc.ts`, `app/src/shared/bridge.ts`, `app/src/preload/index.ts`, `app/src/main/index.ts` (a test hook to answer the photo/scan dialogs), root `CLAUDE.md` (the exception), `app/src/main/CLAUDE.md`.

**Interfaces (produced):**
```ts
// shared/objectName.ts
export function objectNameProblem(name: string, existing: readonly string[]): string | null // null when fine; existing = folder names of the workspace (compared case-insensitively)
export function moduleName(name: string): string // "cable-clip" -> "cable_clip"
// bridge
objects: {
  pickPhotos(): Promise<string[]>            // main's dialog; [] when cancelled; test hook `pickPhotos`
  pickScan(): Promise<string | null>         // the scan dialog (reuse scans:pick)
  pathOf(file: File): string                 // as scans.pathOf
  create(req: CreateRequest): Promise<{ objectId: string }>
}
interface CreateRequest {
  name: string
  description: string
  photos: Array<{ path: string; note: string }>
  doodles: Array<{ png: Uint8Array; note: string }>
  scans: Array<{ path: string; note: string }>     // not copied; imported in Task 2
  objects: Array<{ id: string; note: string }>      // other objects of the workspace
}
```
- [ ] Tests first: name rule (Review Focus 1); create writes exactly the files (template, brief.md with every item, reference copies) and nothing else; an existing folder → refused, nothing written; a symlink/dir/FIFO/oversized photo → refused, temp folder removed (Review Focus 2, 3); the rename is the last step; a doodle that is not PNG → refused. Kernel test: the template builds through `load_scene`, one part `placeholder`, in under a second.
- [ ] Implement; IPC with `isTest` hooks for the dialogs; the workspace listing shows the new object (itest or e2e).
- [ ] Four suites (and kernel pytest), commit.

### Task 2: Main — onboarding the new object

**Files:** Create `app/src/main/onboard.ts` (+ test). Modify `ipc.ts`, `bridge.ts`, preload, `sessions/manager.ts` only if needed to start and prompt in one call, `manager.itest.ts` or a new itest.

**Interfaces (produced):** `onboardPrompt(input: { name; description; items; scans: Array<{ id; file; note }>; objects: Array<{ name; summary; note; thumb?: Uint8Array }>; images: Array<{ file: string; png/jpeg bytes }> }): { text: string; blocks: PromptBlock[] }`; bridge `objects.onboard(objectId: string, draft: { scans: Array<{path; note}>; objects: Array<{id; note}> }): Promise<{ sessionId: string | null; prompt: string; problem?: string }>` — imports scans, starts the chat session, sends the prompt; on a start failure returns `sessionId: null`, the prompt text and the reason.
- [ ] Tests first: the prompt text for a draft with every kind (snapshot of the text is fine, plus specific assertions: every note present, image count ≤ 6, extra images named "not attached", referenced objects' summaries from their last build or "not built in this run"); images scaled to 1280 (use the image scaling the look/attach path already has, in main or the window — reuse, do not add a library); itest with the fake agent: create + onboard → the fake receives one prompt with the text and N image blocks, the scan is in `scans.json`, the hook context arrives as for any prompt; a missing agent command → `sessionId: null`, prompt returned.
- [ ] Implement; four suites; commit.

### Task 3: The window — the onboarding page and the doodle board

**Files:** Create `app/src/renderer/ui/onboard/NewObject.tsx`, `Doodle.tsx`, `ReferenceItems.tsx`, `app/src/renderer/state/onboard.ts` (+ test), `app/src/renderer/styles/onboard.css` (listed in `app.css`), `app/e2e/onboard.spec.ts`. Modify `ObjectList.tsx`, `ShowPage.tsx`, `Welcome.tsx` (entry points), `App.tsx` (the page in place of the viewport), `closing.ts` (+ test: a draft is something a close cuts short), `shared/keys.ts` if keys are added (README table regenerated), `themes.spec.ts` (a capture state `onboard`).

- [ ] Tests first: `state/onboard.ts` (draft per workspace; caps per kind; discard; dropped with the workspace after asking); e2e: open the page from the list; name errors shown live; add a photo through the test dialog hook and by a drop (`DataTransfer` with a file from a temp dir), a doodle drawn with `page.mouse` (a stroke; Done; its thumbnail appears; reopen and undo), a scan (fixture scan from `kernel/tests/fixtures` copy), another object with a note; Create → the object is listed and open, the chat pane shows the first prompt with the photo/doodle thumbnails and the referenced object's thumbnail, the fake agent answered, `brief.md` has every note, `reference/` has the files, `scans.json` has the scan; Cancel with a draft asks; Escape closes when empty.
- [ ] Implement; look at the `onboard` capture in both themes (`TORNO_SHOTS`); four suites; commit.

### Task 4: Docs

README: "Making a new object" (the page, what each kind gives Claude, the template, `brief.md` and `reference/`, what is written in the workspace and that nothing else is), the key table if keys changed, "Not yet verified on a visible screen" gains the onboarding with the real Claude Code. Root `CLAUDE.md` (the exception to writing in the workspace), `app/src/main/CLAUDE.md`, `app/src/renderer/CLAUDE.md`, `app/e2e/CLAUDE.md`. Four suites, commit.
