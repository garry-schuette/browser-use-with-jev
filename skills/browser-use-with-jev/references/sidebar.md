# Run in the visible Codex sidebar

## Connect and run

Use the direct `mcp__cua_repl.js` tool, not a nested `tools.*` call in
`functions.exec`. Absence from `ALL_TOOLS` does not establish missing CUA. Follow
its first-call rule and read the returned documentation. With no existing tab
specified, the first call can contain only:

```js
var taskTab = await cua.createBrowserTab('iab', 'https://example.com', {visible:true});
```

Substitute the actual task URL. Sidebar mode is visible so the user can watch;
honor an explicit background preference with `visible:false`. For an existing
tab, discover and attach using the runtime's documented APIs. Reuse the handle;
the helper never creates tabs or launches browsers.

Resolve `<skill-dir>` from SKILL.md. In the next CUA call:

```js
var jev = await import('file://<skill-dir>/sidebar.mjs');
var jevConfig = await jev.loadConfig();
var session = jev.createSession(taskTab, {
  ...jevConfig, allowedOrigins: ['https://example.com'],
  maxSteps: 12, maxMs: 45000, minConfidence: 0.65
});
var task = {
  goal: 'Open notification preferences and inspect the current settings.',
  controls: [
    {op:'click', name:'Settings'},
    {op:'click', name:'Notification preferences'}
  ]
};
nodeRepl.write(await session.run(task));
```

Use a 60000 ms tool timeout. Keep bindings across chunks. `maxMs` stops further
work but cannot interrupt a dispatched CUA action. `session.cancel()` prevents
future actions; it cannot undo an action. A cancelled session cannot resume.
Do not cache-bust imports except when testing edited code.

## Configuration

`loadConfig()` reads project `~/.config/browser-use-with-jev/config.json` first,
then `~/.config/jev-browser-use/config.json` only if the project file is absent.
Malformed project config never falls through. The project's `jev_env` and the
community `envFile` both reference a credential file. Raw keys and dotenv work;
the TypeSafe and OpenRouter adapters are retained. No key is returned.

Explicit `loadConfig({envFile, provider, model})` takes precedence. With no file,
the Node process environment supplies the selected provider's key. Restricted
CUA may not expose that environment; use a saved file or the API worker below.
The existing `bridge configure --jev-env PATH` command still saves the TypeSafe
file reference. Do not ask for setup again if already configured. Python
standalone continues to use TypeSafe, not OpenRouter.

## Actions and handoffs

Explicit controls support `click`, `input` (handoff only), `scroll`, `press`,
`reload`, and `back`. Click/input matches a visible name or `aliases`. Use `role`, `target: {id,
index, role}` and `within: {name, id, role, index}` to narrow to exactly one
observed node (all provided fields must match; `within` matches an ancestor).
Never choose the first duplicate. AX indices are snapshot-local; rebuild explicit
index selectors after navigation. IDs, names and roles are rechecked against the
entire fresh snapshot before dispatch.

Live result lists can rehydrate and renumber AX nodes without a full navigation.
When repeated controls such as `查看详情` appear inside cards, prefer a stable
card ID/name in `within` over the button's snapshot-local index, for example
`{op:'click', name:'查看详情', within:{name:'70432873', role:'container'}}`.
Re-observe immediately before constructing the control when no stable ancestor
exists.

Explicit clicks may opt into `container`, `text field`, `text area`, or `combo box`
by specifying that exact `role` (or `target.role`). Discovery still excludes them
from clicks. Disabled ancestors and name restrictions remain enforced. Example
selectors below are illustrative: populate IDs from the current AX observation.

```js
controls: [
  {op:'click', name:'checkIn', role:'container', target:{id:'checkIn'},
   within:{id:'home'}, expect:{includes:['选择入住日期']}},
  {op:'click', name:'入住日期', role:'text field', within:{id:'hotel'}},
  {op:'click', name:'搜索', role:'button', target:{id:'search-submit'},
   within:{id:'hotel'}}
]
```

With no candidates, return `no_action_candidates` without calling Jev. Inspect
`excluded` / `rounds[].excluded` for `unsupported_role`, `ambiguous_target`,
`target_not_found`, disabled/reserved targets and prior blocked actions.
Each round retains its candidate identities, exclusion reasons and state summary.

For broader authorized navigation, opt into discovery using `policy`:

```js
var task = {
  goal: 'Find report filters and enter the user-requested date range.',
  // On pages with unrelated private/account content, send only this observed
  // subtree to Jev. Full local state is still used for stale-target checks.
  contextScope: {id:'report-filters'},
  policy: {
    click:true, input:true, scrollDirections:['down','up'], scrollAmount:1,
    requireCodexNames:[/publish/i,/send/i], denyNames:[/delete/i]
  }
};
```

`contextScope` must match exactly one observed node by `id`, `name`, `role`, or
`index`. The Jev request receives only the browser header and that node's subtree;
target discovery and pre-action identity checks still use the full fresh AX tree.
Use a stable `id` or a compound selector when possible. A missing or ambiguous
scope hands back before any request. Rebuild index-based scopes after navigation.

Select policies from the actual authorization; name filters are not a general
permission system. `allowNames` narrows discovery. `denyNames` and
`requireCodexNames` also exclude explicitly named click/input controls.
Scroll can use `targetName`/`targetAliases` (`policy.scrollTargetName`) or a
Codex visually selected `point` (`policy.scrollPoint`). `policy.keys`,
`policy.reload`, and `policy.back` enable safe keys, reload, and back.

For `host_required` / `text_input`, inspect the fresh handoff state, enter the
authorized text, observe again, and resume the same session:

```js
// Use the fresh index in the real handoff; 5 is only an example.
await session.hostAction('Entered the requested value in the named field.',
  tab => tab.setValue(5, 'User-authorized text'));
nodeRepl.write(await session.run(task));
```

Wrap **every** host navigation, input and click in `session.hostAction(note,
async tab => ...)`, including recovery after a handoff. It records the attempt,
execution result and fresh post-action state even when observation fails. Use
one wrapper per action so partial failures remain attributable. Legacy
`recordHostAction(note)` only records a host report and cannot establish execution.
Direct tab calls cannot be counted automatically; `hostActions` is recorded
coverage, never a complete count if wrappers were bypassed.

Never put credentials in the note. Codex handles dropdowns, frames, uploads,
graphical controls and extraction with documented CUA tools, then resumes the
session. These are host actions, not automatic Browser Use tools.

- `needs_verification`: independently inspect fresh evidence; use screenshots
  for visual assertions. VERIFY does not mean success. Record the host verdict:
  `session.recordVerification({accepted:false, reason:'Search was not submitted',
  evidence:freshState})`. After correcting the task, resume to a new VERIFY and
  record acceptance with fresh evidence. Rejection records `verification_rejected`;
  it does not increment successful browser outcomes.
- `host_required`: handle input/planning or a candidate/context limit. Flat
  routing allows 252 actions plus HOST/VERIFY/WAIT; the complete request budget
  is 40000 characters. Excess hands back without truncation.
- `low_confidence`, `no_progress`, `loading_timeout`, `action_error`, `blocked`:
  inspect state before continuing. A failed action may already have had effects.
- `budget` / `step_limit`: continue a bounded chunk if progress warrants it.
- `decision_error`: inspect the safe error. Only transport errors retry, once
  by default. Auth/schema errors never retry or change provider automatically.
- `dns_error`: the runtime could not resolve the configured API hostname. Do
  not keep retrying direct requests. Check connectivity with the host's normal
  network permissions, then use the worker below if the CUA runtime is restricted.
- `outside_origin`: reassess authorization before expanding the origin list.
  The click may already have navigated; the next model request/action is blocked.

`waitForState(tab,{allowedOrigins,includes,excludes})` checks loading without model
calls and returns `matched`, `timeout`, or `blocked`. Task `ready:{includes,
excludes}` checks readiness before Jev; each explicit action's `expect:{includes,
excludes}` waits for the expected effect after dispatch (for example an opened
calendar). `effectTimeoutMs` defaults to 1500 ms, bounded to 10000 ms and the
remaining chunk budget. Missing readiness/effects return `form_not_ready` /
`expected_effect_missing`. A click without any AX change immediately hands back
as `no_progress`; visual-only changes need host inspection.

An ineffective or failed target stays excluded across chunks until a recorded
host recovery. Inspect the page and switch entry points instead of blindly
resuming the same click. A successful host wrapper or legacy host action note
clears this block; only record recovery after actually performing it.

## Optional local API worker

When CUA direct networking fails or is known unavailable, run the bundled API
worker through the host's normally authorized shell/network tool. It retains
the configured provider, opens no network listener and has no browser driver.
It does not grant permissions; a denied escalation is a blocker, not a reason
to bypass the denial.

The worker inherits the shell's network restrictions. After direct CUA DNS
failure, do not launch another worker in the same known restricted environment.
First run the bounded synthetic check through the host's normal network approval
flow (`require_escalated` in Codex):

```bash
node <skill-dir>/sidebar-check.mjs
```

This sends exactly one synthetic decision to the configured provider, using its
existing credential, with no browser state. Explain that scope in the approval
request. It validates the response schema and prints only safe counts/status.
It does not test browser accuracy or speed. A denied approval means this command
did not run: report it separately from failed API requests and honor the denial.
Do not switch providers, rewrite DNS, or bypass restrictions. If approved and
reachable, launch the worker with the same normally approved network permissions;
approval of the check alone does not give a restricted worker network access.
A `ready` state only
means the queue is ready, not that the API is reachable. Verify one synthetic
request through the queue before resuming the browser task:

```bash
node <skill-dir>/sidebar-check.mjs --session-dir <same-session-directory>
```

Count this probe separately from task decisions. Never
report connectivity success solely from `state.json`.

```bash
node <skill-dir>/sidebar-worker.mjs \
  --session-dir <fresh-absolute-temporary-directory> \
  --max-requests 100 --idle-timeout 120
```

Use a short shell yield. The directory must not exist; its permissions are 0700,
and queue files use 0600. Read `state.json` for `status: ready`, then in CUA:

```js
var queue = await import('file://<skill-dir>/sidebar-transport.mjs');
var transport = await queue.connectWorker('<same-session-directory>', jevConfig);
var session = jev.createSession(taskTab, {
  ...jevConfig, transport, allowedOrigins:['https://example.com']
});
```

If a session already exists, `session.run({...task,transport})` preserves its
history. Worker and CUA provider/model must match. The worker reads saved config,
never page-supplied credential paths or endpoints. For differing explicit
per-task config, use direct mode or deliberately configure the intended provider.

The queue is same-user local, not an authenticated service for untrusted
processes. Requests disappear after processing, responses after consumption;
pending files may contain page data. Keep the directory outside Git and remove
it after worker shutdown when no longer useful. Cancellation may leave an API
request in flight; no resulting browser action executes.

Call `await transport.stop()` when done or stopping and confirm worker exit.
It also stops on request/idle limits. Stopping cannot undo an in-flight API call.
A stopped worker needs a fresh directory; preserve the tab/session on reconnect.

## Finish and retain the tab

After independent verification, `await session.keepOpen({done:true})` marks a
deliverable. Before yielding unfinished work, `await session.keepOpen()` marks
a handoff. Marks are turn-scoped: renew them if needed in a later turn. Unmarked
agent tabs may close at turn end; do not close user-owned tabs as cleanup.

`session.metrics()` separates decisions, returned CUA actions, recorded host
notes and handoffs. Decisions include failed attempts; executed actions are not
proof of their effects. `apiMs` includes queue/network time in worker mode.

Before yielding and after verification, **save a private independent log** using
a fresh path outside Git. Do not rely solely on conversation tool records. Save
another uniquely named checkpoint after subsequent recovery; existing files
are never overwritten. No log is saved automatically. `session.saveLog('/absolute/private/path/log.json')`
requires an existing parent, refuses overwrite and writes 0600. Logs include
version-2 rounds, candidates, exclusions, decisions, metrics, status and host
outcomes. Host wrapper states and verification evidence can contain full page
text, so logs are private. They do not include configured API credentials.

`apiRequests` counts dispatches to the API transport (including queue dispatch),
`apiResponses` counts schema-valid Jev responses, and `apiSuccessRate` is their
ratio (null with zero dispatches). A queue dispatch is not proof of a wire request.
Report these separately from `browserTaskVerified` and verification rejection /
acceptance counts. None of these establishes browser success without host evidence. They are evidence, not a resumable browser process.
