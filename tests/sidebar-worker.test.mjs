import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { serve } from '../skills/browser-use-with-jev/sidebar-worker.mjs';
import { connectWorker } from '../skills/browser-use-with-jev/sidebar-transport.mjs';
import { decide, loadConfig } from '../skills/browser-use-with-jev/sidebar-client.mjs';
import { checkConnection } from '../skills/browser-use-with-jev/sidebar-check.mjs';

const roots = [], workers = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
afterEach(async () => {
  for (const worker of workers.splice(0)) {
    await writeFile(join(worker.dir, 'stop'), '');
    await worker.promise;
  }
  mock.restoreAll();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function start(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jev-worker-test-')); roots.push(root);
  const envFile = join(root, 'jev.env');
  await writeFile(envFile, 'worker-fixture-secret-0123456789', { mode: 0o600 });
  const config = await loadConfig({ envFile });
  const dir = join(root, 'session');
  const promise = serve({ sessionDir: dir, config, idleTimeoutMs: 10000, ...options });
  workers.push({ dir, promise });
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try { if (JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).status === 'ready') return; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await pause(10);
    }
    throw new Error('Worker did not start');
  })();
  await Promise.race([ready, promise.then(() => { throw new Error('Worker exited early'); })]);
  return { dir, config, promise, transport: await connectWorker(dir, config) };
}

function fakeApi() {
  return mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, 'Bearer worker-fixture-secret-0123456789');
    assert.equal(options.body.includes('worker-fixture-secret-0123456789'), false);
    const probabilities = Object.fromEntries(Object.keys(body.questions.next.criteria).map(key => [key, key === 'VERIFY' ? 1 : 0]));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { next: {
      type: 'choice', choice: 'VERIFY', confidence: 1, probabilities,
    } } }));
  });
}
const request = { goal: 'Verify synthetic fixture', state: 'Synthetic page', actions: [] };

test('synthetic preflight validates queue response without browser actions', async () => {
  const fetch = fakeApi(); const worker = await start();
  const result = await checkConnection(worker.config, { transport: worker.transport });
  assert.equal(result.status, 'reachable');
  assert.equal(result.requests, 1); assert.equal(result.responses, 1);
  assert.equal(result.browserActions, 0); assert.equal(fetch.mock.callCount(), 1);
  const body = JSON.parse(fetch.mock.calls[0].arguments[1].body);
  assert.match(body.state.browser, /synthetic fixture/);
  assert.deepEqual(Object.keys(body.questions.next.criteria), ['VERIFY', 'HOST', 'WAIT']);
});

test('synthetic preflight reports DNS once and suppresses private errors', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('private credential', { cause: { code: 'ENOTFOUND' } });
  });
  const worker = await start();
  const result = await checkConnection(worker.config, { transport: worker.transport });
  assert.equal(result.code, 'dns_error'); assert.equal(result.status, 'failed');
  assert.equal(result.responses, 0); assert.equal(result.browserActions, 0);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('synthetic preflight does not treat invalid API responses as connectivity success', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const worker = await start();
  const result = await checkConnection(worker.config, { transport: worker.transport });
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'schema_error');
  assert.equal(result.responses, 0);
});

test('queue round trip consumes files, preserves private permissions, and stops', async () => {
  const fetch = fakeApi();
  const worker = await start({ maxRequests: 2 });
  const result = await decide({ ...worker.config, ...request, transport: worker.transport });
  assert.equal(result.choice, 'VERIFY'); assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await readdir(join(worker.dir, 'requests')), []);
  assert.deepEqual(await readdir(join(worker.dir, 'responses')), []);
  assert.equal((await stat(worker.dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(worker.dir, 'state.json'))).mode & 0o777, 0o600);
  await worker.transport.stop(); await worker.promise;
  assert.equal(JSON.parse(await readFile(join(worker.dir, 'state.json'), 'utf8')).status, 'stopped');
  await assert.rejects(connectWorker(worker.dir, worker.config), /not ready/);
});

test('concurrent requests correlate responses and request limit exits', async () => {
  const fetch = fakeApi(); const worker = await start({ maxRequests: 2 });
  const replies = await Promise.all([1, 2].map(i => decide({ ...worker.config, ...request, goal: `Fixture ${i}`, transport: worker.transport })));
  assert.deepEqual(replies.map(reply => reply.choice), ['VERIFY', 'VERIFY']);
  await worker.promise; assert.equal(fetch.mock.callCount(), 2);
});

test('a different provider/model cannot attach to a worker', async () => {
  const worker = await start();
  await assert.rejects(connectWorker(worker.dir, { ...worker.config, provider: 'openrouter' }), /different provider/);
  await assert.rejects(connectWorker(worker.dir, { ...worker.config, model: 'jev-other' }), /different provider/);
});

test('stopped worker and cancelled client return without a model call', async () => {
  const fetch = fakeApi(); const worker = await start();
  const signal = AbortSignal.abort();
  await assert.rejects(decide({ ...worker.config, ...request, signal, transport: worker.transport }), { code: 'cancelled' });
  await worker.transport.stop(); await worker.promise;
  await assert.rejects(decide({ ...worker.config, ...request, transport: worker.transport }), { code: 'worker_stopped' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('expired queue entries are removed without spending an API call', async () => {
  const fetch = fakeApi(); const worker = await start();
  const path = join(worker.dir, 'requests', `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ timeoutMs: 1000, deadline: Date.now() - 1000, body: {} }));
  await pause(120);
  assert.deepEqual(await readdir(join(worker.dir, 'requests')), []);
  assert.equal(fetch.mock.callCount(), 0);
});

test('cancelled entries and late replies are removed without resurrecting a request', async () => {
  const fetch = fakeApi(); const worker = await start();
  const id = randomUUID();
  await writeFile(join(worker.dir, 'requests', `${id}.cancel`), '');
  await writeFile(join(worker.dir, 'requests', `${id}.json`), JSON.stringify({ timeoutMs: 1000, deadline: Date.now() + 1000, body: {} }));
  await writeFile(join(worker.dir, 'responses', `${id}.json`), JSON.stringify({ result: 'late' }));
  await pause(120);
  assert.deepEqual(await readdir(join(worker.dir, 'requests')), []);
  assert.deepEqual(await readdir(join(worker.dir, 'responses')), []);
  assert.equal(fetch.mock.callCount(), 0);
});

test('worker rejects a substituted model and never exposes an API error body', async () => {
  const fetch = fakeApi(); const worker = await start();
  await assert.rejects(worker.transport.request({ model: 'jev-other', questions: { next: { type: 'choice', criteria: { HOST: '', VERIFY: '' } } } }, { timeoutMs: 1000 }), { code: 'contract_error' });
  assert.equal(fetch.mock.callCount(), 0);
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => new Response('private vendor response', { status: 401 }));
  await assert.rejects(decide({ ...worker.config, ...request, transport: worker.transport }), error => error.code === 'api_error' && !error.message.includes('private'));
});

test('idle timeout stops the worker without calls', async () => {
  const worker = await start({ idleTimeoutMs: 100 });
  await worker.promise;
  assert.equal(JSON.parse(await readFile(join(worker.dir, 'state.json'), 'utf8')).requests, 0);
});
