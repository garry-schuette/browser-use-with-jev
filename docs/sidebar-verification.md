# Codex sidebar verification

Verified on 2026-09-23, macOS, inside the current Codex desktop conversation.
The sidebar backend is separate from the Python Browser Use engine.

## Live result

Opened `examples/fixtures/bridge.html` from a loopback-only HTTP server in a
visible Codex in-app tab, using the real CUA runtime and the saved TypeSafe config.
The task was to enter `Codex Sidebar`, enable the greeting checkbox and display
`Hello, Codex Sidebar!`.

| Step | Responsible component | Observed result |
| --- | --- | --- |
| Open the page | Codex CUA | Visible in-app tab, no standalone browser |
| Select the name field | Jev 1.13.0 | `text_input` handoff to Codex |
| Enter the text | Codex CUA | Input contains `Codex Sidebar` |
| Resume the same session | Jev / CUA | Checkbox checked and button clicked |
| Request verification | Jev | `needs_verification`, no success assertion |
| Independently inspect | Codex | Fresh screenshot shows the text, checked box and greeting |
| Keep the page | CUA deliverable mark | Result tab retained |

Measured across two chunks: 4 Jev decisions, 2 executed CUA actions, 1 recorded
host input action, no failed decisions. Total loop time was 9451 ms; model-request
time including queue/network overhead was 7538 ms. This excludes host time
between chunks and is not a speed comparison or server-only inference latency.

Direct API fetch from the CUA runtime failed with DNS `ENOTFOUND`; no page action
executed in that attempt. A normally authorized local Node worker could reach
the same configured TypeSafe endpoint. The successful test used the private
file-queue transport, with all observations and actions remaining in CUA. The
worker was explicitly stopped after verification. No credential was copied or
printed, and private session data stayed outside the repository.

## Offline coverage

Run `node --test tests/sidebar.test.mjs tests/sidebar-worker.test.mjs`.
The tests use fake CUA tabs and mock HTTP responses, covering:

- Project/legacy config precedence, raw/dotenv/environment credentials.
- AX metadata, input labels, ambiguous/disabled/reserved controls.
- Input handoff and continuation with the same history.
- Stale indices, origin changes and observation/action failures.
- Confidence, complete-request/candidate limits and bounded transport retries.
- Page/container scrolling, back, no-progress detection and cancellation.
- Private logs, tab retention, deterministic loading checks.
- Worker correlation, file consumption, provider/model consistency, expiry,
  request/idle limits, stopping and safe API errors.

The Python regression suite remains separate; the sidebar imports no Python
Browser Use browser code. See [architecture](architecture.md) and the
[operator workflow](../skills/browser-use-with-jev/references/sidebar.md).

## Limits

Only the local greeting flow was verified with real CUA/Jev. Scrolling and failure
branches have offline coverage; arbitrary sites, existing Chrome profiles,
OpenRouter, uploads and complex widgets were not tested live in this change.
Direct CUA networking remains environment-dependent. Sidebar routing is flat;
it does not inherit upstream Python tools, memory or hierarchical routing.

## Ctrip candidate regression (2026-09-23)

The reported three Ctrip calls had empty action lists: a `checkIn` container,
a date text field, and nested buttons both named `搜索`. The offline regression
in `tests/sidebar.test.mjs` reconstructs these role/name/hierarchy patterns;
it is **not** an original captured Ctrip snapshot or a live browser run. Dates
and IDs in that fixture are synthetic.

Explicit host selectors now support roles, node IDs/indices and ancestor scopes,
with exactly one match required. Special click roles require explicit opt-in;
discovery remains conservative. Nested duplicate candidates have distinct model
labels. Fresh-state checks still prevent stale target execution. At the time of
this 2026-09-23 check, empty action lists produced `no_action_candidates`; the
later autonomous runner now lets Jev choose VERIFY, HOST or WAIT in that state.

Version-2 private logs include each candidate round, exclusions, state summary,
request dispatch/valid-response flags, decisions, execution outcomes, run
handoffs, host action outcomes and verification evidence. The workflow requires
saving an independent log at handoff and after verification. Saving remains
explicit and refuses overwrite; direct unwrapped browser calls are not observed.
Host wrappers log attempts and post-action state; legacy notes are only reports.

Readiness and expected-effect conditions wait for host-specified page text.
A missing calendar/effect or unchanged AX state stops the loop. Failed targets
remain blocked across chunks until recorded host recovery. This is not visual
proof of failure: host inspection is needed for screenshot-only changes.

Validation: 48 Node tests and 78 Python tests passed; Ruff lint/format, sidebar
doctor, and source/wheel builds passed. Tests cover all three unique candidates,
a mocked Jev-selected click, rejection of premature VERIFY, wrapped host input
and submit, final fixture evidence, private log persistence, delayed calendar
appearance, missing readiness/effects, and cross-chunk repeat prevention.

Live Jev/API success rate and live Ctrip task success rate were **not measured**
in this change. Live acceptance still requires actual Jev execution, fresh page
verification of the user's dates and Beijing University location, and a saved
log covering every host action. `apiSuccessRate` measures valid responses per
transport dispatch; `browserTaskVerified` requires recorded host acceptance.

## Autonomous runner verification (2026-10-09)

The new `session.start(task)` entry was tested through the real Codex CUA tab and
configured TypeSafe Jev provider on local, non-network-submitting fixtures. The
CUA runtime could not resolve the provider; the bounded synthetic preflight
reached it with normal host network permissions, then the local API worker
forwarded only Jev requests. The first CUA attempt made one DNS-failed request
and no browser action. No provider or credential setting was changed.

In the greeting fixture, Jev selected a host-supplied text field, checkbox and
button, then VERIFY. The fresh AX verdict and a separate CUA observation showed
`Codex Autonomous`, a checked checkbox, and `Hello, Codex Autonomous!`.
That successful run made four Jev decisions, executed three actions across four
internal chunks, and needed no intermediate Codex action.

The new [autoloop fixture](../examples/fixtures/autoloop.html) exercises an
asynchronous filter panel, a host-supplied search value, asynchronous results,
and two `View details` buttons distinguished by a stable card ancestor. The first
live attempt handed off after opening filters because CUA called the input a
`search text field`, which the parser did not recognize. After adding that AX
role, the full rerun reached fresh verification: five Jev decisions, four
executed actions, four internal continuations, one accepted verification, and
**zero external handoffs**. A separate fresh CUA observation showed Query =
`Coast` and `Completed: Coast Hotel details opened.` The local fixture does not
establish success rates on arbitrary websites.

Offline tests cover the same multi-chunk pattern plus transport retry, stale
state, observation and verification errors, bounded history, wait timeout,
concurrent-call rejection, and first-chunk readiness. Run
`node --test tests/sidebar.test.mjs tests/sidebar-autoloop.test.mjs tests/sidebar-worker.test.mjs`.

A cross-call CUA probe found that letting browser work continue after a
`runner.wait()` returned caused the next observation to fail. The runner now
pauses at a `running` checkpoint and resumes inside the next `wait()` call.
A second cross-call probe returned `running` with zero requests on a short wait,
then resumed in a new CUA call and reached accepted verification. This is a CUA
runtime constraint, not a Jev handoff per action.
