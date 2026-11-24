#!/usr/bin/env node
'use strict';

const {createHash} = require('node:crypto');
const {execFile} = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const RELEASE_ID = /^r-(?:[a-f0-9]{40}|[a-f0-9]{64})-[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SELECTORS = new Set(['control', 'hook', 'mcp']);
const KEYLESS_BANNER = '// jhw-managed-notion-relay: 1';

function failure(code = 'DEPLOY_RUNTIME_BINDING_INVALID') {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseDescriptor(value) {
  if (!/^(?:[3-9]|[1-9][0-9]+)$/u.test(value ?? '')) throw failure();
  const descriptor = Number(value);
  if (!Number.isSafeInteger(descriptor)) throw failure();
  return descriptor;
}

function parseSize(value) {
  if (!/^[1-9][0-9]*$/u.test(value ?? '')) throw failure();
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size > MAX_ARTIFACT_BYTES) throw failure();
  return size;
}

function canonicalPath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value
    && !value.includes('\0');
}

function validReleaseRoot(value) {
  return canonicalPath(value)
    && path.basename(path.dirname(value)) === 'releases'
    && path.basename(path.dirname(path.dirname(value))) === '.jhw-runtime'
    && RELEASE_ID.test(path.basename(value));
}

function sameFile(left, right) {
  return ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'ctimeNs', 'mtimeNs']
    .every(key => left[key] === right[key]);
}

function readArtifact(descriptor, expectedDigest, expectedSize) {
  try {
    const before = fs.fstatSync(descriptor, {bigint: true});
    if (!before.isFile() || before.size !== BigInt(expectedSize)) throw failure();
    const bytes = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw failure();
      offset += count;
    }
    const after = fs.fstatSync(descriptor, {bigint: true});
    if (!sameFile(before, after)) throw failure();
    if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) throw failure();
    return bytes;
  } finally {
    try { fs.closeSync(descriptor); } catch { /* the descriptor was already invalid */ }
  }
}

function requestNotion(python, profile, request) {
  const unavailable = () => new Error('NOTION_MANAGED_UNAVAILABLE');
  const binding = process.env.JHW_RUNTIME_SESSION_BINDING;
  if (!binding) return Promise.reject(unavailable());
  const input = JSON.stringify(request);
  if (typeof input !== 'string' || Buffer.byteLength(input) > 4096) return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    const child = execFile(python, [
      '-E', '-s', '-B', path.join(__dirname, 'runtime_managed.py'), '--profile', profile, '_notion-read',
    ], {
      env: {JHW_RUNTIME_SESSION_BINDING: binding, LANG: 'C.UTF-8'},
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(unavailable());
      try { resolve(JSON.parse(stdout)); } catch { reject(unavailable()); }
    });
    child.stdin.on('error', () => reject(unavailable()));
    child.stdin.end(input);
  });
}

function loadBundle(bytes, releaseRoot, python, profile, selector, args) {
  Object.defineProperty(globalThis, '__JHW_MANAGED_RELEASE_ROOT__', {
    value: releaseRoot,
    writable: false,
    configurable: false,
    enumerable: false,
  });

  if (selector === 'mcp' || (selector === 'control' && args.length === 1 && args[0] === 'preflight')) {
    const header = bytes.subarray(0, 128).toString('utf8').split('\n', 2);
    if (header[0] !== KEYLESS_BANNER && !(header[0] === '#!/usr/bin/env node' && header[1] === KEYLESS_BANNER)) {
      throw failure();
    }
    Object.defineProperty(globalThis, '__JHW_MANAGED_NOTION_RELAY__', {
      value: requestNotion.bind(null, python, profile),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }

  const builtins = new Set(Module.builtinModules.flatMap(name => [name, name.startsWith('node:') ? name : `node:${name}`]));
  const nativeRequire = Module.createRequire(__filename);
  const bundle = new Module(__filename, module);
  bundle.filename = __filename;
  bundle.paths = [];
  bundle.require = request => {
    if (typeof request !== 'string' || !builtins.has(request)) {
      throw failure('DEPLOY_EXTERNAL_MODULE_FORBIDDEN');
    }
    return nativeRequire(request);
  };

  // control and hook recognize this same logical entry path and run their
  // existing CLI main. The MCP bundle starts its existing main while loading.
  process.argv = [process.execPath, __filename, ...args];
  bundle._compile(bytes.toString('utf8'), __filename);
}

function main() {
  const [rawDescriptor, digest, rawSize, releaseRoot, python, profile, selector, ...args] = process.argv.slice(2);
  const descriptor = parseDescriptor(rawDescriptor);
  let bytes;
  let readStarted = false;
  try {
    const size = parseSize(rawSize);
    if (!SHA256.test(digest ?? '') || !validReleaseRoot(releaseRoot) || !SELECTORS.has(selector)
        || !canonicalPath(python) || !canonicalPath(profile)) throw failure();
    readStarted = true;
    bytes = readArtifact(descriptor, digest, size);
  } catch (error) {
    if (!readStarted) {
      try { fs.closeSync(descriptor); } catch { /* the inherited descriptor was invalid */ }
    }
    throw error;
  }
  loadBundle(bytes, releaseRoot, python, profile, selector, args);
}

try {
  main();
} catch (error) {
  const code = typeof error?.code === 'string' && /^DEPLOY_[A-Z_]{1,56}$/u.test(error.code)
    ? error.code
    : 'DEPLOY_START_FAILED';
  try { fs.writeSync(2, `${JSON.stringify({error: {code}})}\n`); } catch { /* no writable error transport */ }
  process.exitCode = 1;
}
