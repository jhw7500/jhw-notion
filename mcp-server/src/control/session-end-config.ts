import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";

import { loadControlConfig, type ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";

// The secure host's data-only control.env contract; never load credentials or
// source shell code. This fallback belongs only to evidence-only SessionEnd.
const coordinateKeys = [
  "JHW_REGISTRY_DIR", "JHW_REGISTRY_REMOTE", "JHW_REGISTRY_BRANCH",
  "JHW_WORKTREE_ROOT", "JHW_CONTROL_STATE_DIR", "JHW_BUILD_HOST",
  "JHW_GITHUB_OWNER", "JHW_PROJECT_NUMBER", "JHW_REGISTRY_REPOSITORY",
  "JHW_PREFLIGHT_PROJECT_ITEM_ID", "JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER",
] as const;
const maximumConfigBytes = 16 * 1024;

function invalidConfig(): ControlError {
  return new ControlError("INVALID_CONFIG", "SessionEnd host configuration is missing or unsafe");
}

function readPrivateCoordinates(file: string): NodeJS.ProcessEnv {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.uid !== process.getuid?.() ||
        (before.mode & 0o7777) !== 0o600 || before.nlink !== 1 || before.size > maximumConfigBytes) {
      throw invalidConfig();
    }
    const buffer = Buffer.alloc(maximumConfigBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    if (length > maximumConfigBytes || length !== before.size ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw invalidConfig();
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    if (text.includes("\0")) throw invalidConfig();
    const values: NodeJS.ProcessEnv = {};
    for (const line of text.split(/\r\n|\n|\r/)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/.exec(line);
      if (!match) throw invalidConfig();
      const key = match[1];
      const value = match[2];
      if (key === undefined || value === undefined ||
          !(coordinateKeys as readonly string[]).includes(key) || Object.hasOwn(values, key) ||
          !value || value !== value.trim() || /[$`'"\\;&|<>()\u0000-\u001f\u007f]/u.test(value)) {
        throw invalidConfig();
      }
      values[key] = value;
    }
    if (coordinateKeys.some((key) => !Object.hasOwn(values, key))) throw invalidConfig();
    return values;
  } catch {
    // Neither file paths nor untrusted config bytes reach the hook protocol.
    throw invalidConfig();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function loadSessionEndConfig(environment: NodeJS.ProcessEnv): ControlConfig {
  // Any explicit coordinate selects the environment as a whole. Never repair a
  // partial source with file values that may identify another host or Registry.
  if (coordinateKeys.some((key) => environment[key] !== undefined)) return loadControlConfig(environment);
  const home = environment.HOME ?? userInfo().homedir;
  if (!isAbsolute(home) || resolve(home) === parse(resolve(home)).root) throw invalidConfig();
  const coordinates = readPrivateCoordinates(join(home, ".config/jhw-control/control.env"));
  // This evidence-only composition does not consume ambient Guard policy.
  return loadControlConfig(coordinates);
}
