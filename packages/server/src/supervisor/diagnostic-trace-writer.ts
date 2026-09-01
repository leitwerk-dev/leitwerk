import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface DiagnosticTraceWriter {
	append(instanceId: string, text: string): void;
}

export function createDiagnosticTraceWriter(directory: string): DiagnosticTraceWriter {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return {
		append(instanceId, text) {
			appendFileSync(path.join(directory, `${instanceId}.log`), text, {
				encoding: "utf8",
				mode: 0o600,
			});
		},
	};
}
