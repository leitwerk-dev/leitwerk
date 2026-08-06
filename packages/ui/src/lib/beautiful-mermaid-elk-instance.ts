import type { ElkNode } from "elkjs";
import ElkBundledWorker from "./elk-bundled-worker.js";

interface RawFakeWorker {
	onmessage: ((event: { data: Record<string, unknown> }) => void) | null;
	dispatcher: {
		saveDispatch(message: { data: Record<string, unknown> }): void;
	};
}

let elk: ElkBundledWorker | null = null;
let rawWorker: RawFakeWorker | null = null;

function ensureElk(): void {
	if (elk) return;
	const pending: Array<() => void> = [];
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: () => void, delay?: number) => {
		if (delay === 0) {
			pending.push(callback);
			return 0;
		}
		return originalSetTimeout(callback, delay);
	}) as typeof globalThis.setTimeout;
	try {
		elk = new ElkBundledWorker();
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
	for (const callback of pending) callback();
	rawWorker = elk.worker.worker;
}

export function elkLayoutSync(graph: ElkNode): ElkNode {
	ensureElk();
	if (!rawWorker) throw new Error("ELK in-process worker is unavailable");
	let result: ElkNode | undefined;
	let error: unknown;
	const originalOnMessage = rawWorker.onmessage;
	rawWorker.onmessage = (answer) => {
		if (answer.data.error) error = answer.data.error;
		else result = answer.data.data as ElkNode;
	};
	try {
		rawWorker.dispatcher.saveDispatch({
			data: { id: 0, cmd: "layout", graph } as unknown as Record<string, unknown>,
		});
	} finally {
		rawWorker.onmessage = originalOnMessage;
	}
	if (error) throw error;
	if (!result) throw new Error("ELK layout did not return synchronously");
	return result;
}
