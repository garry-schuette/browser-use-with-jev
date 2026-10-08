// Optional network worker. CUA owns all browser observations/actions.
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, requestJev, SidebarError } from './sidebar-client.mjs';
import { pause, validId, exists, remove, atomic } from './sidebar-transport.mjs';

export async function serve({ sessionDir, config, maxRequests = 100, idleTimeoutMs = 120000 }) {
  if (!isAbsolute(sessionDir) || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000 ||
      !Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 100 || idleTimeoutMs > 600000) {
    throw new SidebarError('config_error', 'Invalid worker settings');
  }
  await mkdir(sessionDir, { mode: 0o700 }); // Refuse to reuse an existing session.
  await mkdir(join(sessionDir, 'requests'), { mode: 0o700 });
  await mkdir(join(sessionDir, 'responses'), { mode: 0o700 });
  const statePath = join(sessionDir, 'state.json');
  const info = { provider: config.provider, model: config.model };
  let count = 0, lastActivity = Date.now();
  await atomic(statePath, { ...info, status: 'ready', requests: count });
  try {
    while (count < maxRequests && Date.now() - lastActivity < idleTimeoutMs && !await exists(join(sessionDir, 'stop'))) {
      const names = await readdir(join(sessionDir, 'requests'));
      const previousCount = count;
      for (const name of names) {
        // A cancellation can arrive just after its response was written.
        if (name.endsWith('.cancel') && validId.test(name.slice(0, -7))) {
          const id = name.slice(0, -7);
          await remove(join(sessionDir, 'requests', `${id}.json`));
          await remove(join(sessionDir, 'responses', `${id}.json`));
          await remove(join(sessionDir, 'requests', name));
          continue;
        }
        const id = name.replace(/\.json$/, '');
        if (!name.endsWith('.json') || !validId.test(id)) continue;
        const requestPath = join(sessionDir, 'requests', name);
        const responsePath = join(sessionDir, 'responses', name);
        const cancelPath = join(sessionDir, 'requests', `${id}.cancel`);
        if (!await exists(requestPath)) continue;
        let response;
        try {
          const request = JSON.parse(await readFile(requestPath, 'utf8'));
          if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 30000 ||
              !Number.isFinite(request.deadline)) throw new SidebarError('contract_error', 'Invalid worker request');
          if (Date.now() >= request.deadline || await exists(cancelPath)) continue;
          count++;
          response = { result: await requestJev(config, request.body, {
            timeoutMs: Math.max(1, Math.min(request.timeoutMs, request.deadline - Date.now())),
          }) };
        } catch (error) {
          response = { error: { code: error instanceof SidebarError ? error.code : 'worker_error',
            message: error instanceof SidebarError ? error.message : 'Jev worker request failed' } };
        } finally {
          if (response && !await exists(cancelPath)) await atomic(responsePath, response);
          await remove(requestPath); await remove(cancelPath);
          lastActivity = Date.now();
        }
        if (count >= maxRequests || await exists(join(sessionDir, 'stop'))) break;
      }
      if (count !== previousCount) await atomic(statePath, { ...info, status: 'ready', requests: count });
      await pause(50);
    }
  } finally { await atomic(statePath, { ...info, status: 'stopped', requests: count }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      'session-dir': { type: 'string' }, 'max-requests': { type: 'string', default: '100' },
      'idle-timeout': { type: 'string', default: '120' },
    } });
    const config = await loadConfig();
    await serve({ sessionDir: values['session-dir'] ?? '', config,
      maxRequests: Number(values['max-requests']), idleTimeoutMs: Number(values['idle-timeout']) * 1000 });
  } catch (error) {
    console.error(error instanceof SidebarError ? error.message : 'Sidebar worker could not start');
    process.exitCode = 1;
  }
}
