import { rm } from "node:fs/promises";

// Keep cleanup auditable and scoped to this package's generated dist tree.
const generatedDistDirectory = new URL("../dist", import.meta.url);
await rm(generatedDistDirectory, { recursive: true, force: true });
