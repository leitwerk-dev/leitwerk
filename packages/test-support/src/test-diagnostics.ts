import { AsyncLocalStorage } from "node:async_hooks";
import { threadId } from "node:worker_threads";

const active = new AsyncLocalStorage<ReturnType<typeof createTestDiagnostics>>();

/** @internal Bounded, in-memory trace. Call report from onTestFailed; successful tests stay quiet. */
export function createTestDiagnostics(label: string) {
	const started = performance.now();
	const events: Record<string, unknown>[] = [];
	let dropped = 0;
	const mark = (stage: string, details: Record<string, unknown> = {}) => {
		if (events.length === 512) {
			events.shift();
			dropped++;
		}
		events.push({
			...details,
			stage,
			at: new Date().toISOString(),
			elapsedMs: Math.round(performance.now() - started),
		});
	};
	const diagnostics = {
		/** @internal */
		mark,
		/** @internal */
		run<T>(fn: () => T): T {
			return active.run(diagnostics, fn);
		},
		/** @internal */
		format() {
			return JSON.stringify({ label, pid: process.pid, threadId, dropped, events }, null, 2);
		},
		/** @internal */
		report() {
			mark("diagnostics.report");
			console.error(diagnostics.format());
		},
	};
	mark("test.start");
	return diagnostics;
}

/** @internal Logs only the operation name and exit metadata, never arguments, output or environment. */
export function traceTestSubprocess<T>(operation: string, run: () => T): T {
	const trace = active.getStore();
	if (!trace) return run();
	const started = performance.now();
	trace.mark("subprocess.start", { operation });
	try {
		const result = run();
		trace.mark("subprocess.exit", {
			operation,
			status: 0,
			durationMs: Math.round(performance.now() - started),
		});
		return result;
	} catch (error) {
		const details = error as { status?: unknown; signal?: unknown; code?: unknown } | null;
		trace.mark("subprocess.exit", {
			operation,
			durationMs: Math.round(performance.now() - started),
			status: typeof details?.status === "number" ? details.status : null,
			signal: typeof details?.signal === "string" ? details.signal : null,
			code: typeof details?.code === "string" ? details.code : null,
		});
		throw error;
	}
}
