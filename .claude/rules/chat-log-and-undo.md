---
paths:
  - "app/src/main/sessions/chatlog.ts"
  - "app/src/main/sessions/chatlog.test.ts"
  - "app/src/main/sessions/snapshots.ts"
  - "app/src/main/sessions/snapshots.test.ts"
  - "app/src/main/sessions/undo.ts"
  - "app/src/main/sessions/undo.test.ts"
  - "app/src/main/sessions/reference.ts"
  - "app/src/main/sessions/reference.test.ts"
  - "app/src/shared/changes.ts"
  - "app/src/renderer/ui/chat/TurnEnd.tsx"
  - "app/src/renderer/ui/chat/turnSummary.ts"
  - "app/src/renderer/ui/chat/turnSummary.test.ts"
  - "app/src/renderer/ui/chat/Changes*.tsx"
---

# The chat's log, what a turn changed, undo, the end of a turn

Moved as written from the folder `CLAUDE.md` files; each heading names the folder it came from, and paths are written as they were there (see "Rules by area" in the root `CLAUDE.md`).

## Agents (`app/src/main`)

- The log (`chatlog.ts`) appends each item as it becomes final to `.torno/chat/<conversation>.jsonl`: text only,
  the data of a picture never, `redact` applied to every line, one write at a time per file, the folder checked
  with `ownTorno(dir, 'chat')` and ignored (`ensureIgnored`); after one write fails none is tried. A picture of the
  first prompt of a new object carries `file`, its path in `reference/` (the transcript reads it from the caption
  before it, `REFERENCE_CAPTION`), and the log keeps that and never the data. `chat:reference` (`sessions/reference.ts`
  `readReference`) gives the window the bytes of such a file again, for a session of the open workspace (one ended
  too): only a name of the form `create.ts` gives (`REFERENCE_FILE`), only a plain file read with `readRegular` of
  `create.ts` (no link, `reference` itself no link), at most `MAX_PHOTO`; anything else is null, never an error. A resumed chat
  reads the tail of the file as "Earlier in this conversation". The pane with no session shows the end of the conversation on file the same
  way, read-only (`chat:lastConversation`, `lastConversation` of `chatlog.ts`: the last eight `user`, `text` and `turn` items and the
  log's modification time; it only reads, and the object must be of the open workspace). A log over 5 MB is cut to its last 2,000 lines, whole
  and atomically, when a session starts on it (`trimLog`). Switching `view` ends the session and resumes the
  conversation in the other kind (`session.json` is the same).
- **What a turn changed in the model** (`sessions/snapshots.ts`, `shared/changes.ts`, `chat:changes`). When a
  prompt is sent (its `UserPromptSubmit`, read before the hook is answered, so before the agent can have touched
  anything) and when the turn ends (its `result`, as the transcript puts the turn item), main reads the text of the `.py`
  files directly in the object's folder (as `sourceFolders` has the own folder; not `<workspace>/common`; plain files
  only, `lstat` and `O_NOFOLLOW`, 60 files at most, `MAX_FILE_BYTES` (200 KB) each: a larger file is told to have
  changed by its size and mtime, with no text), and keeps the files that differ as `TurnChanges`, by the id of the turn's item
  (`KeptChanges`: the last `MAX_TURNS` (20) turns of a session and `MAX_KEPT_CHARS` (4 M characters) of text, the oldest let
  go first). **Held in memory only**: never written (not under `.torno/`, not in `.torno/chat/`, not in `state.md`), not
  a chat item and not logged, gone with the session's record. A prompt folded into a turn under way is not a start of its
  own (the turn keeps its first snapshot); a turn with no hook before it begins where the last ended. What the
  person saved between two turns is no turn's. A change made by a `Bash` is found too (it is by the files, not by
  the tools); a file outside the folder is not. `chat:changes(sessionId, turnId)` answers null for a session that is not
  of the open workspace and for a turn it holds nothing of (also one that changed no file there); it waits for the
  turn's snapshot to be read. The window draws the diff (`ChangesSheet`); torno never writes the model.
  **Undo** (`Sessions.undoTurn`, `chat:undo`, `sessions/undo.ts`) is a request, not a restore: for the last turn of an
  idle chat (refused with a `Refusal` otherwise: working or asking, a prompt untaken, not the last turn, nothing kept of it)
  main puts a quiet note in the transcript and sends one prompt of its own words (`undoPrompt`), as the person's, that asks
  the agent to put the files back, with the lines to reverse (`reverseBlock`: what the file has now between what the two
  texts share at their ends as `-`, what it had as `+`, a line of context each side; at most `MAX_REVERSE_CHARS`, 12,000, for
  all files, a file beyond it or too large to have been kept being named without lines; a file the person saved since,
  read again now, is said to have changed). The agent edits, through its own tools and permission cards: torno writes nothing
  of the model, and this rule is unchanged. Claude Code's checkpoints (`--rewind-files`) are not used: they await the spike
  in the manual's "Not yet verified" (`Part of #131`).

## Agents (`app/src/renderer`)

- **The end of a turn** (`ui/chat/TurnEnd.tsx`; the rule is `ui/chat/turnSummary.ts`, pure). Its first quiet line is
  "Done in 42 s" and then what the turn did, said from the turn's own items and nothing else (`turnSummary` over
  `itemsOfTurn`, the items after the turn before it): the files the agent's `Edit`, `Write` and `MultiEdit` changed (only
  those that finished: a denied one is not counted), the builds their edits started (`r1 → r3 ok`, `build failed`,
  `r3 ok after 1 failed build`: the first revision is the build on show when the prompt was sent), the marks it resolved
  and added (`resolve_mark`'s `id`; `add_mark`'s from its answer), and the dimensions whose verdict at the end is another
  than at the start (the first `was` and the last `now` of the digests, `verdictChanges`' own). What it pulled from torno
  is a line of its own. Under them a row of buttons for the turn (`TurnActions`): "See changes" (only when an edit
  changed a `.py`), which opens `ChangesSheet` over the transcript as a picture is shown large (a dialog in the host
  `.chat-scroll`, `chat.close` puts it away, Tab goes round within it, the focus goes back to the button): per file main
  kept (`chat.changes`, in memory, the last 20 turns; none is "No change ... is kept for this turn"), "Changes" (the
  file before against after, `Diff` with `ofEdit` false, so without the caption that is true only of an edit's lines)
  or "Whole file" (read only, the monospace face, no refs searched), and, below, the builds taken together
  (`netParts`: a part's volume and faces from the first digest's `before` to the last's `after`, `≈` unless exact). "Undo"
  (`Undo` in `TurnEnd.tsx`, `chat.undo`) is beside it on the last turn only: `ChatPane` gives its id to `UndoableTurn` while
  the session is live and idle and no prompt of the person's follows that turn. It asks once in the row (a group named "Undo
  this turn", "Ask to undo" / "Keep it"), main sends the prompt and a note, and a refusal of main is said beside the button.
  A further action for a turn is one more button in `TurnActions`, given the turn's `item` and `account`.
