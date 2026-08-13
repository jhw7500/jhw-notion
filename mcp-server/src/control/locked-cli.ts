#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { createCliDependencies, controlErrorResult, isCliEntrypointInvocation, runCli } from "./cli.js";
import { readPrivateCredentialEnvelope, sanitizedChildEnvironment } from "./process.js";

async function main(): Promise<void> {
  try {
    // The wrapper removes all inherited credentials; only this single bounded
    // stdin envelope can restore the two gh credentials for ProcessRunner.
    const credentials = await readPrivateCredentialEnvelope(process.stdin);
    const environment = { ...sanitizedChildEnvironment(process.env), ...credentials };
    const result = await runCli(process.argv.slice(2), createCliDependencies(environment));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  } catch (cause) {
    const result = controlErrorResult(cause);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }
}

if (isCliEntrypointInvocation(process.argv[1], fileURLToPath(import.meta.url))) void main();
