import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { AppContext } from "@leitwerk-dev/server";
import { waitForValue } from "./polling.js";

/** Drive a running or restarted app without bypassing process HTTP actions. */
/** @public */
export function createProcessDriver(context: () => AppContext) {
	/** @public */
	async function post(url: string, payload: Record<string, unknown> = {}) {
		const response = await context().app.inject({ method: "POST", url, payload });
		if (response.statusCode !== 200)
			throw new Error(`POST ${url} failed with ${response.statusCode}: ${response.body}`);
		return response;
	}
	/** @public */
	async function waitForProcess(
		id: string,
		predicate: (process: ProcessInstance) => boolean,
		description: string,
		timeout = 12000,
		allowError = false,
	): Promise<ProcessInstance> {
		try {
			const process = await waitForValue(
				() => {
					const current = context().deps.processes.getById(id);
					if (current?.lifecycleStatus === "error" && !allowError)
						throw new Error("Process entered error lifecycle");
					return current;
				},
				(process) => !!process && predicate(process),
				timeout,
			);
			if (!process) throw new Error("Missing process");
			return process;
		} catch (error) {
			const { processes, turnRecords } = context().deps;
			throw new Error(
				`Waiting for ${id}: ${description}; ${JSON.stringify({ process: processes.getById(id), turns: turnRecords.listByInstance(id) })}`,
				{ cause: error },
			);
		}
	}
	return {
		/** @public */
		post,
		/** @public */
		waitForProcess,
		/** @public */
		wait: (id: string, turn: string | null, lifecycle = "waiting", timeout = 12000) =>
			waitForProcess(
				id,
				(p) => p.selectedTurnId === turn && p.lifecycleStatus === lifecycle,
				`${turn}/${lifecycle}`,
				timeout,
				lifecycle === "error",
			),
		/** @public */
		action: (id: string, action: string, input: Record<string, unknown> = {}) =>
			post(`/api/processes/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, {
				input,
			}),
	};
}
