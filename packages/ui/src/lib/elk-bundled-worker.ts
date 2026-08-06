import ElkApi, { type ELKConstructorArguments } from "elkjs/lib/elk-api.js";
import elkWorkerSource from "elkjs/lib/elk-worker.min.js?raw";

interface ElkInProcessWorker {
	postMessage(message: unknown): void;
	onmessage: ((event: { data: Record<string, unknown> }) => void) | null;
	dispatcher: {
		saveDispatch(message: { data: Record<string, unknown> }): void;
	};
}

interface ElkInProcessWorkerConstructor {
	new (): ElkInProcessWorker;
}

function loadInProcessWorker(): ElkInProcessWorkerConstructor {
	// Evaluate the trusted bundled dependency with CommonJS bindings and a fake
	// document so it exports its synchronous FakeWorker instead of taking over
	// this outer worker's message handler.
	const module = { exports: {} as { Worker?: ElkInProcessWorkerConstructor } };
	const evaluate = new Function("module", "exports", "self", "document", elkWorkerSource);
	evaluate(module, module.exports, globalThis, {});
	if (!module.exports.Worker) throw new Error("ELK in-process worker did not initialize");
	return module.exports.Worker;
}

const InProcessWorker = loadInProcessWorker();
const ElkBase = ElkApi as unknown as new (
	args?: ELKConstructorArguments,
) => {
	worker: { worker: ElkInProcessWorker };
};

export default class ElkBundledWorker extends ElkBase {
	constructor(args: ELKConstructorArguments = {}) {
		super({
			...args,
			workerFactory: args.workerFactory ?? (() => new InProcessWorker() as unknown as Worker),
		});
	}
}
