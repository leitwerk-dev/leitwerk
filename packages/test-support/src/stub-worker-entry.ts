import { createWorkerEntryRuntime } from "@leitwerk-dev/worker";
import { createSchemaDrivenStubPiFactory } from "./worker-testing/schema-driven-stub-pi.js";

const runtime = createWorkerEntryRuntime({
	piFactory: createSchemaDrivenStubPiFactory(),
});

void runtime.start().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
