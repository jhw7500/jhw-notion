#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

const [operation, configFile, mcpEntry, repositoryRoot, backupStamp, transactionEvidence] = process.argv.slice(2);
if (!operation || !configFile || !mcpEntry || !repositoryRoot) process.exit(2);

const CHANGED = 0;
const UNCHANGED = 3;
const FOREIGN = 4;
const CAS_MISMATCH = 5;
const AMBIGUOUS = 6;
const CLEANUP_UNCONFIRMED = 7;
const MANUAL_RECOVERY = 8;

function failForeign() {
  process.exit(FOREIGN);
}

function preserveUnowned() {
  process.exit(operation.startsWith("unregister-") ? UNCHANGED : FOREIGN);
}

function safeExistingFile(file) {
  let info;
  try {
    info = fs.lstatSync(file);
  } catch (cause) {
    if (cause && cause.code === "ENOENT") return { exists: false, mode: 0o600, text: "" };
    throw cause;
  }
  if (info.isSymbolicLink() || !info.isFile()) preserveUnowned();
  return { exists: true, mode: info.mode & 0o777, text: fs.readFileSync(file, "utf8") };
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWrite(file, content, mode, { exclusive = false } = {}) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (exclusive) {
      fs.linkSync(temporary, file);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, file);
    }
    syncDirectory(directory);
  } catch (cause) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch {}
    throw cause;
  }
}

function isOwnedEntryPath(candidate) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return false;
  try {
    const root = fs.realpathSync(repositoryRoot);
    const entry = fs.realpathSync(candidate);
    const relative = path.relative(root, entry);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function isOwnedStdio(entry) {
  return entry && entry.command === "node" && Array.isArray(entry.args) && entry.args.length === 1 && isOwnedEntryPath(entry.args[0]);
}

function isOwnedOpenCode(entry) {
  return entry && Array.isArray(entry.command) && entry.command.length === 2 &&
    entry.command[0] === "node" && isOwnedEntryPath(entry.command[1]);
}

function objectMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function parsedJson(text) {
  if (!text) return {};
  let value;
  try { value = JSON.parse(text); } catch { preserveUnowned(); }
  const object = objectMap(value);
  if (!object) preserveUnowned();
  return object;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function saveIfChanged(file, before, value, mode) {
  const next = jsonText(value);
  if (next === before) process.exit(UNCHANGED);
  atomicWrite(file, next, mode);
  process.exit(CHANGED);
}

const CODEX_HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse"];

function codexHookCommand(eventName) {
  return `"$HOME/.local/bin/jhw-control-hook" --adapter codex --event ${eventName}`;
}

function legacyCodexHookCommand(eventName) {
  const homeDirectory = path.dirname(path.dirname(configFile));
  return `${path.join(homeDirectory, ".local", "bin", "jhw-control-hook")} --adapter codex --event ${eventName}`;
}

function hasExactKeys(value, expected) {
  if (!objectMap(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function ownedCodexHookVariant(value, eventName) {
  if (!hasExactKeys(value, ["hooks"]) || !Array.isArray(value.hooks) || value.hooks.length !== 1) return false;
  const handler = value.hooks[0];
  if (!hasExactKeys(handler, ["type", "command", "timeout"]) ||
      handler.type !== "command" || handler.timeout !== 12) return false;
  if (handler.command === codexHookCommand(eventName)) return "canonical";
  if (handler.command === legacyCodexHookCommand(eventName)) return "legacy";
  return false;
}

function isOwnedCodexHookGroup(value, eventName) {
  return ownedCodexHookVariant(value, eventName) !== false;
}

function ownedCodexHookGroup(eventName) {
  return {
    hooks: [{ type: "command", command: codexHookCommand(eventName), timeout: 12 }],
  };
}

function backupMalformedHooks(current) {
  if (current.exists) {
    const stamp = backupStamp && /^\d{14}$/.test(backupStamp) ? backupStamp : "invalid";
    atomicWrite(`${configFile}.bak.${stamp}.${randomUUID()}`, current.text, 0o600, { exclusive: true });
  }
  failForeign();
}

function lexicalJson(text) {
  let cursor = 0;
  const skipWhitespace = () => {
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  };
  const stringNode = () => {
    const start = cursor;
    if (text[cursor] !== '"') throw new Error("expected JSON string");
    cursor += 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor] === '"') {
        cursor += 1;
        return { kind: "string", start, end: cursor, value: JSON.parse(text.slice(start, cursor)) };
      }
      cursor += 1;
    }
    throw new Error("unterminated JSON string");
  };
  const valueNode = () => {
    skipWhitespace();
    const start = cursor;
    if (text[cursor] === '"') return stringNode();
    if (text[cursor] === "{") {
      cursor += 1;
      const properties = [];
      skipWhitespace();
      if (text[cursor] === "}") {
        const close = cursor;
        cursor += 1;
        return { kind: "object", start, end: cursor, close, properties };
      }
      while (cursor < text.length) {
        skipWhitespace();
        const key = stringNode();
        skipWhitespace();
        if (text[cursor] !== ":") throw new Error("expected JSON colon");
        cursor += 1;
        const value = valueNode();
        properties.push({ start: key.start, end: value.end, key: key.value, value });
        skipWhitespace();
        if (text[cursor] === "}") {
          const close = cursor;
          cursor += 1;
          return { kind: "object", start, end: cursor, close, properties };
        }
        if (text[cursor] !== ",") throw new Error("expected JSON object comma");
        cursor += 1;
      }
      throw new Error("unterminated JSON object");
    }
    if (text[cursor] === "[") {
      cursor += 1;
      const elements = [];
      skipWhitespace();
      if (text[cursor] === "]") {
        const close = cursor;
        cursor += 1;
        return { kind: "array", start, end: cursor, close, elements };
      }
      while (cursor < text.length) {
        elements.push(valueNode());
        skipWhitespace();
        if (text[cursor] === "]") {
          const close = cursor;
          cursor += 1;
          return { kind: "array", start, end: cursor, close, elements };
        }
        if (text[cursor] !== ",") throw new Error("expected JSON array comma");
        cursor += 1;
      }
      throw new Error("unterminated JSON array");
    }
    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor += 1;
    if (cursor === start) throw new Error("expected JSON value");
    return { kind: "scalar", start, end: cursor };
  };
  const root = valueNode();
  skipWhitespace();
  if (cursor !== text.length) throw new Error("trailing JSON content");
  return root;
}

function uniqueProperty(object, key) {
  if (object.kind !== "object") throw new Error("expected JSON object node");
  const matches = object.properties.filter((property) => property.key === key);
  if (matches.length > 1) {
    const cause = new Error("ambiguous duplicate JSON property");
    cause.code = "AMBIGUOUS_HOOK_JSON";
    throw cause;
  }
  return matches[0];
}

function assertUnambiguousHookCandidates(eventProperty) {
  if (!eventProperty || eventProperty.value.kind !== "array") return;
  for (const group of eventProperty.value.elements) {
    if (group.kind !== "object") continue;
    const handlersProperty = uniqueProperty(group, "hooks");
    if (!handlersProperty || handlersProperty.value.kind !== "array") continue;
    for (const handler of handlersProperty.value.elements) {
      if (handler.kind !== "object") continue;
      uniqueProperty(handler, "type");
      uniqueProperty(handler, "command");
      uniqueProperty(handler, "timeout");
    }
  }
}

function inspectCodexHooksText(text) {
  const settings = JSON.parse(text);
  const syntax = lexicalJson(text);
  if (!objectMap(settings) || syntax.kind !== "object") throw new Error("hooks root is not an object");
  const hooksProperty = uniqueProperty(syntax, "hooks");
  if (settings.hooks !== undefined && (!objectMap(settings.hooks) || hooksProperty?.value.kind !== "object")) {
    throw new Error("hooks property is not an object");
  }
  if (settings.hooks !== undefined && !hooksProperty) throw new Error("hooks syntax mismatch");
  for (const eventName of CODEX_HOOK_EVENTS) {
    const eventProperty = hooksProperty ? uniqueProperty(hooksProperty.value, eventName) : undefined;
    if (settings.hooks?.[eventName] !== undefined &&
        (!Array.isArray(settings.hooks[eventName]) || eventProperty?.value.kind !== "array")) {
      throw new Error("hook event is not an array");
    }
    if (settings.hooks?.[eventName] !== undefined && !eventProperty) throw new Error("hook event syntax mismatch");
    assertUnambiguousHookCandidates(eventProperty);
  }
  return { settings, syntax, hooksProperty };
}

function parseCodexHooks(current, backupOnFailure) {
  if (!current.text) {
    if (current.exists) {
      if (backupOnFailure) backupMalformedHooks(current);
      preserveUnowned();
    }
    return undefined;
  }
  try {
    return inspectCodexHooksText(current.text);
  } catch (cause) {
    if (backupOnFailure) backupMalformedHooks(current);
    if (cause?.code === "AMBIGUOUS_HOOK_JSON") failForeign();
    preserveUnowned();
  }
}

function insertObjectProperty(text, object, key, value) {
  const insertion = `${JSON.stringify(key)}:${value}`;
  if (object.properties.length === 0) return `${text.slice(0, object.close)}${insertion}${text.slice(object.close)}`;
  const previous = object.properties.at(-1);
  return `${text.slice(0, previous.value.end)},${insertion}${text.slice(previous.value.end)}`;
}

function prependArrayElement(text, array, value) {
  const insertionPoint = array.elements[0]?.start ?? array.close;
  const separator = array.elements.length === 0 ? "" : ",";
  return `${text.slice(0, insertionPoint)}${value}${separator}${text.slice(insertionPoint)}`;
}

function replaceArrayElement(text, array, index, value) {
  const element = array.elements[index];
  return `${text.slice(0, element.start)}${value}${text.slice(element.end)}`;
}

function removeObjectProperty(text, object, index) {
  const property = object.properties[index];
  if (index > 0) return `${text.slice(0, object.properties[index - 1].value.end)}${text.slice(property.end)}`;
  if (object.properties.length > 1) return `${text.slice(0, property.start)}${text.slice(object.properties[1].start)}`;
  return `${text.slice(0, property.start)}${text.slice(property.end)}`;
}

function removeArrayElement(text, array, index) {
  const element = array.elements[index];
  if (index > 0) return `${text.slice(0, array.elements[index - 1].end)}${text.slice(element.end)}`;
  return `${text.slice(0, element.start)}${text.slice(array.elements[1].start)}`;
}

function saveRawIfChanged(current, next) {
  if (next === current.text) process.exit(UNCHANGED);
  atomicWrite(configFile, next, current.mode);
  process.exit(CHANGED);
}

function buildRegisteredCodexHooks(current) {
  if (!current.text && current.exists) throw new Error("existing empty hooks config");
  let text = current.exists ? current.text : "{}";
  let inspected = inspectCodexHooksText(text);
  if (!inspected.hooksProperty) {
    const hooks = Object.fromEntries(CODEX_HOOK_EVENTS.map((eventName) => [eventName, [ownedCodexHookGroup(eventName)]]));
    return insertObjectProperty(text, inspected.syntax, "hooks", JSON.stringify(hooks));
  }
  for (const eventName of CODEX_HOOK_EVENTS) {
    inspected = inspectCodexHooksText(text);
    const hooksObject = inspected.hooksProperty.value;
    const eventProperty = uniqueProperty(hooksObject, eventName);
    const groups = inspected.settings.hooks[eventName];
    if (!eventProperty) {
      text = insertObjectProperty(text, hooksObject, eventName, JSON.stringify([ownedCodexHookGroup(eventName)]));
      continue;
    }
    const ownedIndexes = groups.flatMap((group, index) => isOwnedCodexHookGroup(group, eventName) ? [index] : []);
    if (ownedIndexes.length > 1) throw new Error("duplicate owned hook group");
    const canonical = JSON.stringify(ownedCodexHookGroup(eventName));
    if (ownedIndexes.length === 0) {
      text = prependArrayElement(text, eventProperty.value, canonical);
      continue;
    }
    const ownedIndex = ownedIndexes[0];
    if (ownedIndex === 0 && ownedCodexHookVariant(groups[0], eventName) === "canonical") continue;
    if (groups.length === 1) {
      text = replaceArrayElement(text, eventProperty.value, ownedIndex, canonical);
      continue;
    }
    text = removeArrayElement(text, eventProperty.value, ownedIndex);
    inspected = inspectCodexHooksText(text);
    const updatedEventProperty = uniqueProperty(inspected.hooksProperty.value, eventName);
    text = prependArrayElement(text, updatedEventProperty.value, canonical);
  }
  return text;
}

function buildUnregisteredCodexHooks(current) {
  if (!current.exists) return current.text;
  if (!current.text) throw new Error("existing empty hooks config");
  const initial = inspectCodexHooksText(current.text);
  if (!initial?.hooksProperty) return current.text;
  let text = current.text;
  let changed = false;
  for (const eventName of CODEX_HOOK_EVENTS) {
    while (true) {
      const inspected = inspectCodexHooksText(text);
      const hooksObject = inspected.hooksProperty?.value;
      if (!hooksObject) break;
      const eventProperty = uniqueProperty(hooksObject, eventName);
      const groups = inspected.settings.hooks?.[eventName];
      if (!eventProperty || !Array.isArray(groups)) break;
      const ownedIndexes = groups.flatMap((group, index) => isOwnedCodexHookGroup(group, eventName) ? [index] : []);
      if (ownedIndexes.length === 0) break;
      if (ownedIndexes.length > 1) throw new Error("duplicate owned hook group");
      changed = true;
      if (ownedIndexes.length === groups.length) {
        const propertyIndex = hooksObject.properties.indexOf(eventProperty);
        text = removeObjectProperty(text, hooksObject, propertyIndex);
        break;
      }
      text = removeArrayElement(text, eventProperty.value, ownedIndexes[0]);
    }
  }
  return changed ? text : current.text;
}

const HOOK_TRANSACTION_PREFIX = ".hooks.json.jhw-txn.";
const HOOK_TRANSACTION_KNOWN = new Set([
  "manifest.json", "original", "original-absent", "captured-live",
  "published", "published-ready", "candidate", "candidate-absent", "candidate-live",
]);
const HOOK_FINALIZABLE_STAGES = new Set([
  "activated", "unchanged-restored", "foreign-restored", "foreign-untouched", "rollback-restored",
]);
const CONTROL_HOOK_LINK_TRANSACTION_PREFIX = ".jhw-control-hook-link-txn.";
const CONTROL_HOOK_LINK_ARTIFACTS = new Set(["captured-link"]);
const CONTROL_HOOK_LINK_STAGES = new Set([
  "allocated", "unchanged-absent", "foreign-untouched", "capture-intent", "captured",
  "delete-intent", "removed-owned", "foreign-republished", "manual-recovery-required",
  "ambiguous", "finalize-intent",
]);
const CONTROL_HOOK_LINK_FINALIZABLE_STAGES = new Set([
  "unchanged-absent", "foreign-untouched", "removed-owned", "foreign-republished",
]);

function hookMode(info) {
  return (info.mode & 0o777).toString(8);
}

function hookKind(info) {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isFIFO()) return "fifo";
  return "nonregular";
}

function hookIdentity(info) {
  return {
    kind: hookKind(info),
    mode: hookMode(info),
    dev: Number(info.dev),
    ino: Number(info.ino),
  };
}

function sameRecordedHookIdentity(actual, expected) {
  return actual?.kind === expected?.kind && actual?.mode === expected?.mode &&
    actual?.dev === expected?.dev && actual?.ino === expected?.ino;
}

function sameHookIdentity(info, expected) {
  return sameRecordedHookIdentity(hookIdentity(info), expected);
}

function lstatMaybe(file) {
  try { return fs.lstatSync(file); } catch (cause) {
    if (cause?.code === "ENOENT") return undefined;
    throw cause;
  }
}

function hookTransactionDirectory({ empty = false } = {}) {
  const directory = path.resolve(backupStamp ?? "");
  const configDirectory = path.dirname(path.resolve(configFile));
  if (path.dirname(directory) !== configDirectory || !path.basename(directory).startsWith(HOOK_TRANSACTION_PREFIX)) {
    throw new Error("invalid hook transaction path");
  }
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error("unsafe hook transaction directory");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("foreign hook transaction owner");
  if (empty && fs.readdirSync(directory).length !== 0) throw new Error("hook transaction is not empty");
  return directory;
}

function transactionFile(directory, name) {
  if (!HOOK_TRANSACTION_KNOWN.has(name)) throw new Error("unknown hook transaction artifact");
  return path.join(directory, name);
}

function writeTransactionArtifact(directory, manifest, name, content, mode = 0o600) {
  atomicWrite(transactionFile(directory, name), content, mode, { exclusive: true });
  manifest.artifacts.push(name);
  manifest.identities[name] = hookIdentity(fs.lstatSync(transactionFile(directory, name)));
}

function writeHookManifest(directory, manifest, { initial = false } = {}) {
  atomicWrite(transactionFile(directory, "manifest.json"), `${JSON.stringify(manifest)}\n`, 0o600, { exclusive: initial });
}

function readHookManifest(directory) {
  const manifestPath = transactionFile(directory, "manifest.json");
  const info = fs.lstatSync(manifestPath);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error("unsafe hook manifest");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!objectMap(manifest) || manifest.version !== 2 || manifest.config !== path.basename(configFile) ||
      typeof manifest.stage !== "string" || !Array.isArray(manifest.artifacts) ||
      !manifest.artifacts.every((name) => typeof name === "string" && HOOK_TRANSACTION_KNOWN.has(name) && name !== "manifest.json") ||
      new Set(manifest.artifacts).size !== manifest.artifacts.length || !objectMap(manifest.identities)) {
    throw new Error("invalid hook manifest");
  }
  return manifest;
}

function validateHookTransactionArtifacts(directory, manifest) {
  const expected = new Set(["manifest.json", ...manifest.artifacts]);
  const actual = fs.readdirSync(directory);
  const intentCapture = manifest.stage === "capture-intent" ? "captured-live" :
    manifest.stage === "rollback-capture-intent" ? "candidate-live" : undefined;
  let missingIntent;
  if (manifest.stage === "finalize-intent") {
    if (manifest.deleteIntent !== undefined &&
        (typeof manifest.deleteIntent !== "string" || !manifest.artifacts.includes(manifest.deleteIntent))) {
      throw new Error("invalid finalize delete intent");
    }
    missingIntent = manifest.deleteIntent;
  } else if (manifest.stage === "activation-detach-intent") {
    if (manifest.deleteIntent !== "published-ready" || manifest.activationTo !== "activated" ||
        !manifest.artifacts.includes("published-ready")) {
      throw new Error("invalid activation detach intent");
    }
    missingIntent = "published-ready";
  } else if (manifest.deleteIntent !== undefined || manifest.activationTo !== undefined) {
    throw new Error("unexpected hook transaction intent");
  }
  if (intentCapture && actual.includes(intentCapture)) expected.add(intentCapture);
  if (actual.some((name) => !expected.has(name)) ||
      expected.size !== actual.length + (missingIntent && !actual.includes(missingIntent) ? 1 : 0)) {
    throw new Error("unexpected hook transaction artifact");
  }
  for (const name of manifest.artifacts) {
    let info;
    try { info = fs.lstatSync(transactionFile(directory, name)); } catch (cause) {
      if (cause?.code === "ENOENT" && missingIntent === name) continue;
      throw cause;
    }
    if (!sameHookIdentity(info, manifest.identities[name])) throw new Error("hook transaction artifact identity changed");
    if (["original", "original-absent", "published", "candidate", "candidate-absent"].includes(name) &&
        (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600)) {
      throw new Error("non-private hook evidence");
    }
  }
  if (intentCapture && actual.includes(intentCapture)) return hookIdentity(fs.lstatSync(transactionFile(directory, intentCapture)));
  return undefined;
}

function markHookTransaction(directory, manifest, stage) {
  manifest.stage = stage;
  writeHookManifest(directory, manifest);
}

function backupCapturedMalformedHooks(bytes) {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  atomicWrite(`${configFile}.bak.${stamp}.${randomUUID()}`, bytes, 0o600, { exclusive: true });
}

function exactUtf8(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("UTF-8 round trip changed hook bytes");
  return text;
}

function recordCapturedArtifact(directory, manifest, name) {
  if (!manifest.artifacts.includes(name)) manifest.artifacts.push(name);
  const identity = hookIdentity(fs.lstatSync(transactionFile(directory, name)));
  manifest.identities[name] = identity;
  return identity;
}

function linkHookState(source, directory, manifest, successStage) {
  try {
    fs.linkSync(source, configFile);
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      markHookTransaction(directory, manifest, "concurrent");
      return CAS_MISMATCH;
    }
    throw cause;
  }
  syncDirectory(path.dirname(configFile));
  if (path.dirname(source) === directory && path.basename(source) === "published-ready") {
    manifest.deleteIntent = "published-ready";
    manifest.activationTo = successStage;
    markHookTransaction(directory, manifest, "activation-detach-intent");
    fs.unlinkSync(source);
    syncDirectory(directory);
    manifest.artifacts = manifest.artifacts.filter((name) => name !== "published-ready");
    delete manifest.identities["published-ready"];
    manifest.deleteIntent = undefined;
    manifest.activationTo = undefined;
  }
  markHookTransaction(directory, manifest, successStage);
  return CHANGED;
}

function restoreCapturedOriginal(directory, manifest, successStage) {
  if (manifest.original.kind === "missing") {
    if (lstatMaybe(configFile)) {
      markHookTransaction(directory, manifest, "concurrent");
      return CAS_MISMATCH;
    }
    markHookTransaction(directory, manifest, successStage);
    return CHANGED;
  }
  return linkHookState(transactionFile(directory, "captured-live"), directory, manifest, successStage);
}

function newHookManifest(operationName) {
  return {
    version: 2,
    config: path.basename(configFile),
    operation: operationName,
    stage: "allocated",
    observed: undefined,
    original: undefined,
    published: undefined,
    candidate: undefined,
    artifacts: [],
    identities: {},
    deleteIntent: undefined,
    activationTo: undefined,
    finalizeFrom: undefined,
  };
}

function captureOriginal(directory, manifest) {
  const initially = lstatMaybe(configFile);
  if (initially && hookKind(initially) !== "file") {
    manifest.observed = "foreign";
    manifest.original = hookIdentity(initially);
    markHookTransaction(directory, manifest, "foreign-untouched");
    return { status: FOREIGN };
  }

  manifest.observed = initially ? "existing" : "missing";
  markHookTransaction(directory, manifest, "capture-intent");
  if (!initially) {
    if (lstatMaybe(configFile)) {
      markHookTransaction(directory, manifest, "concurrent");
      return { status: CAS_MISMATCH };
    }
    manifest.original = { kind: "missing", mode: "", dev: 0, ino: 0 };
    writeTransactionArtifact(directory, manifest, "original-absent", Buffer.alloc(0));
    markHookTransaction(directory, manifest, "captured");
    return { status: CHANGED, current: { exists: false, mode: 0o600, text: "" } };
  }

  const capturedPath = transactionFile(directory, "captured-live");
  try {
    fs.renameSync(configFile, capturedPath);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      markHookTransaction(directory, manifest, "concurrent");
      return { status: CAS_MISMATCH };
    }
    throw cause;
  }
  syncDirectory(path.dirname(configFile));
  syncDirectory(directory);
  validateHookTransactionArtifacts(directory, manifest);
  const identity = recordCapturedArtifact(directory, manifest, "captured-live");
  manifest.original = identity;
  markHookTransaction(directory, manifest, "captured");
  if (identity.kind !== "file") {
    if (identity.kind === "symlink" || identity.kind === "fifo") {
      const restored = linkHookState(capturedPath, directory, manifest, "foreign-restored");
      return { status: restored === CHANGED ? FOREIGN : restored };
    }
    markHookTransaction(directory, manifest, "manual-recovery-required");
    return { status: MANUAL_RECOVERY };
  }
  const bytes = fs.readFileSync(capturedPath);
  writeTransactionArtifact(directory, manifest, "original", bytes);
  writeHookManifest(directory, manifest);
  return {
    status: CHANGED,
    bytes,
    current: { exists: true, mode: Number.parseInt(identity.mode, 8), text: undefined },
  };
}

function reconcileCaptureIntent(directory, manifest) {
  const identity = validateHookTransactionArtifacts(directory, manifest);
  if (!identity) throw new Error("capture-intent has no captured-live artifact");
  recordCapturedArtifact(directory, manifest, "captured-live");
  manifest.original = identity;
  writeHookManifest(directory, manifest);
  if (identity.kind === "directory") {
    markHookTransaction(directory, manifest, "manual-recovery-required");
    return MANUAL_RECOVERY;
  }
  if (!["file", "symlink", "fifo"].includes(identity.kind)) {
    markHookTransaction(directory, manifest, "manual-recovery-required");
    return MANUAL_RECOVERY;
  }
  return linkHookState(transactionFile(directory, "captured-live"), directory, manifest, "capture-recovered") === CHANGED ?
    AMBIGUOUS : CAS_MISMATCH;
}

function recoverCaptureOrActivationError(directory) {
  if (!directory) return AMBIGUOUS;
  let durable;
  try { durable = readHookManifest(directory); } catch { return AMBIGUOUS; }
  if (durable.stage === "capture-intent") {
    try { return reconcileCaptureIntent(directory, durable); } catch {
      process.stderr.write("capture-intent contains an unexpected artifact\n");
      return AMBIGUOUS;
    }
  }
  if (durable.stage === "activation-detach-intent") {
    try { validateHookTransactionArtifacts(directory, durable); } catch {
      process.stderr.write("activation-detach-intent contains unexpected evidence\n");
    }
    return AMBIGUOUS;
  }
  try {
    validateHookTransactionArtifacts(directory, durable);
    markHookTransaction(directory, durable, "ambiguous");
  } catch {}
  return AMBIGUOUS;
}

function registerCodexHooksTransaction() {
  let directory;
  let manifest;
  try {
    directory = hookTransactionDirectory({ empty: true });
    syncDirectory(path.dirname(configFile));
    manifest = newHookManifest("register");
    writeHookManifest(directory, manifest, { initial: true });
    const capture = captureOriginal(directory, manifest);
    if (capture.status !== CHANGED) return capture.status;
    const { current, bytes: originalBytes } = capture;

    let next;
    try {
      if (current.exists) current.text = exactUtf8(originalBytes);
      next = buildRegisteredCodexHooks(current);
    } catch {
      if (current.exists) backupCapturedMalformedHooks(originalBytes);
      return restoreCapturedOriginal(directory, manifest, "foreign-restored") === CHANGED ? FOREIGN : CAS_MISMATCH;
    }

    if (current.exists && next === current.text) {
      return restoreCapturedOriginal(directory, manifest, "unchanged-restored") === CHANGED ? UNCHANGED : CAS_MISMATCH;
    }

    writeTransactionArtifact(directory, manifest, "published", Buffer.from(next, "utf8"));
    const publishedMode = current.exists ? current.mode : 0o600;
    writeTransactionArtifact(directory, manifest, "published-ready", Buffer.from(next, "utf8"), publishedMode);
    manifest.published = hookIdentity(fs.lstatSync(transactionFile(directory, "published-ready")));
    markHookTransaction(directory, manifest, "prepared");
    const activated = linkHookState(transactionFile(directory, "published-ready"), directory, manifest, "activated");
    return activated === CHANGED ? CHANGED : activated;
  } catch {
    return recoverCaptureOrActivationError(directory);
  }
}

function unregisterCodexHooksTransaction() {
  let directory;
  let manifest;
  try {
    directory = hookTransactionDirectory({ empty: true });
    syncDirectory(path.dirname(configFile));
    manifest = newHookManifest("unregister");
    writeHookManifest(directory, manifest, { initial: true });
    const capture = captureOriginal(directory, manifest);
    if (capture.status !== CHANGED) return capture.status;
    const { current, bytes: originalBytes } = capture;
    let next;
    try {
      if (current.exists) current.text = exactUtf8(originalBytes);
      next = buildUnregisteredCodexHooks(current);
    } catch {
      return restoreCapturedOriginal(directory, manifest, "foreign-restored") === CHANGED ? FOREIGN : CAS_MISMATCH;
    }
    if (next === current.text) {
      return restoreCapturedOriginal(directory, manifest, "unchanged-restored") === CHANGED ? UNCHANGED : CAS_MISMATCH;
    }
    writeTransactionArtifact(directory, manifest, "published", Buffer.from(next, "utf8"));
    writeTransactionArtifact(directory, manifest, "published-ready", Buffer.from(next, "utf8"), current.mode);
    manifest.published = hookIdentity(fs.lstatSync(transactionFile(directory, "published-ready")));
    markHookTransaction(directory, manifest, "prepared");
    return linkHookState(transactionFile(directory, "published-ready"), directory, manifest, "activated");
  } catch {
    return recoverCaptureOrActivationError(directory);
  }
}

function reconcileRollbackCaptureIntent(directory, manifest) {
  const observedIdentity = validateHookTransactionArtifacts(directory, manifest);
  if (!observedIdentity) throw new Error("rollback-capture-intent has no candidate-live artifact");
  syncDirectory(path.dirname(configFile));
  syncDirectory(directory);
  const syncedIdentity = validateHookTransactionArtifacts(directory, manifest);
  if (!sameRecordedHookIdentity(syncedIdentity, observedIdentity)) {
    throw new Error("rollback candidate identity changed before durable recovery");
  }
  const recordedIdentity = recordCapturedArtifact(directory, manifest, "candidate-live");
  if (!sameRecordedHookIdentity(recordedIdentity, syncedIdentity)) {
    throw new Error("rollback candidate identity changed while binding recovery evidence");
  }
  manifest.candidate = recordedIdentity;
  writeHookManifest(directory, manifest);
  const boundIdentity = validateHookTransactionArtifacts(directory, manifest);
  if (!sameRecordedHookIdentity(boundIdentity, recordedIdentity)) {
    throw new Error("rollback candidate identity changed after binding recovery evidence");
  }
  markHookTransaction(directory, manifest, "manual-recovery-required");
  return MANUAL_RECOVERY;
}

function recoverRollbackError(directory) {
  if (!directory) return AMBIGUOUS;
  let durable;
  try { durable = readHookManifest(directory); } catch { return AMBIGUOUS; }
  if (durable.stage === "rollback-capture-intent") {
    try { return reconcileRollbackCaptureIntent(directory, durable); } catch {
      process.stderr.write("rollback-capture-intent contains unexpected evidence\n");
      return AMBIGUOUS;
    }
  }
  try {
    validateHookTransactionArtifacts(directory, durable);
    markHookTransaction(directory, durable, "ambiguous");
  } catch {}
  return AMBIGUOUS;
}

function rollbackCodexHooksTransaction() {
  let directory;
  let manifest;
  try {
    directory = hookTransactionDirectory();
    manifest = readHookManifest(directory);
    validateHookTransactionArtifacts(directory, manifest);
    if (manifest.stage !== "activated") throw new Error("hook transaction is not activated");

    const initially = lstatMaybe(configFile);
    manifest.observed = initially ? "existing" : "missing";
    markHookTransaction(directory, manifest, "rollback-capture-intent");

    let candidateBytes;
    if (initially) {
      const candidateLive = transactionFile(directory, "candidate-live");
      try {
        fs.renameSync(configFile, candidateLive);
      } catch (cause) {
        if (cause?.code === "ENOENT") {
          markHookTransaction(directory, manifest, "rollback-concurrent");
          return CAS_MISMATCH;
        }
        throw cause;
      }
      if (lstatMaybe(candidateLive)) {
        syncDirectory(path.dirname(configFile));
        syncDirectory(directory);
        validateHookTransactionArtifacts(directory, manifest);
        manifest.candidate = recordCapturedArtifact(directory, manifest, "candidate-live");
        markHookTransaction(directory, manifest, "rollback-captured");
        if (manifest.candidate.kind !== "file") {
          if (manifest.candidate.kind === "symlink" || manifest.candidate.kind === "fifo") {
            linkHookState(candidateLive, directory, manifest, "rollback-mismatch-republished");
          } else {
            markHookTransaction(directory, manifest, "manual-recovery-required");
            return MANUAL_RECOVERY;
          }
          return CAS_MISMATCH;
        }
        candidateBytes = fs.readFileSync(candidateLive);
        writeTransactionArtifact(directory, manifest, "candidate", candidateBytes);
        writeHookManifest(directory, manifest);
      }
    }
    if (!candidateBytes) {
      manifest.candidate = { kind: "missing", mode: "", dev: 0, ino: 0 };
      writeTransactionArtifact(directory, manifest, "candidate-absent", Buffer.alloc(0));
      markHookTransaction(directory, manifest, "rollback-captured");
    }

    const publishedBytes = fs.readFileSync(transactionFile(directory, "published"));
    const matchesPublished = sameRecordedHookIdentity(manifest.candidate, manifest.published) &&
      candidateBytes.equals(publishedBytes);
    if (matchesPublished) {
      return restoreCapturedOriginal(directory, manifest, "rollback-restored") === CHANGED ? CHANGED : CAS_MISMATCH;
    }
    if (manifest.candidate.kind === "file") {
      linkHookState(transactionFile(directory, "candidate-live"), directory, manifest, "rollback-mismatch-republished");
    } else {
      markHookTransaction(directory, manifest, "rollback-mismatch-absent");
    }
    return CAS_MISMATCH;
  } catch {
    return recoverRollbackError(directory);
  }
}

function inspectCodexHooksTransaction() {
  const directory = hookTransactionDirectory();
  const manifest = readHookManifest(directory);
  validateHookTransactionArtifacts(directory, manifest);
  process.stdout.write(`${JSON.stringify({
    stage: manifest.stage,
    original: manifest.original,
    published: manifest.published,
    candidate: manifest.candidate,
    deleteIntent: manifest.deleteIntent,
    activationTo: manifest.activationTo,
  })}\n`);
  return CHANGED;
}

function finalizeCodexHooksTransaction() {
  const directory = hookTransactionDirectory();
  const manifest = readHookManifest(directory);
  validateHookTransactionArtifacts(directory, manifest);
  const expectedStage = transactionEvidence ?? "";
  if (manifest.stage === "finalize-intent") {
    if (manifest.finalizeFrom !== expectedStage || !HOOK_FINALIZABLE_STAGES.has(expectedStage)) {
      throw new Error("hook transaction finalize intent does not match");
    }
  } else {
    if (manifest.stage !== expectedStage || !HOOK_FINALIZABLE_STAGES.has(manifest.stage)) {
      throw new Error("hook transaction is not finalizable");
    }
    manifest.finalizeFrom = expectedStage;
    manifest.deleteIntent = undefined;
    markHookTransaction(directory, manifest, "finalize-intent");
  }
  while (manifest.artifacts.length > 0) {
    const name = manifest.deleteIntent ?? manifest.artifacts.at(-1);
    if (!manifest.deleteIntent) {
      manifest.deleteIntent = name;
      writeHookManifest(directory, manifest);
    }
    const target = transactionFile(directory, name);
    const info = lstatMaybe(target);
    if (info) {
      if (!sameHookIdentity(info, manifest.identities[name])) throw new Error("finalize artifact identity changed");
      if (info.isDirectory()) throw new Error("finalize refuses directory artifact");
      fs.unlinkSync(target);
      syncDirectory(directory);
    }
    manifest.artifacts = manifest.artifacts.filter((candidate) => candidate !== name);
    delete manifest.identities[name];
    manifest.deleteIntent = undefined;
    writeHookManifest(directory, manifest);
  }
  fs.unlinkSync(transactionFile(directory, "manifest.json"));
  fs.rmdirSync(directory);
  try {
    syncDirectory(path.dirname(configFile));
  } catch {
    process.stdout.write("transaction evidence was removed; parent-directory durability is unconfirmed\n");
    return CLEANUP_UNCONFIRMED;
  }
  return CHANGED;
}

function expectedControlHookTarget() {
  const expected = path.join(path.resolve(repositoryRoot), "scripts", "jhw-control-hook");
  if (path.basename(configFile) !== "jhw-control-hook" || mcpEntry !== expected) {
    throw new Error("control hook link transaction is restricted to the exact repository launcher");
  }
  return expected;
}

function controlHookLinkTransactionDirectory({ empty = false } = {}) {
  expectedControlHookTarget();
  const directory = path.resolve(backupStamp ?? "");
  const liveParent = path.dirname(path.resolve(configFile));
  if (path.dirname(directory) !== liveParent ||
      !path.basename(directory).startsWith(CONTROL_HOOK_LINK_TRANSACTION_PREFIX)) {
    throw new Error("invalid control hook link transaction path");
  }
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) {
    throw new Error("unsafe control hook link transaction directory");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("foreign control hook link transaction owner");
  }
  if (empty && fs.readdirSync(directory).length !== 0) {
    throw new Error("control hook link transaction is not empty");
  }
  return directory;
}

function controlHookLinkTransactionFile(directory, name) {
  if (name !== "manifest.json" && !CONTROL_HOOK_LINK_ARTIFACTS.has(name)) {
    throw new Error("unknown control hook link transaction artifact");
  }
  return path.join(directory, name);
}

function validControlHookLinkIdentity(identity) {
  if (!objectMap(identity) || !["missing", "symlink", "file", "directory", "fifo", "nonregular"].includes(identity.kind) ||
      typeof identity.mode !== "string" || !Number.isSafeInteger(identity.dev) ||
      !Number.isSafeInteger(identity.ino)) return false;
  if (identity.kind === "missing") {
    return identity.mode === "" && identity.dev === 0 && identity.ino === 0;
  }
  return /^[0-7]{3,4}$/.test(identity.mode) && identity.dev >= 0 && identity.ino > 0;
}

function writeControlHookLinkManifest(directory, manifest, { initial = false } = {}) {
  atomicWrite(controlHookLinkTransactionFile(directory, "manifest.json"),
    `${JSON.stringify(manifest)}\n`, 0o600, { exclusive: initial });
}

function readControlHookLinkManifest(directory) {
  const manifestPath = controlHookLinkTransactionFile(directory, "manifest.json");
  const info = fs.lstatSync(manifestPath);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) {
    throw new Error("unsafe control hook link manifest");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const allowedKeys = new Set([
    "version", "live", "expectedTarget", "stage", "observed", "observedTarget",
    "captured", "capturedTarget", "artifacts", "identities", "deleteIntent", "finalizeFrom",
  ]);
  if (!objectMap(manifest) || Object.keys(manifest).some((key) => !allowedKeys.has(key)) ||
      manifest.version !== 1 || manifest.live !== path.basename(configFile) ||
      manifest.expectedTarget !== expectedControlHookTarget() ||
      !CONTROL_HOOK_LINK_STAGES.has(manifest.stage) || !Array.isArray(manifest.artifacts) ||
      !manifest.artifacts.every((name) => CONTROL_HOOK_LINK_ARTIFACTS.has(name)) ||
      new Set(manifest.artifacts).size !== manifest.artifacts.length || !objectMap(manifest.identities) ||
      Object.keys(manifest.identities).length !== manifest.artifacts.length ||
      !Object.keys(manifest.identities).every((name) => manifest.artifacts.includes(name)) ||
      (manifest.observed !== undefined && !validControlHookLinkIdentity(manifest.observed)) ||
      (manifest.captured !== undefined && !validControlHookLinkIdentity(manifest.captured)) ||
      (manifest.observedTarget !== undefined && typeof manifest.observedTarget !== "string") ||
      (manifest.capturedTarget !== undefined && typeof manifest.capturedTarget !== "string") ||
      (manifest.deleteIntent !== undefined && manifest.deleteIntent !== "captured-link") ||
      (manifest.finalizeFrom !== undefined && !CONTROL_HOOK_LINK_FINALIZABLE_STAGES.has(manifest.finalizeFrom))) {
    throw new Error("invalid control hook link manifest");
  }
  for (const name of manifest.artifacts) {
    if (!validControlHookLinkIdentity(manifest.identities[name])) {
      throw new Error("invalid control hook link artifact identity");
    }
  }
  if (manifest.captured !== undefined && manifest.identities["captured-link"] !== undefined &&
      !sameRecordedHookIdentity(manifest.captured, manifest.identities["captured-link"])) {
    throw new Error("captured control hook link identity is not bound to its artifact");
  }
  return manifest;
}

function validateControlHookLinkArtifacts(directory, manifest) {
  const actual = fs.readdirSync(directory);
  const expected = new Set(["manifest.json", ...manifest.artifacts]);
  const intentCaptured = manifest.stage === "capture-intent" &&
    actual.includes("captured-link") && !manifest.artifacts.includes("captured-link");
  const permittedMissing = (manifest.stage === "delete-intent" || manifest.stage === "finalize-intent") ?
    manifest.deleteIntent : undefined;
  for (const name of actual) {
    if (!expected.has(name) && !(intentCaptured && name === "captured-link")) {
      throw new Error("unexpected control hook link transaction artifact");
    }
  }
  for (const name of expected) {
    if (!actual.includes(name) && name !== permittedMissing) {
      throw new Error("missing control hook link transaction artifact");
    }
  }
  for (const name of manifest.artifacts) {
    if (!actual.includes(name)) continue;
    const artifactPath = controlHookLinkTransactionFile(directory, name);
    const info = fs.lstatSync(artifactPath);
    if (!sameHookIdentity(info, manifest.identities[name])) {
      throw new Error("control hook link transaction artifact identity changed");
    }
    if (name === "captured-link") {
      const target = info.isSymbolicLink() ? fs.readlinkSync(artifactPath) : undefined;
      if (target !== manifest.capturedTarget) {
        throw new Error("captured control hook link target changed");
      }
    }
  }
  if (manifest.stage === "delete-intent" &&
      (manifest.deleteIntent !== "captured-link" || !manifest.artifacts.includes("captured-link"))) {
    throw new Error("invalid control hook link delete intent");
  }
  if (manifest.stage === "finalize-intent" &&
      (!CONTROL_HOOK_LINK_FINALIZABLE_STAGES.has(manifest.finalizeFrom) ||
       (manifest.deleteIntent !== undefined && !manifest.artifacts.includes(manifest.deleteIntent)))) {
    throw new Error("invalid control hook link finalize intent");
  }
  if (["captured", "delete-intent", "foreign-republished", "manual-recovery-required"].includes(manifest.stage) &&
      (!manifest.captured || !manifest.artifacts.includes("captured-link"))) {
    throw new Error("control hook link stage has no captured evidence");
  }
  if (manifest.stage === "foreign-republished") {
    const live = lstatMaybe(configFile);
    if (!live || !sameHookIdentity(live, manifest.captured)) {
      throw new Error("republished control hook link identity changed");
    }
    const liveTarget = live.isSymbolicLink() ? fs.readlinkSync(configFile) : undefined;
    if (liveTarget !== manifest.capturedTarget) {
      throw new Error("republished control hook link target changed");
    }
  }
  if (intentCaptured) {
    const capturedPath = controlHookLinkTransactionFile(directory, "captured-link");
    const info = fs.lstatSync(capturedPath);
    return {
      identity: hookIdentity(info),
      target: info.isSymbolicLink() ? fs.readlinkSync(capturedPath) : undefined,
    };
  }
  return undefined;
}

function markControlHookLinkTransaction(directory, manifest, stage) {
  manifest.stage = stage;
  writeControlHookLinkManifest(directory, manifest);
}

function newControlHookLinkManifest() {
  return {
    version: 1,
    live: path.basename(configFile),
    expectedTarget: expectedControlHookTarget(),
    stage: "allocated",
    observed: undefined,
    observedTarget: undefined,
    captured: undefined,
    capturedTarget: undefined,
    artifacts: [],
    identities: {},
    deleteIntent: undefined,
    finalizeFrom: undefined,
  };
}

function bindCapturedControlHookLink(directory, manifest) {
  const capturedPath = controlHookLinkTransactionFile(directory, "captured-link");
  const info = fs.lstatSync(capturedPath);
  const identity = hookIdentity(info);
  manifest.captured = identity;
  manifest.capturedTarget = info.isSymbolicLink() ? fs.readlinkSync(capturedPath) : undefined;
  if (!manifest.artifacts.includes("captured-link")) manifest.artifacts.push("captured-link");
  manifest.identities["captured-link"] = identity;
  return identity;
}

function recoverControlHookLinkError(directory) {
  if (!directory) return AMBIGUOUS;
  let manifest;
  try {
    manifest = readControlHookLinkManifest(directory);
    const intent = validateControlHookLinkArtifacts(directory, manifest);
    if (manifest.stage === "capture-intent" && intent) {
      syncDirectory(path.dirname(configFile));
      syncDirectory(directory);
      const durable = validateControlHookLinkArtifacts(directory, manifest);
      if (!durable || !sameRecordedHookIdentity(durable.identity, intent.identity) || durable.target !== intent.target) {
        return AMBIGUOUS;
      }
      bindCapturedControlHookLink(directory, manifest);
      markControlHookLinkTransaction(directory, manifest, "manual-recovery-required");
      return MANUAL_RECOVERY;
    }
  } catch {
    return AMBIGUOUS;
  }
  return AMBIGUOUS;
}

function removeControlHookLinkTransaction() {
  let directory;
  let manifest;
  try {
    directory = controlHookLinkTransactionDirectory({ empty: true });
    syncDirectory(path.dirname(configFile));
    manifest = newControlHookLinkManifest();
    writeControlHookLinkManifest(directory, manifest, { initial: true });

    const initially = lstatMaybe(configFile);
    if (!initially) {
      manifest.observed = { kind: "missing", mode: "", dev: 0, ino: 0 };
      markControlHookLinkTransaction(directory, manifest, "unchanged-absent");
      return UNCHANGED;
    }
    manifest.observed = hookIdentity(initially);
    manifest.observedTarget = initially.isSymbolicLink() ? fs.readlinkSync(configFile) : undefined;
    const confirmed = lstatMaybe(configFile);
    if (!confirmed || !sameHookIdentity(confirmed, manifest.observed) ||
        (confirmed.isSymbolicLink() ? fs.readlinkSync(configFile) : undefined) !== manifest.observedTarget) {
      markControlHookLinkTransaction(directory, manifest, "ambiguous");
      return CAS_MISMATCH;
    }
    if (!initially.isSymbolicLink() || manifest.observedTarget !== manifest.expectedTarget) {
      markControlHookLinkTransaction(directory, manifest, "foreign-untouched");
      return FOREIGN;
    }

    markControlHookLinkTransaction(directory, manifest, "capture-intent");
    const capturedPath = controlHookLinkTransactionFile(directory, "captured-link");
    try {
      fs.renameSync(configFile, capturedPath);
    } catch (cause) {
      if (cause?.code === "ENOENT") {
        markControlHookLinkTransaction(directory, manifest, "ambiguous");
        return CAS_MISMATCH;
      }
      throw cause;
    }
    syncDirectory(path.dirname(configFile));
    syncDirectory(directory);
    bindCapturedControlHookLink(directory, manifest);
    markControlHookLinkTransaction(directory, manifest, "captured");

    const capturedIsObservedOwned = manifest.captured.kind === "symlink" &&
      sameRecordedHookIdentity(manifest.captured, manifest.observed) &&
      manifest.capturedTarget === manifest.observedTarget &&
      manifest.capturedTarget === manifest.expectedTarget;
    if (!capturedIsObservedOwned) {
      try {
        fs.linkSync(capturedPath, configFile);
        syncDirectory(path.dirname(configFile));
      } catch {
        markControlHookLinkTransaction(directory, manifest, "manual-recovery-required");
        return MANUAL_RECOVERY;
      }
      const republished = lstatMaybe(configFile);
      const republishedTarget = republished?.isSymbolicLink() ? fs.readlinkSync(configFile) : undefined;
      if (!republished || !sameHookIdentity(republished, manifest.captured) ||
          republishedTarget !== manifest.capturedTarget) {
        markControlHookLinkTransaction(directory, manifest, "manual-recovery-required");
        return MANUAL_RECOVERY;
      }
      markControlHookLinkTransaction(directory, manifest, "foreign-republished");
      return FOREIGN;
    }

    validateControlHookLinkArtifacts(directory, manifest);
    manifest.deleteIntent = "captured-link";
    markControlHookLinkTransaction(directory, manifest, "delete-intent");
    validateControlHookLinkArtifacts(directory, manifest);
    fs.unlinkSync(capturedPath);
    syncDirectory(directory);
    manifest.artifacts = manifest.artifacts.filter((name) => name !== "captured-link");
    delete manifest.identities["captured-link"];
    manifest.deleteIntent = undefined;
    markControlHookLinkTransaction(directory, manifest, "removed-owned");
    return CHANGED;
  } catch {
    return recoverControlHookLinkError(directory);
  }
}

function inspectControlHookLinkTransaction() {
  const directory = controlHookLinkTransactionDirectory();
  const manifest = readControlHookLinkManifest(directory);
  validateControlHookLinkArtifacts(directory, manifest);
  process.stdout.write(`${JSON.stringify({ stage: manifest.stage, deleteIntent: manifest.deleteIntent })}\n`);
  return CHANGED;
}

function finalizeControlHookLinkTransaction() {
  const directory = controlHookLinkTransactionDirectory();
  const manifest = readControlHookLinkManifest(directory);
  validateControlHookLinkArtifacts(directory, manifest);
  const expectedStage = transactionEvidence ?? "";
  if (manifest.stage === "finalize-intent") {
    if (manifest.finalizeFrom !== expectedStage || !CONTROL_HOOK_LINK_FINALIZABLE_STAGES.has(expectedStage)) {
      throw new Error("control hook link finalize intent does not match");
    }
  } else {
    if (manifest.stage !== expectedStage || !CONTROL_HOOK_LINK_FINALIZABLE_STAGES.has(manifest.stage)) {
      throw new Error("control hook link transaction is not finalizable");
    }
    manifest.finalizeFrom = expectedStage;
    manifest.deleteIntent = undefined;
    markControlHookLinkTransaction(directory, manifest, "finalize-intent");
  }
  while (manifest.artifacts.length > 0) {
    const name = manifest.deleteIntent ?? manifest.artifacts.at(-1);
    if (!manifest.deleteIntent) {
      manifest.deleteIntent = name;
      writeControlHookLinkManifest(directory, manifest);
    }
    const target = controlHookLinkTransactionFile(directory, name);
    const info = lstatMaybe(target);
    if (info) {
      if (!sameHookIdentity(info, manifest.identities[name]) || info.isDirectory()) {
        throw new Error("control hook link finalize artifact identity changed");
      }
      fs.unlinkSync(target);
      syncDirectory(directory);
    }
    manifest.artifacts = manifest.artifacts.filter((candidate) => candidate !== name);
    delete manifest.identities[name];
    manifest.deleteIntent = undefined;
    writeControlHookLinkManifest(directory, manifest);
  }
  fs.unlinkSync(controlHookLinkTransactionFile(directory, "manifest.json"));
  fs.rmdirSync(directory);
  try {
    syncDirectory(path.dirname(configFile));
  } catch {
    process.stdout.write("transaction evidence was removed; parent-directory durability is unconfirmed\n");
    return CLEANUP_UNCONFIRMED;
  }
  return CHANGED;
}

function registerStdio() {
  const current = safeExistingFile(configFile);
  const settings = parsedJson(current.text);
  if (settings.mcpServers !== undefined && !objectMap(settings.mcpServers)) failForeign();
  settings.mcpServers ??= {};
  const existing = settings.mcpServers["jhw-notion"];
  if (existing !== undefined && !isOwnedStdio(existing)) failForeign();
  settings.mcpServers["jhw-notion"] = {
    type: "stdio",
    command: "node",
    args: [mcpEntry],
    env: { NOTION_API_KEY: "${NOTION_API_KEY}" },
  };
  saveIfChanged(configFile, current.text, settings, current.mode);
}

function unregisterStdio() {
  const current = safeExistingFile(configFile);
  if (!current.exists) process.exit(UNCHANGED);
  const settings = parsedJson(current.text);
  const servers = objectMap(settings.mcpServers);
  const existing = servers?.["jhw-notion"];
  if (existing === undefined || !isOwnedStdio(existing)) process.exit(UNCHANGED);
  delete servers["jhw-notion"];
  if (Object.keys(servers).length === 0) delete settings.mcpServers;
  saveIfChanged(configFile, current.text, settings, current.mode);
}

function registerOpenCode() {
  const current = safeExistingFile(configFile);
  const settings = parsedJson(current.text);
  if (settings.mcp !== undefined && !objectMap(settings.mcp)) failForeign();
  if (settings.mcpServers !== undefined && !objectMap(settings.mcpServers)) failForeign();
  const existing = settings.mcp?.["jhw-notion"];
  const legacy = settings.mcpServers?.["jhw-notion"];
  if (existing !== undefined && !isOwnedOpenCode(existing)) failForeign();
  if (legacy !== undefined && !isOwnedStdio(legacy)) failForeign();
  settings["$schema"] ??= "https://opencode.ai/config.json";
  settings.mcp ??= {};
  settings.mcp["jhw-notion"] = { type: "local", command: ["node", mcpEntry], enabled: true };
  if (legacy !== undefined) {
    delete settings.mcpServers["jhw-notion"];
    if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
  }
  saveIfChanged(configFile, current.text, settings, current.mode);
}

function unregisterOpenCode() {
  const current = safeExistingFile(configFile);
  if (!current.exists) process.exit(UNCHANGED);
  const settings = parsedJson(current.text);
  let changed = false;
  const local = objectMap(settings.mcp);
  const localEntry = local?.["jhw-notion"];
  if (localEntry !== undefined && isOwnedOpenCode(localEntry)) {
    delete local["jhw-notion"];
    if (Object.keys(local).length === 0) delete settings.mcp;
    changed = true;
  }
  const legacy = objectMap(settings.mcpServers);
  const legacyEntry = legacy?.["jhw-notion"];
  if (legacyEntry !== undefined && isOwnedStdio(legacyEntry)) {
    delete legacy["jhw-notion"];
    if (Object.keys(legacy).length === 0) delete settings.mcpServers;
    changed = true;
  }
  if (!changed) process.exit(UNCHANGED);
  saveIfChanged(configFile, current.text, settings, current.mode);
}

const parentHeader = "[mcp_servers.jhw-notion]";
const childPrefix = "[mcp_servers.jhw-notion.";

function stripTomlComment(line) {
  let quote;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && !escaped) {
      if (quote === character) quote = undefined;
      else if (quote === undefined) quote = character;
    }
    if (character === "#" && quote === undefined) return line.slice(0, index);
    escaped = false;
  }
  return line;
}

function decodeTomlBasicKey(encoded) {
  const normalized = encoded.replace(/\\U([0-9a-fA-F]{8})/g, (_escape, hex) => {
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) throw new Error("invalid code point");
    if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    const offset = codePoint - 0x10000;
    const high = 0xd800 + (offset >> 10);
    const low = 0xdc00 + (offset & 0x3ff);
    return `\\u${high.toString(16)}\\u${low.toString(16)}`;
  });
  return JSON.parse(normalized);
}

function tomlDottedKeys(inner) {
  const keys = [];
  let cursor = 0;
  while (cursor < inner.length) {
    while (/\s/.test(inner[cursor] ?? "")) cursor += 1;
    if (cursor >= inner.length) return undefined;
    let key = "";
    const quote = inner[cursor];
    if (quote === '"' || quote === "'") {
      const start = cursor;
      cursor += 1;
      let escaped = false;
      while (cursor < inner.length) {
        const character = inner[cursor];
        if (quote === '"' && character === "\\" && !escaped) {
          escaped = true;
          cursor += 1;
          continue;
        }
        if (character === quote && !escaped) break;
        escaped = false;
        cursor += 1;
      }
      if (inner[cursor] !== quote) return undefined;
      const encoded = inner.slice(start, cursor + 1);
      try { key = quote === '"' ? decodeTomlBasicKey(encoded) : encoded.slice(1, -1); } catch { return undefined; }
      cursor += 1;
    } else {
      const start = cursor;
      while (cursor < inner.length && inner[cursor] !== "." && !/\s/.test(inner[cursor])) cursor += 1;
      key = inner.slice(start, cursor);
    }
    if (!key) return undefined;
    keys.push(key);
    while (/\s/.test(inner[cursor] ?? "")) cursor += 1;
    if (cursor === inner.length) break;
    if (inner[cursor] !== ".") return undefined;
    cursor += 1;
  }
  return keys;
}

function tomlHeaderKeys(line) {
  const trimmed = stripTomlComment(line).trim();
  if (!trimmed.startsWith("[") || trimmed.startsWith("[[") || !trimmed.endsWith("]")) return undefined;
  return tomlDottedKeys(trimmed.slice(1, -1));
}

function tomlArrayHeaderKeys(line) {
  const trimmed = stripTomlComment(line).trim();
  if (!trimmed.startsWith("[[") || !trimmed.endsWith("]]")) return undefined;
  return tomlDottedKeys(trimmed.slice(2, -2));
}

function tomlAssignmentKeys(line) {
  const source = stripTomlComment(line);
  let quote;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && !escaped) {
      if (quote === character) quote = undefined;
      else if (quote === undefined) quote = character;
    } else if (character === "=" && quote === undefined) {
      return tomlDottedKeys(source.slice(0, index).trim());
    }
    escaped = false;
  }
  return undefined;
}

function sameNameTomlHeader(line) {
  const keys = tomlHeaderKeys(line);
  return keys?.[0] === "mcp_servers" && keys[1] === "jhw-notion";
}

function hasConflictingTomlAssignment(lines) {
  let currentTable;
  for (const line of lines) {
    const header = tomlHeaderKeys(line) ?? tomlArrayHeaderKeys(line);
    if (header) {
      currentTable = header;
      continue;
    }
    const keys = tomlAssignmentKeys(line);
    if (!keys) continue;
    if (currentTable?.length === 1 && currentTable[0] === "mcp_servers" && keys[0] === "jhw-notion") {
      return true;
    }
    if (currentTable === undefined && keys[0] === "mcp_servers" &&
        (keys.length === 1 || keys[1] === "jhw-notion")) {
      // A root inline-table assignment cannot be extended later by a table header.
      return true;
    }
  }
  return false;
}

function tomlRange(source) {
  const lines = source.length ? source.split("\n") : [];
  const starts = lines.flatMap((line, index) => line.trim() === parentHeader ? [index] : []);
  const sameNameIndexes = lines.flatMap((line, index) => {
    const keys = tomlHeaderKeys(line) ?? tomlArrayHeaderKeys(line);
    return keys?.[0] === "mcp_servers" && keys[1] === "jhw-notion" ? [index] : [];
  });
  const hasSameName = sameNameIndexes.length > 0;
  const hasConflictingAssignment = hasConflictingTomlAssignment(lines);
  const hasAlternate = lines.some((line) => sameNameTomlHeader(line) &&
    line.trim() !== parentHeader && !line.trim().startsWith(childPrefix));
  if (starts.length === 0) return { lines, hasOrphan: hasSameName || hasConflictingAssignment, hasAlternate };
  if (starts.length !== 1) failForeign();
  const start = starts[0];
  let parentEnd = start + 1;
  while (parentEnd < lines.length && !/^\s*\[/.test(lines[parentEnd])) parentEnd += 1;
  let end = parentEnd;
  while (end < lines.length) {
    const header = lines[end].trim();
    if (!header.startsWith(childPrefix)) break;
    end += 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  }
  const noncontiguous = sameNameIndexes.some((index) => index < start || index >= end);
  return {
    lines,
    start,
    parentEnd,
    end,
    hasOrphan: false,
    hasAlternate: hasAlternate || noncontiguous || hasConflictingAssignment,
  };
}

function ownedToml(source) {
  const range = tomlRange(source);
  if (range.start === undefined) return { owned: false, range };
  if (range.hasAlternate) return { owned: false, range };
  const parent = range.lines.slice(range.start + 1, range.parentEnd);
  const commands = parent.map((line) => /^\s*command\s*=\s*"([^"]*)"\s*$/.exec(line)).filter(Boolean);
  const argsLines = parent.map((line) => /^\s*args\s*=\s*(\[.*\])\s*$/.exec(line)).filter(Boolean);
  if (commands.length !== 1 || argsLines.length !== 1 || commands[0][1] !== "node") return { owned: false, range };
  let args;
  try { args = JSON.parse(argsLines[0][1]); } catch { return { owned: false, range }; }
  return { owned: Array.isArray(args) && args.length === 1 && isOwnedEntryPath(args[0]), range };
}

function codexEntry() {
  return [
    parentHeader,
    'command = "node"',
    `args = [${JSON.stringify(mcpEntry)}]`,
    "startup_timeout_sec = 60.0",
  ];
}

function saveToml(current, next) {
  if (next === current.text) process.exit(UNCHANGED);
  if (current.text.length) {
    if (!backupStamp || !/^\d{14}$/.test(backupStamp)) throw new Error("invalid backup stamp");
    const backup = `${configFile}.bak.jhw-notion.${backupStamp}.${randomUUID()}`;
    atomicWrite(backup, current.text, current.mode, { exclusive: true });
  }
  atomicWrite(configFile, next, current.mode);
  process.exit(CHANGED);
}

function registerCodex() {
  const current = safeExistingFile(configFile);
  const inspected = ownedToml(current.text);
  if ((inspected.range.start !== undefined && !inspected.owned) ||
      (inspected.range.start === undefined && inspected.range.hasOrphan)) failForeign();
  let output;
  if (inspected.range.start !== undefined) {
    const suffix = inspected.range.lines.slice(inspected.range.end);
    output = [
      ...inspected.range.lines.slice(0, inspected.range.start),
      ...codexEntry(),
      ...(suffix.length === 0 && current.text.endsWith("\n") ? [""] : suffix),
    ].join("\n");
  } else {
    const body = current.text.replace(/\n+$/, "");
    output = body ? `${body}\n\n${codexEntry().join("\n")}\n` : `${codexEntry().join("\n")}\n`;
  }
  saveToml(current, output);
}

function unregisterCodex() {
  const current = safeExistingFile(configFile);
  if (!current.exists) process.exit(UNCHANGED);
  const inspected = ownedToml(current.text);
  if (!inspected.owned || inspected.range.start === undefined) process.exit(UNCHANGED);
  const output = [
    ...inspected.range.lines.slice(0, inspected.range.start),
    ...inspected.range.lines.slice(inspected.range.end),
  ].join("\n");
  saveToml(current, output);
}

try {
  if (operation === "register-stdio") registerStdio();
  if (operation === "unregister-stdio") unregisterStdio();
  if (operation === "register-opencode") registerOpenCode();
  if (operation === "unregister-opencode") unregisterOpenCode();
  if (operation === "register-codex") registerCodex();
  if (operation === "unregister-codex") unregisterCodex();
  if (operation === "unregister-codex-hooks-transaction") process.exit(unregisterCodexHooksTransaction());
  if (operation === "register-codex-hooks-transaction") process.exit(registerCodexHooksTransaction());
  if (operation === "rollback-codex-hooks-transaction") process.exit(rollbackCodexHooksTransaction());
  if (operation === "inspect-codex-hooks-transaction") process.exit(inspectCodexHooksTransaction());
  if (operation === "finalize-codex-hooks-transaction") process.exit(finalizeCodexHooksTransaction());
  if (operation === "remove-control-hook-link-transaction") process.exit(removeControlHookLinkTransaction());
  if (operation === "inspect-control-hook-link-transaction") process.exit(inspectControlHookLinkTransaction());
  if (operation === "finalize-control-hook-link-transaction") process.exit(finalizeControlHookLinkTransaction());
  process.exit(2);
} catch {
  process.exit(1);
}
