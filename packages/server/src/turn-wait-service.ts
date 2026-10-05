import { RetryableWaitError, type TurnWaitContext } from "@leitwerk-dev/process-sdk";
import type { RepositoryBundle } from "./db/repositories.js";
import type { ProcessActionRegistry } from "./process-action-registry.js";
import { ArmTurnWait, ResolveTurnWait } from "./process-engine/ops/turn-wait.js";
import { pendingTurnWait, turnWaitPredicate } from "./process-engine/turn-wait-state.js";
import type { ProcessEngine } from "./process-engine/types.js";
import type { ProcessGraphRegistry } from "./process-graph.js";

interface TurnWaitServiceDeps {
	processes: RepositoryBundle["processes"];
	projects: RepositoryBundle["projects"];
	processGraphs: ProcessGraphRegistry;
	registry: Pick<ProcessActionRegistry, "resolveContextData">;
	commands: ProcessEngine;
	require: TurnWaitContext["require"];
	now?: () => number;
	pollIntervalMs?: number;
	timeoutMs?: number;
}

/** Runs read-only predicates outside lifecycle locks. The engine fences every result. */
export function createTurnWaitService(deps: TurnWaitServiceDeps) {
	const running = new Map<string, Promise<void>>();
	const controllers = new Set<AbortController>();
	const now = deps.now ?? Date.now;
	const interval = deps.pollIntervalMs ?? 30_000;
	let stopped = false;
	let activeChecks = 0;
	const queued: Array<() => void> = [];
	function schedule(work: () => Promise<void>): Promise<void> {
		return new Promise((resolve, reject) => {
			const start = () => {
				if (stopped) {
					resolve();
					return;
				}
				activeChecks++;
				void work()
					.then(resolve, reject)
					.finally(() => {
						activeChecks--;
						queued.shift()?.();
					});
			};
			if (activeChecks < 4) start();
			else queued.push(start);
		});
	}
	if (!Number.isFinite(interval) || interval <= 0) throw new Error("Invalid wait polling interval");

	async function evaluate(instanceId: string): Promise<void> {
		let process = deps.processes.getById(instanceId);
		if (!process || !turnWaitPredicate(deps.processGraphs, process)) return;
		if (!pendingTurnWait(process)) {
			if (process.currentExecution || process.lifecycleStatus !== "active") return;
			await deps.commands.run(ArmTurnWait, { instanceId });
			process = deps.processes.getById(instanceId);
		}
		if (!process || stopped) return;
		const wait = pendingTurnWait(process);
		if (
			!wait ||
			wait.status !== "waiting" ||
			process.lifecycleStatus !== "waiting" ||
			wait.nextCheckAt > now()
		)
			return;
		const predicate = turnWaitPredicate(deps.processGraphs, process);
		if (!predicate) return;
		const projects = deps.projects.listByInstance(instanceId);
		const controller = new AbortController();
		controllers.add(controller);
		let state: unknown;
		let result: "ready" | "waiting" | "complete" | "retry" | "error";
		let message: string | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			const data = deps.registry.resolveContextData(process.processId, process);
			const context: TurnWaitContext = {
				process: structuredClone(process),
				projects: structuredClone(projects),
				params: data.params,
				state: data.state,
				signal: controller.signal,
				require: deps.require,
				setState(value) {
					if (!controller.signal.aborted) state = value;
				},
				complete: () => ({ kind: "complete" }),
			};
			const timedOut = new Promise<never>((_, reject) => {
				onAbort = () => reject(new RetryableWaitError("Waiting condition interrupted"));
				controller.signal.addEventListener("abort", onAbort, { once: true });
				timeout = setTimeout(() => {
					reject(new RetryableWaitError("Waiting condition timed out"));
					controller.abort();
				}, deps.timeoutMs ?? 30_000);
			});
			const value = await Promise.race([
				Promise.resolve().then(() => predicate(context)),
				timedOut,
			]);
			if (typeof value === "boolean") result = value ? "ready" : "waiting";
			else if (value && value.kind === "complete") result = "complete";
			else throw new Error("waitFor must return a boolean or process.complete()");
			if (state !== undefined) {
				const codec = deps.processGraphs.get(process.processId)?.stateCodec;
				if (!codec) throw new Error("Process state codec is unavailable");
				state = structuredClone(codec.serialize(codec.parse(state)));
			}
		} catch (error) {
			result = error instanceof RetryableWaitError ? "retry" : "error";
			message = error instanceof Error ? error.message.slice(0, 500) : "Waiting condition failed";
		} finally {
			if (timeout) clearTimeout(timeout);
			if (onAbort) controller.signal.removeEventListener("abort", onAbort);
			controllers.delete(controller);
		}
		if (stopped) return;
		await deps.commands.run(ResolveTurnWait, {
			instanceId,
			waitId: wait.id,
			revision: wait.revision,
			paramsJson: process.paramsJson,
			stateJson: process.stateJson,
			projectsJson: JSON.stringify(projects),
			state,
			result,
			message,
			now: now(),
			pollIntervalMs: interval,
		});
	}

	function check(instanceId: string): Promise<void> {
		if (stopped) return Promise.resolve();
		const current = running.get(instanceId);
		if (current) return current;
		// Defer evaluation until its single-flight identity is installed. Engine hooks can reenter.
		const promise = Promise.resolve()
			.then(() => schedule(() => evaluate(instanceId)))
			.finally(() => running.delete(instanceId));
		running.set(instanceId, promise);
		return promise;
	}

	return {
		check,
		async poll() {
			const errors: string[] = [];
			const candidates = deps.processes
				.listAll()
				.filter(
					(process) =>
						["waiting", "active"].includes(process.lifecycleStatus) &&
						turnWaitPredicate(deps.processGraphs, process),
				);
			// Bound remote concurrency across processes without serializing their lifecycle locks.
			let next = 0;
			await Promise.all(
				Array.from({ length: Math.min(4, candidates.length) }, async () => {
					while (next < candidates.length && !stopped) {
						const process = candidates[next++];
						if (!process) continue;
						try {
							await check(process.id);
						} catch {
							errors.push(`${process.id}:waiting_check_failed`);
						}
					}
				}),
			);
			return { errors };
		},
		async stop() {
			stopped = true;
			for (const start of queued.splice(0)) start();
			for (const controller of controllers) controller.abort();
			await Promise.allSettled(running.values());
		},
	};
}
