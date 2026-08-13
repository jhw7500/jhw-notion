import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import type { ZodType } from "zod";

import { ControlError } from "./errors.js";

export async function readRecord<T>(path: string, schema: ZodType<T>): Promise<T> {
  try {
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(result.error.message);
    }
    return result.data;
  } catch (error) {
    if (error instanceof ControlError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ControlError("INVALID_RECORD", `Invalid Registry record: ${path}`, { path, cause: message });
  }
}

export async function writeRecord(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const tempPath = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
