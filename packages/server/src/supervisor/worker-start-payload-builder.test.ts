import { createCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../config/config-loader.js";
import { createDefaultTestProcessGraphRegistry } from "../test-helpers/process-fixtures.js";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import {
	buildWorkerConfigSnapshot,
	createWorkerStartPayloadBuilder,
} from "./worker-start-payload-builder.js";

describe("buildWorkerConfigSnapshot", () => {
	it("sends only worker-used config sections", () => {
		const config = getDefaultConfig();
		config.auth = {
			enabled: true,
			session: { cookie_name: "orch", ttl: "1h" },
			providers: [
				{
					id: "identity",
					kind: "oidc",
					issuer: "https://identity.example.test",
					client_id: "client",
					client_secret: "secret",
				},
			],
			allowlist: ["alice"],
		};
		config.workers.runner = "kubernetes";
		config.worker_runtime_profiles = {
			generic: { image: "worker:latest" },
		};
		config.process_configs = {
			with_pi: {
				default_model_profile: "generic",
				worker_runtime_profile: "generic",
				turn_configs: { implement: { model_profile: "generic" } },
				pi: { append_system_prompt_template: "Extra" },
			},
			without_pi: { turn_configs: {}, worker_runtime_profile: "generic" },
		};

		const snapshot = buildWorkerConfigSnapshot(config);

		expect(snapshot).toStrictEqual({
			workers: {
				heartbeat_interval: config.workers.heartbeat_interval,
				turn_max_duration: config.workers.turn_max_duration,
				turn_inactivity_timeout: config.workers.turn_inactivity_timeout,
				turn_abort_grace_period: config.workers.turn_abort_grace_period,
			},
			pi: config.pi,
			process_configs: {
				with_pi: { pi: { append_system_prompt_template: "Extra" } },
				without_pi: {},
			},
		});
	});
});

describe("worker.start runtime settings", () => {
	it("sends the configured settings to automatic workers", () => {
		const deps = createTestDeps();
		const config = getDefaultConfig();
		config.workers.heartbeat_interval = "5s";
		config.workers.turn_max_duration = "6h";
		config.workers.turn_inactivity_timeout = "10m";
		config.workers.turn_abort_grace_period = "10s";
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const start = deps.turnStarts.create({
			id: "tsr_automatic_settings",
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "automatic",
			proposedTurnRecordId: "trn_automatic_settings",
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
			state: { kind: "starting", start: { kind: "automatic" } },
		});
		deps.processes.update(process.id, {
			currentExecution: { kind: "worker_start", id: start.id },
		});
		deps.leases.create({
			instanceId: process.id,
			workerId: "wkr_automatic_settings",
			state: "bootstrapping",
		});
		const builder = createWorkerStartPayloadBuilder({
			...deps,
			config,
			processGraphs: createDefaultTestProcessGraphRegistry(),
			processActionRegistry: { getTurnDefinition: () => undefined },
			storageLayout: () => ({
				primaryTreeFile: "/tree/primary.jsonl",
				workspaceRoot: "/workspace",
				resume: false,
			}),
		});

		const message = builder.buildStartMessage(process.id, "wkr_automatic_settings");

		expect(message?.payload.bootstrap).toEqual({ kind: "automatic" });
		expect(message?.payload.workerRuntimeSettings).toEqual({
			heartbeat_interval: "5s",
			turn_max_duration: "6h",
			turn_inactivity_timeout: "10m",
			turn_abort_grace_period: "10s",
		});
	});
});

describe("worker.start Pi resource-bundle delivery", () => {
	function setup() {
		const deps = createTestDeps();
		const config = getDefaultConfig();
		config.pi.model_profiles = [
			{ id: "openai", provider: "openai", model_id: "gpt-test", thinking_level: "off" },
		];
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			selectedTurnModelProfileId: "openai",
			lifecycleStatus: "active",
		});
		const bundle = createCanonicalPiResourceBundle([
			{ path: "generated.json", content: Buffer.from("{}") },
			{ path: "settings.json", content: Buffer.from("{}") },
		]);
		const start = deps.turnStarts.create({
			id: "tsr_bundle",
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "llm",
			proposedTurnRecordId: "trn_bundle",
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
			state: {
				kind: "starting",
				start: {
					kind: "llm",
					model: {
						profileId: "openai",
						providerId: "openai",
						modelId: "gpt-test",
						thinkingLevel: "off",
					},
					providerOptions: {},
					providerWorkerConfig: null,
					piResourceSnapshotDigest: bundle.digest,
					workerRuntimeProfileId: "local",
					piSettings: {},
				},
			},
		});
		deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
		deps.leases.create({ instanceId: process.id, workerId: "wkr_bundle", state: "bootstrapping" });
		return { bundle, config, deps, process };
	}

	it("delivers the canonical archive only through the authenticated worker.start payload", () => {
		const { bundle, config, deps, process } = setup();
		deps.processes.update(process.id, {
			selectedTurnModelProfileId: "mutable-process-selection",
			selectedTurnModelKind: "explicit",
			selectedTurnModelSource: "action_override",
		});
		const builder = createWorkerStartPayloadBuilder({
			...deps,
			config,
			processGraphs: createDefaultTestProcessGraphRegistry(),
			processActionRegistry: { getTurnDefinition: () => undefined },
			storageLayout: () => ({
				primaryTreeFile: "/tree/primary.jsonl",
				workspaceRoot: "/workspace",
				resume: false,
			}),
			resolveResourceBundle: (digest) => (digest === bundle.digest ? bundle : null),
		});

		const message = builder.buildStartMessage(process.id, "wkr_bundle");

		expect(message?.type).toBe("worker.start");
		expect(message?.payload.processSnapshot.selectedTurnModelProfileId).toBe("openai");
		expect(message?.payload.bootstrap).toMatchObject({
			kind: "llm",
			resourceBundle: {
				digest: bundle.digest,
				archiveBase64: Buffer.from(bundle.bytes).toString("base64"),
			},
		});
	});

	it("rebuilds an accepted running LLM turn with its original prepared start", () => {
		const { bundle, config, deps, process } = setup();
		const originalLease = deps.leases.getByInstance(process.id);
		if (!originalLease) throw new Error("Expected original worker lease");
		const originalStart = deps.turnStarts.getById("tsr_bundle");
		if (!originalStart || originalStart.state.kind !== "starting") {
			throw new Error("Expected starting turn record");
		}
		deps.leases.compareAndSetBootstrapReceipt(originalLease.id, {
			kind: "llm",
			startRecordId: "tsr_bundle",
			workerLeaseId: originalLease.id,
			receiptEpoch: originalLease.id,
			verifiedResourceSnapshotDigest: bundle.digest,
			credentialRevision: 1,
			loadedResourceIds: [],
			resolvedModel: { providerId: "openai", modelId: "gpt-test" },
			preparedStart: {
				pathType: "primary",
				contextMode: "full",
				startTarget: { kind: "current_leaf" },
				forkPiEntryId: null,
			},
			readyAt: "2026-01-01T00:00:00.000Z",
		});
		deps.turnRecords.create({
			id: "trn_bundle",
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "llm",
			status: "running",
			attemptNumber: 1,
			parentTurnRecordId: null,
			pathType: "primary",
			forkPiEntryId: null,
			turnStartRecordId: "tsr_bundle",
			acceptedWorkerLeaseId: originalLease.id,
		});
		deps.turnStarts.compareAndSetState({
			id: "tsr_bundle",
			expectedKind: "starting",
			state: {
				kind: "accepted",
				start: originalStart.state.start,
				turnRecordId: "trn_bundle",
				acceptedWorkerLeaseId: originalLease.id,
			},
		});
		deps.leases.update(originalLease.id, { state: "exited", exitedAt: "2026-01-01T00:00:01.000Z" });
		deps.leases.create({
			instanceId: process.id,
			workerId: "wkr_replacement",
			state: "bootstrapping",
		});

		const builder = createWorkerStartPayloadBuilder({
			...deps,
			config,
			processGraphs: createDefaultTestProcessGraphRegistry(),
			processActionRegistry: { getTurnDefinition: () => undefined },
			storageLayout: () => ({
				primaryTreeFile: "/tree/primary.jsonl",
				workspaceRoot: "/workspace",
				resume: true,
			}),
			resolveResourceBundle: (digest) => (digest === bundle.digest ? bundle : null),
		});

		const message = builder.buildStartMessage(process.id, "wkr_replacement");
		expect(message?.type).toBe("worker.start");
		expect(message?.payload.turnStart.state.kind).toBe("accepted");
		expect(message?.payload.acceptedPreparedStart).toEqual({
			pathType: "primary",
			contextMode: "full",
			startTarget: { kind: "current_leaf" },
			forkPiEntryId: null,
		});
	});

	it("rejects a resolver response that is not the requested canonical bundle", () => {
		const { bundle, config, deps, process } = setup();
		const builder = createWorkerStartPayloadBuilder({
			...deps,
			config,
			processGraphs: createDefaultTestProcessGraphRegistry(),
			processActionRegistry: { getTurnDefinition: () => undefined },
			storageLayout: () => ({
				primaryTreeFile: "/tree/primary.jsonl",
				workspaceRoot: "/workspace",
				resume: false,
			}),
			resolveResourceBundle: () => ({ ...bundle, digest: "0".repeat(64) }),
		});

		expect(() => builder.buildStartMessage(process.id, "wkr_bundle")).toThrow(
			/returned '0{64}' for requested digest/,
		);
	});

	it("rejects modified bytes even when an alternate resolver repeats the requested digest", () => {
		const { bundle, config, deps, process } = setup();
		const modified = Uint8Array.from(bundle.bytes);
		modified[0] ^= 0x01;
		const builder = createWorkerStartPayloadBuilder({
			...deps,
			config,
			processGraphs: createDefaultTestProcessGraphRegistry(),
			processActionRegistry: { getTurnDefinition: () => undefined },
			storageLayout: () => ({
				primaryTreeFile: "/tree/primary.jsonl",
				workspaceRoot: "/workspace",
				resume: false,
			}),
			resolveResourceBundle: () => ({ digest: bundle.digest, bytes: modified }),
		});

		expect(() => builder.buildStartMessage(process.id, "wkr_bundle")).toThrow(
			/content digest mismatch/,
		);
	});
});
