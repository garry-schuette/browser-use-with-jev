// File transport for runtimes that cannot reach the configured Jev API directly.
import { readFile, writeFile, unlink, rename, access } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SidebarError } from './sidebar-client.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function remove(path) { try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await remove(temporary); }
}

// Does not launch a process or change network permissions. The host starts the
// worker through its normal approved shell tool, then passes this transport.
export async function connectWorker(sessionDir, config) {
  if (!isAbsolute(sessionDir)) throw new SidebarError('config_error', 'Worker directory must be absolute');
  const state = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8'));
  if (state.status !== 'ready' || state.provider !== config.provider || state.model !== config.model) {
    throw new SidebarError('config_error', 'Worker is not ready or has different provider/model settings');
  }
  return {
    async request(body, { timeoutMs, signal }) {
      if (signal?.aborted) throw new SidebarError('cancelled', 'Sidebar request cancelled');
      const current = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8'));
      if (current.status === 'stopped') throw new SidebarError('worker_stopped', 'Jev worker stopped');
      const id = randomUUID();
      const requestPath = join(sessionDir, 'requests', `${id}.json`);
      const responsePath = join(sessionDir, 'responses', `${id}.json`);
      const cancelPath = join(sessionDir, 'requests', `${id}.cancel`);
      const deadline = Date.now() + timeoutMs;
      await atomic(requestPath, { body, timeoutMs, deadline });
      let consumed = false;
      try {
        while (Date.now() < deadline && !signal?.aborted) {
          let raw;
          try { raw = await readFile(responsePath, 'utf8'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (raw !== undefined) {
            const response = JSON.parse(raw); consumed = true;
            if (response.error) throw new SidebarError(response.error.code, response.error.message);
            return response.result;
          }
          const current = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8'));
          if (current.status === 'stopped') {
            consumed = true;
            throw new SidebarError('worker_stopped', 'Jev worker stopped');
          }
          await pause(50);
        }
        throw new SidebarError(signal?.aborted ? 'cancelled' : 'transport_error', 'Sidebar request cancelled or timed out');
      } finally {
        if (consumed) { await remove(requestPath); await remove(responsePath); }
        else await writeFile(cancelPath, '', { mode: 0o600 });
      }
    },
    async stop() { await writeFile(join(sessionDir, 'stop'), '', { mode: 0o600 }); },
  };
}

export { pause, validId, exists, remove, atomic };
