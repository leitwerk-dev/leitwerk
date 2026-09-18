import { createTestDiagnostics } from "@leitwerk-dev/test-support/local-git";
import { onTestFailed, onTestFinished } from "vitest";
import { createRemoteRepoChangeFixture as createFixture } from "./remote-repo-change-fixture.js";

export {
	type RemoteRepoChangeFixture,
	remoteRepoChangeFixtureConstants,
	remoteState,
} from "./remote-repo-change-fixture.js";

/** Trace setup, awaited operations and cleanup without logging prompts, credentials or provider payloads. */
export async function createRemoteRepoChangeFixture(...args: Parameters<typeof createFixture>) {
	const trace = createTestDiagnostics("forgejo-remote-change");
	onTestFailed(() => trace.report());
	let timer: ReturnType<typeof setInterval> | undefined;
	onTestFinished(() => clearInterval(timer));
	const fixture = await trace.run(() => createFixture(args[0], { ...args[1], diagnostics: trace }));
	let previous = "";
	let closed = false;
	const snapshot = () => {
		if (closed) return;
		try {
			const { deps } = fixture.harness.ctx;
			const processes = deps.processes.listAll().map((process) => ({
				id: process.id,
				turn: process.selectedTurnId,
				status: process.lifecycleStatus,
				execution: process.currentExecution,
				starts: deps.turnStarts
					.listByInstance(process.id)
					.map((start) => ({ id: start.id, state: start.state.kind })),
				records: deps.turnRecords
					.listByInstance(process.id)
					.map((record) => ({ id: record.id, turn: record.turnId, status: record.status })),
				sources: fixture.subscriptions(process.id).map(({ kind, id }) => ({ kind, id })),
			}));
			const state = {
				processes,
				leases: deps.leases
					.listActive()
					.map(({ id, workerId, instanceId, state }) => ({ id, workerId, instanceId, state })),
				piTurns: fixture.piTurns.map(({ kind }) => kind),
			};
			const serialized = JSON.stringify(state);
			if (serialized !== previous) {
				trace.mark("fixture.state", state);
				previous = serialized;
			}
		} catch {
			// Restart closes SQLite while the new app is being constructed.
			trace.mark("fixture.state.unavailable");
		}
	};
	snapshot();
	timer = setInterval(snapshot, 250);
	timer.unref();
	const operations = new Set([
		"restart",
		"launchTicketlessChange",
		"exposeTriggeredIssue",
		"approvePlan",
		"approveImplementation",
		"action",
		"pollFeedback",
		"publishPipeline",
		"markPullRequestMerged",
		"markPullRequestClosed",
		"removeSourceTrigger",
		"waitForTurn",
		"waitForHeadChange",
		"waitForCompleted",
		"close",
	]);
	return new Proxy(fixture, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (!operations.has(String(key)) || typeof value !== "function") return value;
			return (...input: unknown[]) =>
				trace.run(async () => {
					const operation = String(key);
					trace.mark(`${operation}.start`);
					snapshot();
					if (key === "close") {
						closed = true;
						clearInterval(timer);
					}
					try {
						const result = await Reflect.apply(value, target, input);
						trace.mark(`${operation}.end`);
						return result;
					} catch (error) {
						trace.mark(`${operation}.error`, {
							name: error instanceof Error ? error.name : "unknown",
						});
						throw error;
					} finally {
						snapshot();
					}
				});
		},
	});
}
