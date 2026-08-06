import type { ProcessLaunchPlanServiceLike } from "@leitwerk-dev/process-sdk";
import { getDefaultConfig } from "../config/config-loader.js";
import { createDatabase, createInMemoryDatabase, type LeitwerkDb } from "../db/database.js";
import { createAllRepos, type RepositoryBundle } from "../db/repositories.js";
import type { ModelStatusCacheSnapshot } from "../model-providers/model-status-cache.js";
import {
	createServerProcessModelPolicy,
	type ServerProcessModelPolicy,
} from "../process-model-policy/index.js";
import { type Broadcaster, createBroadcaster } from "../ws/broadcast.js";
import { createDefaultTestProcessGraphRegistry } from "./process-fixtures.js";

export interface TestDeps extends RepositoryBundle {
	db: LeitwerkDb;
	broadcaster: Broadcaster;
	processModelPolicy: ServerProcessModelPolicy;
	launchPlans: ProcessLaunchPlanServiceLike;
	getModelAvailabilitySnapshot: () => ModelStatusCacheSnapshot;
}

export function createTestDeps(options: { sqlitePath?: string } = {}): TestDeps {
	const db = options.sqlitePath
		? createDatabase({ sqlitePath: options.sqlitePath, enableWAL: false })
		: createInMemoryDatabase();
	const repos = createAllRepos(db);
	const config = getDefaultConfig();
	const processModelPolicy = createServerProcessModelPolicy({
		config,
		processGraphs: createDefaultTestProcessGraphRegistry(),
		processActionRegistry: { getTurnDefinition: () => undefined },
	});
	const launchPlans: ProcessLaunchPlanServiceLike = {
		async prepare(launchPlan, opts = {}) {
			return processModelPolicy.prepareLaunchPlan(launchPlan, opts);
		},
	};
	const getModelAvailabilitySnapshot = (): ModelStatusCacheSnapshot => ({
		revision: 1,
		capturedAt: new Date().toISOString(),
		availabilityTransitions: [],
		profiles: config.pi.model_profiles.map((profile) => ({
			profileId: profile.id,
			providerId: profile.provider,
			modelId: profile.model_id,
			availability: "available",
			checkedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		})),
	});
	const createTurnRecord = repos.turnRecords.create.bind(repos.turnRecords);
	repos.turnRecords.create = (input) => {
		const turnType = input.turnType ?? "llm";
		if (
			(turnType === "llm" || turnType === "automatic") &&
			(!input.turnStartRecordId || !input.acceptedWorkerLeaseId)
		) {
			const turnRecordId = input.id ?? `trn_fixture_${crypto.randomUUID()}`;
			const isCurrent =
				input.status === "running" || input.status === "failed" || input.status === undefined;
			const lease = repos.leases.create({
				instanceId: input.instanceId,
				workerId: `wkr_fixture_${turnRecordId}`,
				state: input.status === "failed" ? "failed" : isCurrent ? "busy" : "exited",
			});
			const start = repos.turnStarts.create({
				id: `tsr_fixture_${turnRecordId}`,
				instanceId: input.instanceId,
				turnId: input.turnId,
				turnType,
				proposedTurnRecordId: turnRecordId,
				startKind: "selected_turn",
				recoveryTurnRecordId: null,
				continuation: null,
				state: {
					kind: "accepted",
					start:
						turnType === "automatic"
							? { kind: "automatic" }
							: {
									kind: "llm",
									model: {
										profileId: input.modelProfileId ?? "fixture-model",
										providerId: "fixture-provider",
										modelId: "fixture-model",
										thinkingLevel: "low",
									},
									providerOptions: {},
									providerWorkerConfig: null,
									piResourceSnapshotDigest: "fixture-resource-snapshot",
									workerRuntimeProfileId: "local",
									piSettings: {},
								},
					turnRecordId,
					acceptedWorkerLeaseId: lease.id,
				},
			});
			const record = createTurnRecord({
				...input,
				id: turnRecordId,
				turnStartRecordId: start.id,
				acceptedWorkerLeaseId: lease.id,
			});
			if (isCurrent) {
				repos.processes.update(record.instanceId, {
					currentExecution: { kind: "worker_start", id: start.id },
				});
			} else {
				repos.leases.update(lease.id, { exitedAt: record.endedAt ?? record.startedAt });
			}
			return record;
		}
		return createTurnRecord(input);
	};
	return {
		db,
		...repos,
		broadcaster: createBroadcaster(),
		processModelPolicy,
		launchPlans,
		getModelAvailabilitySnapshot,
	};
}
