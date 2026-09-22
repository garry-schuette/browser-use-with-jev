# Current-conversation bridge verification

Manual live smoke test, 2026-09-22, macOS, Browser Use 0.13.10.

The worker used a fresh local headless browser profile, the real TypeSafe Jev
endpoint, and the active Codex conversation for host inference. No separate
text-model API was called. Default extension downloads were disabled.

Task: load a loopback-served synthetic form, enter `Codex Bridge`, check
`Enable greeting`, click `Show greeting`, and verify `Hello, Codex Bridge!`.
The reusable fixture is [bridge.html](../examples/fixtures/bridge.html).

Observed final run:

| Check | Result |
| --- | --- |
| Jev requests | 4 |
| Jev-selected actions | 2: checkbox and button clicks |
| Host decision handoffs | 2: text input and final verification |
| Total host requests | 3, including upstream final judge |
| Jev API errors / stale decisions | 0 / 0 |
| Final rendered text | `Hello, Codex Bridge!` |
| Final worker state | `finished`, `success: true`, no pending requests |
| Worker exit | 0; browser cleanup completed |

The assistant read the actual page context and output schema, generated replies,
and inspected the final screenshots. Element indexes differed between runs and
were read from each request rather than hardcoded into the browser task.

An earlier run reached the correct page result but failed while serializing a
`Counter` in routing statistics. Handoff counts now use a plain dictionary, with
a JSON-serialization regression test. The complete live task was then rerun
successfully. This distinguishes successful browser interaction from successful
worker completion.

The offline suite has 38 tests at this change, including request/response round
trips, replay rejection, invalid response correction, timeout/cancellation,
screenshot export, saved credential-path precedence, and the existing router.

This is one local form workflow, not a benchmark or proof of arbitrary website
compatibility. Host response delays include the active conversation's reasoning
and tools; no speed or cost advantage is claimed. Raw session files, screenshots,
profiles, and credentials remain outside the repository.
