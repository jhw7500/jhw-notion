import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { openBoundRuntimeBundle } from './runtime-managed-artifact.mjs';
import { resolveSessionBindingV2 } from './runtime-store.mjs';

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const selectors = new Set(['mcp', 'control', 'hook']);

function invalid() {
  throw new Error('managed worker probe input is invalid');
}

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.nlink === right.nlink;
}

function validateLease(fd, file) {
  const inherited = fs.fstatSync(fd, {bigint: true});
  const named = fs.lstatSync(file, {bigint: true});
  if (!inherited.isFile() || !named.isFile() || !sameFile(inherited, named)
      || inherited.uid !== BigInt(process.getuid()) || inherited.nlink !== 1n
      || Number(inherited.mode & 0o777n) !== 0o600) invalid();
}

function binding(repositoryRoot) {
  const token = process.env.JHW_RUNTIME_SESSION_BINDING;
  if (typeof token !== 'string') invalid();
  const value = resolveSessionBindingV2({repositoryRoot, token});
  if (!exact(value, ['releaseId', 'bootstrapId', 'runtimeContract', 'compatibilityDigest', 'id', 'kind'])
      || value.kind !== 'session' || !/^s-[a-f0-9]{32}$/.test(value.id)) invalid();
  validateLease(3, path.join(repositoryRoot, '.jhw-runtime', 'admission.lock'));
  validateLease(6, path.join(repositoryRoot, '.jhw-runtime', 'v2', 'sessions', value.id, 'lease'));
  validateLease(7, path.join(repositoryRoot, '.jhw-runtime', 'v2', 'bootstraps', value.bootstrapId, 'lease'));
  return value;
}

function writeAll(bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(1, bytes, offset, bytes.length - offset);
}

function writeHeader(value) {
  writeAll(Buffer.from(`${JSON.stringify(value)}\n`));
}

function main() {
  const [mode, repositoryRoot, selector, ...extra] = process.argv.slice(2);
  if (extra.length !== 0 || !['info', 'artifact'].includes(mode)
      || typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)
      || fs.realpathSync(repositoryRoot) !== repositoryRoot
      || (mode === 'info' ? selector !== undefined : !selectors.has(selector))) invalid();
  const pair = binding(repositoryRoot);
  if (mode === 'info') {
    writeHeader({version: 1, releaseId: pair.releaseId, bootstrapId: pair.bootstrapId, sessionId: pair.id});
    return;
  }
  const bundle = openBoundRuntimeBundle({repositoryRoot, selector});
  try {
    bundle.verify();
    if (bundle.releaseId !== pair.releaseId || bundle.bootstrapId !== pair.bootstrapId) invalid();
    const info = fs.fstatSync(bundle.fd, {bigint: true});
    if (!info.isFile() || info.size < 0n || info.size > BigInt(MAX_ARTIFACT_BYTES)) invalid();
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(bundle.fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) invalid();
      offset += count;
    }
    if (fs.readSync(bundle.fd, Buffer.alloc(1), 0, 1, null) !== 0) invalid();
    bundle.verify();
    writeHeader({
      version: 1,
      releaseId: pair.releaseId,
      bootstrapId: pair.bootstrapId,
      sessionId: pair.id,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    writeAll(bytes);
  } finally {
    bundle.close();
  }
}

try {
  main();
} catch {
  process.exitCode = 1;
}
