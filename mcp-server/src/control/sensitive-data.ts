import { isAbsolute, normalize, parse } from "node:path";

import { ControlError } from "./errors.js";

const MAX_SCAN_BYTES = 256 * 1024;
const MAX_SCAN_NODES = 10_000;
const MAX_TERMS = 128;
const MIN_TERM_BYTES = 8;
const secretKey = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

export function isSensitiveEnvironmentKey(key: string): boolean {
  return secretKey.test(key);
}

export interface SensitiveDataPolicy {
  assertSafe(value: unknown): void;
}

function usableTerm(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= MIN_TERM_BYTES;
}

function privatePathTerm(value: string): string | undefined {
  if (!isAbsolute(value) || value === parse(value).root) return undefined;
  const canonical = normalize(value);
  return usableTerm(canonical) ? canonical : undefined;
}

function rejected(): ControlError {
  return new ControlError("SENSITIVE_DATA_REJECTED", "Content contains protected host data");
}

function scanBounded(value: unknown, inspect: (candidate: string) => void): void {
  let bytes = 0;
  let nodes = 0;
  const visited = new Set<object>();
  const scan = (candidate: unknown): void => {
    nodes += 1;
    if (nodes > MAX_SCAN_NODES) throw new ControlError("SENSITIVE_SCAN_TOO_LARGE", "Content scan exceeded its deterministic boundary");
    if (typeof candidate === "string") {
      bytes += Buffer.byteLength(candidate, "utf8");
      if (bytes > MAX_SCAN_BYTES) throw new ControlError("SENSITIVE_SCAN_TOO_LARGE", "Content scan exceeded its deterministic boundary");
      inspect(candidate);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    if (visited.has(candidate)) throw new ControlError("SENSITIVE_SCAN_TOO_LARGE", "Content scan contains a cycle");
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) scan(entry);
    } else {
      for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
        scan(key);
        scan(entry);
      }
    }
  };
  scan(value);
}

// A host path token may be framed by prose punctuation (`,/srv`, `[/srv]`,
// `;C:\\private`) as well as whitespace.  Exclude only characters that can
// legitimately continue a URL, repository slug, or relative path, and retain
// the double-slash guard so `https://...` is not classified as a Unix path.
const embeddedUnixPath = /(?:^|[^A-Za-z0-9_./-])\/(?!\/)[^\s"'`<>|]+/u;
const embeddedWindowsPath = /(?:^|[^A-Za-z0-9_./\\-])[A-Za-z]:[\\/][^\s"'`<>|]+/u;
// File URIs are host-path carriers regardless of surrounding punctuation.
// Keep this aligned with the direct-error sanitizer rather than trying to
// enumerate every prose/Markdown delimiter.
const embeddedFileUri = /file:\/\//iu;

/** Rejects host-absolute paths only at content boundaries, never operational path arguments. */
export function assertNoAbsoluteHostPaths(value: unknown): void {
  scanBounded(value, (candidate) => {
    if (embeddedUnixPath.test(candidate) || embeddedWindowsPath.test(candidate) || embeddedFileUri.test(candidate)) throw rejected();
  });
}

/** Bounded reject-before-persist/outbound policy; it never returns a match. */
export function createSensitiveDataPolicy(
  environment: NodeJS.ProcessEnv = process.env,
  privatePaths: readonly string[] = [],
): SensitiveDataPolicy {
  const terms = new Set<string>();
  for (const [key, value] of Object.entries(environment)) {
    if (isSensitiveEnvironmentKey(key) && usableTerm(value)) terms.add(value);
  }
  for (const path of privatePaths) {
    const term = privatePathTerm(path);
    if (term) terms.add(term);
  }
  const orderedTerms = [...terms].sort((left, right) => right.length - left.length);
  const termOverflow = orderedTerms.length > MAX_TERMS;
  const protectedTerms = orderedTerms.slice(0, MAX_TERMS);

  return {
    assertSafe(value: unknown): void {
      if (termOverflow) {
        throw new ControlError("SENSITIVE_SCAN_TOO_LARGE", "Protected-term scan exceeded its deterministic boundary");
      }
      scanBounded(value, (candidate) => {
        if (protectedTerms.some((term) => candidate.includes(term))) throw rejected();
      });
    },
  };
}
