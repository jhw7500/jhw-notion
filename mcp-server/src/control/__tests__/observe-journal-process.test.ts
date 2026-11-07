import { expect, it } from "vitest";
import { z } from "zod";

import { ObserveJournal } from "../observe-journal.js";
import type { SecureStateDirectoryHooks } from "../journal.js";

const stateDir = process.env.OBSERVE_PROCESS_STATE_DIR;
const mode = process.env.OBSERVE_PROCESS_MODE;
const sequence = Number(process.env.OBSERVE_PROCESS_SEQUENCE);

it.skipIf(!stateDir || !mode || !Number.isSafeInteger(sequence))(
  "publishes one observe row from an independent process",
  async () => {
    const hooks: SecureStateDirectoryHooks = mode === "short"
      ? {
          afterDirectoryOpen(directory) {
            const openFile = directory.openFile.bind(directory);
            directory.openFile = async (name, flags, fileMode) => {
              const file = await openFile(name, flags, fileMode);
              if (name === "guard-observe-journal.v1.jsonl") {
                const write = file.write.bind(file);
                Object.defineProperty(file, "write", {
                  configurable: true,
                  value: async (bytes: Buffer) => write(bytes.subarray(0, Math.max(1, bytes.length - 2))),
                });
              }
              return file;
            };
          },
        }
      : {};
    const append = new ObserveJournal(stateDir!, z.object({ sequence: z.number().int() }).strict(), hooks)
      .append({ sequence });
    if (mode === "normal") await expect(append).resolves.toBeUndefined();
    else await expect(append).rejects.toMatchObject({ code: "JOURNAL_WRITE_FAILED" });
  },
);
