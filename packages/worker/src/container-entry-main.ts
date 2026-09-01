import { writeFile } from "node:fs/promises";
import { runWorkerContainerEntrypoint } from "./container-entry.js";

const KUBERNETES_TERMINATION_LOG = "/dev/termination-log";
const MAX_STARTUP_DIAGNOSTIC_BYTES = 2_048;

function boundedStartupDiagnostic(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const bytes = Buffer.from(message);
	return bytes.length <= MAX_STARTUP_DIAGNOSTIC_BYTES
		? message
		: bytes.subarray(0, MAX_STARTUP_DIAGNOSTIC_BYTES).toString();
}

void runWorkerContainerEntrypoint()
	.then((code) => {
		process.exitCode = code;
	})
	.catch(async (error) => {
		const diagnostic = boundedStartupDiagnostic(error);
		console.error(diagnostic);
		await writeFile(KUBERNETES_TERMINATION_LOG, diagnostic).catch(() => undefined);
		process.exitCode = 1;
	});
