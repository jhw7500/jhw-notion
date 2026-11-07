import { userInfo } from "node:os";

import { loadControlConfig, type ControlConfig } from "./config.js";
import { ControlError } from "./errors.js";
import { hasControlCoordinates, parsePrivateControlCoordinates, withPrivateControlDirectory } from "./private-control-config.js";

export function loadSessionEndConfig(environment: NodeJS.ProcessEnv): ControlConfig {
  // Any explicit coordinate selects the environment as a whole. This evidence-
  // only path ignores ambient/private Guard policy and never initializes state.
  if (hasControlCoordinates(environment)) return loadControlConfig(environment);
  try {
    const home = environment.HOME ?? userInfo().homedir;
    const coordinates = withPrivateControlDirectory(home, (reader) =>
      parsePrivateControlCoordinates(reader.read("control.env", 16 * 1024)!),
    // Preserve the evidence-only fallback's existing directory permission
    // contract. Guard opt-in uses the helper's stricter parent trust default.
    { trustedParents: false });
    if (coordinates === undefined) throw new Error("Missing host coordinates");
    return loadControlConfig(coordinates);
  } catch {
    throw new ControlError("INVALID_CONFIG", "SessionEnd host configuration is missing or unsafe");
  }
}
