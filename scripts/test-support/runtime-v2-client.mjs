import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

import {inspectSessionBindingsV2} from '../runtime-store.mjs';

const [entry, evidenceDirectory, repositoryRoot, sessionId, claimWorktree, expectedBootstrapId,
  sampleOffsetValue = '0'] = process.argv.slice(2);
if (!entry || !evidenceDirectory || !repositoryRoot || !sessionId || !claimWorktree || !expectedBootstrapId) {
  throw new Error('integration client arguments are required');
}
if (!/^b-[a-f0-9]{64}$/u.test(expectedBootstrapId)) throw new Error('integration bootstrap id is invalid');
const sampleOffsetMs = Number(sampleOffsetValue);
if (!Number.isInteger(sampleOffsetMs) || sampleOffsetMs < 0 || sampleOffsetMs > 2_000) {
  throw new Error('integration client sample offset is invalid');
}
const sleepArray = new Int32Array(new SharedArrayBuffer(4));

const events = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd'];
const rounds = ['during-observation', 'during-activate', 'after-activate', 'during-rollback',
  'before-prune', 'during-prune', 'after-prune'];
const continuousRounds = new Set(['during-observation', 'during-activate', 'during-rollback', 'during-prune']);

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const manifestReadFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

function sameStableFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readPublishedManifest(file) {
  let fd;
  try {
    fd = fs.openSync(file, manifestReadFlags);
    const before = fs.fstatSync(fd, {bigint: true});
    const currentUid = BigInt(process.getuid());
    if (!before.isFile() || before.uid !== currentUid || before.nlink !== 1n
      || before.size < 1n || before.size > 16n * 1024n) return null;
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) return null;
      offset += count;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) return null;
    const after = fs.fstatSync(fd, {bigint: true});
    const named = fs.lstatSync(file, {bigint: true});
    if (!sameStableFile(before, after) || !sameStableFile(before, named)) return null;
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function invocationDescriptors(pid, lease) {
  const descendants = [pid];
  for (let index = 0; index < descendants.length; index += 1) {
    let children = '';
    try { children = fs.readFileSync('/proc/' + descendants[index] + '/task/' + descendants[index] + '/children', 'utf8'); }
    catch {}
    for (const child of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
      if (!descendants.includes(child)) descendants.push(child);
    }
  }
  const executorPid = descendants.find(candidate => {
    try {
      const binding = fs.statSync('/proc/' + candidate + '/fd/6', {bigint: true});
      return String(binding.dev) === lease.dev
        && String(binding.ino) === lease.ino
        && fs.existsSync('/proc/' + candidate + '/fd/7')
        && fs.existsSync('/proc/' + candidate + '/fd/8');
    } catch { return false; }
  });
  if (executorPid === undefined) return null;
  const descriptor = fd => {
    const stat = fs.statSync('/proc/' + executorPid + '/fd/' + fd, {bigint: true});
    return {dev: String(stat.dev), ino: String(stat.ino)};
  };
  return {
    executorPid,
    descriptors: {binding: descriptor(6), generation: descriptor(7), parent: descriptor(8)},
  };
}

function publishedInvocation(pid) {
  const group = path.join(repositoryRoot, '.jhw-runtime/v2/invocations', expectedBootstrapId);
  let names;
  try { names = fs.readdirSync(group); } catch { return null; }
  for (const name of names) {
    if (!/^i-[a-f0-9]{32}$/u.test(name)) continue;
    const manifest = readPublishedManifest(path.join(group, name, 'manifest.json'));
    if (manifest?.owner?.pid === pid && manifest.id === name
      && manifest.bootstrapId === expectedBootstrapId) return manifest;
  }
  return null;
}

async function timedCall(args, input = '') {
  const maximumOutputBytes = 32 * 1024 * 1024;
  const startedNs = process.hrtime.bigint();
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let error = null;
  let invocation = null;
  let liveRow = null;
  function observeInvocation() {
    const published = publishedInvocation(child.pid);
    if (!published) return null;
    const matches = row => row?.id === published.id && row.owner.pid === child.pid
      && row.owner.startTime === published.owner.startTime
      && row.manifest.dev === published.manifest.dev && row.manifest.ino === published.manifest.ino
      && row.lease.dev === published.lease.dev && row.lease.ino === published.lease.ino;
    // A control invocation can end while the full store inventory is being read.
    // The descriptor snapshot and the validated live row must refer to the same publication.
    const early = invocationDescriptors(child.pid, published.lease);
    if (!matches(liveRow)) {
      liveRow = inspectSessionBindingsV2({repositoryRoot})
        .find(row => row.kind === 'invocation' && row.live && matches(row));
    }
    if (!liveRow) return null;
    const proof = early ?? invocationDescriptors(child.pid, liveRow.lease);
    if (!proof) return null;
    const {id, releaseId, bootstrapId, runtimeContract, compatibilityDigest,
      parentBinding, owner, lease, manifest} = liveRow;
    return {id, releaseId, bootstrapId, runtimeContract, compatibilityDigest,
      parentBinding, owner, lease, manifest, ...proof};
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let outputBytes = 0;
  const collect = (stream, chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > maximumOutputBytes) {
      error ??= Object.assign(new Error('selector output exceeded boundary'), {code: 'MAX_BUFFER'});
      child.kill('SIGKILL');
      return;
    }
    if (stream === 'stdout') stdout += chunk;
    else stderr += chunk;
  };
  child.stdout.on('data', chunk => { collect('stdout', chunk); });
  child.stderr.on('data', chunk => { collect('stderr', chunk); });
  child.once('error', value => { error = value; });
  child.stdin.end(input);
  const closed = once(child, 'close');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  while (child.exitCode === null && child.signalCode === null) {
    try {
      if (!invocation) invocation = observeInvocation();
    } catch {}
    await delay(1);
  }
  const [status, signal] = await closed;
  clearTimeout(timeout);
  const finishedNs = process.hrtime.bigint();
  return {
    status,
    signal,
    error: error?.code ?? null,
    stdout,
    stderr,
    childPid: child.pid,
    invocation,
    startedNs: String(startedNs),
    finishedNs: String(finishedNs),
    elapsedMs: Number(finishedNs - startedNs) / 1e6,
  };
}

function parseJsonLines(value) {
  const rows = [];
  let parseError = false;
  for (const line of value.trim().split('\n').filter(Boolean)) {
    try { rows.push(JSON.parse(line)); } catch { parseError = true; }
  }
  return {rows, parseError};
}

function hookInput(event, sampleId) {
  return JSON.stringify({
    session_id: sessionId,
    cwd: claimWorktree,
    hook_event_name: event,
    transcript_path: null,
    ...(event !== 'SessionEnd' ? {
      model: 'fixture-model',
      permission_mode: 'default',
      turn_id: sampleId,
    } : {}),
    ...(event === 'UserPromptSubmit' ? {prompt: 'continue'} : {}),
    ...(event === 'PreToolUse' || event === 'PostToolUse' ? {
      tool_name: 'Read',
      tool_input: {file_path: 'README.md'},
      tool_use_id: 'fixture-read-' + process.pid + '-' + sampleId,
    } : {}),
    ...(event === 'PostToolUse' ? {tool_response: {success: true}} : {}),
    ...(event === 'SessionEnd' ? {reason: 'other'} : {}),
  });
}

async function sample(round, sequence = 0) {
  const sampleId = round + '-' + sequence;
  const startedNs = process.hrtime.bigint();
  fs.writeFileSync(path.join(evidenceDirectory, round + '.started'), String(startedNs), {mode: 0o600});

  const control = await timedCall(['control', '--help']);
  const {rows: controlRows, parseError: controlParseError} = parseJsonLines(control.stdout);
  const controlOk = controlRows.length === 1
    && !controlParseError
    && controlRows[0]?.command === 'help'
    && Array.isArray(controlRows[0]?.result?.commands);

  const mcpInput = [
    {jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {name: 'runtime-v2-integration', version: '1'},
    }},
    {jsonrpc: '2.0', method: 'notifications/initialized'},
    {jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}},
  ].map(JSON.stringify).join('\n') + '\n';
  const mcp = await timedCall(['mcp'], mcpInput);
  const {rows: mcpRows, parseError: mcpParseError} = parseJsonLines(mcp.stdout);
  const initialized = mcpRows.find(row => row.id === 1)?.result;
  const tools = mcpRows.find(row => row.id === 2)?.result?.tools;
  const mcpOk = !mcpParseError
    && !mcpRows.some(row => row.error !== undefined)
    && typeof initialized?.serverInfo?.name === 'string'
    && Array.isArray(tools);

  const hooks = [];
  for (const event of events) {
    const result = await timedCall(['hook', '--adapter', 'codex', '--event', event], hookInput(event, sampleId));
    let output;
    try { output = JSON.parse(result.stdout); } catch {}
    const denied = output?.hookSpecificOutput?.permissionDecision === 'deny'
      || (typeof output?.systemMessage === 'string' && output.systemMessage.startsWith('GUARD_'));
    const expectedDeny = event === 'PostToolUse' && output?.systemMessage === 'GUARD_REQUEST_NOT_FOUND';
    const rawDecisionCode = output?.hookSpecificOutput?.permissionDecisionReason ?? output?.systemMessage;
    const decisionCode = typeof rawDecisionCode === 'string' && /^GUARD_[A-Z_]{1,56}$/u.test(rawDecisionCode)
      ? rawDecisionCode : null;
    const unavailable = ['GUARD_UNAVAILABLE', 'GUARD_PROTOCOL_MISMATCH', 'GUARD_DEADLINE_EXCEEDED']
      .includes(output?.systemMessage)
      || ['GUARD_UNAVAILABLE', 'GUARD_PROTOCOL_MISMATCH', 'GUARD_DEADLINE_EXCEEDED']
        .includes(output?.hookSpecificOutput?.additionalContext);
    const normal = event === 'PreToolUse'
      ? JSON.stringify(output) === JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse'}})
      : event === 'SessionEnd'
        ? output !== null && typeof output === 'object' && !Array.isArray(output) && Object.keys(output).length === 0
        : event === 'UserPromptSubmit'
          ? output?.hookSpecificOutput?.hookEventName === event
            && output.hookSpecificOutput.additionalContext === 'NO_STATE_CHANGE\nPrompt did not change Guard authority'
            && output.systemMessage === 'NO_STATE_CHANGE\nPrompt did not change Guard authority'
          : output?.systemMessage === 'Guarded tool completed' || expectedDeny;
    hooks.push({
      event,
      status: result.status,
      signal: result.signal,
      error: result.error,
      childPid: result.childPid,
      invocation: result.invocation,
      startedNs: result.startedNs,
      finishedNs: result.finishedNs,
      elapsedMs: result.elapsedMs,
      stderrBytes: Buffer.byteLength(result.stderr),
      denied,
      expectedDeny,
      decisionCode,
      unavailable,
      normal,
      outputShape: output && typeof output === 'object' ? Object.keys(output).sort() : null,
    });
  }

  const finishedNs = process.hrtime.bigint();
  return {
    round,
    pid: process.pid,
    sessionId,
    parentPid: process.ppid,
    bindingPresent: typeof process.env.JHW_RUNTIME_SESSION_BINDING === 'string'
      && process.env.JHW_RUNTIME_SESSION_BINDING.length > 0,
    startedNs: String(startedNs),
    finishedNs: String(finishedNs),
    control: {
      status: control.status,
      signal: control.signal,
      error: control.error,
      childPid: control.childPid,
      invocation: control.invocation,
      startedNs: control.startedNs,
      finishedNs: control.finishedNs,
      elapsedMs: control.elapsedMs,
      stderrBytes: Buffer.byteLength(control.stderr),
      ok: controlOk,
    },
    mcp: {
      status: mcp.status,
      signal: mcp.signal,
      error: mcp.error,
      childPid: mcp.childPid,
      invocation: mcp.invocation,
      startedNs: mcp.startedNs,
      finishedNs: mcp.finishedNs,
      elapsedMs: mcp.elapsedMs,
      stderrBytes: Buffer.byteLength(mcp.stderr),
      ok: mcpOk,
      toolCount: Array.isArray(tools) ? tools.length : null,
    },
    hooks,
  };
}

async function writeSample(round) {
  const target = path.join(evidenceDirectory, round + '.json');
  fs.writeFileSync(target, JSON.stringify(await sample(round)) + '\n', {mode: 0o600, flag: 'wx'});
}

async function writeContinuousSamples(round) {
  const target = path.join(evidenceDirectory, round + '.jsonl');
  let sequence = 0;
  if (sampleOffsetMs > 0) Atomics.wait(sleepArray, 0, 0, sampleOffsetMs);
  while (!fs.existsSync(path.join(evidenceDirectory, round + '.stop'))) {
    fs.appendFileSync(target, JSON.stringify(await sample(round, sequence++)) + '\n', {mode: 0o600});
  }
  fs.writeFileSync(path.join(evidenceDirectory, round + '.done'), '', {mode: 0o600, flag: 'wx'});
}

await writeSample('startup');
fs.writeFileSync(path.join(evidenceDirectory, 'ready'), String(process.pid), {mode: 0o600, flag: 'wx'});

const pending = new Set(rounds);
while (true) {
  for (const round of pending) {
    if (!fs.existsSync(path.join(evidenceDirectory, round + '.request'))) continue;
    pending.delete(round);
    if (continuousRounds.has(round)) await writeContinuousSamples(round);
    else {
      await writeSample(round);
      fs.writeFileSync(path.join(evidenceDirectory, round + '.done'), '', {mode: 0o600, flag: 'wx'});
    }
  }
  if (fs.existsSync(path.join(evidenceDirectory, 'stop'))) {
    break;
  }
  await delay(5);
}
