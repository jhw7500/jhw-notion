import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, parse, resolve } from "node:path";

import { ControlError } from "./errors.js";

export const CONTROL_COORDINATE_KEYS = [
  "JHW_REGISTRY_DIR", "JHW_REGISTRY_REMOTE", "JHW_REGISTRY_BRANCH",
  "JHW_WORKTREE_ROOT", "JHW_CONTROL_STATE_DIR", "JHW_BUILD_HOST",
  "JHW_GITHUB_OWNER", "JHW_PROJECT_NUMBER", "JHW_REGISTRY_REPOSITORY",
  "JHW_PREFLIGHT_PROJECT_ITEM_ID", "JHW_PREFLIGHT_REGISTRY_ISSUE_NUMBER",
] as const;

type PrivateConfigName = "control.env" | "guard-policy.json";
interface PinnedDirectory { descriptor: number; parent?: number; name: string; snapshot: BigIntStats }
interface PinnedFile { descriptor: number; name: PrivateConfigName; snapshot: BigIntStats }

function invalid(): never {
  throw new ControlError("INVALID_CONFIG", "Private host configuration is missing or unsafe");
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return (["dev", "ino", "uid", "gid", "mode"] as const).every((key) => left[key] === right[key]);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameDirectory(left, right) && (["nlink", "size", "mtimeNs", "ctimeNs"] as const)
    .every((key) => left[key] === right[key]);
}

export interface PrivateControlReader {
  read(name: PrivateConfigName, maximumBytes: number, optional?: boolean): Buffer | undefined;
}

/** Reads both files synchronously through one pinned host configuration directory. */
export function withPrivateControlDirectory<T>(
  home: string,
  use: (reader: PrivateControlReader) => T,
  options: { optional?: boolean; trustedParents?: boolean } = {},
): T | undefined {
  const opened: number[] = [];
  const directories: PinnedDirectory[] = [];
  const files: PinnedFile[] = [];
  const absent: PrivateConfigName[] = [];
  try {
    if (!isAbsolute(home)) invalid();
    const selectedHome = resolve(home);
    if (selectedHome === parse(selectedHome).root || selectedHome.length > 4096) invalid();
    const uid = process.getuid?.();
    if (uid === undefined) invalid();
    const owner = BigInt(uid);
    const root = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    opened.push(root);
    directories.push({ descriptor: root, name: "/", snapshot: fstatSync(root, { bigint: true }) });
    const components = selectedHome.split("/").filter(Boolean);
    const homeDepth = components.length;
    components.push(".config", "jhw-control");
    for (const [index, name] of components.entries()) {
      const parent = directories.at(-1)!.descriptor;
      let descriptor: number;
      try {
        descriptor = openSync(`/proc/self/fd/${parent}/${name}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (cause) {
        if (options.optional && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw cause;
      }
      opened.push(descriptor);
      const snapshot = fstatSync(descriptor, { bigint: true });
      directories.push({ descriptor, parent, name, snapshot });
      const privateNamespace = index >= homeDepth - 1;
      const stickyRootAncestor = !privateNamespace && snapshot.uid === 0n && (snapshot.mode & 0o1000n) !== 0n;
      if (!snapshot.isDirectory()) invalid();
      if (options.trustedParents !== false && (
        (snapshot.uid !== owner && (privateNamespace || snapshot.uid !== 0n)) ||
        (snapshot.mode & 0o022n) !== 0n && !stickyRootAncestor
      )) invalid();
    }
    const directory = directories.at(-1)!.descriptor;
    const at = (name: string) => `/proc/self/fd/${directory}/${name}`;
    const verify = () => {
      for (const pinned of directories) {
        const current = pinned.parent === undefined ? "/" : `/proc/self/fd/${pinned.parent}/${pinned.name}`;
        if (!sameDirectory(pinned.snapshot, fstatSync(pinned.descriptor, { bigint: true })) ||
            !sameDirectory(pinned.snapshot, lstatSync(current, { bigint: true }))) invalid();
      }
      for (const file of files) {
        if (!sameFile(file.snapshot, fstatSync(file.descriptor, { bigint: true })) ||
            !sameFile(file.snapshot, lstatSync(at(file.name), { bigint: true }))) invalid();
      }
      for (const name of absent) {
        try { lstatSync(at(name)); } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw cause;
        }
        invalid();
      }
    };
    verify();
    const value = use({ read(name, maximumBytes, allowMissing = false) {
      if (!["control.env", "guard-policy.json"].includes(name) ||
          !Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 16 * 1024) invalid();
      verify();
      let descriptor: number;
      try {
        descriptor = openSync(at(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (cause) {
        if (allowMissing && (cause as NodeJS.ErrnoException).code === "ENOENT") {
          absent.push(name);
          return undefined;
        }
        throw cause;
      }
      opened.push(descriptor);
      const snapshot = fstatSync(descriptor, { bigint: true });
      files.push({ descriptor, name, snapshot });
      if (!snapshot.isFile() || snapshot.uid !== owner || snapshot.nlink !== 1n ||
          (snapshot.mode & 0o7777n) !== 0o600n || snapshot.size > BigInt(maximumBytes)) invalid();
      const bytes = Buffer.alloc(maximumBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > maximumBytes || BigInt(length) !== snapshot.size) invalid();
      verify();
      return bytes.subarray(0, length);
    } });
    verify();
    return value;
  } catch {
    invalid();
  } finally {
    for (const descriptor of opened.reverse()) {
      try { closeSync(descriptor); } catch { /* Close all remaining owned descriptors. */ }
    }
  }
}

export function hasControlCoordinates(environment: NodeJS.ProcessEnv): boolean {
  return CONTROL_COORDINATE_KEYS.some((key) => environment[key] !== undefined);
}

export function parsePrivateControlCoordinates(bytes: Uint8Array): NodeJS.ProcessEnv {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) invalid();
    const coordinates: NodeJS.ProcessEnv = {};
    for (const line of text.split(/\r\n|\n|\r/)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/.exec(line);
      if (!match) invalid();
      const key = match[1]!;
      const value = match[2]!;
      if (!(CONTROL_COORDINATE_KEYS as readonly string[]).includes(key) || Object.hasOwn(coordinates, key) ||
          !value || value !== value.trim() || /[$`'"\\;&|<>()\u0000-\u001f\u007f]/u.test(value)) invalid();
      coordinates[key] = value;
    }
    if (CONTROL_COORDINATE_KEYS.some((key) => !Object.hasOwn(coordinates, key))) invalid();
    return coordinates;
  } catch {
    invalid();
  }
}
