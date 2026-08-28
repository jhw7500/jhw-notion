import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearch } from "./tools/search.js";
import { registerStatus } from "./tools/status.js";
import { registerContext } from "./tools/context.js";
import { registerHistory } from "./tools/history.js";
import { registerRecord } from "./tools/record.js";
import { registerNote } from "./tools/note.js";
import { registerDelete } from "./tools/delete.js";
import { registerStart } from "./tools/start.js";
import { registerClose } from "./tools/close.js";
import { registerReportPreview } from "./tools/report-preview.js";
import { registerReportExport } from "./tools/report-export.js";
import { registerRecall } from "./tools/recall.js";
import { registerRetrieve } from "./tools/retrieve.js";
import { registerAppend } from "./tools/append.js";
import { registerFetch } from "./tools/fetch.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "jhw-notion",
    version: "1.0.0",
  });

  registerSearch(server);
  registerStatus(server);
  registerContext(server);
  registerHistory(server);
  registerRecord(server);
  registerNote(server);
  registerDelete(server);
  registerStart(server);
  registerClose(server);
  registerReportPreview(server);
  registerReportExport(server);
  registerRecall(server);
  registerRetrieve(server);
  registerAppend(server);
  registerFetch(server);

  return server;
}
