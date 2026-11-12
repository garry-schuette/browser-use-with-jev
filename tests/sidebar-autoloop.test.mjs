import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../skills/browser-use-with-jev/sidebar.mjs';

const temporary = [];
const header = 'Browser tab: 1, Title: "Flow", URL: "https://example.com/".';
const page = body => `${header}\n0 AXWebArea Flow\n${body}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

afterEach(async () => {
  mock.restoreAll();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function config() {
  const root = await mkdtemp(join(tmpdir(), 'jev-autoloop-test-'));
  temporary.push(root);
  const envFile = join(root, 'credential.env');
  await writeFile(envFile, 'fixture-secret-123456789', { mode: 0o600 });
  return { envFile, provider: 'typesafe', model: 'jev-latest' };
}

function choiceResponse(body, choice) {
  const criteria = body.questions.next.criteria;
  assert.ok(Object.hasOwn(criteria, choice), `unoffered choice ${choice}`);
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { next: {
    type: 'choice', choice, confidence: 0.99,
    probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0])),
  } } }), { status: 200 });
}

test('one start crosses four chunks, waits for async AX effects, and hands off only at VERIFY', async () => {
  const states = {
    closed: page('  1 button Open filters, ID: open'),
    form: page('  2 container Filter panel, ID: filters\n    3 text field (settable) Query, ID: query'),
    ready: page('  2 container Filter panel, ID: filters\n    5 text Query: Coast\n    6 button Apply filters, ID: apply'),
    results: page('  9 container Results\n    10 container Hotel 70432873, ID: card-70432873\n      11 button View details, ID: detail-70432873'),
    details: page('  12 heading Hotel 70432873\n  13 text Coast filter applied; detail page ready'),
  };
  const tab = {
    id: 'autoloop-flow', state: states.closed, clicks: [], values: [], reads: 0,
    async getAXState() { this.reads++; return this.state; },
    async click(index) {
      this.clicks.push(index);
      if (index === 1) setTimeout(() => { this.state = states.form; }, 120);
      else if (index === 6) setTimeout(() => { this.state = states.results; }, 120);
      else if (index === 11) this.state = states.details;
      else throw new Error('unexpected fixture click');
    },
    async setValue(index, value) {
      this.values.push([index, value]);
      if (index !== 3) throw new Error('unexpected fixture input');
      this.state = states.ready;
    },
    async pressKey() { throw new Error('fallback key must not execute'); },
  };
  const requests = [];
  mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const selected = body.state.browser.includes('detail page ready') ? 'VERIFY' : 'a0';
    return choiceResponse(body, selected);
  });
  const task = {
    goal: 'Filter by Coast and open Hotel 70432873',
    allowedOrigins: ['https://example.com'], policy: {},
    maxSteps: 1, maxMs: 5000, waitPollMs: 100, effectTimeoutMs: 1000,
    controls: [
      { op: 'click', name: 'Open filters', expect: { includes: ['Filter panel'] } },
      { op: 'input', name: 'Query', value: 'Coast' },
      { op: 'click', name: 'Apply filters', expect: { includes: ['Hotel 70432873'] } },
      { op: 'click', name: 'View details', within: { id: 'card-70432873' } },
    ],
  };
  const session = createSession(tab, await config());
  const runner = session.start(task);
  const result = await runner.wait({ timeoutMs: 10000 });

  assert.equal(result.status, 'needs_verification');
  assert.equal(result.handoff, 'verify');
  assert.equal(result.chunks, 5);
  assert.deepEqual(tab.clicks, [1, 6, 11]);
  assert.deepEqual(tab.values, [[3, 'Coast']]);
  assert.equal(requests.length, 5);
  assert.equal(session.metrics().executedActions, 4);
  assert.equal(session.metrics().hostActions, 0);
  assert.deepEqual(session.metrics().handoffs, { verify: 1 });
  assert.equal(session.metrics().internalContinuations, 4);
  assert.equal(session.history().filter(event => event.actor === 'jev' && event.choice === 'VERIFY').length, 1);
  assert.equal(session.history().filter(event => event.effect === 'matched').length, 2);
  assert.equal(JSON.stringify(requests[0]).includes('Coast'), true); // Goal only; no buffered input in candidate labels.
  assert.equal(JSON.stringify(requests[0].questions.next.criteria).includes('Coast'), false);
});

test('retry and stale decisions stay inside the runner; observation failure stops safely without a repeated action', async () => {
  const initial = page('  1 button Open modal, ID: open');
  const tab = {
    id: 'autoloop-errors', state: initial, clicks: [], reads: 0, failNextRead: false,
    async getAXState() {
      this.reads++;
      if (this.failNextRead) { this.failNextRead = false; throw new Error('private rendered AX state'); }
      return this.state;
    },
    async click(index) {
      this.clicks.push(index);
      this.state = page('  2 dialog Modal open\n    3 text Expected content');
      this.failNextRead = true;
    },
    async pressKey() { throw new Error('fallback key must not execute'); },
  };
  let calls = 0;
  mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    if (calls === 1) throw new Error('private transport detail');
    const body = JSON.parse(options.body);
    if (calls === 2) tab.state += '\n  9 text Loading complete';
    return choiceResponse(body, 'a0');
  });
  const session = createSession(tab, await config());
  const runner = session.start({
    goal: 'Open the modal and inspect expected content',
    allowedOrigins: ['https://example.com'], policy: {}, maxSteps: 1,
    maxMs: 5000, maxDecisionRetries: 1,
    controls: [{ op: 'click', name: 'Open modal' }],
  });
  const result = await runner.wait({ timeoutMs: 10000 });

  assert.equal(result.status, 'blocked');
  assert.equal(result.handoff, 'observation_error');
  assert.deepEqual(tab.clicks, [1]);
  assert.equal(calls, 3);
  assert.equal(session.history().filter(event => event.reason === 'stale_state').length, 1);
  assert.equal(session.history().filter(event => event.reason === 'transport_error').length, 1);
  assert.equal(session.history().filter(event => event.executed).length, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
  await pause(50);
  assert.deepEqual(tab.clicks, [1]);

  mock.restoreAll();
  const verificationTab = {
    id: 'autoloop-verification', state: page('  4 text Expected result ready'), reads: 0,
    async getAXState() { this.reads++; return this.state; },
    async pressKey() { throw new Error('fallback key must not execute'); },
  };
  mock.method(globalThis, 'fetch', async (_url, options) => choiceResponse(JSON.parse(options.body), 'VERIFY'));
  const verificationSession = createSession(verificationTab, await config());
  const verificationRunner = verificationSession.start({
    goal: 'Check the expected result', allowedOrigins: ['https://example.com'],
    policy: {}, controls: [],
  }, { verify: () => { throw new Error('private verifier detail'); } });
  const verificationResult = await verificationRunner.wait({ timeoutMs: 10000 });
  assert.equal(verificationResult.status, 'blocked');
  assert.equal(verificationResult.handoff, 'verification_error');
  assert.equal(verificationSession.metrics().browserTaskVerified, false);
  assert.equal(JSON.stringify(verificationResult).includes('private'), false);
});

test('long action chains bound Jev request history across chunks', async () => {
  const tab = {
    id: 'autoloop-long-chain', clicks: 0,
    state: page('  1 button Advance\n  2 text Progress 0'),
    async getAXState() { return this.state; },
    async click(index) {
      assert.equal(index, 1);
      this.clicks++;
      this.state = page(`  1 button Advance\n  2 text ${this.clicks === 22 ? 'Goal reached' : `Progress ${this.clicks}`}`);
    },
    async pressKey() { throw new Error('fallback key must not execute'); },
  };
  const requests = [];
  mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return choiceResponse(body, body.state.browser.includes('Goal reached') ? 'VERIFY' : 'a0');
  });
  const session = createSession(tab, await config());
  const runner = session.start({
    goal: 'Advance until the goal is reached', allowedOrigins: ['https://example.com'],
    policy: {}, maxSteps: 1, maxContextChars: 3000,
    controls: [{ op: 'click', name: 'Advance' }, { op: 'press', key: 'Escape' }],
  });
  const result = await runner.wait({ timeoutMs: 10000 });

  assert.equal(result.status, 'needs_verification');
  assert.equal(result.handoff, 'verify');
  assert.equal(tab.clicks, 22);
  assert.equal(requests.length, 23);
  assert.equal(result.chunks, 23);
  assert.equal(session.metrics().internalContinuations, 22);
  assert.deepEqual(session.metrics().handoffs, { verify: 1 });
  assert.ok(requests.every(body => body.state.history.length <= 13));
  assert.ok(requests.some(body => body.state.history[0]?.kind === 'history_summary'));
  assert.ok(requests.every(body => JSON.stringify(body).length <= 3000));
});

test('wait timeout pauses the runner; the next wait resumes and rejects competing actions', async () => {
  let release, started;
  const requestStarted = new Promise(resolve => { started = resolve; });
  mock.method(globalThis, 'fetch', (_url, options) => new Promise(resolve => {
    release = () => resolve(choiceResponse(JSON.parse(options.body), 'VERIFY'));
    started();
  }));
  const tab = {
    id: 'autoloop-wait', state: page('  1 button Review'),
    async getAXState() { return this.state; },
    async pressKey() { throw new Error('fallback key must not execute'); },
  };
  const task = { goal: 'Review state', allowedOrigins: ['https://example.com'],
    policy: {}, controls: [{ op: 'press', key: 'Escape' }] };
  const session = createSession(tab, await config());
  const runner = session.start(task);
  const waiting = await runner.wait({ timeoutMs: 5 });
  assert.equal(waiting.status, 'running');
  assert.equal(waiting.handoff, null);
  assert.equal(session.metrics().apiRequests, 0);
  const activeWait = runner.wait({ timeoutMs: 10000 });
  await requestStarted;
  try {
    const concurrent = await runner.wait({ timeoutMs: 5 });
    assert.equal(concurrent.status, 'running');
    assert.match(concurrent.waitError, /already active/);
    await assert.rejects(session.run(task), { code: 'session_busy' });
    await assert.rejects(session.hostAction('Competing click', async () => {}), { code: 'session_busy' });
  } finally { release(); }
  const result = await activeWait;
  assert.equal(result.status, 'needs_verification');
  assert.equal(result.handoff, 'verify');
  assert.equal(session.metrics().apiRequests, 1);
});

test('a completed runner cannot cancel the next runner in the same session', { timeout: 5000 }, async () => {
  let requestStarted, releaseRequest, requestSignal;
  const requestInFlight = new Promise(resolve => { requestStarted = resolve; });
  const responseGate = new Promise(resolve => { releaseRequest = resolve; });
  let requests = 0;
  mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    if (++requests === 2) {
      requestSignal = options.signal;
      requestStarted();
      await responseGate;
    }
    return choiceResponse(body, 'VERIFY');
  });
  const tab = { id: 'autoloop-cancel-ownership',
    async getAXState() { return page('  1 text Expected result ready'); } };
  const task = { goal: 'Check the expected result', allowedOrigins: ['https://example.com'],
    policy: {}, controls: [] };
  const session = createSession(tab, await config());
  const runnerA = session.start(task, { verify: fresh => ({
    accepted: true, reason: 'Expected result confirmed', evidence: fresh,
  }) });
  const resultA = await runnerA.wait({ timeoutMs: 10000 });
  assert.equal(resultA.status, 'verified');

  const runnerB = session.start(task);
  const waitingB = runnerB.wait({ timeoutMs: 10000 });
  await requestInFlight;
  try {
    assert.equal(requestSignal.aborted, false);
    runnerA.cancel();
  } finally { releaseRequest(); }
  const resultB = await waitingB;
  assert.equal(resultB.status, 'needs_verification');
  assert.equal(resultB.handoff, 'verify');
  assert.equal(requestSignal.aborted, false);
  assert.equal(requests, 2);
  assert.deepEqual(await runnerA.wait(), resultA);
  assert.deepEqual(session.metrics().handoffs, { verify: 1 });
});

test('a runner cancels its own in-flight request without poisoning the session', { timeout: 5000 }, async () => {
  let requestStarted, requestSignal, releaseRequest;
  const requestInFlight = new Promise(resolve => { requestStarted = resolve; });
  let requests = 0;
  mock.method(globalThis, 'fetch', (_url, options) => {
    const body = JSON.parse(options.body);
    if (++requests > 1) return Promise.resolve(choiceResponse(body, 'VERIFY'));
    requestSignal = options.signal;
    return new Promise((resolve, reject) => {
      releaseRequest = () => resolve(choiceResponse(body, 'a0'));
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
      requestStarted();
    });
  });
  const tab = { id: 'autoloop-cancel-request', clicks: [],
    async getAXState() { return page('  1 button Advance'); },
    async click(index) { this.clicks.push(index); } };
  const task = { goal: 'Advance', allowedOrigins: ['https://example.com'],
    policy: {}, controls: [{ op: 'click', name: 'Advance' }] };
  const session = createSession(tab, await config());
  const runnerB = session.start(task);
  const waitingB = runnerB.wait({ timeoutMs: 10000 });
  await requestInFlight;
  try {
    runnerB.cancel();
    assert.equal(requestSignal.aborted, true);
  } finally { releaseRequest(); }
  const resultB = await waitingB;
  assert.equal(resultB.status, 'cancelled');
  assert.equal(resultB.handoff, 'cancelled');
  assert.deepEqual(tab.clicks, []);
  assert.deepEqual(await runnerB.wait(), resultB);
  assert.equal((await session.start(task).wait({ timeoutMs: 10000 })).status, 'needs_verification');
  assert.equal(requests, 2);
});

test('cancellation between waits is terminal before any further browser or model work', async () => {
  // Advance a virtual clock past the checkpoint after one real action chunk.
  let now = 0;
  mock.method(performance, 'now', () => now);
  let requests = 0;
  mock.method(globalThis, 'fetch', async (_url, options) => {
    requests++;
    return choiceResponse(JSON.parse(options.body), requests === 1 ? 'a0' : 'VERIFY');
  });
  const tab = { id: 'autoloop-cancel-paused', reads: 0, clicks: 0,
    async getAXState() { this.reads++; return page(`  1 button Advance\n  2 text Progress ${this.clicks}`); },
    async click(index) { assert.equal(index, 1); this.clicks++; now = 8500; } };
  const task = { goal: 'Advance', allowedOrigins: ['https://example.com'],
    policy: {}, maxSteps: 1, controls: [{ op: 'click', name: 'Advance' }] };
  const session = createSession(tab, await config());
  const runnerB = session.start(task);
  const paused = await runnerB.wait({ timeoutMs: 10000 });
  assert.equal(paused.status, 'running');
  assert.equal(paused.chunks, 1);
  assert.equal(requests, 1);
  assert.equal(tab.clicks, 1);
  const readsBeforeCancel = tab.reads;
  runnerB.cancel();
  runnerB.cancel();
  const resultB = await runnerB.wait({ timeoutMs: 1 });
  assert.equal(resultB.status, 'cancelled');
  assert.equal(resultB.handoff, 'cancelled');
  assert.deepEqual(await runnerB.wait(), resultB);
  assert.equal(tab.reads, readsBeforeCancel);
  assert.equal(requests, 1);
  assert.equal(tab.clicks, 1);
  assert.deepEqual(session.metrics().handoffs, { cancelled: 1 });

  const runnerC = session.start(task);
  runnerB.cancel();
  assert.equal((await runnerC.wait({ timeoutMs: 10000 })).status, 'needs_verification');
  assert.equal(requests, 2);
});

test('cancellation before the first wait performs no work and session cancellation stays permanent', async () => {
  const tab = { id: 'autoloop-cancel-before-wait', reads: 0,
    async getAXState() { this.reads++; throw new Error('Cancelled runner must not observe'); } };
  mock.method(globalThis, 'fetch', () => { throw new Error('Cancelled runner must not request'); });
  const task = { goal: 'Check the expected result', allowedOrigins: ['https://example.com'],
    policy: {}, controls: [] };
  const session = createSession(tab, await config());
  const runner = session.start(task);
  runner.cancel();
  const result = await runner.wait({ timeoutMs: 1 });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.handoff, 'cancelled');
  assert.deepEqual(await runner.wait(), result);
  assert.equal(tab.reads, 0);
  assert.equal(session.metrics().runs, 0);

  session.cancel();
  for (let attempt = 0; attempt < 2; attempt++) {
    const next = await session.start(task).wait({ timeoutMs: 1 });
    assert.equal(next.status, 'cancelled');
    assert.equal(next.handoff, 'cancelled');
  }
  assert.equal((await session.run(task)).status, 'cancelled');
  assert.equal(tab.reads, 0);
  assert.equal(session.metrics().apiRequests, 0);
});

test('cancellation during verification cannot accept a late verifier result', { timeout: 5000 }, async () => {
  let verificationStarted, releaseVerification;
  const atVerification = new Promise(resolve => { verificationStarted = resolve; });
  const verificationGate = new Promise(resolve => { releaseVerification = resolve; });
  mock.method(globalThis, 'fetch', async (_url, options) => choiceResponse(JSON.parse(options.body), 'VERIFY'));
  const tab = { id: 'autoloop-cancel-verification',
    async getAXState() { return page('  1 text Expected result ready'); } };
  const task = { goal: 'Check the expected result', allowedOrigins: ['https://example.com'],
    policy: {}, controls: [] };
  const session = createSession(tab, await config());
  const runner = session.start(task, { verify: async fresh => {
    verificationStarted();
    await verificationGate;
    return { accepted: true, reason: 'Expected result confirmed', evidence: fresh };
  } });
  const waiting = runner.wait({ timeoutMs: 10000 });
  await atVerification;
  try { runner.cancel(); }
  finally { releaseVerification(); }
  const result = await waiting;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.handoff, 'cancelled');
  assert.equal(session.metrics().verificationAccepted, 0);
  assert.equal(session.metrics().browserTaskVerified, false);
  assert.deepEqual(session.metrics().handoffs, { cancelled: 1 });
  assert.deepEqual(await runner.wait(), result);
  assert.equal((await session.start(task).wait({ timeoutMs: 10000 })).status, 'needs_verification');
});

test('ready is checked at startup and not repeated after an authorized action changes the page', async () => {
  const tab = {
    id: 'autoloop-ready', clicks: 0,
    state: page('  1 text Form ready\n  2 button Advance'),
    async getAXState() { return this.state; },
    async click(index) {
      assert.equal(index, 2);
      this.clicks++;
      this.state = page(`  2 button Advance\n  3 text ${this.clicks === 2 ? 'Goal reached' : 'Stage one'}`);
    },
    async pressKey() { throw new Error('fallback key must not execute'); },
  };
  mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    return choiceResponse(body, body.state.browser.includes('Goal reached') ? 'VERIFY' : 'a0');
  });
  const session = createSession(tab, await config());
  const runner = session.start({
    goal: 'Advance twice after the form becomes ready', allowedOrigins: ['https://example.com'],
    policy: {}, maxSteps: 1, ready: { includes: ['Form ready'] }, effectTimeoutMs: 1,
    controls: [{ op: 'click', name: 'Advance' }, { op: 'press', key: 'Escape' }],
  });
  const result = await runner.wait({ timeoutMs: 10000 });

  assert.equal(result.status, 'needs_verification');
  assert.equal(result.handoff, 'verify');
  assert.equal(tab.clicks, 2);
  assert.equal(result.chunks, 3);
  assert.equal(session.metrics().internalContinuations, 2);
  assert.deepEqual(session.metrics().handoffs, { verify: 1 });
});

test('terminal waits are stable after autonomy limit and invalid runner options', async () => {
  const tab = {
    id: 'autoloop-limit', clicks: 0, state: page('  1 button Advance'),
    async getAXState() { return this.state; },
    async click(index) { assert.equal(index, 1); this.clicks++; this.state = page(`  1 button Advance\n  2 text Progress ${this.clicks}`); },
  };
  mock.method(globalThis, 'fetch', async (_url, options) => choiceResponse(JSON.parse(options.body), 'a0'));
  const task = { goal: 'Advance until done', allowedOrigins: ['https://example.com'],
    policy: {}, maxSteps: 1, controls: [{ op: 'click', name: 'Advance' }] };
  const session = createSession(tab, await config());
  const runner = session.start(task, { maxTotalSteps: 1 });
  const first = await runner.wait({ timeoutMs: 10000 });
  const repeated = await runner.wait({ timeoutMs: 10000 });
  assert.deepEqual(repeated, first);
  assert.equal(first.status, 'limit_reached');
  assert.equal(first.handoff, 'autonomy_limit');
  assert.equal(tab.clicks, 1);
  assert.deepEqual(session.metrics().handoffs, { autonomy_limit: 1 });

  const invalidSession = createSession(tab, await config());
  const invalidRunner = invalidSession.start(task, { maxTotalSteps: 0 });
  const invalid = await invalidRunner.wait({ timeoutMs: 10000 });
  assert.deepEqual(await invalidRunner.wait({ timeoutMs: 10000 }), invalid);
  assert.equal(invalid.status, 'blocked');
  assert.equal(invalid.handoff, 'contract_error');
  assert.equal(invalidSession.metrics().runs, 0);
  assert.deepEqual(invalidSession.metrics().handoffs, { contract_error: 1 });

  const malformedSession = createSession(tab, await config());
  assert.equal((await malformedSession.start(task, null).wait({ timeoutMs: 10000 })).handoff,
    'contract_error');
  assert.equal((await malformedSession.runCompact(task, null)).handoff, 'contract_error');
  assert.equal((await malformedSession.runPlan(null, null)).handoff, 'contract_error');
});

test('async compact verification and async plan stage reserve the session until completion', async () => {
  mock.method(globalThis, 'fetch', async (_url, options) => choiceResponse(JSON.parse(options.body), 'VERIFY'));
  const tab = { id: 'autoloop-async-host', state: page('  1 text Expected result'),
    async getAXState() { return this.state; } };
  const task = { goal: 'Verify expected result', allowedOrigins: ['https://example.com'],
    policy: {}, controls: [] };
  async function assertBusy(session) {
    await assert.rejects(session.run(task), { code: 'session_busy' });
    assert.equal((await session.start(task).wait({ timeoutMs: 1000 })).handoff, 'session_busy');
    await assert.rejects(session.hostAction('Competing action', async () => {}), { code: 'session_busy' });
  }

  const compactSession = createSession(tab, await config());
  let releaseVerify, verificationReached;
  const atVerification = new Promise(resolve => { verificationReached = resolve; });
  const verificationGate = new Promise(resolve => { releaseVerify = resolve; });
  const compact = compactSession.runCompact(task, { verify: async fresh => {
    verificationReached(); await verificationGate;
    return { accepted: true, reason: 'Fresh result confirmed', evidence: fresh };
  } });
  await atVerification;
  try { await assertBusy(compactSession); }
  finally { releaseVerify(); }
  assert.equal((await compact).status, 'verified');

  const planSession = createSession(tab, { ...await config(), allowedOrigins: task.allowedOrigins });
  let releaseStage, stageReached;
  const atStage = new Promise(resolve => { stageReached = resolve; });
  const stageGate = new Promise(resolve => { releaseStage = resolve; });
  const plan = planSession.runPlan([{ task: async () => {
    stageReached(); await stageGate; return task;
  }, verify: fresh => ({ accepted: true, reason: 'Stage result confirmed', evidence: fresh }) }]);
  await atStage;
  try { await assertBusy(planSession); }
  finally { releaseStage(); }
  assert.equal((await plan).status, 'verified');
});

test('cancel interrupts ready and expected-effect waits before their long poll interval', async () => {
  const readyTab = { id: 'autoloop-cancel-ready', reads: 0,
    state: page('  1 button Advance'),
    async getAXState() { this.reads++; if (this.reads === 2) readyWaitReached(); return this.state; } };
  let readyWaitReached;
  const readyWaiting = new Promise(resolve => { readyWaitReached = resolve; });
  const readySession = createSession(readyTab, await config());
  const readyRunner = readySession.start({
    goal: 'Wait for form readiness', allowedOrigins: ['https://example.com'],
    policy: {}, ready: { includes: ['Form ready'] }, waitPollMs: 5000, effectTimeoutMs: 10000,
    controls: [{ op: 'click', name: 'Advance' }],
  });
  const readyRun = readyRunner.wait({ timeoutMs: 3000 });
  await readyWaiting;
  readyRunner.cancel();
  const readyResult = await readyRun;
  assert.equal(readyResult.status, 'cancelled');
  assert.equal(readyResult.handoff, 'cancelled');
  assert.equal(readySession.metrics().apiRequests, 0);

  const effectTab = { id: 'autoloop-cancel-effect', reads: 0, clicks: 0,
    state: page('  1 button Advance'),
    async getAXState() { this.reads++; if (this.reads === 4) effectWaitReached(); return this.state; },
    async click(index) { assert.equal(index, 1); this.clicks++; this.state = page('  1 button Advance\n  2 text Clicked'); },
  };
  let effectWaitReached;
  const effectWaiting = new Promise(resolve => { effectWaitReached = resolve; });
  mock.method(globalThis, 'fetch', async (_url, options) => choiceResponse(JSON.parse(options.body), 'a0'));
  const effectSession = createSession(effectTab, await config());
  const effectRunner = effectSession.start({
    goal: 'Advance until the expected effect appears', allowedOrigins: ['https://example.com'],
    policy: {}, waitPollMs: 5000, effectTimeoutMs: 10000,
    controls: [{ op: 'click', name: 'Advance', expect: { includes: ['Effect complete'] } }],
  });
  const effectRun = effectRunner.wait({ timeoutMs: 3000 });
  await effectWaiting;
  effectRunner.cancel();
  const effectResult = await effectRun;
  assert.equal(effectResult.status, 'cancelled');
  assert.equal(effectResult.handoff, 'cancelled');
  assert.equal(effectTab.clicks, 1);
});

test('outside-origin results never include unauthorized AX content', async () => {
  const privateText = 'UNAUTHORIZED PRIVATE PAGE CONTENT';
  const outside = page('  1 text harmless').replace('https://example.com/', 'https://outside.example/') + `\n  2 text ${privateText}`;
  const initialSession = createSession({ id: 'outside-initial', async getAXState() { return outside; } }, await config());
  const task = { goal: 'Inspect an allowed page', allowedOrigins: ['https://example.com'],
    policy: {}, controls: [{ op: 'click', name: 'Advance' }] };
  const initial = await initialSession.start(task).wait({ timeoutMs: 10000 });
  assert.equal(initial.handoff, 'outside_origin');
  assert.equal(JSON.stringify(initial).includes(privateText), false);
  assert.equal(JSON.stringify(initialSession.history()).includes(privateText), false);

  const tab = { id: 'outside-after-click', state: page('  1 button Advance'), clicks: 0,
    async getAXState() { return this.state; },
    async click(index) { assert.equal(index, 1); this.clicks++; this.state = outside; } };
  mock.method(globalThis, 'fetch', async (_url, options) => choiceResponse(JSON.parse(options.body), 'a0'));
  const session = createSession(tab, await config());
  const result = await session.start(task).wait({ timeoutMs: 10000 });
  assert.equal(result.handoff, 'outside_origin');
  assert.equal(tab.clicks, 1);
  assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.equal(JSON.stringify(session.history()).includes(privateText), false);
});
