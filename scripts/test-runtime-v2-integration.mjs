import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {observeCompatiblePairDeployment, observeLivePruneInventory, observePruneScanPair,
  runDeployment, wiringPhase} from './runtime-deploy.mjs';
import {ensureBootstrapGeneration, readActivation, inspectSessionBindingsV2} from './runtime-store.mjs';
import {readRuntimeJournalV2} from './runtime-prune.mjs';
import {acquireLease} from './runtime-safety.mjs';
import {createRuntimeFixture} from './test-support/runtime-v2.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const clientProgram = path.join(source, 'test-support/runtime-v2-client.mjs');

function waitFor(check, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) { resolve(); return; }
      if (Date.now() >= deadline) { reject(new Error('timed out: ' + label)); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function checkedGit(root, ...args) {
  const gitHome = path.join(root, '.git-home');
  fs.mkdirSync(gitHome, {recursive: true, mode: 0o700});
  const result = spawnSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      HOME: gitHome,
      PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
      LANG: 'C.UTF-8',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function configureGuard(fixture) {
  const registry = path.join(fixture.home, 'guard-registry');
  const registryRemote = path.join(fixture.home, 'guard-registry-remote.git');
  fs.mkdirSync(registry, {mode: 0o700});
  fs.mkdirSync(registryRemote, {mode: 0o700});
  checkedGit(registry, 'init', '--initial-branch=main');
  checkedGit(registryRemote, 'init', '--bare', '--initial-branch=main');
  checkedGit(registry, 'config', 'user.name', 'Runtime integration');
  checkedGit(registry, 'config', 'user.email', 'runtime-integration@example.invalid');
  fs.writeFileSync(path.join(registry, 'README.md'), 'fixture\n', {mode: 0o600});

  const config = path.join(fixture.home, '.config/jhw-control');
  fs.mkdirSync(config, {recursive: true, mode: 0o700});
  const coordinates = {
    JHW_REGISTRY_DIR: registry,
    JHW_REGISTRY_REMOTE: 'origin',
    JHW_REGISTRY_BRANCH: 'main',
    JHW_WORKTREE_ROOT: path.join(fixture.home, 'guard-worktrees'),
    JHW_CONTROL_STATE_DIR: path.join(fixture.home, 'guard-state'),
    JHW_BUILD_HOST: 'runtime-integration',
    JHW_GITHUB_OWNER: 'fixture-owner',
    JHW_PROJECT_NUMBER: '1',
    JHW_REGISTRY_REPOSITORY: 'fixture-owner/registry',
    JHW_PREFLIGHT_PROJECT_ITEM_ID: 'PVTI_fixture',
    JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER: '1',
  };
  fs.writeFileSync(path.join(config, 'control.env'),
    Object.entries(coordinates).map(([key, value]) => key + '=' + value + '\n').join(''), {mode: 0o600});
  checkedGit(registry, 'add', '.');
  checkedGit(registry, 'commit', '-m', 'fixture');
  checkedGit(registry, 'remote', 'add', 'origin', registryRemote);
  checkedGit(registry, 'push', '--set-upstream', 'origin', 'main');
  return {coordinates, clients: Array.from({length: 5}, (_, number) => ({
    sessionId: 'runtime-v2-integration-client-' + number,
    worktree: fixture.root,
  }))};
}

function clientEnvironment(fixture, extra = {}) {
  const temporary = path.join(fixture.home, 'tmp');
  fs.mkdirSync(temporary, {recursive: true, mode: 0o700});
  return {
    ...fixture.environment,
    TMPDIR: temporary,
    ...extra,
  };
}

async function terminateClient(client) {
  if (client.child.exitCode !== null || client.child.signalCode !== null) return;
  try { fs.writeFileSync(path.join(client.directory, 'stop'), '', {mode: 0o600}); } catch {}
  const graceful = await Promise.race([
    client.done.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (graceful) return;
  try { process.kill(-client.child.pid, 'SIGTERM'); } catch {}
  const terminated = await Promise.race([
    client.done.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!terminated) {
    try { process.kill(-client.child.pid, 'SIGKILL'); } catch {}
  }
  const killed = await Promise.race([
    client.done.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!killed) throw new Error('bound client did not terminate: ' + client.child.pid);
}

async function startBoundClient(fixture, environment, authority, pair, number) {
  const directory = path.join(fixture.home, 'integration-client-' + number);
  fs.mkdirSync(directory, {mode: 0o700});
  const child = spawn(fixture.entry, ['session', '--', process.execPath, clientProgram, fixture.entry, directory,
    fixture.root, authority.sessionId, authority.worktree, pair.bootstrapId, String(number * 250)], {
    cwd: fixture.root,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = once(child, 'close');
  const client = {child, directory, done, startup: null, stdout: () => stdout, stderr: () => stderr};
  try {
    await waitFor(() => fs.existsSync(path.join(directory, 'ready')) || child.exitCode !== null,
      'bound client ' + number + ' startup');
    assert.equal(child.exitCode, null, stderr || stdout);
    client.startup = JSON.parse(fs.readFileSync(path.join(directory, 'startup.json'), 'utf8'));
    return client;
  } catch (error) {
    await terminateClient(client);
    throw error;
  }
}

function requestRound(clients, round) {
  for (const client of clients) {
    fs.writeFileSync(path.join(client.directory, round + '.request'), '', {mode: 0o600, flag: 'wx'});
  }
}

function roundReady(clients, round) {
  return clients.every(client => fs.existsSync(path.join(client.directory, round + '.done')));
}

function roundStarted(clients, round) {
  return clients.every(client => fs.existsSync(path.join(client.directory, round + '.started')));
}

function readRound(clients, round) {
  const continuous = round.startsWith('during-');
  return clients.flatMap(client => {
    const file = path.join(client.directory, round + (continuous ? '.jsonl' : '.json'));
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  });
}

function stopRound(clients, round) {
  for (const client of clients) {
    fs.writeFileSync(path.join(client.directory, round + '.stop'), '', {mode: 0o600, flag: 'wx'});
  }
}

async function stopClients(clients) {
  const results = await Promise.allSettled(clients.map(terminateClient));
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function assertSample(sample, expectation, {includePid = true} = {}) {
  const failed = (selector, call, reason, extra = {}) => assert.fail(JSON.stringify({
    round: sample.round,
    ...(includePid ? {pid: sample.pid} : {}),
    selector,
    status: call?.status ?? null,
    signal: call?.signal ?? null,
    error: call?.error ?? null,
    elapsedMs: call?.elapsedMs ?? null,
    stderrBytes: call?.stderrBytes ?? null,
    reason,
    ...extra,
  }));
  const assertInvocation = (selector, call, event) => {
    const invocation = call.invocation;
    const extra = event ? {event} : {};
    if (!invocation) failed(selector, call, 'invocation_evidence_missing', extra);
    if (invocation.owner?.pid !== call.childPid) failed(selector, call, 'invocation_owner_mismatch', extra);
    for (const field of ['releaseId', 'bootstrapId', 'runtimeContract', 'compatibilityDigest']) {
      if (invocation[field] !== expectation.pair[field]) {
        failed(selector, call, 'invocation_pair_mismatch', {...extra, field});
      }
    }
    if (invocation.parentBinding !== expectation.root.token) {
      failed(selector, call, 'invocation_parent_mismatch', extra);
    }
    if (invocation.descriptors?.binding?.dev !== invocation.lease?.dev
      || invocation.descriptors?.binding?.ino !== invocation.lease?.ino) {
      failed(selector, call, 'invocation_lease_fd_mismatch', extra);
    }
    if (invocation.descriptors?.generation?.dev !== expectation.root.generationDev
      || invocation.descriptors?.generation?.ino !== expectation.root.generationIno) {
      failed(selector, call, 'invocation_generation_fd_mismatch', extra);
    }
    if (invocation.descriptors?.parent?.dev !== expectation.root.bindingDev
      || invocation.descriptors?.parent?.ino !== expectation.root.bindingIno) {
      failed(selector, call, 'invocation_parent_fd_mismatch', extra);
    }
    if (!invocation.manifest?.dev || !invocation.manifest?.ino) {
      failed(selector, call, 'invocation_manifest_identity_missing', extra);
    }
  };
  if (!sample.bindingPresent) failed('session', null, 'binding_missing');
  for (const [selector, call] of [['control', sample.control], ['mcp', sample.mcp]]) {
    if (call.status !== 0 || call.signal !== null || call.error !== null || call.stderrBytes !== 0) {
      failed(selector, call, 'process_failed');
    }
    if (!call.ok) failed(selector, call, 'response_invalid');
    assertInvocation(selector, call);
  }
  if (!(sample.mcp.toolCount > 0)) failed('mcp', sample.mcp, 'tool_list_empty');
  const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd'];
  if (JSON.stringify(sample.hooks.map(hook => hook.event)) !== JSON.stringify(events)) {
    failed('hook', null, 'event_set_invalid');
  }
  for (const hook of sample.hooks) {
    const extra = {event: hook.event, normal: hook.normal, denied: hook.denied,
      expectedDeny: hook.expectedDeny, unavailable: hook.unavailable, decisionCode: hook.decisionCode};
    if (hook.status !== 0 || hook.signal !== null || hook.error !== null || hook.stderrBytes !== 0) {
      failed('hook', hook, 'process_failed', extra);
    }
    if (hook.denied && !hook.expectedDeny) failed('hook', hook, 'guard_denied', extra);
    if (hook.expectedDeny && hook.event !== 'PostToolUse') failed('hook', hook, 'unexpected_deny_classification', extra);
    if (hook.unavailable) failed('hook', hook, 'guard_unavailable', extra);
    if (!hook.normal) failed('hook', hook, 'response_invalid', extra);
    assertInvocation('hook', hook, hook.event);
  }
}

function assertSamples(samples, expectations, options) {
  for (const sample of samples) {
    const expectation = expectations.get(sample.pid);
    assert.ok(expectation, JSON.stringify({round: sample.round,
      ...(options?.includePid === false ? {} : {pid: sample.pid}), reason: 'session_expectation_missing'}));
    assertSample(sample, expectation, options);
  }
}

function sessionEvidence(fixture, clients, pair) {
  const rows = inspectSessionBindingsV2({repositoryRoot: fixture.root})
    .filter(row => row.kind === 'session' && row.live);
  return clients.map(client => {
    const row = rows.find(value => value.owner.pid === client.child.pid);
    assert.ok(row, 'live root binding must belong to the wrapper process');
    assert.equal(row.releaseId, pair.releaseId);
    assert.equal(row.bootstrapId, pair.bootstrapId);
    assert.equal(client.startup.parentPid, client.child.pid);
    const binding = fs.statSync('/proc/' + client.startup.pid + '/fd/6', {bigint: true});
    assert.equal(String(binding.dev), row.lease.dev);
    assert.equal(String(binding.ino), row.lease.ino);
    const generation = fs.statSync('/proc/' + client.startup.pid + '/fd/7', {bigint: true});
    const namedGeneration = fs.statSync(path.join(fixture.root,
      '.jhw-runtime/v2/bootstraps', pair.bootstrapId, 'lease'), {bigint: true});
    assert.equal(generation.dev, namedGeneration.dev);
    assert.equal(generation.ino, namedGeneration.ino);
    return {
      token: row.token,
      wrapperPid: client.child.pid,
      payloadPid: client.startup.pid,
      bindingDev: row.lease.dev,
      bindingIno: row.lease.ino,
      generationDev: String(generation.dev),
      generationIno: String(generation.ino),
    };
  });
}

function diagnosticRoots(roots) {
  return roots.map(({token: _token, ...root}) => root);
}

function publicationPhase() {
  const phase = options => wiringPhase(options);
  let startedNs = null;
  let finishedNs = null;
  const observed = {probeStarted: false, probeCompleted: false, publicationAcquired: false,
    pointerIntent: false, pointerRenamed: false};
  phase.observe = event => {
    if (event.phase === 'candidate_probe_start') observed.probeStarted = true;
    if (event.phase === 'candidate_probe_complete') observed.probeCompleted = true;
    if (event.phase === 'publication_acquired') observed.publicationAcquired = true;
    if (event.phase === 'pointer_intent') {
      assert.equal(event.exclusive, true);
      assert.equal(startedNs, null);
      observed.pointerIntent = true;
      startedNs = process.hrtime.bigint();
    }
    if (event.phase === 'pointer_renamed') {
      assert.equal(event.exclusive, true);
      assert.notEqual(startedNs, null);
      observed.pointerRenamed = true;
      finishedNs = process.hrtime.bigint();
    }
  };
  phase.window = () => ({startedNs, finishedNs});
  phase.observed = () => ({...observed});
  return phase;
}

function selectorIntervals(samples) {
  return samples.flatMap(sample => [
    {selector: 'control', startedNs: BigInt(sample.control.startedNs), finishedNs: BigInt(sample.control.finishedNs)},
    {selector: 'mcp', startedNs: BigInt(sample.mcp.startedNs), finishedNs: BigInt(sample.mcp.finishedNs)},
    ...sample.hooks.map(hook => ({
      selector: 'hook',
      event: hook.event,
      startedNs: BigInt(hook.startedNs),
      finishedNs: BigInt(hook.finishedNs),
    })),
  ]);
}

function overlapsForWindow(samples, window) {
  return selectorIntervals(samples).filter(call =>
    call.startedNs < window.finishedNs && call.finishedNs > window.startedNs);
}

function validatedPublicationOverlaps(samples, window) {
  if (window.startedNs === null || window.finishedNs === null) return null;
  return samples.flatMap(sample => [
    {selector: 'control', call: sample.control},
    {selector: 'mcp', call: sample.mcp},
    ...sample.hooks.filter(hook => !hook.expectedDeny).map(call => ({selector: 'hook', call})),
  ]).filter(({call}) => BigInt(call.startedNs) < window.finishedNs
    && BigInt(call.finishedNs) > window.startedNs);
}

function assertPublicationOverlap(samples, window, label) {
  assert.notEqual(window.startedNs, null);
  assert.notEqual(window.finishedNs, null);
  assert.ok(window.startedNs < window.finishedNs);
  const overlaps = validatedPublicationOverlaps(samples, window);
  assert.ok(overlaps.length > 0, label + ' missed validated calls');
  return overlaps;
}

function diagnoseSamples(t, label, samples) {
  const calls = samples.flatMap(sample => [sample.control, sample.mcp, ...sample.hooks]);
  t.diagnostic(JSON.stringify({
    label,
    sampleCount: samples.length,
    callCount: calls.length,
    invocationEvidenceCount: calls.filter(call => call.invocation !== null).length,
    processFailureCount: calls.filter(call => call.status !== 0 || call.signal !== null || call.error !== null).length,
    responseFailureCount: samples.reduce((count, sample) => count
      + Number(!sample.control.ok) + Number(!sample.mcp.ok)
      + sample.hooks.filter(hook => !hook.normal || (hook.denied && !hook.expectedDeny) || hook.unavailable).length, 0),
    expectedDenyCount: samples.reduce((count, sample) => count
      + sample.hooks.filter(hook => hook.expectedDeny).length, 0),
    successfulPostToolCount: samples.reduce((count, sample) => count
      + sample.hooks.filter(hook => hook.event === 'PostToolUse' && hook.normal && !hook.denied).length, 0),
    maximumElapsedMs: Math.max(...calls.map(call => call.elapsedMs)),
  }));
}

function diagnoseWindow(t, label, samples, window, overlaps) {
  const intervals = selectorIntervals(samples);
  const maximumElapsedMs = Object.fromEntries(['control', 'mcp', 'hook'].map(selector => [
    selector,
    Math.max(...intervals.filter(call => call.selector === selector)
      .map(call => Number(call.finishedNs - call.startedNs) / 1e6)),
  ]));
  t.diagnostic(JSON.stringify({
    label,
    sampleCount: samples.length,
    windowNs: String(window.finishedNs - window.startedNs),
    overlapCount: Object.fromEntries(['control', 'mcp', 'hook'].map(selector => [
      selector, overlaps.filter(call => call.selector === selector).length,
    ])),
    maximumElapsedMs,
  }));
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function assertGuardEvidence(fixture, clients, samples) {
  const state = path.join(fixture.home, 'guard-state');
  const journal = readJsonLines(path.join(state, 'guard-journal.jsonl'));
  const sessionIds = new Set(clients.map(client => client.startup.sessionId));
  const decisions = journal.filter(row => row.event === 'decision'
    && row.origin_adapter === 'codex'
    && sessionIds.has(row.session_id));
  for (const sessionId of sessionIds) {
    const expected = samples.filter(sample => sessionId === sample.sessionId).length;
    const normal = decisions.filter(row => row.session_id === sessionId
      && row.mode === undefined
      && row.observed_decision === undefined
      && row.decision_code === undefined);
    assert.equal(normal.length, expected, 'enforce decision count mismatch for ' + sessionId);
  }
  assert.equal(fs.existsSync(path.join(state, 'guard-observe-journal.v1.jsonl')), false);
  const diagnostics = path.join(state, 'guard-hook-diagnostics.v1.jsonl');
  if (fs.existsSync(diagnostics)) {
    const failures = readJsonLines(diagnostics).filter(row =>
      ['deadline', 'unrecorded_allow', 'decode_failure'].includes(row.kind)
      || row.code === 'GUARD_UNAVAILABLE');
    assert.deepEqual(failures, []);
  }
  return {sessionCount: sessionIds.size, enforceDecisionCount: decisions.length};
}

function boundedSampleSummary(samples) {
  const calls = samples.flatMap(sample => [sample.control, sample.mcp, ...sample.hooks]);
  const timingViolations = samples.flatMap(sample => sample.hooks.flatMap(hook => {
    const budgetMs = hook.event === 'SessionEnd' ? 3_000 : 12_000;
    return hook.elapsedMs >= budgetMs ? [{event: hook.event, elapsedMs: hook.elapsedMs, budgetMs}] : [];
  }));
  return {
    sampleCount: samples.length,
    callCount: calls.length,
    invocationEvidenceCount: calls.filter(call => call.invocation !== null).length,
    processFailureCount: calls.filter(call => call.status !== 0 || call.signal !== null || call.error !== null).length,
    responseFailureCount: samples.reduce((count, sample) => count
      + Number(!sample.control.ok) + Number(!sample.mcp.ok)
      + sample.hooks.filter(hook => !hook.normal || (hook.denied && !hook.expectedDeny) || hook.unavailable).length, 0),
    expectedDenyCount: samples.reduce((count, sample) => count
      + sample.hooks.filter(hook => hook.expectedDeny).length, 0),
    terminalHookFailureCount: samples.reduce((count, sample) => count
      + sample.hooks.filter(hook => hook.event === 'SessionEnd'
        && (hook.status !== 0 || hook.signal !== null || hook.error !== null || !hook.normal || hook.unavailable)).length, 0),
    timingViolationCount: timingViolations.length,
    timingViolations,
    maximumElapsedMs: Math.max(...calls.map(call => call.elapsedMs)),
  };
}

function transitionSampleSummary(samples) {
  if (samples.length === 0) return {
    sampleCount: 0, callCount: 0, invocationEvidenceCount: 0,
    processFailureCount: 0, responseFailureCount: 0, expectedDenyCount: 0, unexpectedDenyCount: 0,
    successfulPostToolCount: 0, terminalHookFailureCount: 0,
    timingViolationCount: 0, timingViolations: [], maximumElapsedMs: null,
  };
  return {
    ...boundedSampleSummary(samples),
    unexpectedDenyCount: samples.reduce((count, sample) => count
      + sample.hooks.filter(hook => hook.denied && !hook.expectedDeny).length, 0),
    successfulPostToolCount: samples.reduce((count, sample) => count
      + sample.hooks.filter(hook => hook.event === 'PostToolUse' && hook.normal && !hook.denied).length, 0),
  };
}

function boundedPointer(repositoryRoot, expectedPairs) {
  const current = readActivation({repositoryRoot});
  const label = Object.entries(expectedPairs).find(([, pair]) => {
    const fields = ['releaseId', 'bootstrapId', 'runtimeContract', 'compatibilityDigest']
      .filter(field => pair?.[field] !== undefined);
    return fields.length > 0 && fields.every(field => current[field] === pair[field]);
  })?.[0] ?? 'other';
  return {label, identity: currentIdentity(repositoryRoot)};
}

function pointerTransition(before, after) {
  return {
    before: before.label,
    after: after.label,
    unchanged: JSON.stringify(before.identity) === JSON.stringify(after.identity),
    changedFields: ['target', 'dev', 'ino', 'ctimeNs']
      .filter(field => before.identity[field] !== after.identity[field]),
  };
}

function boundedOverlap(samples, window) {
  if (window.startedNs === null || window.finishedNs === null) return null;
  const overlaps = overlapsForWindow(samples, window);
  return Object.fromEntries(['control', 'mcp', 'hook'].map(selector => [
    selector, overlaps.filter(call => call.selector === selector).length,
  ]));
}

function transitionStage(name) {
  return {
    name,
    status: 'not_reached',
    acceptance: 'not_reached',
    command: {status: 'not_reached', code: null},
    pointer: {before: null, after: null, unchanged: null, changedFields: []},
    journal: {status: 'not_reached', count: 0, states: []},
    probes: {started: false, completed: false},
    publicationAcquired: false,
    pointerIntent: false,
    pointerRenamed: false,
    overlapCount: null,
    validatedOverlapCount: null,
    samples: null,
    sampleEvidence: 'not_reached',
  };
}

function boundedJournalEvidence(repositoryRoot, before) {
  try {
    const names = journalNames(repositoryRoot).filter(name => !before.includes(name));
    const states = names.map(name => readRuntimeJournalV2({
      repositoryRoot,
      journalDirectory: path.join(repositoryRoot, '.jhw-runtime/v2/journals', name),
    }).state).map(state => Object.fromEntries(['kind', 'operation', 'status', 'phase', 'outcome']
      .map(field => [field, typeof state[field] === 'string' && /^[a-z_]{1,55}$/.test(state[field])
        ? state[field] : state[field] === null || state[field] === undefined ? null : 'other'])));
    return {status: names.length === 0 ? 'none' : 'read', count: names.length, states};
  } catch {
    return {status: 'unreadable', count: null, states: []};
  }
}

function isDeploymentRefusal(error) {
  return typeof error?.code === 'string' && /^DEPLOY_[A-Z_]{1,55}$/.test(error.code);
}

function boundedCommand(result, error, evidence = {}) {
  if (error) return {
    status: !isDeploymentRefusal(error) ? 'harness_failed'
      : evidence.operation === 'prune' ? 'indeterminate'
        : evidence.pointerRenamed || (evidence.pointer && evidence.pointer.before !== evidence.pointer.after)
        ? 'product_error'
        : evidence.pointerIntent || !evidence.pointer || evidence.pointer.unchanged === false
          ? 'indeterminate' : 'refused',
    code: isDeploymentRefusal(error) ? error.code : null,
  };
  return {
    status: 'returned',
    code: typeof result?.code === 'string' && /^DEPLOY_[A-Z_]{1,55}$/.test(result.code) ? result.code : null,
  };
}

function currentIdentity(repositoryRoot) {
  const current = path.join(repositoryRoot, '.jhw-runtime/current');
  const stat = fs.lstatSync(current, {bigint: true});
  return {target: fs.readlinkSync(current), dev: String(stat.dev), ino: String(stat.ino), ctimeNs: String(stat.ctimeNs)};
}

function journalNames(repositoryRoot) {
  const root = path.join(repositoryRoot, '.jhw-runtime/v2/journals');
  try { return fs.readdirSync(root).sort(); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function activationNames(repositoryRoot) {
  return fs.readdirSync(path.join(repositoryRoot, '.jhw-runtime/v2/activations')).sort();
}

test('transition evidence separates publication errors and validated overlap', () => {
  const deploymentError = Object.assign(new Error('bounded fixture error'), {code: 'DEPLOY_INVENTORY_UNCERTAIN'});
  assert.deepEqual(boundedCommand(null, deploymentError, {
    pointer: {before: 'A', after: 'A', unchanged: true}, pointerIntent: false, pointerRenamed: false,
  }), {status: 'refused', code: 'DEPLOY_INVENTORY_UNCERTAIN'});
  assert.deepEqual(boundedCommand(null, deploymentError, {
    pointer: {before: 'A', after: 'A'}, pointerIntent: true, pointerRenamed: false,
  }), {status: 'indeterminate', code: 'DEPLOY_INVENTORY_UNCERTAIN'});
  assert.deepEqual(boundedCommand(null, deploymentError, {
    pointer: {before: 'A', after: 'A', unchanged: false}, pointerIntent: false, pointerRenamed: false,
  }), {status: 'indeterminate', code: 'DEPLOY_INVENTORY_UNCERTAIN'});
  assert.deepEqual(boundedCommand(null, deploymentError, {
    operation: 'prune', pointer: {before: 'A', after: 'A', unchanged: true},
  }), {status: 'indeterminate', code: 'DEPLOY_INVENTORY_UNCERTAIN'});
  assert.deepEqual(boundedCommand(null, deploymentError),
    {status: 'indeterminate', code: 'DEPLOY_INVENTORY_UNCERTAIN'});
  assert.deepEqual(boundedCommand(null, deploymentError, {
    pointer: {before: 'A', after: 'B'}, pointerIntent: true, pointerRenamed: true,
  }), {status: 'product_error', code: 'DEPLOY_INVENTORY_UNCERTAIN'});
  assert.deepEqual(boundedCommand(null, deploymentError, {
    pointer: {before: 'A', after: 'A'}, pointerIntent: true, pointerRenamed: true,
  }), {status: 'product_error', code: 'DEPLOY_INVENTORY_UNCERTAIN'});

  const window = {startedNs: 10n, finishedNs: 20n};
  const call = (startedNs, finishedNs, expectedDeny = false) => ({
    startedNs: String(startedNs), finishedNs: String(finishedNs), expectedDeny,
  });
  const oneValidated = [{
    control: call(0, 5),
    mcp: call(12, 13),
    hooks: [call(11, 12, true)],
  }];
  assert.equal(assertPublicationOverlap(oneValidated, window, 'single validated selector').length, 1);
  const negativeOnly = [{
    control: call(0, 5),
    mcp: call(21, 22),
    hooks: [call(11, 12, true)],
  }];
  assert.throws(() => assertPublicationOverlap(negativeOnly, window, 'negative-only overlap'),
    /missed validated calls/);
});

async function prepareAgedThirdGeneration(fixture, {pairA, pairB, marker}) {
  const helper = path.join(fixture.root, 'scripts/runtime-entry.mjs');
  fixture.write('scripts/runtime-entry.mjs', fs.readFileSync(helper, 'utf8') + '\n// ' + marker + '\n');
  checkedGit(fixture.root, 'add', 'scripts/runtime-entry.mjs');
  checkedGit(fixture.root, '-c', 'user.name=Runtime integration', '-c',
    'user.email=runtime-integration@example.invalid', 'commit', '-m', 'fixture generation C');
  const releaseC = await fixture.prepare();
  assert.notEqual(releaseC.releaseId, pairA.releaseId);
  assert.notEqual(releaseC.releaseId, pairB.releaseId);
  let pairC;
  const writer = acquireLease(path.join(fixture.root, '.jhw-runtime/deploy.lock'));
  try {
    pairC = ensureBootstrapGeneration({
      repositoryRoot: fixture.root,
      releaseId: releaseC.releaseId,
      deployLease: writer,
    });
  } finally {
    writer.close();
  }
  const previousBootstrapIds = new Set([pairA.bootstrapId, pairB.bootstrapId]);
  assert.equal(previousBootstrapIds.has(pairC.bootstrapId), false);
  const thirdDirectory = path.join(fixture.root, '.jhw-runtime/v2/bootstraps', pairC.bootstrapId);
  const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000);
  fs.utimesSync(thirdDirectory, stale, stale);
  return {releaseC, pairC, thirdDirectory};
}

async function fiveRootTransitionFixture(t, {thirdGeneration = false} = {}) {
  const fixture = await createRuntimeFixture(t, {realDependencies: true});
  const clients = [];
  const deploy = argv => runDeployment({
    repositoryRoot: fixture.root,
    home: fixture.home,
    procRoot: fixture.procRoot,
    environment: fixture.environment,
    argv,
    phaseRunner: wiringPhase,
  });
  try {
    const releaseA = await fixture.prepare();
    await deploy(['--activate', releaseA.releaseId]);
    const currentA = readActivation({repositoryRoot: fixture.root});
    const pairA = {
      releaseId: currentA.releaseId,
      bootstrapId: currentA.bootstrapId,
      runtimeContract: currentA.runtimeContract,
      compatibilityDigest: currentA.compatibilityDigest,
    };
    const guardFixture = configureGuard(fixture);
    const guardEnvironment = clientEnvironment(fixture, guardFixture.coordinates);
    for (const number of [0, 1, 2]) {
      clients.push(await startBoundClient(fixture, guardEnvironment, guardFixture.clients[number], pairA, number));
    }
    const clientsA = [...clients];
    const rootsA = sessionEvidence(fixture, clientsA, pairA);
    assert.equal(rootsA.length, 3);
    const expectations = new Map(rootsA.map(root => [root.payloadPid, {pair: pairA, root}]));

    const helper = path.join(fixture.root, 'scripts/runtime-entry.mjs');
    fixture.write('scripts/runtime-entry.mjs', fs.readFileSync(helper, 'utf8')
      + '\n// runtime-v2-prune-plan generation B\n');
    checkedGit(fixture.root, 'add', 'scripts/runtime-entry.mjs');
    checkedGit(fixture.root, '-c', 'user.name=Runtime integration', '-c',
      'user.email=runtime-integration@example.invalid', 'commit', '-m', 'fixture generation B');
    const releaseB = await fixture.prepare();
    assert.notEqual(releaseB.releaseId, releaseA.releaseId);
    assert.notEqual(
      fs.readFileSync(path.join(fixture.root, '.jhw-runtime/releases', releaseA.releaseId,
        'scripts/runtime-entry.mjs'), 'utf8'),
      fs.readFileSync(path.join(fixture.root, '.jhw-runtime/releases', releaseB.releaseId,
        'scripts/runtime-entry.mjs'), 'utf8'));

    const promoted = await deploy(['--activate-compatible', releaseB.releaseId]);
    assert.equal(promoted.code, 'DEPLOY_COMPATIBLE_ACTIVATED');
    const currentB = readActivation({repositoryRoot: fixture.root});
    const pairB = {
      releaseId: currentB.releaseId,
      bootstrapId: currentB.bootstrapId,
      runtimeContract: currentB.runtimeContract,
      compatibilityDigest: currentB.compatibilityDigest,
    };
    assert.notEqual(pairB.bootstrapId, pairA.bootstrapId);
    const clientB = await startBoundClient(fixture, guardEnvironment, guardFixture.clients[3], pairB, 3);
    clients.push(clientB);
    const rootsB = sessionEvidence(fixture, [clientB], pairB);
    expectations.set(rootsB[0].payloadPid, {pair: pairB, root: rootsB[0]});

    const rolledBack = await deploy(['--rollback']);
    assert.equal(rolledBack.code, 'DEPLOY_ROLLED_BACK');
    assert.equal(rolledBack.releaseId, pairA.releaseId);
    const currentAfterRollback = readActivation({repositoryRoot: fixture.root});
    assert.deepEqual({
      releaseId: currentAfterRollback.releaseId,
      bootstrapId: currentAfterRollback.bootstrapId,
      runtimeContract: currentAfterRollback.runtimeContract,
      compatibilityDigest: currentAfterRollback.compatibilityDigest,
    }, pairA);
    const clientAfterRollback = await startBoundClient(
      fixture, guardEnvironment, guardFixture.clients[4], pairA, 4);
    clients.push(clientAfterRollback);
    const rollbackRoots = sessionEvidence(fixture, [clientAfterRollback], pairA);
    expectations.set(rollbackRoots[0].payloadPid, {pair: pairA, root: rollbackRoots[0]});
    assert.equal(sessionEvidence(fixture, clientsA, pairA).length, 3);
    assert.equal(sessionEvidence(fixture, [clientB], pairB).length, 1);

    let releaseC = null;
    let pairC = null;
    let thirdDirectory = null;
    if (thirdGeneration) {
      ({releaseC, pairC, thirdDirectory} = await prepareAgedThirdGeneration(fixture, {
        pairA,
        pairB,
        marker: 'runtime-v2-generation-prune generation C',
      }));
      assert.notEqual(pairC.bootstrapId, pairA.bootstrapId);
      assert.notEqual(pairC.bootstrapId, pairB.bootstrapId);
    }
    return {
      fixture, clients, clientsA, clientB, clientAfterRollback, expectations,
      pairA, pairB, pairC, releaseA, releaseB, releaseC, thirdDirectory,
    };
  } catch (error) {
    await stopClients(clients);
    throw error;
  }
}

test('v2 prune dry run classifies candidates during five real bound sessions', async t => {
  const setup = await fiveRootTransitionFixture(t);
  const {
    fixture, clients, clientsA, clientB, clientAfterRollback, expectations, pairA, pairB,
  } = setup;
  try {
    const pointerBefore = currentIdentity(fixture.root);
    const activationsBefore = activationNames(fixture.root);
    const journalsBefore = journalNames(fixture.root);
    const bootstrapRoot = path.join(fixture.root, '.jhw-runtime/v2/bootstraps');
    const bootstrapsBefore = fs.readdirSync(bootstrapRoot).sort();
    assert.ok(bootstrapsBefore.length >= 2);
    assert.equal(inspectSessionBindingsV2({repositoryRoot: fixture.root})
      .filter(row => row.kind === 'session' && row.live).length, 5);

    requestRound(clients, 'during-prune');
    await waitFor(() => roundStarted(clients, 'during-prune'), 'prune plan samples started');
    const planStartedNs = process.hrtime.bigint();
    let plan;
    let planFinishedNs;
    try {
      plan = await runDeployment({
        repositoryRoot: fixture.root,
        home: fixture.home,
        procRoot: fixture.procRoot,
        environment: fixture.environment,
        argv: ['--prune'],
      });
    } finally {
      planFinishedNs = process.hrtime.bigint();
      stopRound(clients, 'during-prune');
    }
    await waitFor(() => roundReady(clients, 'during-prune'), 'prune plan samples complete');
    const planSamples = readRound(clients, 'during-prune');
    assert.ok(planSamples.length >= clients.length, 'prune plan sampling must not be empty');
    assertSamples(planSamples, expectations);
    const sampledSessions = new Set(planSamples.map(sample => sample.sessionId));
    assert.deepEqual([...sampledSessions].sort(),
      clients.map(client => client.startup.sessionId).sort());
    const planWindow = {startedNs: planStartedNs, finishedNs: planFinishedNs};
    const validatedOverlap = assertPublicationOverlap(planSamples, planWindow, 'prune plan');

    assert.equal(plan.code, 'DEPLOY_PRUNE_PLAN');
    assert.equal(plan.version, 1);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.advisory, true);
    assert.equal(plan.blocked, false);
    assert.deepEqual(plan.reasons, []);
    assert.deepEqual(plan.removed, Object.fromEntries(
      Object.keys(plan.removed).map(category => [category, 0])));
    for (const category of ['journals', 'previous', 'bootstrapGenerations']) {
      assert.equal(Object.hasOwn(plan.candidates, category), true);
      assert.ok(Array.isArray(plan.candidates[category]));
    }
    assert.deepEqual(Object.keys(plan.skipped).sort(),
      ['evidence', 'legacy', 'retainedAge', 'retainedPrevious', 'retainedRecent', 'unknown']);
    assert.ok(Object.values(plan.skipped).every(value => Number.isSafeInteger(value) && value >= 0));

    assert.deepEqual(currentIdentity(fixture.root), pointerBefore);
    assert.deepEqual(activationNames(fixture.root), activationsBefore);
    assert.deepEqual(journalNames(fixture.root), journalsBefore);
    assert.deepEqual(fs.readdirSync(bootstrapRoot).sort(), bootstrapsBefore);
    assert.equal(sessionEvidence(fixture, clientsA, pairA).length, 3);
    assert.equal(sessionEvidence(fixture, [clientB], pairB).length, 1);
    assert.equal(sessionEvidence(fixture, [clientAfterRollback], pairA).length, 1);

    const legacyJournalCandidates = plan.candidates.journals
      .filter(name => /^\.deploy\.[a-f0-9]{32}$/.test(name)).length;
    const v2JournalCandidates = plan.candidates.journals
      .filter(name => /^d-[a-f0-9]{32}$/.test(name)).length;
    assert.equal(legacyJournalCandidates + v2JournalCandidates, plan.candidates.journals.length);
    t.diagnostic(JSON.stringify({
      label: 'prune-plan-result',
      code: plan.code,
      categoryFieldsPresent: {
        bootstrapGenerations: Object.hasOwn(plan.candidates, 'bootstrapGenerations'),
        previous: Object.hasOwn(plan.candidates, 'previous'),
        journals: Object.hasOwn(plan.candidates, 'journals'),
      },
      candidates: {
        bootstrapGenerations: plan.candidates.bootstrapGenerations.length,
        previous: plan.candidates.previous.length,
        legacyJournals: legacyJournalCandidates,
        v2Journals: v2JournalCandidates,
      },
      skipped: plan.skipped,
      observed: plan.observed,
      actual: {
        bootstrapGenerations: bootstrapsBefore.length,
        liveRoots: 5,
        pairARoots: 4,
        pairBRoots: 1,
        activations: activationsBefore.length,
        journals: journalsBefore.length,
      },
      planCalls: {
        sessions: sampledSessions.size,
        ...transitionSampleSummary(planSamples),
        validatedOverlapCount: validatedOverlap.length,
      },
      unchanged: {pointer: true, activations: true, journals: true, bootstraps: true, roots: true},
    }));
  } finally {
    await stopClients(clients);
  }
  assert.deepEqual(inspectSessionBindingsV2({repositoryRoot: fixture.root}), []);
});


function generationObjectEvidence(repositoryRoot, pair) {
  return directoryAndLeaseEvidence(path.join(repositoryRoot, '.jhw-runtime/v2/bootstraps', pair.bootstrapId));
}

function directoryAndLeaseEvidence(directory) {
  const directoryStat = fs.statSync(directory, {bigint: true});
  const leaseStat = fs.statSync(path.join(directory, 'lease'), {bigint: true});
  return {
    directory: {dev: String(directoryStat.dev), ino: String(directoryStat.ino)},
    lease: {dev: String(leaseStat.dev), ino: String(leaseStat.ino)},
  };
}

function pruneObjectNames(repositoryRoot) {
  const runtime = path.join(repositoryRoot, '.jhw-runtime');
  return {
    pointer: currentIdentity(repositoryRoot),
    activations: activationNames(repositoryRoot),
    journals: journalNames(repositoryRoot),
    releases: fs.readdirSync(path.join(runtime, 'releases')).sort(),
    bootstraps: fs.readdirSync(path.join(runtime, 'v2/bootstraps')).sort(),
    catalog: fs.readdirSync(path.join(runtime, 'v2/bootstrap-catalog')).sort(),
  };
}

async function generationPruneExperiment(t, continuous) {
  const setup = await fiveRootTransitionFixture(t, {thirdGeneration: true});
  const {
    fixture, clients, clientsA, clientB, clientAfterRollback, expectations,
    pairA, pairB, pairC, releaseC, thirdDirectory,
  } = setup;
  let diagnostic;
  try {
    const plan = await runDeployment({
      repositoryRoot: fixture.root,
      home: fixture.home,
      procRoot: fixture.procRoot,
      environment: fixture.environment,
      argv: ['--prune'],
    });
    assert.equal(plan.code, 'DEPLOY_PRUNE_PLAN');
    assert.deepEqual(plan.candidates.bootstrapGenerations, [pairC.bootstrapId]);
    assert.deepEqual(plan.candidates.previous, []);
    assert.deepEqual(plan.candidates.journals, []);

    const beforeNames = pruneObjectNames(fixture.root);
    const beforeObjects = {
      A: generationObjectEvidence(fixture.root, pairA),
      B: generationObjectEvidence(fixture.root, pairB),
      C: generationObjectEvidence(fixture.root, pairC),
    };
    const beforeRoots = [
      ...sessionEvidence(fixture, clientsA, pairA),
      ...sessionEvidence(fixture, [clientB], pairB),
      ...sessionEvidence(fixture, [clientAfterRollback], pairA),
    ];
    let beforeSamples = [];
    let duringSamples = [];
    if (continuous) {
      requestRound(clients, 'during-prune');
      await waitFor(() => roundStarted(clients, 'during-prune'), 'generation prune samples started');
    } else {
      requestRound(clients, 'before-prune');
      await waitFor(() => roundReady(clients, 'before-prune'), 'pre-prune calls');
      beforeSamples = readRound(clients, 'before-prune');
    }
    const startedNs = process.hrtime.bigint();
    let applied;
    let commandError;
    let finishedNs;
    try {
      applied = await runDeployment({
        repositoryRoot: fixture.root,
        home: fixture.home,
        procRoot: fixture.procRoot,
        environment: fixture.environment,
        argv: ['--prune', '--apply'],
      });
    } catch (error) {
      commandError = error;
    } finally {
      finishedNs = process.hrtime.bigint();
      if (continuous) stopRound(clients, 'during-prune');
    }
    if (continuous) {
      await waitFor(() => roundReady(clients, 'during-prune'), 'generation prune samples complete');
      duringSamples = readRound(clients, 'during-prune');
    }
    requestRound(clients, 'after-prune');
    await waitFor(() => roundReady(clients, 'after-prune'), 'post-prune calls');
    const afterSamples = readRound(clients, 'after-prune');

    const afterNames = pruneObjectNames(fixture.root);
    const aAfter = generationObjectEvidence(fixture.root, pairA);
    const bAfter = generationObjectEvidence(fixture.root, pairB);
    const cPresentAfter = fs.existsSync(thirdDirectory);
    const afterRoots = [
      ...sessionEvidence(fixture, clientsA, pairA),
      ...sessionEvidence(fixture, [clientB], pairB),
      ...sessionEvidence(fixture, [clientAfterRollback], pairA),
    ];
    const relevantSamples = [...beforeSamples, ...duringSamples, ...afterSamples];
    const expectedSessionIds = clients.map(client => client.startup.sessionId).sort();
    const sampleSessions = samples => [...new Set(samples.map(sample => sample.sessionId))].sort();
    const window = {startedNs, finishedNs};
    const overlap = continuous ? boundedOverlap(duringSamples, window) : null;
    let sampleError;
    let validatedOverlapCount = null;
    try {
      assertSamples(beforeSamples, expectations);
      assertSamples(duringSamples, expectations);
      assertSamples(afterSamples, expectations);
      if (continuous && overlap) {
        validatedOverlapCount = assertPublicationOverlap(
          duringSamples, window, 'generation prune apply').length;
      }
    } catch (error) {
      sampleError = error;
    }
    diagnostic = {
      label: 'generation-prune-result',
      mode: continuous ? 'continuous_calls' : 'between_calls',
      fixtureAgeDays: 40,
      plan: {
        code: plan.code,
        bootstrapGenerations: plan.candidates.bootstrapGenerations.length,
        previous: plan.candidates.previous.length,
        journals: plan.candidates.journals.length,
        exactThirdOnly: true,
      },
      command: boundedCommand(applied, commandError, {
        operation: 'prune',
      }),
      removed: applied?.removed ?? null,
      applyPlan: applied ? {
        bootstrapGenerations: applied.candidates.bootstrapGenerations.length,
        previous: applied.candidates.previous.length,
        journals: applied.candidates.journals.length,
        exactThirdOnly: applied.candidates.bootstrapGenerations.length === 1
          && applied.candidates.bootstrapGenerations[0] === pairC.bootstrapId
          && applied.candidates.previous.length === 0 && applied.candidates.journals.length === 0,
      } : null,
      inventory: applied ? {
        beforeRoots: applied.inventory.before.roots.length,
        afterRoots: applied.inventory.after.roots.length,
        beforeBound: applied.inventory.before.processes.bound,
        afterBound: applied.inventory.after.processes.bound,
      } : null,
      generations: {
        before: {A: true, B: true, C: true, count: beforeNames.bootstraps.length},
        after: {
          A: afterNames.bootstraps.includes(pairA.bootstrapId),
          B: afterNames.bootstraps.includes(pairB.bootstrapId),
          C: cPresentAfter,
          count: afterNames.bootstraps.length,
        },
      },
      identities: {
        aDirectoryAndLeasePreserved: JSON.stringify(beforeObjects.A) === JSON.stringify(aAfter),
        bDirectoryAndLeasePreserved: JSON.stringify(beforeObjects.B) === JSON.stringify(bAfter),
        cDirectoryAndLeaseCaptured: Boolean(beforeObjects.C.directory && beforeObjects.C.lease),
        cDirectoryAndLeaseRemoved: !cPresentAfter,
        fiveRootPairAndLeaseProofPreserved: JSON.stringify(beforeRoots) === JSON.stringify(afterRoots),
      },
      retained: {
        cRelease: afterNames.releases.includes(releaseC.releaseId),
        cCatalog: afterNames.catalog.includes(pairC.bootstrapId + '.json'),
      },
      unchanged: {
        pointer: JSON.stringify(beforeNames.pointer) === JSON.stringify(afterNames.pointer),
        activations: JSON.stringify(beforeNames.activations) === JSON.stringify(afterNames.activations),
        journals: JSON.stringify(beforeNames.journals) === JSON.stringify(afterNames.journals),
        releases: JSON.stringify(beforeNames.releases) === JSON.stringify(afterNames.releases),
        catalog: JSON.stringify(beforeNames.catalog) === JSON.stringify(afterNames.catalog),
        onlyThirdBootstrapRemoved: JSON.stringify(afterNames.bootstraps)
          === JSON.stringify(beforeNames.bootstraps.filter(name => name !== pairC.bootstrapId)),
      },
      roots: {before: {live: beforeRoots.length, A: 4, B: 1}, after: {live: afterRoots.length, A: 4, B: 1}},
      calls: {
        before: transitionSampleSummary(beforeSamples),
        during: transitionSampleSummary(duringSamples),
        after: transitionSampleSummary(afterSamples),
        total: transitionSampleSummary(relevantSamples),
        applyWindowOverlap: overlap,
        validatedApplyWindowOverlapCount: validatedOverlapCount,
        samplesValidated: !sampleError,
        expectedSessionCount: expectedSessionIds.length,
        beforeSessionsComplete: !continuous
          && JSON.stringify(sampleSessions(beforeSamples)) === JSON.stringify(expectedSessionIds),
        duringSessionsComplete: continuous
          && JSON.stringify(sampleSessions(duringSamples)) === JSON.stringify(expectedSessionIds),
        afterSessionsComplete: JSON.stringify(sampleSessions(afterSamples)) === JSON.stringify(expectedSessionIds),
      },
    };
    t.diagnostic(JSON.stringify(diagnostic));
    if (commandError) throw commandError;
    if (sampleError) throw sampleError;
    assert.equal(applied.code, 'DEPLOY_PRUNED');
    assert.deepEqual(applied.candidates.bootstrapGenerations, [pairC.bootstrapId]);
    assert.deepEqual(applied.candidates.previous, []);
    assert.deepEqual(applied.candidates.journals, []);
    assert.deepEqual(applied.removed, {journals: 0, previous: 0, bootstrapGenerations: 1});
    assert.equal(cPresentAfter, false);
    assert.equal(fs.existsSync(path.join(fixture.root, '.jhw-runtime/releases', releaseC.releaseId)), true);
    assert.equal(fs.existsSync(path.join(fixture.root,
      '.jhw-runtime/v2/bootstrap-catalog', pairC.bootstrapId + '.json')), true);
    assert.equal(diagnostic.identities.aDirectoryAndLeasePreserved, true);
    assert.equal(diagnostic.identities.bDirectoryAndLeasePreserved, true);
    assert.equal(diagnostic.identities.fiveRootPairAndLeaseProofPreserved, true);
    assert.deepEqual(aAfter, beforeObjects.A);
    assert.deepEqual(bAfter, beforeObjects.B);
    assert.deepEqual(diagnostic.unchanged, {
      pointer: true, activations: true, journals: true, releases: true, catalog: true,
      onlyThirdBootstrapRemoved: true,
    });
    assert.equal(continuous
      ? diagnostic.calls.duringSessionsComplete : diagnostic.calls.beforeSessionsComplete, true);
    assert.equal(diagnostic.calls.afterSessionsComplete, true);
    assert.equal(afterRoots.length, 5);
    assert.equal(diagnostic.calls.total.processFailureCount, 0);
    assert.equal(diagnostic.calls.total.responseFailureCount, 0);
    assert.equal(diagnostic.calls.total.expectedDenyCount, diagnostic.calls.total.sampleCount);
    assert.equal(diagnostic.calls.total.unexpectedDenyCount, 0);
    assert.equal(diagnostic.calls.total.successfulPostToolCount, 0);
    assert.equal(diagnostic.calls.total.terminalHookFailureCount, 0);
    assert.equal(diagnostic.calls.total.timingViolationCount, 0);
    assert.equal(applied.inventory.before.roots.length, 5);
    assert.equal(applied.inventory.after.roots.length, 5);
    assert.equal(applied.inventory.before.processes.clear, true);
    assert.equal(applied.inventory.after.processes.clear, true);
    if (continuous) assert.ok(validatedOverlapCount > 0, 'prune apply missed validated calls');
  } finally {
    await stopClients(clients);
  }
  assert.ok(diagnostic, 'generation prune evidence was not completed');
  assert.deepEqual(inspectSessionBindingsV2({repositoryRoot: fixture.root}), []);
}

test('v2 prune removes only an aged third generation between five-root calls', async t => {
  await generationPruneExperiment(t, false);
});

test('v2 prune removes only an aged third generation during five-root calls', async t => {
  await generationPruneExperiment(t, true);
});

test('v2 prune first inventory attributes uncertainty across idle and continuous five-root calls', async t => {
  const setup = await fiveRootTransitionFixture(t, {thirdGeneration: true});
  const {
    fixture, clients, clientsA, clientB, clientAfterRollback, expectations,
    pairA, pairB, pairC,
  } = setup;
  const causes = ['classification_unknown', 'identity_changed', 'pid_set_changed',
    'process_vanished', 'record_unreadable', 'root_mismatch'];
  const verifyObservation = result => {
    assert.equal(result.code, 'DEPLOY_PRUNE_INVENTORY_OBSERVED');
    assert.deepEqual(result.route, {hasGenerations:true,hasLegacy:false,livePath:true});
    assert.deepEqual(result.plan,
      {bootstrapGenerations:1,previous:0,legacyJournals:0,v2Journals:0});
    assert.equal(result.rootCount, 5);
    assert.deepEqual(Object.keys(result.observation.causeCounts).sort(), causes);
    assert.equal(Object.values(result.observation.causeCounts)
      .reduce((total,count)=>total+count,0),result.inventory.uncertain);
    assert.equal(result.observation.stage, 'preliminary');
    assert.equal(result.observation.elapsedMs, result.elapsedMs.scan);
    for(const elapsed of Object.values(result.elapsedMs))assert.ok(Number.isFinite(elapsed)&&elapsed>=0);
  };
  const verifyCalls = samples => {
    assertSamples(samples, expectations);
    const summary=transitionSampleSummary(samples);
    assert.equal(summary.invocationEvidenceCount,summary.callCount);
    assert.equal(summary.expectedDenyCount,summary.sampleCount);
    assert.equal(summary.processFailureCount,0);
    assert.equal(summary.responseFailureCount,0);
    assert.equal(summary.unexpectedDenyCount,0);
    assert.equal(summary.terminalHookFailureCount,0);
    assert.equal(summary.timingViolationCount,0);
    return summary;
  };
  let diagnostic;
  try {
    const plan=await runDeployment({repositoryRoot:fixture.root,home:fixture.home,
      procRoot:fixture.procRoot,environment:fixture.environment,argv:['--prune']});
    assert.deepEqual(plan.candidates.bootstrapGenerations,[pairC.bootstrapId]);
    assert.deepEqual(plan.candidates.previous,[]);
    assert.deepEqual(plan.candidates.journals,[]);
    const beforeNames=pruneObjectNames(fixture.root);
    const beforeRoots=[
      ...sessionEvidence(fixture,clientsA,pairA),
      ...sessionEvidence(fixture,[clientB],pairB),
      ...sessionEvidence(fixture,[clientAfterRollback],pairA),
    ];

    requestRound(clients,'before-prune');
    await waitFor(()=>roundReady(clients,'before-prune'),'pre-census calls');
    const beforeSamples=readRound(clients,'before-prune');
    const beforeSummary=verifyCalls(beforeSamples);
    const idle=observeLivePruneInventory({repositoryRoot:fixture.root,procRoot:fixture.procRoot});
    verifyObservation(idle);
    requestRound(clients,'after-prune');
    await waitFor(()=>roundReady(clients,'after-prune'),'post-idle-census calls');
    const afterIdleSamples=readRound(clients,'after-prune');
    const afterIdleSummary=verifyCalls(afterIdleSamples);

    requestRound(clients,'during-prune');
    await waitFor(()=>roundStarted(clients,'during-prune'),'continuous census calls started');
    let continuous;
    try {
      continuous=observeLivePruneInventory({repositoryRoot:fixture.root,procRoot:fixture.procRoot});
    } finally {
      stopRound(clients,'during-prune');
    }
    await waitFor(()=>roundReady(clients,'during-prune'),'continuous census calls complete');
    const continuousSamples=readRound(clients,'during-prune');
    const continuousSummary=verifyCalls(continuousSamples);
    verifyObservation(continuous);
    let validatedOverlap=[];
    let overlapError;
    try {
      validatedOverlap=assertPublicationOverlap(continuousSamples,
        {startedNs:BigInt(continuous.scanWindow.startedNs),
          finishedNs:BigInt(continuous.scanWindow.finishedNs)},'live prune first inventory');
    } catch(error) {
      overlapError=error;
    }
    const expectedSessions=clients.map(client=>client.startup.sessionId).sort();
    assert.deepEqual([...new Set(continuousSamples.map(sample=>sample.sessionId))].sort(),expectedSessions);

    const afterNames=pruneObjectNames(fixture.root);
    const afterRoots=[
      ...sessionEvidence(fixture,clientsA,pairA),
      ...sessionEvidence(fixture,[clientB],pairB),
      ...sessionEvidence(fixture,[clientAfterRollback],pairA),
    ];
    assert.deepEqual(afterNames,beforeNames);
    assert.deepEqual(afterRoots,beforeRoots);
    diagnostic={
      label:'prune-first-inventory-result',
      plan:{bootstrapGenerations:1,previous:0,journals:0,exactThirdOnly:true},
      roots:{before:beforeRoots.length,after:afterRoots.length,A:4,B:1},
      idle:{scanComplete:idle.observation.outcome==='complete',
        inventory:idle.inventory,observation:idle.observation,elapsedMs:idle.elapsedMs,
        calls:{before:beforeSummary,after:afterIdleSummary}},
      continuous:{scanComplete:continuous.observation.outcome==='complete',
        inventory:continuous.inventory,observation:continuous.observation,
        elapsedMs:continuous.elapsedMs,calls:continuousSummary,
        validatedOverlapCount:validatedOverlap.length},
      unchanged:{pointer:true,activations:true,journals:true,releases:true,
        bootstraps:true,catalog:true,roots:true},
    };
    t.diagnostic(JSON.stringify(diagnostic));
    if(overlapError)throw overlapError;
  } finally {
    await stopClients(clients);
  }
  assert.ok(diagnostic,'prune first inventory evidence was not completed');
  assert.deepEqual(inspectSessionBindingsV2({repositoryRoot:fixture.root}),[]);
});

test('v2 prune compares two baseline and prepared scans with five live roots', async t => {
  const setup = await fiveRootTransitionFixture(t, {thirdGeneration:true});
  const {fixture,clients,clientsA,clientB,clientAfterRollback,expectations,pairA,pairB,pairC}=setup;
  const order=['idle-baseline','idle-prepared','continuous-baseline','continuous-prepared'];
  const runtime=path.join(fixture.root,'.jhw-runtime');
  const lockNames=['deploy.lock','admission.lock','publication.lock'];
  const lockEvidence=()=>Object.fromEntries(lockNames.map(name=>{
    const file=path.join(runtime,name);
    try{const stat=fs.lstatSync(file,{bigint:true});return[name,{exists:true,dev:String(stat.dev),
      ino:String(stat.ino),ctimeNs:String(stat.ctimeNs)}];}
    catch(error){if(error.code!=='ENOENT')throw error;return[name,{exists:false}];}
  }));
  const verifyCalls=samples=>{
    assertSamples(samples,expectations);
    assert.deepEqual([...new Set(samples.map(sample=>sample.sessionId))].sort(),
      clients.map(client=>client.startup.sessionId).sort());
    const summary=transitionSampleSummary(samples);
    assert.equal(summary.invocationEvidenceCount,summary.callCount);
    assert.equal(summary.expectedDenyCount,summary.sampleCount);
    for(const field of ['processFailureCount','responseFailureCount','unexpectedDenyCount',
      'terminalHookFailureCount','timingViolationCount'])assert.equal(summary[field],0);
    return summary;
  };
  const verifyResult=(result,method)=>{
    assert.equal(result.method,method);
    assert.equal(result.rootCount,5);
    assert.deepEqual(result.plan,
      {bootstrapGenerations:1,previous:0,legacyJournals:0,v2Journals:0});
    assert.equal(result.scans.length,2);
    assert.deepEqual(result.scans.map(scan=>scan.observation.stage),['preliminary','publication']);
    assert.ok(Object.values(result.elapsedMs).every(elapsed=>Number.isFinite(elapsed)&&elapsed>=0));
    for(const scan of result.scans){
      assert.equal(Object.values(scan.observation.causeCounts)
        .reduce((total,count)=>total+count,0),scan.inventory.uncertain);
      assert.equal(scan.observation.elapsedMs,scan.elapsedMs.scan);
      assert.ok(BigInt(scan.scanWindow.startedNs)<BigInt(scan.scanWindow.finishedNs));
      assert.ok(Object.values(scan.elapsedMs).every(elapsed=>Number.isFinite(elapsed)&&elapsed>=0));
    }
  };
  const normalOverlapCount=(samples,scan)=>samples.flatMap(sample=>[
    sample.control,sample.mcp,...sample.hooks.filter(hook=>!hook.expectedDeny),
  ]).filter(call=>BigInt(call.startedNs)<BigInt(scan.scanWindow.finishedNs)
    &&BigInt(call.finishedNs)>BigInt(scan.scanWindow.startedNs)).length;
  const beforeNames=pruneObjectNames(fixture.root);
  const beforeRoots=[...sessionEvidence(fixture,clientsA,pairA),
    ...sessionEvidence(fixture,[clientB],pairB),
    ...sessionEvidence(fixture,[clientAfterRollback],pairA)];
  const locksBefore=lockEvidence();
  assert.equal(fs.existsSync(path.join(runtime,'.prune.v1')),false);
  let diagnostic;
  try{
    const plan=await runDeployment({repositoryRoot:fixture.root,home:fixture.home,
      procRoot:fixture.procRoot,environment:fixture.environment,argv:['--prune']});
    assert.deepEqual(plan.candidates.bootstrapGenerations,[pairC.bootstrapId]);
    assert.deepEqual(plan.candidates.previous,[]);
    assert.deepEqual(plan.candidates.journals,[]);
    requestRound(clients,'before-prune');
    await waitFor(()=>roundReady(clients,'before-prune'),'pre-comparison calls');
    const beforeSummary=verifyCalls(readRound(clients,'before-prune'));
    const idleBaseline=observePruneScanPair({repositoryRoot:fixture.root,
      procRoot:fixture.procRoot,method:'baseline'});
    verifyResult(idleBaseline,'baseline');
    const idlePrepared=observePruneScanPair({repositoryRoot:fixture.root,
      procRoot:fixture.procRoot,method:'prepared'});
    verifyResult(idlePrepared,'prepared');
    for(let index=0;index<2;index++){
      assert.deepEqual(idlePrepared.scans[index].inventory,idleBaseline.scans[index].inventory);
      assert.deepEqual(idlePrepared.scans[index].observation.causeCounts,
        idleBaseline.scans[index].observation.causeCounts);
      assert.equal(idlePrepared.scans[index].observation.outcome,
        idleBaseline.scans[index].observation.outcome);
      assert.equal(idlePrepared.scans[index].inventory.uncertain,0);
      assert.equal(idlePrepared.scans[index].inventory.bound.managed,5);
      assert.deepEqual(idlePrepared.scans[index].inventory.counts,
        {tui:0,app_server:0,legacy:0,managed:0});
    }
    requestRound(clients,'during-prune');
    await waitFor(()=>roundStarted(clients,'during-prune'),'comparison calls started');
    let continuousBaseline;let continuousPrepared;
    try{
      continuousBaseline=observePruneScanPair({repositoryRoot:fixture.root,
        procRoot:fixture.procRoot,method:'baseline'});
      continuousPrepared=observePruneScanPair({repositoryRoot:fixture.root,
        procRoot:fixture.procRoot,method:'prepared'});
    }finally{stopRound(clients,'during-prune');}
    await waitFor(()=>roundReady(clients,'during-prune'),'comparison calls complete');
    const continuousSamples=readRound(clients,'during-prune');
    const continuousSummary=verifyCalls(continuousSamples);
    verifyResult(continuousBaseline,'baseline');
    verifyResult(continuousPrepared,'prepared');
    const overlap={
      baseline:continuousBaseline.scans.map(scan=>normalOverlapCount(continuousSamples,scan)),
      prepared:continuousPrepared.scans.map(scan=>normalOverlapCount(continuousSamples,scan)),
    };
    requestRound(clients,'after-prune');
    await waitFor(()=>roundReady(clients,'after-prune'),'post-comparison calls');
    const afterSummary=verifyCalls(readRound(clients,'after-prune'));
    const afterNames=pruneObjectNames(fixture.root);
    const afterRoots=[...sessionEvidence(fixture,clientsA,pairA),
      ...sessionEvidence(fixture,[clientB],pairB),
      ...sessionEvidence(fixture,[clientAfterRollback],pairA)];
    assert.deepEqual(afterNames,beforeNames);
    assert.deepEqual(afterRoots,beforeRoots);
    assert.deepEqual(lockEvidence(),locksBefore);
    assert.equal(fs.existsSync(path.join(runtime,'.prune.v1')),false);
    diagnostic={label:'prune-scan-comparison',order,
      plan:{bootstrapGenerations:1,previous:0,journals:0,exactThirdOnly:true},
      roots:{before:beforeRoots.length,after:afterRoots.length,A:4,B:1},
      results:{idleBaseline,idlePrepared,continuousBaseline,continuousPrepared},
      calls:{before:beforeSummary,continuous:continuousSummary,after:afterSummary},
      continuousNormalOverlap:overlap,
      instrumentation:Object.fromEntries(Object.entries({
        idleBaseline:idleBaseline.instrumentation,idlePrepared:idlePrepared.instrumentation,
        continuousBaseline:continuousBaseline.instrumentation,
        continuousPrepared:continuousPrepared.instrumentation,
      }).filter(([,value])=>value!==undefined)),
      unchanged:{pointer:true,activations:true,journals:true,releases:true,bootstraps:true,
        catalog:true,roots:true,deployAdmissionPublicationLocks:true,pruneRecoveryMarkerAbsent:true}};
    t.diagnostic(JSON.stringify(diagnostic));
  }finally{await stopClients(clients);}
  assert.ok(diagnostic,'prune scan comparison evidence was not completed');
  assert.deepEqual(inspectSessionBindingsV2({repositoryRoot:fixture.root}),[]);
});

test('v2 observation records three inventory stages without publishing a candidate', async t => {
  const fixture = await createRuntimeFixture(t, {realDependencies: true});
  const clients = [];
  let observation;
  try {
    const releaseA = await fixture.prepare();
    const activated = await runDeployment({
      repositoryRoot: fixture.root,
      home: fixture.home,
      procRoot: fixture.procRoot,
      environment: fixture.environment,
      argv: ['--activate', releaseA.releaseId],
      phaseRunner: wiringPhase,
    });
    assert.equal(activated.releaseId, releaseA.releaseId);
    const currentA = readActivation({repositoryRoot: fixture.root});
    assert.equal(currentA.version, 2);
    const pairA = {
      releaseId: currentA.releaseId,
      bootstrapId: currentA.bootstrapId,
      runtimeContract: currentA.runtimeContract,
      compatibilityDigest: currentA.compatibilityDigest,
    };
    const guardFixture = configureGuard(fixture);
    const guardEnvironment = clientEnvironment(fixture, guardFixture.coordinates);
    for (const number of [0, 1, 2]) {
      clients.push(await startBoundClient(fixture, guardEnvironment, guardFixture.clients[number], pairA, number));
    }
    const rootsA = sessionEvidence(fixture, clients, pairA);
    const expectations = new Map(rootsA.map(root => [root.payloadPid, {pair: pairA, root}]));
    const startup = clients.map(client => client.startup);
    assertSamples(startup, expectations, {includePid: false});

    const helper = path.join(fixture.root, 'scripts/runtime-entry.mjs');
    fixture.write('scripts/runtime-entry.mjs', fs.readFileSync(helper, 'utf8')
      + '\n// runtime-v2-observation candidate B\n');
    checkedGit(fixture.root, 'add', 'scripts/runtime-entry.mjs');
    checkedGit(fixture.root, '-c', 'user.name=Runtime observation', '-c',
      'user.email=runtime-observation@example.invalid', 'commit', '-m', 'fixture observation candidate B');
    const releaseB = await fixture.prepare();
    assert.notEqual(releaseB.releaseId, releaseA.releaseId);

    const activationBefore = readActivation({repositoryRoot: fixture.root});
    const pointerBefore = currentIdentity(fixture.root);
    const journalsBefore = journalNames(fixture.root);
    const activationsBefore = activationNames(fixture.root);
    requestRound(clients, 'during-observation');
    await waitFor(() => roundStarted(clients, 'during-observation'), 'observation samples started');
    const windows = new Map();
    const observe = event => {
      assert.ok(['preliminary', 'post_probe', 'publication'].includes(event.stage));
      assert.ok(['inventory_start', 'inventory_complete'].includes(event.phase));
      const expectedExclusive = event.stage === 'publication';
      assert.equal(event.exclusive, expectedExclusive);
      const window = windows.get(event.stage) ?? {startedNs: null, finishedNs: null, exclusive: event.exclusive};
      if (event.phase === 'inventory_start') {
        assert.equal(window.startedNs, null);
        window.startedNs = process.hrtime.bigint();
      } else {
        assert.notEqual(window.startedNs, null);
        assert.equal(window.finishedNs, null);
        window.finishedNs = process.hrtime.bigint();
      }
      windows.set(event.stage, window);
    };
    let result;
    let productErrorCode = null;
    try {
      result = await observeCompatiblePairDeployment({
        repositoryRoot: fixture.root,
        home: fixture.home,
        procRoot: fixture.procRoot,
        environment: fixture.environment,
        releaseId: releaseB.releaseId,
        phaseRunner: wiringPhase,
        observe,
      });
    } catch (error) {
      if (typeof error.code !== 'string' || !/^DEPLOY_[A-Z_]{1,55}$/u.test(error.code)) throw error;
      productErrorCode = error.code;
      const recorded = error.observations ?? {stages: [], reached: []};
      const failed = recorded.failed ? [{inventory: null, observation: recorded.failed}] : [];
      const stages = [...recorded.stages, ...failed];
      const reached = stages.map(stage => stage.observation.stage);
      result = {
        code: 'DEPLOY_PAIR_OBSERVED',
        stages,
        reached,
        missed: ['preliminary', 'post_probe', 'publication'].filter(stage => !reached.includes(stage)),
        probes: recorded.probes ?? {current: false, candidate: false},
      };
    } finally {
      stopRound(clients, 'during-observation');
    }
    await waitFor(() => roundReady(clients, 'during-observation'), 'observation samples complete');
    const samples = readRound(clients, 'during-observation');
    assert.ok(samples.length >= clients.length, 'observation sampling must not be empty');
    const sampleSummary = boundedSampleSummary(samples);
    const currentUnchanged = JSON.stringify(readActivation({repositoryRoot: fixture.root}))
      === JSON.stringify(activationBefore);
    const pointerUnchanged = JSON.stringify(currentIdentity(fixture.root)) === JSON.stringify(pointerBefore);
    const journalsUnchanged = JSON.stringify(journalNames(fixture.root)) === JSON.stringify(journalsBefore);
    const activationsUnchanged = JSON.stringify(activationNames(fixture.root)) === JSON.stringify(activationsBefore);
    const intervals = selectorIntervals(samples);
    const stageOverlapCounts = Object.fromEntries(result.reached.map(stage => {
      const window = windows.get(stage);
      assert.ok(window && typeof window.startedNs === 'bigint' && typeof window.finishedNs === 'bigint');
      return [stage, intervals.filter(call =>
        call.startedNs < window.finishedNs && call.finishedNs > window.startedNs).length];
    }));
    observation = {
      label: 'observation-result',
      stages: result.stages,
      reached: result.reached,
      missed: result.missed,
      productErrorCode,
      candidatePrepared: true,
      probes: result.probes,
      currentUnchanged,
      activationPointerUnchanged: pointerUnchanged,
      journalNamesUnchanged: journalsUnchanged,
      activationNamesUnchanged: activationsUnchanged,
      publicationStageReached: result.reached.includes('publication'),
      publicationExclusive: windows.get('publication')?.exclusive ?? null,
      stageOverlapCounts,
      rootCount: rootsA.length,
      ...sampleSummary,
    };
    t.diagnostic(JSON.stringify(observation));
    assertSamples(samples, expectations, {includePid: false});
    assert.equal(result.code, 'DEPLOY_PAIR_OBSERVED');
    assert.deepEqual(result.reached, result.stages.map(stage => stage.observation.stage));
    assert.deepEqual([...result.reached, ...result.missed], ['preliminary', 'post_probe', 'publication']);
    assert.equal(currentUnchanged, true);
    assert.equal(pointerUnchanged, true);
    assert.equal(journalsUnchanged, true);
    assert.equal(activationsUnchanged, true);
    if (result.reached.includes('post_probe')) assert.deepEqual(result.probes, {current: true, candidate: true});
    if (result.reached.includes('publication')) assert.equal(windows.get('publication')?.exclusive, true);
    for (const stage of result.reached) assert.ok(stageOverlapCounts[stage] > 0, stage + ' missed continuous load');
    sessionEvidence(fixture, clients, pairA);
    assert.equal(sampleSummary.processFailureCount, 0);
    assert.equal(sampleSummary.responseFailureCount, 0);
    assert.equal(sampleSummary.terminalHookFailureCount, 0);
    assert.equal(sampleSummary.timingViolationCount, 0);
  } finally {
    await stopClients(clients);
  }
  assert.ok(observation, 'observation evidence was not completed');
  assert.deepEqual(inspectSessionBindingsV2({repositoryRoot: fixture.root}), []);
});

test('v2 real dependencies keep bound sessions and claim-free hook conformance through transitions', async t => {
  const fixture = await createRuntimeFixture(t, {realDependencies: true});
  const environment = fixture.environment;
  const clients = [];
  const allSamples = [];
  const stages = {
    activate: transitionStage('activate'),
    rollback: transitionStage('rollback'),
    prune: transitionStage('prune'),
  };
  const transitionResult = {
    label: 'transition-result',
    stages: Object.values(stages),
    rounds: [],
    roots: {
      aStartup: 0, aAfterActivate: 0, bAfterActivate: 0,
      aDuringRollback: 0, bDuringRollback: 0, aAfterRollback: 0,
      aAfterPrune: 0, bAfterPrune: 0,
    },
    candidateHelperDifferent: false,
    oldGenerationLeaseProtectionConfirmed: false,
    generationPrune: null,
    stop: null,
    harness: {status: 'complete', stage: null, category: null},
    summary: null,
  };
  const recordRound = (name, samples) => {
    allSamples.push(...samples);
    const summary = transitionSampleSummary(samples);
    transitionResult.rounds.push({name, ...summary});
    return summary;
  };
  let activeStage = 'setup';
  let failure;
  let commandFailure;
  let acceptance;
  try {
    const releaseA = await fixture.prepare();
    const activated = await runDeployment({
      repositoryRoot: fixture.root,
      home: fixture.home,
      procRoot: fixture.procRoot,
      environment,
      argv: ['--activate', releaseA.releaseId],
      phaseRunner: wiringPhase,
    });
    assert.equal(activated.releaseId, releaseA.releaseId);
    const currentA = readActivation({repositoryRoot: fixture.root});
    assert.equal(currentA.version, 2);
    const pairA = {
      releaseId: currentA.releaseId,
      bootstrapId: currentA.bootstrapId,
      runtimeContract: currentA.runtimeContract,
      compatibilityDigest: currentA.compatibilityDigest,
    };
    const guardFixture = configureGuard(fixture);
    const guardEnvironment = clientEnvironment(fixture, guardFixture.coordinates);

    for (const number of [0, 1, 2]) {
      clients.push(await startBoundClient(fixture, guardEnvironment, guardFixture.clients[number], pairA, number));
    }
    const clientsA = [...clients];
    const rootsA = sessionEvidence(fixture, clientsA, pairA);
    transitionResult.roots.aStartup = rootsA.length;
    const expectations = new Map(rootsA.map(root => [root.payloadPid, {pair: pairA, root}]));
    const startupA = clientsA.map(client => client.startup);
    recordRound('generation-a-startup', startupA);
    diagnoseSamples(t, 'generation-a-startup', startupA);
    assertSamples(startupA, expectations);
    assert.equal(new Set(rootsA.map(row => row.bindingDev + ':' + row.bindingIno)).size, clientsA.length);
    t.diagnostic(JSON.stringify({label: 'generation-a-bindings', pair: pairA, roots: diagnosticRoots(rootsA)}));

    const helper = path.join(fixture.root, 'scripts/runtime-entry.mjs');
    fixture.write('scripts/runtime-entry.mjs', fs.readFileSync(helper, 'utf8')
      + '\n// runtime-v2-integration generation B\n');
    checkedGit(fixture.root, 'add', 'scripts/runtime-entry.mjs');
    checkedGit(fixture.root, '-c', 'user.name=Runtime integration', '-c',
      'user.email=runtime-integration@example.invalid', 'commit', '-m', 'fixture generation B');
    const releaseB = await fixture.prepare();
    assert.notEqual(releaseB.releaseId, releaseA.releaseId);
    assert.notEqual(
      fs.readFileSync(path.join(fixture.root, '.jhw-runtime/releases', releaseA.releaseId,
        'scripts/runtime-entry.mjs'), 'utf8'),
      fs.readFileSync(path.join(fixture.root, '.jhw-runtime/releases', releaseB.releaseId,
        'scripts/runtime-entry.mjs'), 'utf8'));
    transitionResult.candidateHelperDifferent = true;

    activeStage = 'activate';
    stages.activate.status = 'reached';
    stages.activate.acceptance = 'pending';
    const activateBefore = boundedPointer(fixture.root, {A: pairA});
    const activateJournalsBefore = journalNames(fixture.root);
    requestRound(clientsA, 'during-activate');
    await waitFor(() => roundStarted(clientsA, 'during-activate'), 'activation samples started');
    const activatePhase = publicationPhase();
    let promoted;
    let activateError;
    let activateRoundError;
    try {
      promoted = await runDeployment({
        repositoryRoot: fixture.root,
        home: fixture.home,
        procRoot: fixture.procRoot,
        environment,
        argv: ['--activate-compatible', releaseB.releaseId],
        phaseRunner: activatePhase,
      });
    } catch (error) {
      activateError = error;
    } finally {
      try { stopRound(clientsA, 'during-activate'); } catch (error) { activateRoundError = error; }
    }
    const activateObserved = activatePhase.observed();
    stages.activate.command = boundedCommand(promoted, activateError);
    const activateAfter = boundedPointer(fixture.root, {A: pairA, B: {releaseId: releaseB.releaseId}});
    stages.activate.pointer = pointerTransition(activateBefore, activateAfter);
    stages.activate.command = boundedCommand(promoted, activateError, {
      pointer: stages.activate.pointer,
      pointerIntent: activateObserved.pointerIntent,
      pointerRenamed: activateObserved.pointerRenamed,
    });
    stages.activate.status = stages.activate.command.status;
    stages.activate.journal = boundedJournalEvidence(fixture.root, activateJournalsBefore);
    stages.activate.probes = {
      started: activateObserved.probeStarted,
      completed: activateObserved.probeCompleted,
    };
    stages.activate.publicationAcquired = activateObserved.publicationAcquired;
    stages.activate.pointerIntent = activateObserved.pointerIntent;
    stages.activate.pointerRenamed = activateObserved.pointerRenamed;
    if (activateRoundError) throw activateRoundError;
    await waitFor(() => roundReady(clientsA, 'during-activate'), 'activation samples complete');
    const duringActivate = readRound(clientsA, 'during-activate');
    stages.activate.samples = recordRound('during-activate', duringActivate);
    assert.ok(duringActivate.length >= clientsA.length, 'activation sampling must not be empty');
    diagnoseSamples(t, 'during-activation', duringActivate);
    const activationWindow = activatePhase.window();
    stages.activate.overlapCount = boundedOverlap(duringActivate, activationWindow);
    if (stages.activate.overlapCount) diagnoseWindow(t, 'activation-publication', duringActivate, activationWindow,
      overlapsForWindow(duringActivate, activationWindow));
    assertSamples(duringActivate, expectations);
    if (stages.activate.overlapCount) stages.activate.validatedOverlapCount =
      assertPublicationOverlap(duringActivate, activationWindow, 'activation publication').length;
    stages.activate.sampleEvidence = 'confirmed';
    if (activateError) {
      stages.activate.acceptance = stages.activate.command.status;
      commandFailure = activateError;
      throw activateError;
    }
    assert.notEqual(stages.activate.overlapCount, null, 'activation publication window missing');
    assert.ok(stages.activate.validatedOverlapCount > 0, 'activation publication missed validated calls');
    assert.equal(promoted.code, 'DEPLOY_COMPATIBLE_ACTIVATED');

    const currentB = readActivation({repositoryRoot: fixture.root});
    const pairB = {
      releaseId: currentB.releaseId,
      bootstrapId: currentB.bootstrapId,
      runtimeContract: currentB.runtimeContract,
      compatibilityDigest: currentB.compatibilityDigest,
    };
    assert.equal(pairB.releaseId, releaseB.releaseId);
    assert.notEqual(pairB.bootstrapId, pairA.bootstrapId);
    assert.equal(boundedPointer(fixture.root, {A: pairA, B: pairB}).label, 'B');
    stages.activate.pointer.after = 'B';
    assert.equal(stages.activate.pointer.before, 'A');
    assert.equal(stages.activate.pointer.after, 'B');
    assert.equal(stages.activate.pointer.unchanged, false);
    requestRound(clientsA, 'after-activate');
    await waitFor(() => roundReady(clientsA, 'after-activate'), 'post-activation samples');
    const afterActivate = readRound(clientsA, 'after-activate');
    recordRound('after-activate', afterActivate);
    diagnoseSamples(t, 'after-activation', afterActivate);
    assertSamples(afterActivate, expectations);
    transitionResult.roots.aAfterActivate = sessionEvidence(fixture, clientsA, pairA).length;

    const clientB = await startBoundClient(fixture, guardEnvironment, guardFixture.clients[3], pairB, 3);
    clients.push(clientB);
    const rootsB = sessionEvidence(fixture, [clientB], pairB);
    transitionResult.roots.bAfterActivate = rootsB.length;
    expectations.set(rootsB[0].payloadPid, {pair: pairB, root: rootsB[0]});
    recordRound('generation-b-startup', [clientB.startup]);
    diagnoseSamples(t, 'generation-b-startup', [clientB.startup]);
    assertSamples([clientB.startup], expectations);
    stages.activate.acceptance = 'accepted';
    t.diagnostic(JSON.stringify({label: 'generation-b-bindings', pair: pairB, roots: diagnosticRoots(rootsB)}));

    activeStage = 'rollback';
    stages.rollback.status = 'reached';
    stages.rollback.acceptance = 'pending';
    const rollbackBefore = boundedPointer(fixture.root, {A: pairA, B: pairB});
    const rollbackJournalsBefore = journalNames(fixture.root);
    requestRound(clients, 'during-rollback');
    await waitFor(() => roundStarted(clients, 'during-rollback'), 'rollback samples started');
    const rollbackPhase = publicationPhase();
    let rolledBack;
    let rollbackError;
    let rollbackRoundError;
    try {
      rolledBack = await runDeployment({
        repositoryRoot: fixture.root,
        home: fixture.home,
        procRoot: fixture.procRoot,
        environment,
        argv: ['--rollback'],
        phaseRunner: rollbackPhase,
      });
    } catch (error) {
      rollbackError = error;
    } finally {
      try { stopRound(clients, 'during-rollback'); } catch (error) { rollbackRoundError = error; }
    }
    const rollbackObserved = rollbackPhase.observed();
    stages.rollback.command = boundedCommand(rolledBack, rollbackError);
    const rollbackAfter = boundedPointer(fixture.root, {A: pairA, B: pairB});
    stages.rollback.pointer = pointerTransition(rollbackBefore, rollbackAfter);
    stages.rollback.command = boundedCommand(rolledBack, rollbackError, {
      pointer: stages.rollback.pointer,
      pointerIntent: rollbackObserved.pointerIntent,
      pointerRenamed: rollbackObserved.pointerRenamed,
    });
    stages.rollback.status = stages.rollback.command.status;
    stages.rollback.journal = boundedJournalEvidence(fixture.root, rollbackJournalsBefore);
    stages.rollback.probes = {
      started: rollbackObserved.probeStarted,
      completed: rollbackObserved.probeCompleted,
    };
    stages.rollback.publicationAcquired = rollbackObserved.publicationAcquired;
    stages.rollback.pointerIntent = rollbackObserved.pointerIntent;
    stages.rollback.pointerRenamed = rollbackObserved.pointerRenamed;
    if (rollbackRoundError) throw rollbackRoundError;
    await waitFor(() => roundReady(clients, 'during-rollback'), 'rollback samples complete');
    const duringRollback = readRound(clients, 'during-rollback');
    stages.rollback.samples = recordRound('during-rollback', duringRollback);
    assert.ok(duringRollback.length >= clients.length, 'rollback sampling must not be empty');
    diagnoseSamples(t, 'during-rollback', duringRollback);
    const rollbackWindow = rollbackPhase.window();
    stages.rollback.overlapCount = boundedOverlap(duringRollback, rollbackWindow);
    if (stages.rollback.overlapCount) diagnoseWindow(t, 'rollback-publication', duringRollback, rollbackWindow,
      overlapsForWindow(duringRollback, rollbackWindow));
    assertSamples(duringRollback, expectations);
    if (stages.rollback.overlapCount) stages.rollback.validatedOverlapCount =
      assertPublicationOverlap(duringRollback, rollbackWindow, 'rollback publication').length;
    stages.rollback.sampleEvidence = 'confirmed';
    if (rollbackError) {
      stages.rollback.acceptance = stages.rollback.command.status;
      commandFailure = rollbackError;
      throw rollbackError;
    }
    assert.notEqual(stages.rollback.overlapCount, null, 'rollback publication window missing');
    assert.ok(stages.rollback.validatedOverlapCount > 0, 'rollback publication missed validated calls');
    assert.equal(rolledBack.code, 'DEPLOY_ROLLED_BACK');
    assert.equal(rolledBack.releaseId, pairA.releaseId);
    assert.equal(stages.rollback.pointer.before, 'B');
    assert.equal(stages.rollback.pointer.after, 'A');
    assert.equal(stages.rollback.pointer.unchanged, false);
    transitionResult.roots.aDuringRollback = sessionEvidence(fixture, clientsA, pairA).length;
    transitionResult.roots.bDuringRollback = sessionEvidence(fixture, [clientB], pairB).length;
    const currentAfterRollback = readActivation({repositoryRoot: fixture.root});
    assert.deepEqual({
      releaseId: currentAfterRollback.releaseId,
      bootstrapId: currentAfterRollback.bootstrapId,
      runtimeContract: currentAfterRollback.runtimeContract,
      compatibilityDigest: currentAfterRollback.compatibilityDigest,
    }, pairA);
    const clientAfterRollback = await startBoundClient(fixture, guardEnvironment, guardFixture.clients[4], pairA, 4);
    clients.push(clientAfterRollback);
    const rollbackRoots = sessionEvidence(fixture, [clientAfterRollback], pairA);
    expectations.set(rollbackRoots[0].payloadPid, {pair: pairA, root: rollbackRoots[0]});
    recordRound('rollback-new-session', [clientAfterRollback.startup]);
    diagnoseSamples(t, 'rollback-new-session', [clientAfterRollback.startup]);
    assertSamples([clientAfterRollback.startup], expectations);
    transitionResult.roots.aAfterRollback = rollbackRoots.length;
    stages.rollback.acceptance = 'accepted';
    t.diagnostic(JSON.stringify({label: 'rollback-new-binding', pair: pairA,
      roots: diagnosticRoots(rollbackRoots)}));

    activeStage = 'prune';
    stages.prune.status = 'reached';
    stages.prune.acceptance = 'pending';
    transitionResult.generationPrune = {setup: 'pending'};
    let generationC;
    try {
      generationC = await prepareAgedThirdGeneration(fixture, {
        pairA,
        pairB,
        marker: 'runtime-v2-transition generation C',
      });
      transitionResult.generationPrune.setup = 'complete';
    } catch (error) {
      transitionResult.generationPrune.setup = 'failed';
      throw error;
    }
    const {releaseC, pairC, thirdDirectory} = generationC;
    assert.notEqual(pairC.bootstrapId, pairA.bootstrapId);
    assert.notEqual(pairC.bootstrapId, pairB.bootstrapId);
    const pruneNamesBefore = pruneObjectNames(fixture.root);
    const pruneObjectsBefore = {
      A: generationObjectEvidence(fixture.root, pairA),
      B: generationObjectEvidence(fixture.root, pairB),
      C: generationObjectEvidence(fixture.root, pairC),
    };
    const pruneRootsBefore = [
      ...sessionEvidence(fixture, clientsA, pairA),
      ...sessionEvidence(fixture, [clientB], pairB),
      ...sessionEvidence(fixture, [clientAfterRollback], pairA),
    ];
    assert.equal(pruneRootsBefore.length, 5);

    stages.prune.journal = {status: 'not_applicable', count: 0, states: []};
    const pruneBefore = boundedPointer(fixture.root, {A: pairA, B: pairB});
    requestRound(clients, 'during-prune');
    await waitFor(() => roundStarted(clients, 'during-prune'), 'prune samples started');
    const pruneStartedNs = process.hrtime.bigint();
    const originalRenameSync = fs.renameSync;
    const originalRmdirSync = fs.rmdirSync;
    let captureStartedNs = null;
    let captureFinishedNs = null;
    let capturedDirectory = null;
    let capturedIdentity = null;
    fs.renameSync = function(sourcePath, destinationPath) {
      const isThirdCapture = path.basename(String(sourcePath)) === pairC.bootstrapId
        && /^capture\.\d{8}$/.test(path.basename(String(destinationPath)));
      if (isThirdCapture) captureStartedNs = process.hrtime.bigint();
      const result = originalRenameSync.apply(this, arguments);
      if (isThirdCapture) {
        capturedDirectory = String(destinationPath);
        capturedIdentity = directoryAndLeaseEvidence(capturedDirectory);
      }
      return result;
    };
    fs.rmdirSync = function(directoryPath) {
      const isThirdCapture = capturedDirectory !== null && String(directoryPath) === capturedDirectory;
      const result = originalRmdirSync.apply(this, arguments);
      if (isThirdCapture) captureFinishedNs = process.hrtime.bigint();
      return result;
    };
    let pruned;
    let pruneError;
    let pruneRoundError;
    try {
      pruned = await runDeployment({
        repositoryRoot: fixture.root,
        home: fixture.home,
        procRoot: fixture.procRoot,
        environment,
        argv: ['--prune', '--apply'],
      });
    } catch (error) {
      pruneError = error;
    } finally {
      fs.renameSync = originalRenameSync;
      fs.rmdirSync = originalRmdirSync;
      try { stopRound(clients, 'during-prune'); } catch (error) { pruneRoundError = error; }
    }
    const pruneFinishedNs = process.hrtime.bigint();
    stages.prune.command = boundedCommand(pruned, pruneError);
    const pruneAfter = boundedPointer(fixture.root, {A: pairA, B: pairB});
    stages.prune.pointer = pointerTransition(pruneBefore, pruneAfter);
    stages.prune.command = boundedCommand(pruned, pruneError, {
      operation: 'prune', pointer: stages.prune.pointer,
    });
    stages.prune.status = stages.prune.command.status;
    if (pruneRoundError) throw pruneRoundError;
    await waitFor(() => roundReady(clients, 'during-prune'), 'prune samples complete');
    const duringPrune = readRound(clients, 'during-prune');
    stages.prune.samples = recordRound('during-prune', duringPrune);
    assert.ok(duringPrune.length >= clients.length, 'prune sampling must not be empty');
    diagnoseSamples(t, 'during-prune', duringPrune);
    const pruneWindow = {startedNs: pruneStartedNs, finishedNs: pruneFinishedNs};
    const captureWindow = {startedNs: captureStartedNs, finishedNs: captureFinishedNs};
    stages.prune.overlapCount = boundedOverlap(duringPrune, pruneWindow);
    diagnoseWindow(t, 'prune-execution', duringPrune, pruneWindow,
      overlapsForWindow(duringPrune, pruneWindow));
    const captureOverlapCount = boundedOverlap(duringPrune, captureWindow);
    const pruneNamesAfter = pruneObjectNames(fixture.root);
    const pruneRootsAfter = [
      ...sessionEvidence(fixture, clientsA, pairA),
      ...sessionEvidence(fixture, [clientB], pairB),
      ...sessionEvidence(fixture, [clientAfterRollback], pairA),
    ];
    const pruneObjectsAfter = {
      A: generationObjectEvidence(fixture.root, pairA),
      B: generationObjectEvidence(fixture.root, pairB),
    };
    const cPresentAfter = fs.existsSync(thirdDirectory);
    transitionResult.generationPrune = {
      setup: transitionResult.generationPrune.setup,
      fixtureAgeDays: 40,
      applyPlan: pruned ? {
        bootstrapGenerations: pruned.candidates.bootstrapGenerations.length,
        previous: pruned.candidates.previous.length,
        journals: pruned.candidates.journals.length,
        exactThirdOnly: pruned.candidates.bootstrapGenerations.length === 1
          && pruned.candidates.bootstrapGenerations[0] === pairC.bootstrapId
          && pruned.candidates.previous.length === 0 && pruned.candidates.journals.length === 0,
      } : null,
      removed: pruned ? {
        bootstrapGenerations: pruned.removed.bootstrapGenerations,
        previous: pruned.removed.previous,
        journals: pruned.removed.journals,
      } : null,
      capture: {
        observed: captureStartedNs !== null && captureFinishedNs !== null,
        overlapCount: captureOverlapCount,
        validatedOverlapCount: null,
      },
      generations: {
        before: {A: true, B: true, C: true},
        after: {
          A: pruneNamesAfter.bootstraps.includes(pairA.bootstrapId),
          B: pruneNamesAfter.bootstraps.includes(pairB.bootstrapId),
          C: cPresentAfter,
        },
      },
      identities: {
        cDirectoryAndLeaseCaptured: capturedIdentity !== null
          && JSON.stringify(capturedIdentity) === JSON.stringify(pruneObjectsBefore.C),
        aDirectoryAndLeasePreserved:
          JSON.stringify(pruneObjectsBefore.A) === JSON.stringify(pruneObjectsAfter.A),
        bDirectoryAndLeasePreserved:
          JSON.stringify(pruneObjectsBefore.B) === JSON.stringify(pruneObjectsAfter.B),
        fiveRootPairAndLeaseProofPreserved:
          JSON.stringify(pruneRootsBefore) === JSON.stringify(pruneRootsAfter),
        onlyThirdBootstrapRemoved: JSON.stringify(pruneNamesAfter.bootstraps)
          === JSON.stringify(pruneNamesBefore.bootstraps.filter(name => name !== pairC.bootstrapId)),
      },
      retained: {
        cRelease: pruneNamesAfter.releases.includes(releaseC.releaseId),
        cCatalog: pruneNamesAfter.catalog.includes(pairC.bootstrapId + '.json'),
      },
    };
    assertSamples(duringPrune, expectations);
    stages.prune.validatedOverlapCount = assertPublicationOverlap(duringPrune, pruneWindow, 'prune execution').length;
    const captureOverlaps = validatedPublicationOverlaps(duringPrune, captureWindow);
    transitionResult.generationPrune.capture.validatedOverlapCount = captureOverlaps?.length ?? null;
    stages.prune.sampleEvidence = 'confirmed';
    if (pruneError) {
      stages.prune.acceptance = stages.prune.command.status;
      commandFailure = pruneError;
      throw pruneError;
    }
    assert.equal(pruned.code, 'DEPLOY_PRUNED');
    assert.equal(stages.prune.pointer.before, 'A');
    assert.equal(stages.prune.pointer.after, 'A');
    assert.equal(stages.prune.pointer.unchanged, true);
    assert.deepEqual(pruned.candidates.bootstrapGenerations, [pairC.bootstrapId]);
    assert.deepEqual(pruned.candidates.previous, []);
    assert.deepEqual(pruned.candidates.journals, []);
    assert.deepEqual(pruned.removed, {journals: 0, previous: 0, bootstrapGenerations: 1});
    assert.equal(transitionResult.generationPrune.applyPlan.exactThirdOnly, true);
    assert.deepEqual(transitionResult.generationPrune.removed,
      {bootstrapGenerations: 1, previous: 0, journals: 0});
    assert.equal(transitionResult.generationPrune.capture.observed, true);
    assert.ok(transitionResult.generationPrune.capture.validatedOverlapCount > 0,
      'generation C capture missed validated calls');
    assert.equal(cPresentAfter, false);
    assert.deepEqual(pruneObjectsAfter.A, pruneObjectsBefore.A);
    assert.deepEqual(pruneObjectsAfter.B, pruneObjectsBefore.B);
    assert.equal(transitionResult.generationPrune.identities.cDirectoryAndLeaseCaptured, true);
    assert.equal(transitionResult.generationPrune.identities.fiveRootPairAndLeaseProofPreserved, true);
    assert.equal(transitionResult.generationPrune.identities.onlyThirdBootstrapRemoved, true);
    assert.deepEqual(transitionResult.generationPrune.retained, {cRelease: true, cCatalog: true});

    requestRound(clients, 'after-prune');
    await waitFor(() => roundReady(clients, 'after-prune'), 'post-prune samples');
    const afterPrune = readRound(clients, 'after-prune');
    recordRound('after-prune', afterPrune);
    diagnoseSamples(t, 'after-prune', afterPrune);
    assertSamples(afterPrune, expectations);
    transitionResult.roots.aAfterPrune = sessionEvidence(fixture, clientsA, pairA).length;
    transitionResult.roots.bAfterPrune = sessionEvidence(fixture, [clientB], pairB).length;
    transitionResult.oldGenerationLeaseProtectionConfirmed = true;
    stages.prune.acceptance = 'accepted';
    t.diagnostic(JSON.stringify({label: 'guard-evidence', ...assertGuardEvidence(fixture, clients, allSamples)}));
    const timingViolations = allSamples.flatMap(sample => sample.hooks
      .filter(hook => hook.elapsedMs >= (hook.event === 'SessionEnd' ? 3_000 : 12_000))
      .map(hook => ({round: sample.round, pid: sample.pid, event: hook.event,
        elapsedMs: hook.elapsedMs, budgetMs: hook.event === 'SessionEnd' ? 3_000 : 12_000})));
    const postTool = allSamples.flatMap(sample => sample.hooks.filter(hook => hook.event === 'PostToolUse'));
    const positivePostToolCount = postTool.filter(hook => hook.normal && !hook.denied).length;
    const expectedDenyCount = postTool.filter(hook => hook.expectedDeny).length;
    t.diagnostic(JSON.stringify({label: 'automatic-conformance', sampleCount: allSamples.length,
      timingViolationCount: timingViolations.length, timingViolations,
      positivePostToolCount, expectedDenyCount,
      interactiveEvidence: 'required-for-positive-post-tool'}));
    acceptance = {timingViolations, positivePostToolCount, expectedDenyCount,
      expectedPostToolCount: allSamples.length};
  } catch (error) {
    failure = error;
    if (isDeploymentRefusal(error) && error === commandFailure) {
      transitionResult.stop = {
        kind: stages[activeStage]?.command.status,
        stage: activeStage,
        code: error.code,
      };
    } else {
      if (stages[activeStage]?.acceptance === 'pending') stages[activeStage].acceptance = 'harness_failed';
      transitionResult.harness = {
        status: 'failed',
        stage: activeStage,
        category: error instanceof assert.AssertionError ? 'assertion' : 'runtime',
      };
    }
  }
  try {
    await stopClients(clients);
  } catch (error) {
    transitionResult.harness = {status: 'failed', stage: 'cleanup', category: 'runtime'};
    failure ??= error;
  }
  if (!failure) {
    activeStage = 'final';
    try {
      assert.deepEqual(inspectSessionBindingsV2({repositoryRoot: fixture.root}), []);
      assert.ok(acceptance, 'acceptance evidence was not completed');
      assert.equal(acceptance.timingViolations.length, 0, 'hook timing acceptance failed');
      assert.equal(acceptance.positivePostToolCount, 0,
        'claim-free Read must not impersonate an approved PostToolUse completion');
      assert.equal(acceptance.expectedDenyCount, acceptance.expectedPostToolCount,
        'claim-free Read PostToolUse must remain explicit negative coverage');
    } catch (error) {
      transitionResult.harness = {
        status: 'failed', stage: activeStage,
        category: error instanceof assert.AssertionError ? 'assertion' : 'runtime',
      };
      failure = error;
    }
  }
  transitionResult.summary = transitionSampleSummary(allSamples);
  t.diagnostic(JSON.stringify(transitionResult));
  if (failure) throw failure;
});
