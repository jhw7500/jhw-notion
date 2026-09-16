import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

declare const __JHW_BUNDLED_CONTROL_TOOL_VERSION__: string | undefined;

const version = typeof __JHW_BUNDLED_CONTROL_TOOL_VERSION__ === "string"
  ? __JHW_BUNDLED_CONTROL_TOOL_VERSION__
  : (JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
      version?: unknown;
    }).version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Control package version is invalid");
}

/** One runtime version source shared with package metadata. */
export const CONTROL_TOOL_VERSION = version;
