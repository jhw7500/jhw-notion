const sensitiveEnvironmentKey = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;
const unixHostPath = /(^|[^A-Za-z0-9_./-])(\/(?!\/)[^\s"'`<>|]+)/gu;
const windowsHostPath = /(^|[^A-Za-z0-9_./\\-])([A-Za-z]:[\\/][^\s"'`<>|]+)/gu;
const fileUri = /file:\/\/[^\s"'`<>|]*/giu;
const maximumErrorNodes = 2_000;

function protectedTerms(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => sensitiveEnvironmentKey.test(key) && value && Buffer.byteLength(value, "utf8") >= 8)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

/**
 * Deliberately conservative, and it costs nothing to be. A message is never
 * emitted — `controlErrorResult` sends the stable code, the claim coordinates
 * on a Claim conflict, a schema-pinned `reason` identifier where a throw site
 * sets one, and nothing else — so a slash command or non-ASCII prose mangled
 * here is read only by whoever is debugging. Anything an operator has to act
 * on belongs in the code or that bounded reason, not the message.
 *
 * What must survive is the other half: the coordinates that are emitted. Branch
 * names and worktree refs carry slashes, and a Claim conflict is useless
 * without them, so widening this to catch every slash would break the one
 * diagnosis that reaches anyone. The Claim conflict test in
 * __tests__/cli.test.ts pins that, and it is not alone: catching every slash
 * fails five tests across four suites.
 */
function sanitizeString(value: string, terms: readonly string[]): string {
  let safe = value;
  for (const term of terms) safe = safe.split(term).join("[REDACTED]");
  return safe
    .replace(fileUri, "[REDACTED]")
    .replace(unixHostPath, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(windowsHostPath, (_match, prefix: string) => `${prefix}[REDACTED]`);
}

function sanitizeDetails(value: Record<string, unknown>, terms: readonly string[]): Record<string, unknown> {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const walk = (candidate: unknown): unknown => {
    nodes += 1;
    if (nodes > maximumErrorNodes) return "[REDACTED]";
    if (typeof candidate === "string") return sanitizeString(candidate, terms);
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (seen.has(candidate)) return "[REDACTED]";
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.map(walk);
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .map(([key, entry]) => [sanitizeString(key, terms), walk(entry)]),
    );
  };
  return walk(value) as Record<string, unknown>;
}

export class ControlError extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    readonly code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    const terms = protectedTerms();
    super(sanitizeString(message, terms));
    this.name = "ControlError";
    this.details = sanitizeDetails(details, terms);
  }
}
