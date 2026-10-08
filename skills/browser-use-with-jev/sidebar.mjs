// Codex CUA backend, adapted from jev-browser-use. See THIRD_PARTY_NOTICES.md.
// This module accepts an existing authorized tab; it never launches a browser.
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { decide, SidebarError } from './sidebar-client.mjs';
export { loadConfig } from './sidebar-client.mjs';

const clickRoles = new Set(['button', 'link', 'checkbox', 'radiobutton', 'radio', 'menuitem', 'tab']);
const inputRoles = new Set(['textfield', 'textarea']);
const safeKeys = new Set(['Enter', 'Return', 'Escape', 'Tab', 'Shift+Tab', 'PageUp', 'PageDown', 'Home', 'End']);
const clone = value => structuredClone(value);

function nameOf(value) {
  return value.replace(/,\s*(?:Value|ID|URL):[\s\S]*$/, '').trim();
}

function parseState(state) {
  const entries = [], stack = [];
  for (const [lineNumber, line] of state.split('\n').entries()) {
    const match = line.trim().match(/^(\d+) (text field|text area|combo box|radio button|menu item|[\w]+)(?: \(([^)]*)\))?(?: (?:Description:\s*)?(.*))?$/);
    if (!match) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const id = match[4]?.match(/(?:^|,\s*)ID: ([^,]*)/)?.[1]?.trim();
    let name = nameOf(match[4] ?? '');
    // Some live controls expose only changing metadata (for example
    // `Value: 北京, ID: destinationInput`) instead of an accessible name.
    // A stable AX id is a safer label than treating the current value as the
    // name, and lets explicit controls remain addressable across value changes.
    if (/^(?:Value|ID|URL|Help):(?:\s|$)/.test(name)) name = id ?? '';
    const entry = {
      index: Number(match[1]), role: match[2].replace(/\s/g, '').toLowerCase(),
      name, id,
      disabled: /disabled|unavailable/i.test(match[3] ?? '') || stack.some(item => item.disabled),
      ancestors: stack.map(({ index, role, name, id }) => ({ index, role, name, id })), indent, lineNumber,
    };
    entries.push(entry); stack.push(entry);
  }
  return entries;
}

function decisionState(state, scope) {
  if (!scope) return { state };
  const found = parseState(state).filter(entry => matchesSelector(entry, scope));
  if (found.length !== 1) return { error: found.length ? 'context_scope_ambiguous' : 'context_scope_not_found' };
  const lines = state.split('\n'), entry = found[0];
  let end = entry.lineNumber + 1;
  while (end < lines.length && lines[end].length - lines[end].trimStart().length > entry.indent) end++;
  return { state: [lines[0], ...lines.slice(entry.lineNumber, end)].join('\n') };
}

const normalizedRole = role => role.replace(/\s/g, '').toLowerCase();
function validSelector(selector) {
  return selector && typeof selector === 'object' &&
    Object.keys(selector).length > 0 &&
    Object.entries(selector).every(([key, value]) =>
      key === 'index' ? Number.isInteger(value) && value >= 0 :
      ['name', 'role', 'id'].includes(key) && typeof value === 'string' && !!value.trim());
}
function matchesSelector(entry, selector) {
  return Object.entries(selector).every(([key, value]) => entry[key] === (key === 'role' ? normalizedRole(value) : value));
}
function validCondition(condition) {
  return condition && typeof condition === 'object' &&
    ['includes', 'excludes'].every(key => condition[key] === undefined ||
      Array.isArray(condition[key]) && condition[key].every(value => typeof value === 'string' && value.length)) &&
    [...(condition.includes ?? []), ...(condition.excludes ?? [])].length > 0;
}
function conditionMatches(state, condition) {
  return (condition.includes ?? []).every(value => state.includes(value)) &&
    (condition.excludes ?? []).every(value => !state.includes(value));
}

function matches(name, pattern) {
  if (pattern instanceof RegExp) { pattern.lastIndex = 0; return pattern.test(name); }
  return name === pattern;
}

function validateControl(control) {
  if (!control || typeof control !== 'object') return false;
  if (['click', 'input'].includes(control.op)) return typeof control.name === 'string' && !!control.name.trim() &&
    (control.aliases === undefined || Array.isArray(control.aliases) && control.aliases.every(value => typeof value === 'string')) &&
    (control.target === undefined || validSelector(control.target)) &&
    (control.within === undefined || validSelector(control.within)) &&
    (control.role === undefined || typeof control.role === 'string' && !!control.role.trim()) &&
    (control.expect === undefined || validCondition(control.expect));
  if (control.op === 'scroll') return ['up', 'down'].includes(control.direction) &&
    Number.isInteger(control.amount ?? 1) && (control.amount ?? 1) >= 1 && (control.amount ?? 1) <= 5 &&
    (control.targetName === undefined || typeof control.targetName === 'string') &&
    (control.point === undefined || (Array.isArray(control.point) && control.point.length === 2 && control.point.every(Number.isFinite))) &&
    !(control.targetName && control.point);
  if (control.op === 'press') return safeKeys.has(control.key);
  return ['reload', 'back'].includes(control.op);
}

function blockedName(name, policy) {
  return [...(policy.denyNames ?? []), ...(policy.requireCodexNames ?? [])].some(pattern => matches(name, pattern));
}

export function availableActions(state, controls = [], policy = {}, excluded = []) {
  const entries = parseState(state);
  const actions = [];
  for (const control of controls) {
    if (!validateControl(control)) throw new SidebarError('contract_error', 'Unsupported control');
    if (['click', 'input'].includes(control.op)) {
      const roles = control.op === 'input' ? inputRoles : clickRoles;
      const names = [control.name, ...(control.aliases ?? [])];
      let found = entries.filter(entry => names.includes(entry.name));
      if (control.role) found = found.filter(entry => entry.role === normalizedRole(control.role));
      if (control.target) found = found.filter(entry => matchesSelector(entry, control.target));
      if (control.within) found = found.filter(entry => entry.ancestors.some(parent => matchesSelector(parent, control.within)));
      const specialRole = control.role ?? control.target?.role;
      const supported = entry => roles.has(entry.role) || control.op === 'click' &&
        specialRole && normalizedRole(specialRole) === entry.role &&
        ['container', 'textfield', 'textarea', 'combobox'].includes(entry.role);
      const eligible = found.filter(supported);
      if (eligible.length) found = eligible;
      const reason = !found.length ? 'target_not_found' : found.length !== 1 ? 'ambiguous_target' :
        !supported(found[0]) ? 'unsupported_role' : found[0].disabled ? 'disabled_target' :
        blockedName(found[0].name, policy) ? 'reserved_target' : null;
      if (reason) { excluded.push({ control: clone(control), reason, matches: found.map(({ index, role, name, id, ancestors }) => ({ index, role, name, id, ancestors })) }); continue; }
      const entry = found[0];
      const duplicate = entries.filter(item => item.name === entry.name && supported(item)).length > 1;
      const qualifier = duplicate ? ` [${entry.role}, ${entry.id ? `ID: ${entry.id}, ` : ''}node ${entry.index}${entry.ancestors.length ? `, within ${entry.ancestors.at(-1).name || entry.ancestors.at(-1).index}` : ''}]` : '';
      actions.push({ op: control.op, name: entry.name, index: entry.index,
        identity: { role: entry.role, id: entry.id, ancestors: entry.ancestors },
        ...(control.expect ? { expect: clone(control.expect) } : {}),
        description: control.description ?? `${control.op === 'input' ? 'Ask Codex to enter text in' : 'Click'} ${entry.name}${qualifier}` });
    } else if (control.op === 'scroll') {
      const names = [control.targetName, ...(control.targetAliases ?? [])].filter(Boolean);
      const found = names.length ? entries.filter(entry => names.includes(entry.name)) : [];
      if (names.length && found.length !== 1) { excluded.push({ control: clone(control), reason: found.length ? 'ambiguous_target' : 'target_not_found' }); continue; }
      actions.push({ op: 'scroll', direction: control.direction, amount: control.amount ?? 1,
        target: control.point ?? found[0]?.index,
        description: control.description ?? `Scroll ${control.direction}${names.length ? ` within ${control.targetName}` : ''}` });
    } else actions.push({ ...control, description: control.description ??
      (control.op === 'press' ? `Press ${control.key}` : control.op === 'back' ? 'Go back' : 'Reload page') });
  }
  return actions;
}

export function discoverActions(state, policy = {}, excluded = []) {
  const entries = parseState(state);
  const counts = new Map();
  const kind = entry => inputRoles.has(entry.role) ? 'input' : 'click';
  const key = entry => `${kind(entry)}:${entry.name}`;
  for (const entry of entries) {
    if (clickRoles.has(entry.role) || inputRoles.has(entry.role)) counts.set(key(entry), (counts.get(key(entry)) ?? 0) + 1);
  }
  const controls = [];
  for (const entry of entries) {
    if (!entry.name) continue;
    const relevant = policy.click === true || policy.input === true;
    const reason = entry.disabled ? 'disabled_target' : blockedName(entry.name, policy) ? 'reserved_target' :
      policy.allowNames?.length && !policy.allowNames.some(pattern => matches(entry.name, pattern)) ? 'outside_allow_names' :
      !clickRoles.has(entry.role) && !inputRoles.has(entry.role) ? 'unsupported_role' :
      counts.get(key(entry)) !== 1 ? 'ambiguous_target' : null;
    if (reason) { if (relevant) excluded.push({ source: 'discovery', index: entry.index, role: entry.role, name: entry.name, reason }); continue; }
    if (policy.click === true && clickRoles.has(entry.role)) controls.push({ op: 'click', name: entry.name });
    if (policy.input === true && inputRoles.has(entry.role)) controls.push({ op: 'input', name: entry.name });
  }
  for (const direction of policy.scrollDirections ?? []) {
    controls.push({ op: 'scroll', direction, amount: policy.scrollAmount ?? 1,
      targetName: policy.scrollTargetName, targetAliases: policy.scrollTargetAliases, point: policy.scrollPoint });
  }
  for (const key of policy.keys ?? []) controls.push({ op: 'press', key });
  if (policy.reload === true) controls.push({ op: 'reload' });
  if (policy.back === true) controls.push({ op: 'back' });
  return availableActions(state, controls, policy, excluded);
}

function checkState(state, allowedOrigins) {
  const url = state.match(/^Browser tab:.* URL: "([^"]+)"\./)?.[1];
  let origin;
  try { origin = new URL(url).origin; }
  catch { throw new SidebarError('unreadable_origin', 'Cannot establish the browser origin'); }
  if (!allowedOrigins.includes(origin)) throw new SidebarError('outside_origin', 'Browser left the authorized origins');
}

function validateTask(options) {
  const { goal, controls = [], policy, allowedOrigins, maxSteps, maxMs, minConfidence,
    decisionTimeoutMs, maxDecisionRetries, maxContextChars, waitPollMs, ready, effectTimeoutMs, contextScope } = options;
  if ((ready !== undefined && !validCondition(ready)) || !Number.isFinite(effectTimeoutMs) || effectTimeoutMs < 1 || effectTimeoutMs > 10000 || typeof goal !== 'string' || !goal.trim() || !Array.isArray(controls) ||
      (contextScope !== undefined && !validSelector(contextScope)) ||
      (!controls.length && !policy) || controls.some(control => !validateControl(control)) ||
      !Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.some(origin => {
        try { return !/^https?:/.test(origin) || new URL(origin).origin !== origin; } catch { return true; }
      }) || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 30 ||
      !Number.isFinite(maxMs) || maxMs < 1 || maxMs > 45000 ||
      !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1 ||
      !Number.isInteger(decisionTimeoutMs) || decisionTimeoutMs < 1000 || decisionTimeoutMs > 30000 ||
      !Number.isInteger(maxDecisionRetries) || maxDecisionRetries < 0 || maxDecisionRetries > 2 ||
      !Number.isInteger(maxContextChars) || maxContextChars < 1 || maxContextChars > 40000 ||
      !Number.isInteger(waitPollMs) || waitPollMs < 100 || waitPollMs > 5000) {
    throw new SidebarError('contract_error', 'Invalid sidebar task contract');
  }
}

async function execute(tab, action) {
  if (action.op === 'click') await tab.click(action.index);
  else if (action.op === 'scroll' && action.target !== undefined) await tab.scroll(action.target, action.direction, action.amount);
  else if (action.op === 'scroll') {
    for (let i = 0; i < action.amount; i++) await tab.pressKey(action.direction === 'down' ? 'PageDown' : 'PageUp');
  } else if (action.op === 'press') await tab.pressKey(action.key === 'Enter' ? 'Return' : action.key);
  else if (action.op === 'reload') await tab.reload();
  else if (action.op === 'back') await tab.back();
  else throw new SidebarError('contract_error', 'Action requires Codex');
}

// The host keeps the tab/session bindings across input and verification handoffs.
export function createSession(tab, defaults = {}) {
  let history = [];
  let runs = 0;
  let elapsedMs = 0;
  let lastStatus = null;
  let running = false;
  let cancelled = false;
  let controller;
  const handoffs = {};
  const rounds = [];
  const outcomes = [];
  const blockedTargets = new Set();
  const actionKey = action => JSON.stringify([action.op, action.index, action.identity, action.target, action.direction, action.key]);
  let pendingHandoff = null;
  function metrics() {
    return { backend: 'codex-sidebar', runs,
      apiRequests: rounds.filter(item => item.requestSubmitted).length,
      apiResponses: rounds.filter(item => item.responseReceived).length,
      apiSuccessRate: rounds.some(item => item.requestSubmitted) ? rounds.filter(item => item.responseReceived).length / rounds.filter(item => item.requestSubmitted).length : null,
      browserTaskVerified: lastStatus === 'verified',
      decisions: history.filter(item => item.actor === 'jev').length,
      executedActions: history.filter(item => item.actor === 'jev' && item.executed).length,
      hostActions: history.filter(item => item.actor === 'host' && item.kind === 'action').length,
      hostActionCoverage: 'Only wrapped or explicitly recorded actions; direct tab calls are not observed',
      verificationAccepted: history.filter(item => item.kind === 'verification' && item.accepted).length,
      verificationRejected: history.filter(item => item.reason === 'verification_rejected').length,
      failedDecisions: history.filter(item => item.choice === 'ERROR').length,
      apiMs: history.reduce((sum, item) => sum + (item.apiMs ?? 0), 0), elapsedMs, handoffs: { ...handoffs } };
  }
  return {
    metrics,
    history: () => clone(history),
    cancel() { cancelled = true; controller?.abort(); },
    recordHostAction(note) {
      if (running) throw new SidebarError('session_busy', 'Wait for the current chunk before recording a host action');
      if (typeof note !== 'string' || !note || note.length > 2000) throw new SidebarError('contract_error', 'Invalid host action note');
      history.push({ actor: 'host', kind: 'action', handoff: pendingHandoff, action: note, outcome: 'host_reported', at: new Date().toISOString() });
      blockedTargets.clear();
      pendingHandoff = null;
      lastStatus = 'host_action_recorded';
    },
    async hostAction(note, action) {
      if (running) throw new SidebarError('session_busy', 'Wait for the current chunk before host actions');
      if (typeof note !== 'string' || !note || note.length > 2000 || typeof action !== 'function') throw new SidebarError('contract_error', 'Invalid host action');
      const record = { actor: 'host', kind: 'action', action: note, handoff: pendingHandoff, executed: false, at: new Date().toISOString() };
      history.push(record);
      pendingHandoff = null;
      lastStatus = 'host_action';
      running = true;
      try {
        const result = await action(tab);
        record.executed = true;
        blockedTargets.clear();
        record.stateAfter = await tab.getAXState({ emit: false, disableDiffing: true });
        return result;
      } catch (error) { record.reason = record.executed ? 'observation_error' : 'host_action_error'; throw error; }
      finally { running = false; }
    },
    recordVerification({ accepted, reason, evidence }) {
      if (running) throw new SidebarError('session_busy', 'Wait for the current chunk before verification');
      if (pendingHandoff !== 'verify' || typeof accepted !== 'boolean' || typeof reason !== 'string' || !reason.trim() || typeof evidence !== 'string' || !evidence.trim())
        throw new SidebarError('contract_error', 'Verification requires a pending VERIFY, reason and fresh evidence');
      history.push({ actor: 'host', kind: 'verification', accepted, reason: accepted ? 'verification_accepted' : 'verification_rejected', detail: reason, evidence, at: new Date().toISOString() });
      lastStatus = accepted ? 'verified' : 'verification_rejected';
      pendingHandoff = null;
    },
    async keepOpen({ done = false } = {}) {
      if (done) await tab.markDeliverable();
      else await tab.markHandoff();
    },
    async saveLog(path) {
      if (running) throw new SidebarError('session_busy', 'Wait for the current chunk before saving');
      if (!isAbsolute(path)) throw new SidebarError('contract_error', 'Log path must be absolute');
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ version: 2, tabId: tab.id,
        status: lastStatus, metrics: metrics(), history, rounds, outcomes }, null, 2)); }
      finally { await file.close(); }
    },
    async run(task) {
      if (running) throw new SidebarError('session_busy', 'Sidebar session is already running');
      const options = { maxSteps: 12, maxMs: 45000, minConfidence: 0.65,
        decisionTimeoutMs: 20000, maxDecisionRetries: 1, maxContextChars: 40000,
        waitPollMs: 750, effectTimeoutMs: 1500, controls: [], policy: {}, ...defaults, ...task };
      validateTask(options);
      running = true;
      controller = new AbortController();
      const started = performance.now();
      const remaining = () => options.maxMs - (performance.now() - started);
      let state = '';
      let retries = 0;
      let waits = 0;
      let phase = 'observation';
      const finish = (status, handoff = null, details = {}) => {
        lastStatus = status;
        pendingHandoff = handoff;
        outcomes.push({ run: runs, status, handoff, stateSummary: state.split('\n')[0], at: new Date().toISOString() });
        if (rounds.at(-1)?.run === runs) rounds.at(-1).outcome = { status, handoff };
        if (handoff) handoffs[handoff] = (handoffs[handoff] ?? 0) + 1;
        elapsedMs += Math.round(performance.now() - started);
        return { status, handoff, state, ...details, history: clone(history), rounds: clone(rounds), sessionMetrics: metrics() };
      };
      const observe = async () => {
        phase = 'observation';
        state = await tab.getAXState({ emit: false, disableDiffing: true });
        checkState(state, options.allowedOrigins);
        return state;
      };
      try {
        runs += 1;
        if (cancelled) return finish('cancelled', 'cancelled');
        await observe();
        if (options.ready && !conditionMatches(state, options.ready)) {
          const result = await waitForState(tab, { ...options.ready, allowedOrigins: options.allowedOrigins,
            timeoutMs: Math.max(1, Math.min(options.effectTimeoutMs, remaining())), pollMs: options.waitPollMs });
          state = result.state;
          if (result.status !== 'matched') return finish('blocked', result.handoff ?? 'form_not_ready');
        }
        for (let step = 0; step < options.maxSteps; step++) {
          if (cancelled) return finish('cancelled', 'cancelled');
          if (remaining() <= 0) return finish('budget', 'budget');
          phase = 'candidates';
          const seen = new Set();
          const excluded = [];
          const actions = [...availableActions(state, options.controls, options.policy, excluded), ...discoverActions(state, options.policy, excluded)]
            .filter(action => {
              const key = JSON.stringify([action.op, action.index, action.target, action.direction, action.amount, action.key]);
              if (blockedTargets.has(actionKey(action))) { excluded.push({ control: action, reason: 'previous_action_blocked' }); return false; }
              if (seen.has(key)) return false;
              seen.add(key); return true;
            });
          const round = { run: runs, step, stateSummary: { header: state.split('\n')[0], chars: state.length, nodes: parseState(state).length }, actions: clone(actions), excluded, requestAttempted: false, requestSubmitted: false, responseReceived: false };
          rounds.push(round);
          if (!actions.length) return finish('host_required', 'no_action_candidates', { excluded });
          if (actions.length > 252) return finish('host_required', 'candidate_limit');
          const scoped = decisionState(state, options.contextScope);
          if (scoped.error) return finish('host_required', scoped.error);
          round.decisionStateSummary = { chars: scoped.state.length, nodes: parseState(scoped.state).length };
          phase = 'decision';
          let decision;
          const decisionStarted = performance.now();
          try {
            round.requestAttempted = true;
            decision = await decide({ ...options, state: scoped.state, actions,
              history: history.map(({ stateAfter, evidence, ...item }) => item),
              onRequest: () => { round.requestSubmitted = true; },
              onResponse: () => { round.responseReceived = true; },
              timeoutMs: Math.max(1, Math.min(options.decisionTimeoutMs, Math.floor(remaining()))), signal: controller.signal });
          } catch (error) {
            const reason = error instanceof SidebarError ? error.code : 'decision_error';
            round.error = reason;
            history.push({ actor: 'jev', choice: 'ERROR', reason, executed: false,
              apiMs: Math.round(performance.now() - decisionStarted) });
            if (reason === 'transport_error' && retries++ < options.maxDecisionRetries && remaining() >= 1000) {
              await observe(); step -= 1; continue;
            }
            return finish(cancelled ? 'cancelled' : reason === 'context_limit' ? 'host_required' : 'decision_error', reason,
              { error: error instanceof SidebarError ? error.message : 'Jev decision failed' });
          }
          retries = 0;
          const record = { actor: 'jev', provider: decision.provider, model: decision.model,
            choice: decision.choice, confidence: decision.confidence, apiMs: decision.apiMs,
            action: decision.action?.description ?? decision.choice, executed: false };
          const before = state;
          const previous = history.at(-1);
          history.push(record);
          round.decision = record;
          await observe();
          if (cancelled) return finish('cancelled', 'cancelled');
          if (remaining() <= 0) { record.reason = 'budget'; return finish('budget', 'budget'); }
          if (state !== before) { record.reason = 'stale_state'; continue; }
          if (decision.choice === 'HOST') return finish('host_required', 'host');
          if (decision.choice === 'VERIFY') return finish('needs_verification', 'verify');
          if (decision.confidence < options.minConfidence) return finish('low_confidence', 'low_confidence');
          if (decision.choice === 'WAIT') {
            record.reason = 'wait';
            if (++waits >= 3) return finish('loading_timeout', 'loading_timeout');
            await new Promise(resolve => setTimeout(resolve, Math.min(options.waitPollMs, Math.max(0, remaining()))));
            await observe(); continue;
          }
          waits = 0;
          if (decision.action.op === 'input') return finish('host_required', 'text_input',
            { target: { index: decision.action.index, name: decision.action.name } });
          if (previous?.noEffect && previous.action === record.action) return finish('no_progress', 'no_progress');
          phase = 'action';
          try { await execute(tab, decision.action); }
          catch {
            record.reason = 'action_error';
            blockedTargets.add(actionKey(decision.action));
            return finish('action_error', 'action_error', { error: 'Browser action failed; inspect the page before retrying' });
          }
          record.executed = true;
          await observe();
          if (decision.action.expect) {
            const result = await waitForState(tab, { ...decision.action.expect, allowedOrigins: options.allowedOrigins,
              timeoutMs: Math.max(1, Math.min(options.effectTimeoutMs, remaining())), pollMs: options.waitPollMs });
            state = result.state;
            record.effect = result.status;
            if (result.status !== 'matched') { blockedTargets.add(actionKey(decision.action)); record.reason = result.handoff ?? 'expected_effect_missing'; return finish('blocked', record.reason); }
          }
          if (state === before) {
            if (decision.action.op === 'scroll') record.effectNeedsVisualVerification = true;
            else { record.noEffect = true; blockedTargets.add(actionKey(decision.action)); return finish('no_progress', 'no_progress'); }
          }
        }
        return finish('step_limit', 'step_limit');
      } catch (error) {
        const reason = error instanceof SidebarError ? error.code : `${phase}_error`;
        return finish('blocked', reason, { error: error instanceof SidebarError ? error.message : 'Browser state unavailable; inspect before resuming' });
      } finally { running = false; controller = undefined; }
    },
  };
}

export async function waitForState(tab, { allowedOrigins, includes = [], excludes = [], timeoutMs = 30000, pollMs = 750 }) {
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || !Array.isArray(includes) || !Array.isArray(excludes) ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 45000 || !Number.isFinite(pollMs) || pollMs < 100 || pollMs > 5000) {
    throw new SidebarError('contract_error', 'Invalid wait contract');
  }
  const started = performance.now();
  let state = '';
  try {
    while (performance.now() - started < timeoutMs) {
      state = await tab.getAXState({ emit: false, disableDiffing: true });
      checkState(state, allowedOrigins);
      if (includes.every(value => state.includes(value)) && excludes.every(value => !state.includes(value))) return { status: 'matched', state };
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, timeoutMs - (performance.now() - started)))));
    }
    return { status: 'timeout', state };
  } catch (error) {
    return { status: 'blocked', handoff: error instanceof SidebarError ? error.code : 'observation_error', state };
  }
}
