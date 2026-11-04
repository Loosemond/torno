# Security policy

## Reporting a vulnerability

Please don't open a public issue. Use [private vulnerability
reporting](https://github.com/luisg0nc/torno/security/advisories/new).

Say which commit you ran, on which platform, the steps that show it, and what the finding lets someone do. You'll
get an acknowledgement within a few days. A fix lands on `main` and is noted in the advisory. There is no bounty:
torno is one person's project.

## Supported versions

`main`, and the latest release once there are releases. Nothing older.

## How torno is meant to be safe

So that a report is on target:

- The HTTP server for the agent's tools and hooks binds `127.0.0.1` only, on a port the OS picks.
- Every request carries a per-session token in the `X-Torno-Session` header. It is compared in constant time, and a
  wrong, missing or revoked one is answered 404.
- The token reaches the agent only through its environment, never in an argument or a file, and is never logged.
- torno writes in a workspace only under `<project>/.torno/`, plus the one new folder "Create" makes and the one
  file an export saves where the person chose.
- The kernel never writes a file.
- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`.
- The agent is the person's own `claude`, under their own login. torno uploads nothing.

## In scope

- Anything that gets around the token or the `127.0.0.1` binding.
- A model file or a scan that makes the kernel or the app write outside `.torno/`.
- Agent output that runs code in the window.
- A secret reaching a log or `.torno/chat/`.

## Out of scope

- What Claude Code itself does with the person's permission settings. torno reads none and changes none.
- A model file the person wrote running code when it is built. That is what a model is.
