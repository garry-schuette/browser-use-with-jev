import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { createSession, loadConfig, discoverActions, availableActions, waitForState } from '../skills/browser-use-with-jev/sidebar.mjs';
import { decide } from '../skills/browser-use-with-jev/sidebar-client.mjs';

const temporary = [];
afterEach(async () => {
  mock.restoreAll();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function temp() {
  const path = await mkdtemp(join(tmpdir(), 'jev-sidebar-test-'));
  temporary.push(path); return path;
}
async function config(raw = 'fixture-secret-123456789') {
  const envFile = join(await temp(), 'credential.env');
  await writeFile(envFile, raw, { mode: 0o600 });
  return { envFile, provider: 'typesafe', model: 'jev-latest' };
}
const header = 'Browser tab: 1, Title: "Fixture", URL: "https://example.com/".';
const state = `${header}\n0 AXWebArea Fixture\n  1 text Name\n  2 text field (settable) Name , ID: name\n  3 checkbox (settable, integer) Description:  Enable greeting, Value: 0, ID: agree\n  4 button Show greeting, ID: show`;
const task = { goal: 'Enable greeting and show it', allowedOrigins: ['https://example.com'], policy: { click: true, input: true } };

function fakeTab(initial = state) {
  return { id: 'fixture-tab', state: initial, clicks: [], keys: [], marks: [], reads: 0,
    async getAXState() { this.reads++; return this.state; },
    async click(index) { this.clicks.push(index); this.state += `\n${10 + this.clicks.length} text Result ${this.clicks.length}`; },
    async pressKey(key) { this.keys.push(key); },
    async scroll(...args) { this.scrollArgs = args; },
    async reload() { this.reloaded = true; },
    async back() { this.backed = true; },
    async markDeliverable() { this.marks.push('deliverable'); },
    async markHandoff() { this.marks.push('handoff'); },
  };
}
function respond(body, choice, extra = {}) {
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { next: {
    type: 'choice', choice, confidence: 0.99,
    probabilities: Object.fromEntries(Object.keys(body.questions.next.criteria).map(key => [key, key === choice ? 1 : 0])),
    ...extra,
  } } }), { status: 200 });
}
function fakeDecisions(choices) {
  const bodies = [];
  mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    const choice = choices.shift();
    return respond(body, typeof choice === 'function' ? choice(body) : choice ?? 'VERIFY');
  });
  return bodies;
}
function select(label) { return body => Object.entries(body.questions.next.criteria).find(([, value]) => value === label)?.[0]; }

test('configuration preserves project precedence, legacy provider, and explicit overrides', async () => {
  const root = await temp();
  const configFile = join(root, 'project.json'), legacyConfigFile = join(root, 'legacy.json');
  await writeFile(legacyConfigFile, JSON.stringify({ envFile: '/legacy.env', provider: 'openrouter', model: '~typesafe/jev-latest' }));
  assert.equal((await loadConfig({ configFile, legacyConfigFile })).provider, 'openrouter');
  await writeFile(configFile, JSON.stringify({ jev_env: '/project.key' }));
  assert.deepEqual(await loadConfig({ configFile, legacyConfigFile }), { envFile: '/project.key', provider: 'typesafe', model: 'jev-latest' });
  assert.equal((await loadConfig({ configFile, legacyConfigFile, envFile: '/explicit.env' })).envFile, '/explicit.env');
  await writeFile(configFile, 'broken');
  await assert.rejects(loadConfig({ configFile, legacyConfigFile }), /Invalid Jev configuration/);
});

test('raw and dotenv credential files authenticate without entering the model body', async () => {
  for (const raw of ['fixture-secret-123456789', 'TYPESAFE_API_KEY="fixture-secret-123456789"']) {
    const settings = await config(raw);
    mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(options.headers.Authorization, 'Bearer fixture-secret-123456789');
      assert.equal(options.body.includes('fixture-secret-123456789'), false);
      assert.equal(options.redirect, 'error');
      return respond(JSON.parse(options.body), 'VERIFY');
    });
    assert.equal((await decide({ ...settings, goal: 'Verify', state, actions: [] })).choice, 'VERIFY');
    mock.restoreAll();
  }
});

test('environment-only credentials work without returning a key in config', async t => {
  const root = await temp();
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'environment-fixture-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  });
  const settings = await loadConfig({ configFile: join(root, 'missing'), legacyConfigFile: join(root, 'missing-legacy') });
  assert.equal('apiKey' in settings, false);
  mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer environment-fixture-secret');
    return respond(JSON.parse(options.body), 'VERIFY');
  });
  assert.equal((await decide({ ...settings, goal: 'Verify', state, actions: [] })).choice, 'VERIFY');
});

test('current AX names support IDs, values and text labels adjacent to inputs', () => {
  const actions = discoverActions(state, task.policy);
  assert.deepEqual(actions.map(action => [action.op, action.name, action.index]), [
    ['input', 'Name', 2], ['click', 'Enable greeting', 3], ['click', 'Show greeting', 4],
  ]);
});

test('duplicate and disabled controls are excluded; explicit controls respect reserved names', () => {
  const duplicates = `${state}\n5 button Show greeting, ID: another\n6 button (disabled) Delete`;
  assert.equal(discoverActions(duplicates, { click: true }).some(action => ['Show greeting', 'Delete'].includes(action.name)), false);
  assert.deepEqual(availableActions(state, [{ op: 'click', name: 'Show greeting' }], { requireCodexNames: [/greeting/] }), []);
});

test('input handoff resumes the same history after Codex enters text', async () => {
  const tab = fakeTab();
  const bodies = fakeDecisions([select('Ask Codex to enter text in Name'), select('Click Enable greeting'), 'VERIFY']);
  const session = createSession(tab, await config());
  const first = await session.run(task);
  assert.equal(first.handoff, 'text_input');
  assert.deepEqual(first.target, { name: 'Name', index: 2 });
  assert.deepEqual(tab.clicks, []);
  tab.state = tab.state.replace('Name , ID:', 'Name , Value: Ada, ID:');
  session.recordHostAction('Entered Ada in Name');
  const second = await session.run(task);
  assert.equal(second.status, 'needs_verification');
  assert.deepEqual(tab.clicks, [3]);
  assert.equal(second.sessionMetrics.runs, 2);
  assert.equal(second.sessionMetrics.hostActions, 1);
  assert.equal(second.sessionMetrics.executedActions, 1);
  assert.equal(bodies[1].state.history.some(item => item.actor === 'host'), true);
});

test('stale indices never execute after a decision', async () => {
  const tab = fakeTab();
  mock.method(globalThis, 'fetch', async (_url, options) => {
    tab.state = tab.state.replace('4 button', '44 button');
    return respond(JSON.parse(options.body), 'a2');
  });
  const result = await createSession(tab, await config()).run({ ...task, maxSteps: 1 });
  assert.equal(result.history[0].reason, 'stale_state');
  assert.deepEqual(tab.clicks, []);
});

test('outside-origin initial pages never reach Jev', async () => {
  const bodies = fakeDecisions([]);
  const tab = fakeTab(state.replace('https://example.com/', 'https://outside.example/'));
  const result = await createSession(tab, await config()).run(task);
  assert.equal(result.handoff, 'outside_origin'); assert.equal(bodies.length, 0);
});

test('cross-origin action preserves executed history and stops before another decision', async () => {
  const tab = fakeTab();
  tab.click = async () => { tab.state = state.replace('https://example.com/', 'https://outside.example/'); };
  const bodies = fakeDecisions(['a2']);
  const result = await createSession(tab, await config()).run(task);
  assert.equal(result.handoff, 'outside_origin');
  assert.equal(result.sessionMetrics.executedActions, 1); assert.equal(bodies.length, 1);
});

test('observation failure after an action retains execution evidence and hides raw errors', async () => {
  const tab = fakeTab();
  const original = tab.getAXState;
  tab.getAXState = async function () { if (this.clicks.length) throw new Error('private page detail'); return original.call(this); };
  fakeDecisions(['a2']);
  const result = await createSession(tab, await config()).run(task);
  assert.equal(result.handoff, 'observation_error'); assert.equal(result.history[0].executed, true);
  assert.equal(JSON.stringify(result).includes('private page detail'), false);
});

test('action failures are handed back without automatic repeats', async () => {
  const tab = fakeTab();
  tab.click = async () => { throw new Error('sensitive browser error'); };
  const bodies = fakeDecisions(['a2']);
  const result = await createSession(tab, await config()).run(task);
  assert.equal(result.status, 'action_error'); assert.equal(bodies.length, 1);
  assert.equal(result.history[0].executed, false);
  assert.equal(JSON.stringify(result).includes('sensitive browser error'), false);
});

test('low confidence never executes a selected control', async () => {
  const tab = fakeTab();
  mock.method(globalThis, 'fetch', async (_url, options) => respond(JSON.parse(options.body), 'a2', { confidence: 0.2 }));
  const result = await createSession(tab, await config()).run(task);
  assert.equal(result.status, 'low_confidence'); assert.deepEqual(tab.clicks, []);
});

test('VERIFY remains a verification handoff even at low confidence', async () => {
  mock.method(globalThis, 'fetch', async (_url, options) => respond(JSON.parse(options.body), 'VERIFY', { confidence: 0.2 }));
  const result = await createSession(fakeTab(), await config()).run(task);
  assert.equal(result.status, 'needs_verification'); assert.equal('success' in result, false);
});

test('oversized candidate pools and complete requests hand back without a network call', async () => {
  const bodies = fakeDecisions([]);
  const large = header + Array.from({ length: 253 }, (_, i) => `\n${i} button Item ${i}`).join('');
  const settings = await config();
  const result = await createSession(fakeTab(large), settings).run(task);
  assert.equal(result.handoff, 'candidate_limit');
  const context = await createSession(fakeTab(), settings).run({ ...task, goal: 'x'.repeat(40001) });
  assert.equal(context.handoff, 'context_limit'); assert.equal(bodies.length, 0);
});

test('transport failure retries once; authentication errors never retry', async () => {
  const settings = await config();
  let calls = 0;
  mock.method(globalThis, 'fetch', async (_url, options) => {
    if (++calls === 1) throw new Error('offline');
    return respond(JSON.parse(options.body), 'VERIFY');
  });
  const recovered = await createSession(fakeTab(), settings).run(task);
  assert.equal(recovered.status, 'needs_verification'); assert.equal(calls, 2);
  mock.restoreAll(); calls = 0;
  mock.method(globalThis, 'fetch', async () => { calls++; return new Response('do not expose', { status: 401 }); });
  const failed = await createSession(fakeTab(), settings).run(task);
  assert.equal(failed.handoff, 'api_error'); assert.equal(calls, 1);
  assert.equal(JSON.stringify(failed).includes('do not expose'), false);
});

test('invalid choice probabilities cannot execute', async () => {
  mock.method(globalThis, 'fetch', async (_url, options) => respond(JSON.parse(options.body), 'a2', { probabilities: { a2: 1 } }));
  const tab = fakeTab();
  const result = await createSession(tab, await config()).run(task);
  assert.equal(result.handoff, 'schema_error'); assert.deepEqual(tab.clicks, []);
});

test('DNS failures give an actionable safe handoff without repeating requests', async () => {
  const settings = await config();
  const fetch = mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('private request details', { cause: Object.assign(new Error('private hostname'), { code: 'ENOTFOUND' }) });
  });
  const result = await createSession(fakeTab(), settings).run(task);
  assert.equal(result.handoff, 'dns_error');
  assert.match(result.error, /host-authorized network permissions/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('queue errors from a separately loaded client retain their safe classification', async () => {
  const { SidebarError } = await import('../skills/browser-use-with-jev/sidebar-client.mjs?separate-instance');
  const transport = { async request() { throw new SidebarError('dns_error', 'Jev API DNS lookup failed.'); } };
  const result = await createSession(fakeTab(), { ...await config(), transport }).run(task);
  assert.equal(result.handoff, 'dns_error');
  assert.equal(result.error, 'Jev API DNS lookup failed.');
});

test('same no-effect action is not repeated, while scroll remains visually verifiable', async () => {
  const tab = fakeTab(); tab.click = async index => { tab.clicks.push(index); };
  fakeDecisions(['a2', 'a2']);
  const settings = await config();
  const result = await createSession(tab, settings).run(task);
  assert.equal(result.status, 'no_progress'); assert.equal(tab.clicks.length, 1);
  mock.restoreAll(); fakeDecisions(['a0']);
  const scrolled = await createSession(tab, settings).run({ ...task, policy: {}, controls: [{ op: 'scroll', direction: 'down', amount: 2 }], maxSteps: 1 });
  assert.deepEqual(tab.keys, ['PageDown', 'PageDown']);
  assert.equal(scrolled.history[0].effectNeedsVisualVerification, true);
});

test('nested scroll resolves fresh named targets and back uses the tab API', async () => {
  const tab = fakeTab(`${state}\n9 container Results`);
  fakeDecisions(['a0', 'a0']);
  const session = createSession(tab, await config());
  await session.run({ ...task, policy: {}, controls: [{ op: 'scroll', direction: 'down', targetName: 'Results' }], maxSteps: 1 });
  assert.deepEqual(tab.scrollArgs, [9, 'down', 1]);
  await session.run({ ...task, policy: { back: true }, controls: [], maxSteps: 1 });
  assert.equal(tab.backed, true);
});

test('cancellation during a decision prevents execution and concurrent chunks are rejected', async () => {
  const tab = fakeTab();
  let pending, started;
  const waiting = new Promise(resolve => { started = resolve; });
  mock.method(globalThis, 'fetch', (_url, options) => new Promise(resolve => { pending = () => resolve(respond(JSON.parse(options.body), 'a2')); started(); }));
  const session = createSession(tab, await config());
  const run = session.run(task); await waiting;
  await assert.rejects(session.run(task), /already running/);
  session.cancel(); pending();
  assert.equal((await run).status, 'cancelled'); assert.deepEqual(tab.clicks, []);
  assert.equal((await session.run(task)).status, 'cancelled');
});

test('private logs are explicit, cannot overwrite, and preserve tab lifecycle', async () => {
  const tab = fakeTab(); fakeDecisions(['VERIFY']);
  const session = createSession(tab, await config());
  await session.run(task); await session.keepOpen(); await session.keepOpen({ done: true });
  assert.deepEqual(tab.marks, ['handoff', 'deliverable']);
  const path = join(await temp(), 'session.json');
  await session.saveLog(path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const log = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(log.metrics.backend, 'codex-sidebar'); assert.equal(log.status, 'needs_verification');
  assert.equal(JSON.stringify(log).includes('fixture-secret-123456789'), false);
  await assert.rejects(session.saveLog(path), { code: 'EEXIST' });
  const history = session.history(); history[0].choice = 'tampered';
  assert.equal(session.history()[0].choice, 'VERIFY');
});

test('deterministic waits match fresh state and stop on origin change', async () => {
  assert.equal((await waitForState(fakeTab(), { allowedOrigins: task.allowedOrigins, includes: ['Show greeting'] })).status, 'matched');
  const tab = fakeTab(state.replace('https://example.com/', 'https://outside.example/'));
  assert.equal((await waitForState(tab, { allowedOrigins: task.allowedOrigins })).handoff, 'outside_origin');
});

// Reconstructed from the reported Ctrip AX roles, not a captured live snapshot.
const ctrip = `${header}
0 AXWebArea 携程
  10 container 首页, ID: home
    11 container checkIn, ID: checkIn
  20 container 酒店频道, ID: hotel
    21 text field 入住日期, Value: 2026-10-01, ID: hotel-date
    22 button 搜索, ID: search-wrapper
      23 button 搜索, ID: search-submit`;
const ctripControls = [
  { op: 'click', name: 'checkIn', role: 'container', target: { id: 'checkIn' }, within: { id: 'home' } },
  { op: 'click', name: '入住日期', role: 'text field', within: { name: '酒店频道' } },
  { op: 'click', name: '搜索', role: 'button', target: { id: 'search-submit' }, within: { id: 'hotel' } },
];

test('Ctrip special controls and nested duplicate search resolve uniquely without broad discovery', () => {
  assert.deepEqual(availableActions(ctrip, ctripControls).map(item => item.index), [11, 21, 23]);
  assert.equal(discoverActions(ctrip, { click: true }).length, 0);
  assert.equal(availableActions(ctrip, [{ op: 'click', name: '搜索', within: { id: 'hotel' } }]).length, 0);
  assert.equal(availableActions(ctrip, [{ op: 'click', name: '搜索', target: { index: 22, role: 'button' } }])[0].index, 22);
  assert.equal(availableActions(ctrip, ctripControls, { denyNames: ['checkIn', '入住日期', '搜索'] }).length, 0);
  assert.equal(availableActions(ctrip.replace('10 container', '10 container (disabled)'), [ctripControls[0]]).length, 0);
});

test('Ctrip value-only text fields use their stable AX id instead of the changing value', () => {
  const live = `${header}\n58 text field (settable) Value: 北京, ID: destinationInput\n59 button`;
  const actions = availableActions(live, [{
    op: 'click', name: 'destinationInput', role: 'text field', target: { id: 'destinationInput' },
  }]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].name, 'destinationInput');
  assert.equal(actions[0].index, 58);
  assert.equal(actions[0].identity.id, 'destinationInput');
});

test('Ctrip hydrated result cards use stable ancestor names instead of drifting indices', () => {
  const beforeHydration = `${header}\n100 container 70432873\n  101 button 查看详情\n110 container 99112233\n  111 button 查看详情`;
  const afterHydration = beforeHydration.replaceAll('100 container', '340 container')
    .replaceAll('101 button', '355 button').replaceAll('110 container', '360 container')
    .replaceAll('111 button', '370 button');
  const control = [{
    op: 'click', name: '查看详情', role: 'button',
    within: { name: '70432873', role: 'container' },
  }];
  assert.equal(availableActions(beforeHydration, control)[0].index, 101);
  assert.equal(availableActions(afterHydration, control)[0].index, 355);
});

test('decision context can be scoped without weakening full-state execution checks', async () => {
  const scoped = `${header}\n1 container Private account\n  2 text Secret history\n3 container Search properties, ID: hotel-search\n  4 text field (settable) Value: 北京, ID: destinationInput\n  5 button 搜索`;
  const bodies = fakeDecisions(['a0']);
  const tab = fakeTab(scoped);
  await createSession(tab, await config()).run({
    goal: 'Search Shanghai hotels', allowedOrigins: ['https://example.com'], maxSteps: 1,
    contextScope: { id: 'hotel-search' },
    controls: [{ op: 'click', name: '搜索', target: { index: 5 } }],
  });
  assert.match(bodies[0].state.browser, /Search properties/);
  assert.doesNotMatch(bodies[0].state.browser, /Private account|Secret history/);
  assert.deepEqual(tab.clicks, [5]);
});

test('missing or ambiguous decision scopes hand back without sending page state', async () => {
  const bodies = fakeDecisions([]);
  const tab = fakeTab(`${state}\n5 container Search properties\n6 container Search properties`);
  const session = createSession(tab, await config());
  const missing = await session.run({ ...task, contextScope: { id: 'missing' } });
  const ambiguous = await session.run({ ...task, contextScope: { name: 'Search properties' } });
  assert.equal(missing.handoff, 'context_scope_not_found');
  assert.equal(ambiguous.handoff, 'context_scope_ambiguous');
  assert.equal(bodies.length, 0);
});

test('empty candidates explain excluded roles and ambiguity without requesting Jev', async () => {
  const bodies = fakeDecisions([]);
  const result = await createSession(fakeTab(ctrip), await config()).run({ ...task, policy: {}, controls: [
    { op: 'click', name: 'checkIn' }, { op: 'click', name: '入住日期' }, { op: 'click', name: '搜索' },
  ] });
  assert.equal(result.handoff, 'no_action_candidates');
  assert.deepEqual(result.excluded.map(item => item.reason), ['unsupported_role', 'unsupported_role', 'ambiguous_target']);
  assert.equal(bodies.length, 0);
  assert.equal(result.rounds[0].requestAttempted, false);
  assert.equal(result.sessionMetrics.decisions, 0);
});

test('Ctrip replay executes, rejects premature VERIFY, logs host recovery and validates final evidence', async () => {
  const tab = fakeTab(ctrip);
  const session = createSession(tab, await config());
  fakeDecisions(['a0', 'VERIFY', 'VERIFY']);
  const result = await session.run({ ...task, policy: {}, controls: [ctripControls[0]], maxSteps: 1 });
  assert.deepEqual(tab.clicks, [11]);
  assert.equal(result.rounds[0].actions[0].identity.id, 'checkIn');
  await session.run({ ...task, policy: {}, controls: [ctripControls[2]] });
  session.recordVerification({ accepted: false, reason: '搜索尚未提交', evidence: tab.state });
  await session.hostAction('设置日期和北大位置', async tab => { tab.state += '\n30 text 入住 2026-10-01 离店 2026-10-03 北京大学'; });
  await session.hostAction('提交酒店搜索', tab => tab.click(23));
  await session.run({ ...task, policy: {}, controls: [ctripControls[2]] });
  const fresh = await tab.getAXState();
  assert.match(fresh, /入住 2026-10-01 离店 2026-10-03 北京大学/);
  session.recordVerification({ accepted: true, reason: '结果日期和位置已核验（离线样例）', evidence: fresh });
  const path = join(await temp(), 'ctrip.json');
  await session.saveLog(path);
  const log = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(log.status, 'verified');
  assert.equal(log.metrics.hostActions, 2);
  assert.equal(log.metrics.verificationAccepted, 1);
  assert.equal(log.metrics.verificationRejected, 1);
  assert.equal(log.rounds.length, 3);
  assert.equal(log.history.filter(item => item.kind === 'action').every(item => item.executed && item.stateAfter), true);
});

test('form readiness and missing calendar stop without repeating a target', async () => {
  const bodies = fakeDecisions(['a0']);
  const tab = fakeTab(ctrip);
  const session = createSession(tab, await config());
  const ready = await session.run({ ...task, ready: { includes: ['表单就绪'] }, effectTimeoutMs: 1 });
  assert.equal(ready.handoff, 'form_not_ready');
  assert.equal(bodies.length, 0);
  const missing = await session.run({ ...task, policy: {}, effectTimeoutMs: 1,
    controls: [{ ...ctripControls[0], expect: { includes: ['选择入住日期日历'] } }] });
  assert.equal(missing.handoff, 'expected_effect_missing');
  assert.equal(missing.history[0].executed, true);
  assert.equal(tab.clicks.length, 1);
});

test('expected calendar waits for delayed appearance', async () => {
  const tab = fakeTab(ctrip);
  tab.click = async index => { tab.clicks.push(index); };
  const read = tab.getAXState;
  tab.getAXState = async function () { if (this.reads === 3) this.state += '\n40 container 日历'; return read.call(this); };
  fakeDecisions(['a0']);
  const result = await createSession(tab, await config()).run({ ...task, policy: {}, maxSteps: 1,
    controls: [{ ...ctripControls[0], expect: { includes: ['日历'] } }] });
  assert.equal(result.history[0].effect, 'matched');
  assert.equal(result.handoff, 'step_limit');
});

test('host failures are recorded and invalid verification cannot mark success', async () => {
  const session = createSession(fakeTab(), await config());
  assert.throws(() => session.recordVerification({ accepted: true, reason: 'ok', evidence: state }), /pending VERIFY/);
  await assert.rejects(session.hostAction('输入失败', async () => { throw new Error('fixture failure'); }));
  assert.equal(session.history()[0].reason, 'host_action_error');
  assert.equal(session.history()[0].executed, false);
});

test('blocked targets stay excluded across chunks until recorded host recovery', async () => {
  const tab = fakeTab(ctrip); tab.click = async index => { tab.clicks.push(index); };
  const bodies = fakeDecisions(['a0', 'a0']);
  const session = createSession(tab, await config());
  const options = { ...task, policy: {}, controls: [ctripControls[0]], maxSteps: 1 };
  assert.equal((await session.run(options)).handoff, 'no_progress');
  const blocked = await session.run(options);
  assert.equal(blocked.handoff, 'no_action_candidates');
  assert.equal(blocked.excluded[0].reason, 'previous_action_blocked');
  assert.equal(bodies.length, 1);
  await session.hostAction('切换入口并重新观察', async tab => { tab.state += '\n80 text 新入口'; });
  await session.run(options);
  assert.equal(bodies.length, 2);
});

test('API metrics separate local rejection, responses and verified browser outcomes', async () => {
  fakeDecisions(['VERIFY']);
  const session = createSession(fakeTab(), await config());
  await session.run({ ...task, goal: 'x'.repeat(40001) });
  assert.equal(session.metrics().apiRequests, 0);
  assert.equal(session.metrics().apiSuccessRate, null);
  await session.run(task);
  assert.equal(session.metrics().apiRequests, 1);
  assert.equal(session.metrics().apiSuccessRate, 1);
  assert.equal(session.metrics().browserTaskVerified, false);
  session.recordVerification({ accepted: false, reason: '搜索未提交', evidence: state });
  assert.equal(session.metrics().browserTaskVerified, false);
});

test('same-name explicit buttons have distinct model labels and role selectors disambiguate', () => {
  const actions = availableActions(ctrip, [22, 23].map(index => ({ op: 'click', name: '搜索', target: { index } })));
  assert.equal(actions.length, 2);
  assert.notEqual(actions[0].description, actions[1].description);
  const mixed = `${header}\n1 link 搜索\n2 button 搜索`;
  assert.equal(availableActions(mixed, [{ op: 'click', name: '搜索', role: 'button' }])[0].index, 2);
});

test('special target identity change during Jev selection prevents execution', async () => {
  const tab = fakeTab(ctrip);
  mock.method(globalThis, 'fetch', async (_url, options) => {
    tab.state = tab.state.replace('ID: checkIn', 'ID: replacement');
    return respond(JSON.parse(options.body), 'a0');
  });
  const result = await createSession(tab, await config()).run({ ...task, policy: {}, controls: [ctripControls[0]], maxSteps: 1 });
  assert.equal(result.history[0].reason, 'stale_state');
  assert.deepEqual(tab.clicks, []);
});
