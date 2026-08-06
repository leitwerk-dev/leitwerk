import type {
	DockerContainerExit,
	DockerContainerInspect,
	DockerContainerSpec,
	DockerContainerSummary,
	DockerEngineClient,
	DockerListContainersFilter,
} from "./docker-engine-client.js";

interface FakeContainerRecord {
	id: string;
	spec: DockerContainerSpec;
	running: boolean;
	resolveExit?: (exit: DockerContainerExit) => void;
	exitPromise: Promise<DockerContainerExit>;
}

/**
 * In-memory Docker Engine API double for the Docker runner unit tests.
 *
 * It records create/start/stop/remove calls, lets a test resolve a container's
 * `waitContainer` promise to simulate a physical exit, and answers
 * list/inspect against its recorded state. No daemon, no sockets.
 */
export interface FakeDockerEngineClient extends DockerEngineClient {
	readonly containers: ReadonlyMap<string, FakeContainerRecord>;
	readonly volumesEnsured: string[];
	readonly volumesRemoved: string[];
	readonly stopCalls: Array<{ id: string; timeoutSeconds: number }>;
	readonly removeCalls: Array<{ id: string; force?: boolean }>;
	/** Resolves a container's wait promise to simulate a physical exit. */
	simulateExit(id: string, exit: DockerContainerExit): void;
	/** Seeds a pre-existing container (e.g. to model adoption after restart). */
	seedContainer(record: {
		id: string;
		labels: Record<string, string>;
		running?: boolean;
		state?: string;
	}): void;
}

let fakeContainerCounter = 0;

export function createFakeDockerEngineClient(): FakeDockerEngineClient {
	const containers = new Map<string, FakeContainerRecord>();
	const seededState = new Map<string, { labels: Record<string, string>; state: string }>();
	const volumesEnsured: string[] = [];
	const volumesRemoved: string[] = [];
	const stopCalls: Array<{ id: string; timeoutSeconds: number }> = [];
	const removeCalls: Array<{ id: string; force?: boolean }> = [];
	function newExitPromise(): {
		promise: Promise<DockerContainerExit>;
		resolve: (exit: DockerContainerExit) => void;
	} {
		let resolve!: (exit: DockerContainerExit) => void;
		const promise = new Promise<DockerContainerExit>((res) => {
			resolve = res;
		});
		return { promise, resolve };
	}

	return {
		containers,
		volumesEnsured,
		volumesRemoved,
		stopCalls,
		removeCalls,
		async createContainer(spec: DockerContainerSpec) {
			fakeContainerCounter += 1;
			const id = `fake_container_${fakeContainerCounter}`;
			const { promise, resolve } = newExitPromise();
			containers.set(id, {
				id,
				spec,
				running: false,
				resolveExit: resolve,
				exitPromise: promise,
			});
			return { id };
		},
		async startContainer(id: string) {
			const record = containers.get(id);
			if (!record) {
				throw new Error(`No such container: ${id}`);
			}
			record.running = true;
		},
		async stopContainer(id: string, opts: { timeoutSeconds: number }) {
			stopCalls.push({ id, timeoutSeconds: opts.timeoutSeconds });
			const record = containers.get(id);
			if (record) {
				record.running = false;
				record.resolveExit?.({ statusCode: 0, signal: "SIGTERM" });
			}
		},
		async removeContainer(id: string, opts: { force?: boolean }) {
			removeCalls.push({ id, force: opts.force });
			containers.delete(id);
		},
		async inspectContainer(id: string): Promise<DockerContainerInspect> {
			const record = containers.get(id);
			if (record) {
				return {
					id,
					running: record.running,
					labels: record.spec.labels,
				};
			}
			const seeded = seededState.get(id);
			if (seeded) {
				return {
					id,
					running: seeded.state === "running",
					labels: seeded.labels,
				};
			}
			throw new Error(`No such container: ${id}`);
		},
		async listContainers(filter: DockerListContainersFilter): Promise<DockerContainerSummary[]> {
			const summaries: DockerContainerSummary[] = [];
			const matchesFilter = (labels: Record<string, string>) =>
				Object.entries(filter.labels).every(([key, value]) => labels[key] === value);
			for (const record of containers.values()) {
				if (!record.running) {
					continue;
				}
				if (!matchesFilter(record.spec.labels)) {
					continue;
				}
				summaries.push({
					id: record.id,
					labels: record.spec.labels,
				});
			}
			for (const [id, seeded] of seededState.entries()) {
				if (containers.has(id)) {
					continue;
				}
				if (seeded.state !== "running") {
					continue;
				}
				if (!matchesFilter(seeded.labels)) {
					continue;
				}
				summaries.push({ id, labels: seeded.labels });
			}
			return summaries;
		},
		async waitContainer(id: string): Promise<DockerContainerExit> {
			const record = containers.get(id);
			if (!record) {
				throw new Error(`No such container: ${id}`);
			}
			return record.exitPromise;
		},
		async ensureVolume(name: string) {
			volumesEnsured.push(name);
		},
		async removeVolume(name: string) {
			volumesRemoved.push(name);
		},
		simulateExit(id: string, exit: DockerContainerExit) {
			const record = containers.get(id);
			if (!record) {
				throw new Error(`No such container: ${id}`);
			}
			record.running = false;
			record.resolveExit?.(exit);
		},
		seedContainer(record: {
			id: string;
			labels: Record<string, string>;
			running?: boolean;
			state?: string;
		}) {
			seededState.set(record.id, {
				labels: record.labels,
				state: record.state ?? (record.running ? "running" : "exited"),
			});
		},
	};
}
