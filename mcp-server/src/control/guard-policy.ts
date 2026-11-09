import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { loadControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { hasControlCoordinates, parsePrivateControlCoordinates, withPrivateControlDirectory } from "./private-control-config.js";

export interface GuardEnvironmentResolution {
  environment: NodeJS.ProcessEnv;
  source: "environment" | "private-policy";
  mode: "enforce" | "observe";
}

function invalid(): never {
  throw new ControlError("INVALID_CONFIG", "Guard host policy is missing or unsafe");
}

function assertObservePolicy(bytes: Uint8Array): void {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
    const policy = value as Record<string, unknown>;
    if (Object.keys(policy).length !== 2 || policy.version !== 1 || policy.mode !== "observe") invalid();
    // Only two scalar members are supported. Count decoded key tokens as well
    // so JSON.parse cannot hide duplicate or escaped duplicate member names.
    const keys = [...text.matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)].map((match) => JSON.parse(match[1]!));
    if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes("version") || !keys.includes("mode")) invalid();
  } catch {
    invalid();
  }
}

/** Absence grants no fallback or observe mode; existing policies still require the pinned reader. */
function hostPolicyPresent(home: string): boolean {
  if (!isAbsolute(home)) invalid();
  try {
    lstatSync(join(home, ".config", "jhw-control", "guard-policy.json"));
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    invalid();
  }
}

/** Explicit host opt-in applies only to Guard, never the ordinary CLI graph. */
export function resolveGuardEnvironment(environment: NodeJS.ProcessEnv): GuardEnvironmentResolution {
  const explicit = hasControlCoordinates(environment);
  if (explicit) loadControlConfig(environment); // Reject a partial source before reading any fallback.
  const home = environment.HOME;
  const selected = home === undefined || !hostPolicyPresent(home) ? undefined : withPrivateControlDirectory(home, (reader) => {
    const policy = reader.read("guard-policy.json", 4096, true);
    if (policy === undefined) return undefined;
    assertObservePolicy(policy);
    const coordinates = explicit ? undefined : parsePrivateControlCoordinates(reader.read("control.env", 16 * 1024)!);
    return { coordinates };
  }, { optional: true });
  if (selected !== undefined) {
    if (environment.JHW_GUARD_MODE !== undefined && environment.JHW_GUARD_MODE !== "observe" ||
        environment.JHW_GUARD_ALLOW_OBSERVE !== undefined && environment.JHW_GUARD_ALLOW_OBSERVE !== "true") invalid();
    const resolved = Object.freeze({ ...environment, ...selected.coordinates,
      JHW_GUARD_MODE: "observe", JHW_GUARD_ALLOW_OBSERVE: "true" });
    loadControlConfig(resolved);
    return Object.freeze({ environment: resolved, source: "private-policy", mode: "observe" });
  }
  const config = loadControlConfig(environment);
  return Object.freeze({ environment: Object.freeze({ ...environment }), source: "environment", mode: config.guardMode });
}
