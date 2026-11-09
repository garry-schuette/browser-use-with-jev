# Architecture

## Execution modes

The skill defaults to Codex's visible in-app browser when its CUA tools are
available. Explicit standalone/SDK requests retain the Python Browser Use engine.
These are two execution backends, not interchangeable browser objects.

The bundled `sidebar.mjs` adapts the community Jev CUA loop. It accepts an existing
authorized tab, builds actions from fresh AX observations, asks Jev, rechecks the
snapshot, then calls the documented CUA tab methods. Codex supplies text: an
explicit non-secret literal can be executed when Jev chooses the field, while
other input and unsupported widgets hand off to Codex. The default
`session.start(task)` entry returns a runner; `runner.wait({timeoutMs:45000})`
returns either a `status: 'running'` snapshot with metrics/chunks/last event or
a structured handoff. During each wait, the runner continues across internal
`run()` step/time chunks without another host-model decision. Browser work pauses
at a `running` checkpoint and resumes in the next active CUA call; background
browser calls after a CUA call has returned are unsupported.
Its default total limit is 120 rounds or 10 minutes, configurable through
`session.start(task, {maxTotalSteps, maxTotalMs})`; reaching it returns
`autonomy_limit`. CUA calls use a 60000 ms timeout;
the host can call `wait` again on the same runner while it works, or call
`session.cancel()` to stop future actions. Errors at the runner boundary return
safe structured results with status and handoff reason, including when an action
may already have executed. An optional `verify` callback checks fresh AX
evidence at VERIFY and may finish the runner when accepted; visual verification
still belongs to Codex. `runCompact` can check
fresh host-defined AX evidence in the same CUA call as the Jev loop. `runPlan`
continues across bounded stages only after each fresh verdict is accepted. Tab
handoff/deliverable marks preserve the page across turns; final verification
remains with Codex.

The runner counts only handoffs actually returned to Codex; internal step/time
continuations are tracked separately. Jev can choose VERIFY, HOST or WAIT when
the page has no remaining action candidates. To bound long sessions without
discarding task constraints, each request carries the full goal and current AX
state plus the latest 12 history entries and counts for older events; the full
history remains in the private session log. Background runs check `ready` once
at startup, then use each action's `expect` condition for later page transitions.

`sidebar-client.mjs` supports the existing project config and the community config
as a fallback only when the project config is absent. Direct API requests run in
CUA when networking is available. The optional `sidebar-worker.mjs` is a local
Node process with normal host-authorized network access, connected via private
request/response files by `sidebar-transport.mjs`. It has no browser driver, HTTP
listener or host-model API. Its fixed provider configuration cannot be overridden
by page content. Queue IDs, expiry, response consumption, request/idle limits and
explicit stop bound its lifetime. Cancellation can leave an API request in flight,
but its result does not dispatch a browser action.

`sidebar-check.mjs` makes one synthetic Choice request, directly or through an
existing queue, and validates the response without browser observations/actions.
Use it with normally approved network access to distinguish restricted-runtime
DNS failures from provider failures before starting or resuming real work.
Its request/response counts are diagnostics, separate from session metrics.

Sidebar routing is flat (252 actions plus three handoffs), with a 40000-character
complete-request budget. Large pools/context hand back without truncation. It does
not reuse the Python tool registry, upstream memory, or hierarchical router.
Session metrics/logs label their backend; API timing in queue mode includes local
queue overhead. This backend's Node tests and real CUA verification are separate
from the Python suite. See [sidebar verification](sidebar-verification.md).

The sections below describe the unchanged Python execution boundary.

## Dependency boundary

`JevAgent` subclasses the installed Browser Use `Agent`. The upstream run loop,
browser session, DOM collection, action executor, tool registry, history, memory,
extraction, and completion/judge machinery remain upstream-owned. An ordinary
Browser Use `Agent` can still be used alongside this class without any patching.

Only two overrides exist: `_get_next_action` captures the current typed page for
one upstream decision, and `get_model_output` chooses between Jev selection and
the inherited model call. The private hook is a deliberate compatibility risk,
bounded by an exact dependency pin and contract tests.

## Decision path

1. Browser Use prepares its page, messages, active action schema and context.
2. Build validated concrete candidates from indexed DOM nodes and observed tabs.
3. Small pools use a flat Choice. Larger pools ask for an operation and compatible
   targets in parallel; only the chosen operation's answer is used. Oversized target
   pools use exhaustive groups, then recursively select a concrete candidate.
   Every question includes HOST/VERIFY within its choice limit. Input fields are
   targeted handoffs; groups are never executable actions.
4. Before another target request and on a concrete action, re-observe and verify
   the state fingerprint. Return one
   normal upstream `AgentOutput`; do not execute an independent browser mutation.
5. Browser Use executes and records the result. A prior action error routes the
   next step to the host for recovery instead of blindly retrying it.
6. Host handoff invokes the original `get_model_output` with the full messages,
   screenshots and output schema. The host can use all registered upstream tools.

The Python adapter no longer forces a host review every 12 Jev actions by
default. `host_every` can still request a positive periodic interval. Unexpected
candidate, provider, selection or validation errors route to a safe `jev_error`
handoff; raw exception text is not passed to the host or decision trace.

Jev context v2 reuses the current redacted upstream state message once. This
message already contains the task, history/compacted memory, todo, plan, read-once
results and browser observation. The exact default system prompt captured at
initialization is removed; configured extensions, overrides and unknown messages
are preserved. State detection uses the message-manager slot identity, never
parsing page-controlled XML-like tags. History compaction remains upstream-owned;
there is no second lossy memory or arbitrary tail truncation in the adapter.

Direct SDK calls without that state slot fall back to typed task, DOM, tabs,
scroll state, memory, plan and recent results. Both paths omit image bytes and
keep original host messages unchanged. The budget covers the complete request
body (including candidate labels and selection instructions), not just state.
Bridge and SDK default to 40,000 characters. Over-budget requests hand off without
silently dropping constraints. Decision traces include the actual request body
without authorization headers, source mode and input/context/request character
counts. These are character metrics, not model token counts.

The per-question ceiling is `min(max_candidates, 255)` including HOST/VERIFY.
Groups preserve DOM/provider order and candidate identity, including separate
frames. Built-in indexed targets may reference the current DOM in group criteria;
both the typed observation and the actual context must contain that index. New-node
`*[index]` markers from the pinned serializer are supported. Missing references
and custom candidates retain full labels unless an explicit `dom_index` hint is
supplied. Final leaf questions always retain full labels; oversized leaves split
further rather than truncating their descriptions.

If the combined speculative body is too large, only the operation is requested
first, followed by its target head. Any individual body that still exceeds the
budget hands off. All routing layers retain original context and require confidence
on the consumed answers; low confidence on unused heads is ignored. Structural API
validation still checks every answer. Multiple questions count as one request and
one latency interval. Each round's `requests` records all attempted bodies,
submission flags, choice counts and answers; `selection_path` identifies consumed
choices. The top-level `request`/`request_chars` describe the latest attempt and
`request_submitted` distinguishes a locally rejected body from a submitted one.

`about:blank` requires host navigation. An unchanged fingerprint on the next round
after a Jev action hands off as `no_progress`; any host handoff resets this guard
so later host actions are not attributed to Jev.

## Extensibility

Custom `candidate_provider` functions can offer finite parameter combinations
for existing/custom tools without changing the executor. `allow_candidate` is a
delegation filter, not a security boundary; host authorization remains upstream.
Do not change model-generated strings into executable Python/JS or selectors.

`HostModel` provides an inference callback seam for embedding agents. The local
`bridge` worker implements that seam with private request/response files. The
active Codex assistant reads each request through its tools, views local images,
and submits its own schema-validated completion. This includes extraction and
final judging. The Python process never invokes a hidden Codex endpoint.

Requests use unique IDs, responses are atomically created once, and consumed or
cancelled requests reject reuse. Waiting requests have a deadline. A cancellation
marker cancels the upstream run, and normal shutdown closes its isolated browser.
The session directory holds private page data and should live outside the repo.
The file queue is a same-user local trust boundary, not an authenticated service
for mutually untrusted local processes. It does not persist a resumable browser
worker across process death.

## Next validation milestones

- Local browser fixtures: input, dropdown, pagination, tab switch, upload,
  extraction and a custom tool, including failures after action execution.
- Broader live host-runtime coverage beyond the verified local form task.
- Matched upstream-only vs hybrid runs: task success, Jev selection share,
  all host calls (including auxiliary calls), tokens, elapsed time and cost.
- Expand selection to observed dropdown choices and host-generated parameter
  buffers; keep generative work with the host.
- Evaluate context size and connection reuse before claiming speed or cost
  improvements. Current client opens a connection per decision.

No benchmark numbers or majority-decision claims are established yet.
