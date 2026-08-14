#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const [operation, configFile, mcpEntry, repositoryRoot, backupStamp] = process.argv.slice(2);
if (!operation || !configFile || !mcpEntry || !repositoryRoot) process.exit(2);

const CHANGED = 0;
const UNCHANGED = 3;
const FOREIGN = 4;

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
  process.exit(2);
} catch {
  process.exit(1);
}
