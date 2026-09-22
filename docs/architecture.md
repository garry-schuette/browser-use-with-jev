# Architecture

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
3. Jev selects a candidate, HOST, or VERIFY. Input fields are targeted handoffs.
4. On a concrete action, re-observe and verify the state fingerprint. Return one
   normal upstream `AgentOutput`; do not execute an independent browser mutation.
5. Browser Use executes and records the result. A prior action error routes the
   next step to the host for recovery instead of blindly retrying it.
6. Host handoff invokes the original `get_model_output` with the full messages,
   screenshots and output schema. The host can use all registered upstream tools.

Jev state includes text-only upstream messages to preserve task constraints and
history. It also includes the typed DOM and latest action results. The complete
state is budget-checked rather than silently truncated. Host calls keep original
message objects; image data is not sent to TypeSafe.

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
