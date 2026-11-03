# Chat pictures across sessions: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A resumed chat shows the person's own reference pictures (the photos and doodles given in New object) again, read from `<object>/reference/` by the path the log records. Every other picture whose data is gone says what it was instead of only "Picture not kept". A new conversation on an object is told which reference files it has, so the agent can read them when it needs them.

**Architecture:** The log stays text only. The transcript recognises an onboarding picture by the caption `onboardPrompt` puts before it (`Picture 2: reference/doodle-1.png (the person's doodle): …`) and stores that path on the `ChatImage` (`file`). The log keeps `file` and leaves out `data`, as it does today. When the window draws a picture with no `data` and a `file`, it asks main (`chat.reference`) for the bytes. Main reads `<object>/reference/<file>` only if it is a plain, size-capped file whose name has the form `create.ts` gives, and returns nothing otherwise. The window then scales the bytes as it does for any image (`images.ts`). The fresh context of a new conversation (`contextFor(..., { fresh: true })`) gains one line naming the files in `reference/`. Nothing new is stored, and a drawing on the view is still kept nowhere.

**Tech Stack:** as torno: Electron, electron-vite, React 19, Zustand, TypeScript, vitest, Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-08-torno-design.md` (sessions, the chat), `docs/superpowers/plans/2026-10-15-torno-chat.md` (the chat, its log), `docs/superpowers/plans/2026-10-15-torno-onboard.md` (the first prompt), and Issue #22.

## Global Constraints

Everything in the root `CLAUDE.md` and in the `CLAUDE.md` of every folder touched holds. In particular:

- `.torno/chat/` holds text only: no address, no secret, no picture data. This plan **keeps** the rule. The log gains a picture's relative path (`reference/photo-1.jpg`), which is text. The root `CLAUDE.md` sentence is extended to say so (Task 5), not relaxed.
- A drawing on the view is kept nowhere: not under `.torno/`, not in the log. That stays as it is.
- Never write inside a user workspace except under `<object>/.torno/`. This plan writes nothing new anywhere. `reference/` is only read, as plain files (no link followed), size-capped.
- Images for the agent have a long edge of at most 2000 px, 1280 by default. Nothing new is sent to the agent as an image. The window scales what it shows through `images.ts`.
- The run's secret never reaches a file (`HttpRouter.redact` on whatever is logged).
- Tests never open a visible window: every Electron launch sets `TORNO_TEST=1`. Never `--ozone-platform=headless`, never `page.screenshot()`, never the clipboard (read `app/e2e/CLAUDE.md` before Task 3's e2e).
- No real agent CLI in tests: `TORNO_AGENT_CMD="node app/test/fake-agent.mjs"`. Never `claude`.
- UI text in sentence case. File names and numbers are set in the monospace face. Colours only from `styles/tokens.css`.
- No new npm dependency. Stage explicit paths (never `git add -A`). Commit after every task, ending the message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before each commit: `pnpm -C app typecheck`, `pnpm test`, `pnpm test:kernel`, `pnpm test:e2e` green (`kernel/` is not touched, so no pytest).

## Decisions (confirmed 2026-10-16)

Confirmed on #22: Every recommendation below holds. The owner chose decision 4's recommendation: a new session gets one line naming the files in `reference/`, not the pictures. Task 6 (by hand, against the real CLI) stays with the owner: an implementer does not do it.

The owner asked to brainstorm these first. Each one gives a recommendation, the reason, and the main alternative. **(changes tasks)** marks a decision that would change the tasks if it went the other way.

1. **Which pictures are worth keeping?** Recommendation: only the person's references (photos and doodles from New object). They are the only ones that can't be made again, and they are already on disk. The agent's pictures of the view show older builds (they are history, and `look` makes a new one in a second). Drawings on the view stay kept nowhere: they were made for one prompt, and keeping them would mean storing picture data. Alternative: keep everything in a capped `.torno/chat/pictures/` folder. **(changes tasks)**: that would add a store task, a sweep tied to `trimLog`, and a rewrite of the text-only rule.
2. **The person's side: how are the references shown?** Recommendation: by path, from `reference/`, read again on demand. This needs no new storage and keeps the text-only rule. If the person has deleted or replaced the file, the chat shows what is there now, or says the file is gone. Alternative: copy them under `.torno/chat/`. That would duplicate files the person owns and break the rule. **(changes tasks)**
3. **The agent's side on resume.** Recommendation: do nothing. Claude Code's own session files keep image blocks. Counted on this machine (counts only, no content read), lines with `"type":"image"` in `~/.claude/projects/<workspace>/*.jsonl`: guitar-wall-stand 21, helmet-stand 1, intake 78, spoiler 14, spoiler-wing 111, speaker-stand 4, tiago-support 6. So `--resume` most likely gives the model its pictures again, and only the window lacks them. This still has to be confirmed by hand against a resumed session (Task 6), because no test may run the real CLI. Alternative: send the references again on every resume. That spends tokens on pictures the agent most likely already has.
4. **The agent's side on a new session.** Recommendation: send no pictures. Instead, add one line to the fresh context naming the files in `reference/` and saying to read them when they matter. The agent can read files, and pictures it doesn't need cost tokens on every prompt. Alternative: attach the references (at most 6, 1280 px) to the first prompt of every new conversation. **(changes tasks)**: Task 4 would build prompt blocks instead of a line of text.
5. **Budget.** Recommendation: no new budget, because nothing new is stored. `chat.reference` reads at most `MAX_PHOTO` (the cap `create.ts` already uses for a photo) and only names of the form `reference/(photo|doodle)-<n>.<png|jpg|jpeg|webp>`. The window keeps at most the same 40 decoded pictures the transcript does, so it does not hold more data than now. `trimLog` is unchanged: cutting the log drops the line, and the picture goes with it from the earlier part of the chat. The file in `reference/` stays.
6. **Privacy.** Recommendation: nothing new to ignore, because nothing new is written. `reference/` belongs to the person: it is next to the model, and whether git tracks it is up to them, as it is today. A picture of the view can show other parts or a scan of something private, which is one more reason not to keep those. Alternative (with decision 1's alternative): a `chat/pictures/` folder, ignored by the existing `ensureIgnored(dir, ['chat/'])`.

## Design

### What the log records

`ChatImage` (`shared/chat.ts`) gains an optional `file?: string`, the path relative to the object, set only for an onboarding reference:

```ts
export interface ChatImage {
  id: string
  mediaType: string
  data?: string
  width?: number
  height?: number
  /** The person's reference this picture is (`reference/photo-1.jpg`), when the prompt named it so: shown from the file once `data` is gone. */
  file?: string
}
```

`Transcript` (in its user-prompt branch, `transcript.ts` around line 140) already drops a text block that comes right before an image. Now it also tests that text against

```ts
const REFERENCE_CAPTION = /^Picture \d+: (reference\/(?:photo|doodle)-\d+\.(?:png|jpe?g|webp)) \(the person's (?:photo|doodle)\)/
```

and, on a match, gives the next image `file: m[1]`. The pictures of other objects (`../<name>/ as torno last drew it`) get no `file`. A thumbnail changes, so it is history. `chatlog.ts` `written()` already leaves out only `data`, so `file` reaches the log without any change there. Task 1 adds a test that holds this.

### What the window shows for a picture without data

| Picture | Shown |
|---|---|
| A reference (`file`), file readable | the picture, read from `reference/`, with `title` = the file name |
| A reference, file missing or not a plain file | `reference/doodle-1.png is no longer there` (the path in monospace) |
| An agent's tool picture (`what` of a tool card) | `Picture of an earlier build, not kept` |
| A view attached by the person, or a drawing | `Picture not kept` (as today) |

A reference shown from its file can be opened large like any other thumbnail.

### What a new conversation is told

When `contextFor` is called with `fresh: true` and the object's `reference/` holds files of the names above, the context gains this line (names in order, at most 12, then `and <n> more`):

```
The person's references for this object are in reference/: photo-1.jpg, doodle-1.png. Read them when they matter; they are not attached.
```

A resumed conversation is not fresh and is not told this again.

## Tasks

### Task 1: The transcript names a reference picture, and the log keeps the name

**Files:**
- Modify: `app/src/shared/chat.ts` (`ChatImage.file`)
- Modify: `app/src/main/sessions/transcript.ts` (`REFERENCE_CAPTION`, user-prompt branch, `image()` takes an optional file)
- Test: `app/src/main/sessions/transcript.test.ts`, `app/src/main/sessions/chatlog.test.ts`

- [ ] **Step 1: Failing tests.** In `transcript.test.ts`: feed the user message built from `onboardPrompt(...).blocks` (import from `../onboard`) with one photo and one doodle, plus a referred object's thumbnail. Expect the user item's `images` to have `file: 'reference/photo-1.jpg'`, `file: 'reference/doodle-1.png'`, and no `file` on the thumbnail. Also expect that a prompt whose text merely says `Picture 1: reference/x.png` with no image after it sets nothing. In `chatlog.test.ts`: `appendItems` then `readLog` of a user item with `{ data, file }` gives back `file` and no `data`.
- [ ] **Step 2: Run them and see them fail:** `pnpm -C app exec vitest run src/main/sessions/transcript.test.ts src/main/sessions/chatlog.test.ts`
- [ ] **Step 3: Implement.** Add the field, then in the branch at `transcript.ts:140`:

```ts
} else if (block.type === 'image') {
  const caption = content[i - 1]?.type === 'text' ? REFERENCE_CAPTION.exec(content[i - 1].text) : null
  images.push(this.image(block.source.media_type, block.source.data, caption?.[1]))
}
```

with `image(mediaType, data, file?)` returning `{ ..., ...(file ? { file } : {}) }`. `withoutData` already keeps `file`.
- [ ] **Step 4: Run the tests and see them pass.** Then `pnpm -C app typecheck`.
- [ ] **Step 5: Commit** `app/src/shared/chat.ts app/src/main/sessions/transcript.ts app/src/main/sessions/transcript.test.ts app/src/main/sessions/chatlog.test.ts`: "Chat: a picture of the first prompt names its file in reference/, and the log keeps the name (never the data)".

### Task 2: Main reads a reference for the window

**Files:**
- Create: `app/src/main/sessions/reference.ts` (`readReference(dir, file): Promise<{ mediaType: string; bytes: Uint8Array } | null>`)
- Modify: `app/src/main/objects/create.ts` (export `readRegular` and `MAX_PHOTO` for reuse; no behaviour change)
- Modify: `app/src/shared/bridge.ts` (`chat.reference(sessionId: string, file: string): Promise<{ mediaType: string; bytes: Uint8Array } | null>`), `app/src/preload/index.ts`, `app/src/main/ipc.ts` (`chat:reference`, resolving the session's object dir through `Sessions`, as `chat:history` does)
- Test: `app/src/main/sessions/reference.test.ts`

- [ ] **Step 1: Failing tests** in a temp object folder. A `reference/photo-1.jpg` plain file is read with `image/jpeg`. These give `null`: `reference/../brief.md`, `reference/photo-1.jpg` when it is a symlink, `reference/notes.txt`, `.torno/thumb.png`, an absolute path, a file over `MAX_PHOTO`, a missing file, and a `reference` that is itself a link.
- [ ] **Step 2: Run them and see them fail:** `pnpm -C app exec vitest run src/main/sessions/reference.test.ts`
- [ ] **Step 3: Implement.** Test `file` against `^reference/(?:photo|doodle)-\d+\.(?:png|jpe?g|webp)$`. Check that `<dir>/reference` is a real folder (`lstat`, not a link). Then read with `readRegular(join(dir, file), MAX_PHOTO, 'reference')`, catching every error as `null`. Map the extension to a media type. Never log the bytes.
- [ ] **Step 4: Wire `chat:reference`** in `ipc.ts` and the preload: an unknown session answers `null`.
- [ ] **Step 5: Run the tests and the typecheck, then commit** the files above: "Chat: main reads a picture of reference/ again for the window, plain files of create's names only".

### Task 3: The window shows a reference from its file, and says what other pictures were

**Files:**
- Modify: `app/src/renderer/ui/chat/Pictures.tsx`
- Create: `app/src/renderer/ui/chat/gone.ts` (`goneText(image: ChatImage, what: string): string`, pure)
- Modify: the chat store `app/src/renderer/state/chat.ts` (a small cache of the decoded reference: `sessionId + file` to an object URL, at most 40, revoked when evicted and when the session's chat is closed)
- Test: `app/src/renderer/ui/chat/gone.test.ts`, `app/e2e/onboard.spec.ts`

- [ ] **Step 1: Failing unit test** for `goneText` with the texts of the Design table. The `what` a tool card passes is the one it passes today: grep `<Pictures` under `ui/chat/` and match it.
- [ ] **Step 2: Failing e2e** in `onboard.spec.ts` (hidden window, the stand-in agent). Create an object with one doodle and send. Close the session. Start it again with resume. Expect the earlier user item's thumbnail to be an `img` (not `.chat-thumb-gone`) with `title` `doodle-1.png`. Delete `reference/doodle-1.png`, resume again, and expect the text `reference/doodle-1.png is no longer there`. Read state through the DOM and `__tornoMain` only. No screenshot.
- [ ] **Step 3: Run and see them fail:** `pnpm -C app exec vitest run src/renderer/ui/chat/gone.test.ts`, then `pnpm build && pnpm -C app exec playwright test e2e/onboard.spec.ts`
- [ ] **Step 4: Implement.** In `Pictures`, an image with no `data` and a `file` asks the store, which calls `window.torno.chat.reference(sessionId, file)` once. It scales the bytes with the window's `images.ts` (long edge 1280) and turns them into an object URL (`src()` takes it in place of the data URL). While it loads, it shows the thumbnail frame empty. A `null` answer shows `goneText`. Everything else that has no data shows `goneText`. `Pictures` gets `sessionId` from its callers.
- [ ] **Step 5: Run both and see them pass,** then the four suites, then commit the files above: "Chat: a resumed chat shows the person's references from reference/, and says what a picture no longer kept was".

### Task 4: A new conversation is told which references the object has

**Files:**
- Modify: `app/src/main/context.ts` (`ContextDeps` gains `references(objectId): string[]`; `contextText` adds the line when `opts.fresh`)
- Modify: `app/src/main/index.ts` (the deps: list `<dir>/reference` with `readdirSync`, plain files of the names above, sorted photos then doodles by number; `[]` on any error or when `reference` is a link)
- Test: `app/src/main/context.test.ts`, `app/src/main/sessions/manager.itest.ts`

- [ ] **Step 1: Failing unit tests.** Fresh, with two references: the context holds the Design line word for word. Not fresh: it doesn't. No references: no line. With 14 references, the line names 12 and says `and 2 more`.
- [ ] **Step 2: Failing itest** (stand-in agent). An object with `reference/photo-1.jpg`, a new session, one prompt: the `UserPromptSubmit` answer the stand-in receives holds `reference/: photo-1.jpg`. With `resume: true` on a conversation on file, it does not.
- [ ] **Step 3: Run and see them fail:** `pnpm -C app exec vitest run src/main/context.test.ts` and `pnpm -C app exec vitest run --mode kernel src/main/sessions/manager.itest.ts`
- [ ] **Step 4: Implement**, keeping the text out of anything already counted as marks. The onboarding's first prompt is also fresh, and the line there repeats what the prompt says. That is acceptable, or skip the line when the prompt text already names `reference/`. Pick the first and keep it simple.
- [ ] **Step 5: Run the tests, then the four suites, and commit** the files above: "Context: a new conversation is told the files of reference/, to read when they matter".

### Task 5: Docs

**Files:**
- Modify: `CLAUDE.md` (root): under "What crosses processes", change "`.torno/chat/` holds text only: no address, no secret, no picture data." to "`.torno/chat/` holds text only: no address, no secret, no picture data; a reference picture is recorded by its path in `reference/` and shown from that file again."
- Modify: `app/src/main/CLAUDE.md`: the chat session and the log (`file` on a picture; `chat:reference` and its rules), and the onboarding (the caption is now also read by the transcript, so its form is a contract held by `transcript.test.ts`)
- Modify: `app/src/renderer/CLAUDE.md` (section "Agents", the chat pane: the Design table's texts)
- Modify: `README.md`: section "Not yet verified on a visible screen", add the by-hand check of Task 6, plus the files-torno-writes section if it lists the log's contents
- Modify: `docs/superpowers/specs/2026-10-08-torno-design.md` (the chat log paragraph)

- [ ] **Step 1:** Edit the docs. Then `pnpm -C app exec vitest run src/readme.test.ts` (headings order, one unverified section).
- [ ] **Step 2: Commit** the files above: "Docs: pictures of a resumed chat (references from reference/, the others said for what they were)".

### Task 6: By hand, once, against the real CLI (the owner)

No test does this.

- [ ] In torno, make an object with one photo and one doodle and send the first prompt. Let Claude Code take one `look`. Quit torno.
- [ ] Start torno again and open the object (the chat resumes). The photo and doodle show. The `look` picture says `Picture of an earlier build, not kept`.
- [ ] Ask the agent: "Without reading any file, describe the doodle I gave at the start." A right answer confirms that the CLI's resume gives the model its pictures again (decision 3). Record the result in README's section.
- [ ] Start a new conversation (`/clear`) and ask what references the object has. It names `reference/` from the context line.
