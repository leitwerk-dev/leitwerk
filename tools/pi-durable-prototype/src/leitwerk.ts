// biome-ignore-all lint/style/noNonNullAssertion: This throwaway fixture requires identities established by preceding operations and assertions.
// PROTOTYPE: deliberate imports of existing internals let this experiment exercise
// production semantics without adding a supported application API for the spike.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PreparedTurnStart, TurnOutcomePayload } from "@leitwerk-dev/domain";
import { defineProcess, llmTurn } from "@leitwerk-dev/process-sdk";
import { bindExternalWrites } from "../../../packages/external-writes/src/external-writes.ts";
import { getDefaultConfig } from "../../../packages/server/src/config/config-loader.ts";
import { closeDatabase, createDatabase } from "../../../packages/server/src/db/database.ts";
import { createAllRepos } from "../../../packages/server/src/db/repositories.ts";
import { buildProcessActionRegistry } from "../../../packages/server/src/process-action-registry.ts";
import { createProcessEngine } from "../../../packages/server/src/process-engine/engine.ts";
import { AcceptWorkerTurnStart } from "../../../packages/server/src/process-engine/ops/accept-worker-turn-start.ts";
import { TurnFailed } from "../../../packages/server/src/process-engine/ops/turn-failed.ts";
import { TurnOutcome } from "../../../packages/server/src/process-engine/ops/turn-outcome.ts";
import type {
	EngineResult,
	ProcessEngineDeps,
} from "../../../packages/server/src/process-engine/types.ts";
import { createServerProcessModelPolicy } from "../../../packages/server/src/process-model-policy/index.ts";
import { createProcessOperationCoordinator } from "../../../packages/server/src/process-operation-coordinator.ts";
import { createFakeWorkerSupervisor } from "../../../packages/server/src/test-helpers/fake-worker-supervisor.ts";
import { createBroadcaster } from "../../../packages/server/src/ws/broadcast.ts";

export const RESOURCE_TEXT =
	"Managed prototype instructions v1. Never request or reveal credentials.";
export const MODEL_PROFILE = { id: "prototype", provider: "prototype", model_id: "fake-model" };
const processDefinition = defineProcess<unknown, unknown>({
	id: "durable_prototype",
	displayName: "Durable prototype",
	entry: "primary",
	paramsCodec: { parse: () => ({}), serialize: () => ({}) },
	stateCodec: { parse: () => ({}), serialize: () => ({}) },
	initialState: () => ({}),
	turns: {
		primary: llmTurn({
			description: "Produce a plan",
			branchType: "primary",
			context: "fresh",
			availableTools: [],
			prompt: async () => "Produce a plan",
			publishedProduct: "plan",
			resultSemanticRef: "plan",
			outcomes: { done: { description: "Plan complete", parameters: {}, to: "review" } },
		}),
		review: llmTurn({
			description: "Review the plan",
			branchType: "leaf_branch",
			context: "full",
			availableTools: [],
			prompt: async () => "Review the plan",
			publishedProduct: "review",
			resultSemanticRef: "review",
			restorePrimaryLeafAfterTurn: true,
			outcomes: { done: { description: "Review complete", parameters: {}, to: "revise" } },
		}),
		revise: llmTurn({
			description: "Revise the plan",
			branchType: "primary",
			context: "full",
			availableTools: [],
			prompt: async () => "Revise the plan",
			publishedProduct: "final",
			outcomes: { done: { description: "Finished", parameters: {}, complete: true } },
		}),
	},
});

/** Use production SQLite repositories, ProcessEngine operations, and external-write reconciliation. @internal */
export class LeitwerkProcess {
	readonly db;
	readonly repos;
	readonly engine;
	readonly supervisor = createFakeWorkerSupervisor();
	readonly processId: string;
	readonly resourceDigest: string;
	constructor(directory: string, resourceDigest: string) {
		this.resourceDigest = resourceDigest;
		this.db = createDatabase({ sqlitePath: path.join(directory, "leitwerk.sqlite") });
		this.repos = createAllRepos(this.db);
		const graphs = new Map([[processDefinition.id, processDefinition]]);
		const registry = buildProcessActionRegistry({ processes: graphs });
		const config = getDefaultConfig();
		config.pi.model_profiles = [MODEL_PROFILE];
		config.process_configs = {
			durable_prototype: { default_model_profile: "prototype", turn_configs: {} },
		};
		const deps: ProcessEngineDeps = {
			...this.repos,
			processGraphs: graphs,
			processOperations: createProcessOperationCoordinator(),
			broadcaster: createBroadcaster(),
			getSupervisor: () => this.supervisor,
			getProcessActionRegistry: () => registry,
			processModelPolicy: createServerProcessModelPolicy({
				config,
				processGraphs: graphs,
				processActionRegistry: registry,
			}),
			getModelAvailabilitySnapshot: () => ({
				revision: 1,
				capturedAt: new Date().toISOString(),
				availabilityTransitions: [],
				profiles: [
					{
						profileId: "prototype",
						providerId: "prototype",
						modelId: "fake-model",
						availability: "available",
						checkedAt: new Date().toISOString(),
						expiresAt: "2099-01-01T00:00:00.000Z",
					},
				],
			}),
			prepareTurnStarts: async (_process, writes) => {
				for (const write of writes.turnStartWrites) {
					if (write.kind !== "create") continue;
					write.input.state = { kind: "starting", start: this.startConfiguration() };
					writes.processPatch.lifecycleStatus = "active";
					writes.workerIntent = { kind: "restart_worker" };
				}
				return { ok: true };
			},
		};
		this.engine = createProcessEngine(deps);
		this.processId =
			this.repos.processes.listAll()[0]?.id ??
			this.repos.processes.create({
				processId: processDefinition.id,
				selectedTurnId: null,
				lifecycleStatus: "discovered",
				defaultModelProfileId: "prototype",
				paramsJson: "{}",
				stateJson: "{}",
			}).id;
	}
	private startConfiguration() {
		return {
			kind: "llm" as const,
			model: {
				profileId: "prototype",
				providerId: "prototype",
				modelId: "fake-model",
				thinkingLevel: "off",
			},
			providerOptions: {},
			providerWorkerConfig: null,
			piResourceSnapshotDigest: this.resourceDigest,
			workerRuntimeProfileId: "prototype",
			piSettings: {},
		};
	}
	current() {
		const process = this.repos.processes.getById(this.processId);
		if (!process) throw new Error("Prototype process missing");
		const start =
			process.currentExecution?.kind === "worker_start"
				? this.repos.turnStarts.getById(process.currentExecution.id)
				: null;
		const record =
			start?.state.kind === "accepted"
				? this.repos.turnRecords.getById(start.state.turnRecordId)
				: null;
		return { process, start, record };
	}
	async start(): Promise<void> {
		if (this.current().process.lifecycleStatus === "discovered") {
			this.check(await this.engine.startProcess(this.processId, "primary"));
		}
		if (
			this.current().process.lifecycleStatus === "active" &&
			!this.supervisor.getWorker(this.processId)
		)
			await this.supervisor.spawnWorker(this.processId);
	}
	async requestStop(): Promise<void> {
		this.check(await this.engine.abortTurn(this.processId, { reason: "Stopped by operator" }));
	}
	async accept(preparedStart: PreparedTurnStart): Promise<string> {
		const { start } = this.current();
		if (!start) throw new Error("No reserved start");
		let lease = this.repos.leases.getByInstance(this.processId);
		if (lease?.bootstrapReceipt?.startRecordId !== start.id) {
			if (lease)
				this.repos.leases.update(lease.id, { state: "exited", exitedAt: new Date().toISOString() });
			lease = this.repos.leases.create({
				instanceId: this.processId,
				workerId: `prototype-${randomUUID()}`,
				state: "idle",
				turnStartRecordId: start.id,
			});
			this.repos.leases.compareAndSetBootstrapReceipt(lease.id, {
				kind: "llm",
				startRecordId: start.id,
				workerLeaseId: lease.id,
				receiptEpoch: "prototype",
				verifiedResourceSnapshotDigest: this.resourceDigest,
				credentialRevision: null,
				loadedResourceIds: [this.resourceDigest],
				resolvedModel: { providerId: "prototype", modelId: "fake-model" },
				preparedStart,
				readyAt: new Date().toISOString(),
			});
		}
		const result = await this.engine.run(AcceptWorkerTurnStart, {
			instanceId: this.processId,
			workerLeaseId: lease.id,
			startRecordId: start.id,
			proposedTurnRecordId: start.proposedTurnRecordId,
		});
		this.check(result);
		return start.proposedTurnRecordId;
	}
	assertCurrent(turnRecordId: string): void {
		const { process, record } = this.current();
		if (
			process.lifecycleStatus !== "active" ||
			record?.id !== turnRecordId ||
			record.status !== "running"
		) {
			throw new Error("Stale or unaccepted execution");
		}
	}
	async outcome(payload: TurnOutcomePayload) {
		const recorded = this.repos.turnRecords.getById(payload.turnRecordId);
		// Duplicate terminal delivery is a receipt lookup, never another transition.
		if (recorded?.status === "succeeded") {
			if (
				recorded.resultPiEntryId !== payload.resultPiEntryId ||
				recorded.turnResultMarkdown !== payload.turnResultMarkdown
			)
				throw new Error("Conflicting terminal replay");
			return { duplicate: true };
		}
		this.assertCurrent(payload.turnRecordId);
		const result = await this.engine.run(TurnOutcome, { instanceId: this.processId, payload });
		this.check(result);
		return { duplicate: false };
	}
	async fail(turnRecordId: string, message: string): Promise<void> {
		const record = this.repos.turnRecords.getById(turnRecordId);
		if (!record) throw new Error("Unknown turn");
		this.check(
			await this.engine.run(TurnFailed, {
				instanceId: this.processId,
				payload: {
					instanceId: this.processId,
					turnRecordId,
					turnId: record.turnId,
					turnType: "llm",
					pathType: record.pathType,
					errorSummary: message,
					errorClass: "infrastructure",
				},
			}),
		);
	}
	async retry(): Promise<void> {
		this.check(await this.engine.retryProcess(this.processId));
	}
	externalWrites() {
		return bindExternalWrites(this.repos.externalWrites, this.processId);
	}
	close(): void {
		closeDatabase(this.db);
	}
	private check<T>(result: EngineResult<T>): void {
		if (!result.ok) throw new Error(`ProcessEngine ${result.code}: ${result.message}`);
	}
}
