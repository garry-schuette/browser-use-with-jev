// Explicit, synthetic connectivity check. Never reads browser state or retries.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decide, loadConfig, SidebarError } from './sidebar-client.mjs';
import { connectWorker } from './sidebar-transport.mjs';

export async function checkConnection(config, { transport } = {}) {
  let requests = 0, responses = 0;
  try {
    const result = await decide({
      ...config, transport, timeoutMs: 10000,
      goal: 'Synthetic connectivity check: the requested test marker is present. Hand off for verification.',
      state: 'Public synthetic fixture. Test marker: READY.', actions: [],
      onRequest: () => requests++, onResponse: () => responses++,
    });
    return { status: 'reachable', provider: config.provider, model: result.model,
      requests, responses, browserActions: 0, apiMs: result.apiMs };
  } catch (error) {
    return { status: 'failed', provider: config.provider, requests, responses, browserActions: 0,
      code: error instanceof SidebarError ? error.code : 'check_error' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { 'session-dir': { type: 'string' } } });
    const config = await loadConfig();
    const transport = values['session-dir']
      ? await connectWorker(values['session-dir'], config) : undefined;
    const result = await checkConnection(config, { transport });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'reachable' ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed',
      code: error instanceof SidebarError ? error.code : 'check_error' }));
    process.exitCode = 1;
  }
}
