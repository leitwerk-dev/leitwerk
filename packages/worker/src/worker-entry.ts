import { createWorkerEntryRuntime } from "./entry-runtime.js";

const runtime = createWorkerEntryRuntime();

void runtime.start().catch((e) => {
	console.error(e);
	process.exit(1);
});
