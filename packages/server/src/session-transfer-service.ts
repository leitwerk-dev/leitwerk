import { createHash } from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
	DEFAULT_SESSION_TRANSFER_LIMITS,
	type LeitwerkTransferManifestV1,
	type SessionTransferLimits,
} from "@leitwerk-dev/session-transfer";
import type {
	PreparedProcessStateExport,
	ProcessStateExporter,
} from "@leitwerk-dev/worker-runners";
import type { LeitwerkConfig } from "./config/config-types.js";
import type {
	RepositoryBundle,
	SessionTransferAttempt,
	SessionTransferPhase,
} from "./db/repositories.js";
import type { ProcessOperationCoordinator } from "./process-operation-coordinator.js";
import type { ProcessSessionSource } from "./process-session-store.js";
import type { SessionTransferHelperRelays } from "./session-transfer-helper-relays.js";
import { createWorkerStorageLayout } from "./supervisor/worker-storage-layout.js";
import type { WorkerSupervisor } from "./supervisor/worker-supervisor.js";

const GRANT_LIFETIME_MS = 60 * 60 * 1000;
const ATTEMPT_LEASE_MS = 90 * 1000;
const ATTEMPT_HARD_DEADLINE_MS = 60 * 60 * 1000;
const CONSUMED_TOMBSTONE_MS = 24 * 60 * 60 * 1000;

interface AttemptRuntime {
	controller: AbortController;
	prepared: PreparedProcessStateExport | null;
	streamClaimed: boolean;
}

interface AttemptAuth {
	instanceId: string;
	grantId: string;
	attemptId: string;
	token: string;
}

export function presentSessionTransferOperation(attempt: SessionTransferAttempt | null) {
	return attempt
		? {
				attemptId: attempt.id,
				phase: attempt.phase,
				blocksManualTurns: attempt.state === "queued" || attempt.state === "exporting",
			}
		: null;
}

function parseSessionHeader(content: string): Record<string, unknown> {
	const firstLine = content.split(/\r?\n/, 1)[0];
	if (!firstLine) throw new Error("Primary Pi session is empty");
	const value = JSON.parse(firstLine) as unknown;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(value as Record<string, unknown>).type !== "session"
	) {
		throw new Error("Primary Pi session header is invalid");
	}
	return value as Record<string, unknown>;
}

function relativeSessionCwd(input: {
	sourceCwd: string;
	workspaceRoot: string;
	repositoryBacked: boolean;
}): string | null {
	if (!input.repositoryBacked) return null;
	const relative = path.relative(path.resolve(input.workspaceRoot), path.resolve(input.sourceCwd));
	if (relative === "") return ".";
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Repository-backed Pi session cwd is outside the process workspace");
	}
	return relative.split(path.sep).join("/");
}

export function createSessionTransferService(deps: {
	repos: Pick<
		RepositoryBundle,
		"processes" | "projects" | "leases" | "sessionTransfers" | "transaction"
	>;
	processOperations: ProcessOperationCoordinator;
	supervisor: WorkerSupervisor;
	exporter: ProcessStateExporter;
	helperRelays: SessionTransferHelperRelays;
	sessionSource: ProcessSessionSource;
	config: LeitwerkConfig;
	limits?: SessionTransferLimits;
	now?: () => Date;
	logger?: { warn(details: unknown, message: string): void };
	onUpdated?: (attempt: SessionTransferAttempt) => void;
	isDeletionPending?: (instanceId: string) => boolean;
}) {
	const now = deps.now ?? (() => new Date());
	const limits = deps.limits ?? DEFAULT_SESSION_TRANSFER_LIMITS;
	const runtimes = new Map<string, AttemptRuntime>();
	let sweepTimer: NodeJS.Timeout | null = null;

	function makeRuntime(): AttemptRuntime {
		return { controller: new AbortController(), prepared: null, streamClaimed: false };
	}

	function publish(attempt: SessionTransferAttempt | null): SessionTransferAttempt | null {
		if (attempt && deps.onUpdated) {
			try {
				deps.onUpdated(attempt);
			} catch (error) {
				deps.logger?.warn(
					{ error, attemptId: attempt.id },
					"session transfer update broadcast failed",
				);
			}
		}
		return attempt;
	}

	function updatePhase(
		id: string,
		phase: SessionTransferPhase,
		extra: Partial<SessionTransferAttempt> = {},
	): SessionTransferAttempt | null {
		return publish(deps.repos.sessionTransfers.updateAttempt(id, { phase, ...extra }));
	}

	async function snapshotManifest(
		attempt: SessionTransferAttempt,
	): Promise<LeitwerkTransferManifestV1> {
		const process = deps.repos.processes.getById(attempt.instanceId);
		if (!process) throw new Error("Process was deleted");
		const handle = await deps.sessionSource.readSnapshotHandle(attempt.instanceId);
		if (!handle) throw new Error("Primary Pi session is unavailable");
		const header = parseSessionHeader(await handle.load());
		const sourceCwd = typeof header.cwd === "string" ? header.cwd : "";
		if (!sourceCwd) throw new Error("Primary Pi session header has no cwd");
		const projects = deps.repos.projects.listByInstance(attempt.instanceId);
		const storage = createWorkerStorageLayout(deps.config)(attempt.instanceId);
		return {
			version: 1,
			instanceId: process.id,
			processId: process.processId,
			processTitle: process.title,
			createdAt: now().toISOString(),
			session: {
				relativePath: "session.jsonl",
				sourceCwd,
				cwdRelativeToWorkspace: relativeSessionCwd({
					sourceCwd,
					workspaceRoot: storage.workspaceRoot,
					repositoryBacked: projects.length > 0,
				}),
			},
			workspace: { relativePath: "workspace", hasLocalState: projects.length > 0 },
			projects: projects.map((project) => ({
				key: project.key,
				relativePath: project.key,
				branch: null,
				head: null,
			})),
		};
	}

	function transitionTerminal(
		attemptId: string,
		state: "failed" | "cancelled",
		code: string,
	): SessionTransferAttempt | null {
		const attempt = publish(
			deps.repos.sessionTransfers.updateAttempt(attemptId, {
				state,
				phase: state,
				failureCode: code,
				completedAt: now().toISOString(),
			}),
		);
		const runtime = runtimes.get(attemptId);
		runtime?.controller.abort(new Error(code));
		runtimes.delete(attemptId);
		return attempt;
	}

	function failAttempt(attemptId: string, code: string): void {
		transitionTerminal(attemptId, "failed", code);
	}

	function launch(attempt: SessionTransferAttempt): void {
		const runtime = makeRuntime();
		runtimes.set(attempt.id, runtime);
		void (async () => {
			updatePhase(attempt.id, "waiting_for_execution_chain");
			while (true) {
				const reserved = await deps.processOperations.runExclusive(attempt.instanceId, () => {
					const current = deps.repos.sessionTransfers.getAttempt(attempt.id);
					if (!current || current.state !== "queued") throw new Error("transfer_no_longer_queued");
					const process = deps.repos.processes.getById(attempt.instanceId);
					if (!process) throw new Error("process_deleted");
					const lease = deps.repos.leases.getByInstance(attempt.instanceId);
					const stable = ["waiting", "error", "completed", "aborted"].includes(
						process.lifecycleStatus,
					);
					if (!stable || (lease && lease.state !== "idle" && lease.state !== "failed")) {
						return false;
					}
					updatePhase(attempt.id, "stopping_worker", { state: "exporting" });
					return true;
				});
				if (reserved) break;
				await delay(250, undefined, { signal: runtime.controller.signal });
			}

			await deps.supervisor.stopWorker(attempt.instanceId, "session_transfer");
			if (deps.repos.leases.getByInstance(attempt.instanceId)) {
				throw new Error("worker_lease_remains");
			}
			runtime.controller.signal.throwIfAborted();
			updatePhase(attempt.id, "starting_exporter");
			const manifest = await snapshotManifest(attempt);
			updatePhase(attempt.id, "scanning");
			runtime.prepared = await deps.exporter.prepare({
				instanceId: attempt.instanceId,
				manifest,
				limits,
				signal: runtime.controller.signal,
			});
			updatePhase(attempt.id, "ready_to_stream", {
				entriesTotal: runtime.prepared.preflight.entriesTotal,
				logicalBytesTotal: runtime.prepared.preflight.logicalBytesTotal,
			});
		})()
			.catch((error: unknown) => {
				const current = deps.repos.sessionTransfers.getAttempt(attempt.id);
				if (current && (current.state === "queued" || current.state === "exporting")) {
					failAttempt(attempt.id, error instanceof Error ? error.message : "export_failed");
				}
				deps.logger?.warn({ error, attemptId: attempt.id }, "session transfer export failed");
			})
			.finally(() => {
				const current = deps.repos.sessionTransfers.getAttempt(attempt.id);
				if (current && current.state !== "exporting" && current.state !== "queued") {
					runtimes.delete(attempt.id);
				}
			});
	}

	function cancelAttempt(attempt: SessionTransferAttempt, code: string): SessionTransferAttempt {
		if (attempt.state === "consumed" || attempt.state === "cancelled" || attempt.state === "failed")
			return attempt;
		return transitionTerminal(attempt.id, "cancelled", code) as SessionTransferAttempt;
	}

	function sweep(): void {
		const currentTime = now().getTime();
		deps.helperRelays.sweep();
		for (const attempt of deps.repos.sessionTransfers.listActive()) {
			if (Date.parse(attempt.hardDeadline) <= currentTime)
				cancelAttempt(attempt, "hard_deadline_expired");
			else if (Date.parse(attempt.leaseUntil) <= currentTime)
				cancelAttempt(attempt, "lease_expired");
		}
		deps.repos.sessionTransfers.cleanup(now());
	}

	return {
		async createGrant(instanceId: string) {
			return deps.processOperations.runExclusive(instanceId, async () => {
				if (deps.isDeletionPending?.(instanceId)) return { kind: "deletion_pending" as const };
				if (!deps.repos.processes.getById(instanceId)) return { kind: "not_found" as const };
				const handle = await deps.sessionSource.readSnapshotHandle(instanceId);
				if (!handle) return { kind: "not_found" as const };
				const created = deps.repos.sessionTransfers.createGrant({
					instanceId,
					now: now(),
					lifetimeMs: GRANT_LIFETIME_MS,
				});
				return {
					kind: "created" as const,
					grantId: created.grant.id,
					rawToken: created.rawToken,
					expiresAt: created.grant.expiresAt,
				};
			});
		},
		startAttempt(input: { instanceId: string; grantId: string; token: string }) {
			const result = deps.repos.transaction((repos) =>
				repos.sessionTransfers.startAttempt({
					...input,
					now: now(),
					leaseMs: ATTEMPT_LEASE_MS,
					hardDeadlineMs: ATTEMPT_HARD_DEADLINE_MS,
				}),
			);
			if (result.kind === "created") {
				publish(result.attempt);
				launch(result.attempt);
			}
			return result;
		},
		heartbeat(input: AttemptAuth) {
			const attempt = deps.repos.sessionTransfers.verifyAttempt(input);
			if (!attempt) return null;
			return (
				deps.repos.sessionTransfers.renew(attempt.id, { now: now(), leaseMs: ATTEMPT_LEASE_MS }) ??
				attempt
			);
		},
		openStream(input: AttemptAuth) {
			const attempt = deps.repos.sessionTransfers.verifyAttempt(input);
			const runtime = attempt ? runtimes.get(attempt.id) : undefined;
			if (
				!runtime?.prepared ||
				!attempt ||
				attempt.phase !== "ready_to_stream" ||
				runtime.streamClaimed
			) {
				throw new Error("transfer_stream_unavailable");
			}
			runtime.streamClaimed = true;
			updatePhase(attempt.id, "streaming");
			const source = runtime.prepared.stream({
				signal: runtime.controller.signal,
				onProgress: (progress) => {
					deps.repos.sessionTransfers.updateAttempt(attempt.id, progress);
				},
			});
			const hash = createHash("sha256");
			let compressedBytes = 0;
			let finished = false;
			const meter = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					compressedBytes += chunk.length;
					if (compressedBytes > limits.maxCompressedBytes) {
						callback(new Error("compressed_limit_exceeded"));
						return;
					}
					hash.update(chunk);
					callback(null, chunk);
				},
				flush(callback) {
					finished = true;
					publish(
						deps.repos.sessionTransfers.updateAttempt(attempt.id, {
							state: "awaiting_ack",
							phase: "awaiting_ack",
							compressedBytes,
							streamSha256: hash.digest("hex"),
						}),
					);
					runtimes.delete(attempt.id);
					callback();
				},
			});
			source.on("error", (error) => meter.destroy(error));
			meter.on("error", (error) => {
				if (!finished) failAttempt(attempt.id, error.message || "stream_failed");
				runtimes.delete(attempt.id);
			});
			source.pipe(meter);
			return meter;
		},
		cancel(input: AttemptAuth & { code?: string }) {
			const attempt = deps.repos.sessionTransfers.verifyAttempt(input);
			return attempt ? cancelAttempt(attempt, input.code ?? "client_cancelled") : null;
		},
		cancelForWeb(instanceId: string, attemptId: string) {
			const attempt = deps.repos.sessionTransfers.getAttempt(attemptId);
			if (!attempt || attempt.instanceId !== instanceId) return null;
			return attempt.state === "awaiting_ack"
				? attempt
				: cancelAttempt(attempt, "operator_cancelled");
		},
		acknowledge(input: AttemptAuth) {
			const attempt = deps.repos.sessionTransfers.verifyAttempt(input);
			if (!attempt) return null;
			const acknowledged = deps.repos.transaction((repos) =>
				repos.sessionTransfers.acknowledge({
					attemptId: attempt.id,
					now: now(),
					tombstoneMs: CONSUMED_TOMBSTONE_MS,
				}),
			);
			return publish(acknowledged);
		},
		activeForProcess(instanceId: string) {
			return deps.repos.sessionTransfers.getActiveByInstance(instanceId);
		},
		revokeProcess(instanceId: string) {
			const active = deps.repos.sessionTransfers.getActiveByInstance(instanceId);
			if (active) cancelAttempt(active, "process_deleted");
			deps.repos.sessionTransfers.revokeProcess(instanceId);
		},
		async reconcile() {
			await deps.exporter.reconcile();
			for (const attempt of deps.repos.sessionTransfers.listActive()) {
				if (attempt.phase === "streaming") {
					failAttempt(attempt.id, "server_restarted_during_stream");
				} else if (attempt.state === "queued" || attempt.state === "exporting") {
					deps.repos.sessionTransfers.updateAttempt(attempt.id, {
						state: "queued",
						phase: "queued",
					});
					launch({ ...attempt, state: "queued", phase: "queued" });
				}
			}
			sweep();
		},
		start() {
			if (!sweepTimer) sweepTimer = setInterval(sweep, 15_000);
		},
		stop() {
			if (sweepTimer) clearInterval(sweepTimer);
			sweepTimer = null;
			deps.helperRelays.stop();
		},
		helperSpec: deps.helperRelays.helperSpec,
		reportHelperPreflight: deps.helperRelays.reportHelperPreflight,
		acceptHelperStream: deps.helperRelays.acceptHelperStream,
		reportHelperProgress: deps.helperRelays.reportHelperProgress,
	};
}

export type SessionTransferService = ReturnType<typeof createSessionTransferService>;
