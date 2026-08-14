import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const metadata = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
  version?: unknown;
};

if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
  throw new Error("Control package version is invalid");
}

/** One runtime version source shared with package metadata. */
export const CONTROL_TOOL_VERSION = metadata.version;
