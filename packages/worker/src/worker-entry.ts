import { createWorkerEntryRuntime } from "./entry-runtime.js";

const runtime = createWorkerEntryRuntime();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		void runtime.stop(signal).then(
			() => process.exit(0),
			() => process.exit(1),
		);
	});
}

void runtime.start().catch((e) => {
	console.error(e);
	process.exit(1);
});
