# Recording the CLI's stream again

The two recordings here, `claude-stream.jsonl` (Claude Code 2.1.300) and `claude-stream-asks.jsonl` (2.1.301), are what
the reducer (`src/main/sessions/transcript.ts`) is held to, and the versions in their `init` are the range torno was
checked with (`TESTED_CLAUDE` in `src/main/sessions/claude.ts`; the README names it). When the CLI moves, record a new
stream and move both. This is done by a person, by hand, with their own login. Never in a test, and never by an agent.

1. In an empty folder with a `note.txt` holding `hello`, start the CLI as torno does in a chat, with the person's own
   login and no key in the environment: `claude -p --input-format stream-json --output-format stream-json --verbose
   --include-partial-messages --permission-prompt-tool stdio`, and write the prompts as lines of JSON on its stdin
   (`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`). The prompts of
   `claude-stream.jsonl` are "read note.txt", "write probe.txt" and "count to 200". For the asks, one that needs a
   permission, one `AskUserQuestion` and `/compact`.
2. Keep stdout line by line. It holds the person's paths, ids and every installed plugin and skill: scrub them as the
   recordings are (`/work/obj` for the folder, `/home/person/x` for any path of the person's, fresh uuids, the names of
   the plugins and skills as they are in the files here), and keep every field name and shape, which are the point.
3. Every line must parse as JSON. Run `pnpm test`: `transcript.test.ts` plays the files.
4. Read the new `init` for a field torno should know that the old one lacks, and the `result` likewise.
5. Move `TESTED_CLAUDE` to the versions of the recordings you hold, and the line of the README that names the range
   ("checked with …"). The test in `claude.test.ts` holds the range to the files here.
