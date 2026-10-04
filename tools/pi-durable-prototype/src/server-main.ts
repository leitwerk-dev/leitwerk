// Trusted server process. Its configuration never crosses the worker transport.
import { PrototypeRuntime, type RuntimeConfig } from "./runtime.ts";

let runtime: PrototypeRuntime;
function send(value: unknown): void {
	process.send?.(value);
}
process.on("message", async (message: { id: number; method: string; args: unknown[] }) => {
	const { id, method, args } = message;
	try {
		let result: unknown;
		switch (method) {
			case "open":
				runtime = new PrototypeRuntime(args[0] as RuntimeConfig, (type, data) =>
					send({ event: type, data }),
				);
				await runtime.open();
				result = runtime.state();
				break;
			case "prepare":
				result = await runtime.prepare();
				break;
			case "run":
				result = await runtime.run(String(args[0]));
				break;
			case "state":
				result = runtime.state();
				break;
			case "history":
				result = await runtime.history();
				break;
			case "view":
				result = await runtime.view(Number(args[0]));
				break;
			case "watch":
				result = await runtime.watch(Number(args[0]), String(args[1]));
				break;
			case "probe":
				result = await runtime.probe(String(args[0]), args[1] as string | undefined);
				break;
			case "inspectWorker":
				result = runtime.worker.inspect();
				break;
			case "stop":
				result = await runtime.stop();
				break;
			case "retry":
				result = await runtime.core.retry();
				break;
			case "outcome":
				result = await runtime.core.outcome(args[0] as Parameters<typeof runtime.core.outcome>[0]);
				break;
			case "checkTool":
				result = await runtime.checkTool(Number(args[0]), String(args[1]));
				break;
			case "rejectSecret":
				result = await runtime.rejectSecret();
				break;
			case "submitInput":
				result = await runtime.submitInput(String(args[0]), String(args[1]));
				break;
			case "awaitInput":
				result = await runtime.awaitInput(Number(args[0]));
				break;
			case "close":
				await runtime.close();
				send({ id });
				process.disconnect?.();
				return;
			default:
				throw new Error("Unknown prototype command");
		}
		runtime.boundary.assertPublic(result);
		send({ id, result });
	} catch (error) {
		send({ id, error: error instanceof Error ? error.message : "Prototype operation failed" });
	}
});
