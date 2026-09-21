import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createServer } from "vite";

const { values } = parseArgs({ options: { "reports-dir": { type: "string" } } });
const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.API_REPORTS_DIR = path.resolve(
	values["reports-dir"] ?? path.join(tool, "../../.leitwerk/api-explorer/reports"),
);
const server = await createServer({ root: tool, configFile: path.join(tool, "vite.config.ts") });
await server.listen();
server.printUrls();
