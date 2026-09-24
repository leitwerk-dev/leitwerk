import type { ExtensionTestCapability } from "./test-capability.js";

export type { ExtensionTestCapability } from "./test-capability.js";

import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
	Actor,
	ExternalWriteLog,
	ProcessInstance,
	ProcessProject,
	ProcessTurnRecord,
} from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	coreHostCapabilities,
	type ExtensionProcessDefinition,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import {
	createAcceptedWorkerTurn,
	prepareAcceptedFixtureStart,
} from "@leitwerk-dev/server/testing";
import { persistPiResourceBundleForStart } from "@leitwerk-dev/worker";
import { postImmediateLaunch } from "./http-launch.js";
import { createPersistentIntegrationFixture } from "./integration-harness.js";
import { observe, type TestObservation } from "./observations.js";
import { createProcessFixture, type ProcessFixtureOptions } from "./process-fixtures.js";
import type { QuestionRequestFixture } from "./supported-question-fixtures.js";
import { StubPiTreeHandleFactory } from "./worker-testing/stub-pi-tree-handle.js";

/** Model-visible inputs for a scripted invocation. @public */
export interface IntegrationPromptObservation {
	/** @public */
	turnId: string;
	/** Working directory available for fixture repository edits. @public */
	cwd: string;
	/** Opaque branch-session identity for comparing execution relationships. @public */
	branchId: string;
	/** Text inherited by the current branch. @public */
	history: string;
	/** @public */
	tools: readonly {
		/** @public */
		name: string;
		/** @public */
		parameters: Record<string, unknown>;
	}[];
}

/** Rendered result retained at a tree leaf. @public */
export interface IntegrationLeafObservation {
	/** @public */
	id: string;
	/** @public */
	instanceId: string;
	/** @public */
	leafEntryId: string;
	/** @public */
	turnRecordId: string | null;
	/** @public */
	rendererId: string | null;
	/** @public */
	schemaVersion: number | null;
	/** @public */
	props: Record<string, unknown> | null;
	/** @public */
	fallbackMarkdown: string | null;
	/** @public */
	status: "ready" | "capture_error";
}

/** Recorded semantic event. @public */
export interface IntegrationEventObservation {
	/** @public */
	id: string;
	/** @public */
	eventType: string;
	/** @public */
	data: Record<string, unknown>;
	/** @public */
	createdAt: string;
}

/** Durable annotation of process execution. @public */
export interface IntegrationAnnotationObservation {
	/** @public */
	id: string;
	/** @public */
	annotationType: string;
	/** @public */
	payload: Record<string, unknown>;
}

/** One scripted model prompt, executed through registered tools. @public */
export interface IntegrationTurnScript {
	/** @public */
	tools: readonly IntegrationToolCall[];
	/** Scripted reasoning retained by the normal worker path. @public */
	thinking?: readonly string[];
	/** Assistant markdown for turns completed by model output. @public */
	markdown?: string;
	/** Optional model response after an integration-tool result. @public */
	afterToolResult?(call: IntegrationToolCall, result: unknown): IntegrationToolCall | undefined;
}

/** @public */
export interface IntegrationToolCall {
	/** @public */
	name: string;
	/** @public */
	arguments: Record<string, unknown>;
}

/** Instruction delivered through the application's durable input queue. @public */
export interface IntegrationProcessInput {
	/** @public */
	bodyMarkdown: string;
	/** Target a published product branch. @public */
	product?: string;
}

/** Durable instruction delivery observations. @public */
export interface IntegrationInputObservation {
	/** @public */
	id: string;
	/** @public */
	instanceId: string;
	/** @public */
	sequence: number;
	/** @public */
	source: string;
	/** @public */
	kind: string;
	/** @public */
	bodyMarkdown: string;
	/** @public */
	target: {
		/** @public */
		productName?: string;
		/** @public */
		semanticRef?: string;
	} | null;
	/** @public */
	actor: Actor;
	/** @public */
	receivedAt: string;
	/** @public */
	consumedAt: string | null;
}

/** Operator approval observations. @public */
export interface IntegrationApprovalObservation {
	/** @public */
	id: string;
	/** @public */
	instanceId: string;
	/** @public */
	turnRecordId: string;
	/** @public */
	toolCallId: string;
	/** @public */
	toolName: string;
	/** @public */
	arguments: Record<string, unknown>;
	/** @public */
	destination: {
		/** @public */
		id: string;
		/** @public */
		displayName: string;
		/** @public */
		group?: string;
		/** @public */
		description?: string;
	} | null;
	/** @public */
	status: "open" | "accepted" | "feedback" | "declined" | "cancelled";
	/** @public */
	requestedAt: string;
	/** @public */
	resolvedAt: string | null;
	/** @public */
	resolvedBy: Actor | null;
	/** @public */
	feedback: string | null;
}

/** Explicit accepted execution setup, independent of process business state. @public */
export interface AcceptedTurnFixture {
	/** @public */
	turnId: string;
	/** @public */
	execution:
		| {
				/** @public */
				status: "running";
		  }
		| {
				/** @public */
				status: "succeeded";
				/** @public */
				outcome: string;
				/** @public */
				markdown: string;
		  };
}

/** Detached durable observations. @public */
export interface ExtensionIntegrationSnapshot {
	/** Harness-owned process workspace. @public */
	workspaceRoot: string;
	/** @public */
	events: IntegrationEventObservation[];
	/** @public */
	annotations: IntegrationAnnotationObservation[];
	/** @public */
	leafOutcomes: IntegrationLeafObservation[];

	/** @public */
	process: ProcessInstance;
	/** @public */
	params: unknown;
	/** @public */
	state: unknown;
	/** @public */
	projects: ProcessProject[];
	/** @public */
	turns: ProcessTurnRecord[];
	/** @public */
	inputs: IntegrationInputObservation[];
	/** @public */
	questions: QuestionRequestFixture[];
	/** @public */
	approvals: IntegrationApprovalObservation[];
	/** @public */
	writeReceipts: ExternalWriteLog[];
}

/** @public */
export interface ExtensionIntegrationHarnessOptions {
	/** Per-process watcher configuration. @public */
	watchers?: Readonly<Record<string, Record<string, unknown>>>;
	/** Advance extension provider pollers explicitly in tests. @public */
	polling?: "automatic" | "manual";
	/** Host Docker boundary for extensions which require it. @public */
	hostDocker?: {
		/** @public */
		preflight(timeoutMs: number): Promise<void>;
	};

	/** Configuration keyed by extension manifest id. @public */
	extensionConfig?: Readonly<Record<string, unknown>>;
	/** @public */
	extensions: readonly LeitwerkExtensionModule[];
	/** @public */
	capabilities?: readonly ExtensionTestCapability[];
	/** Automatic execution starts admitted work immediately. @public */
	execution?: "automatic" | "manual";
	/** Model catalog used by the supplied provider extensions. @public */
	models?: readonly {
		/** @public */
		id: string;
		/** @public */
		provider: string;
		/** @public */
		modelId: string;
		/** @public */
		thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	}[];
	/** Default model profile for all registered processes. @public */
	defaultModel?: string;
	/** Model scripts for automatic execution, in prompt order per process. @public */
	script?(
		instanceId: string,
		prompt: string,
		observation: TestObservation<IntegrationPromptObservation>,
	): IntegrationTurnScript | Promise<IntegrationTurnScript>;
}

/** HTTP-shaped requests without a Fastify handle. @public */
export interface ExtensionTestRequest {
	/** @public */
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	/** @public */
	url: string;
	/** @public */
	payload?: Record<string, unknown>;
	/** @public */
	headers?: Record<string, string>;
}

/** HTTP response observation. @public */
export interface ExtensionTestResponse {
	/** @public */
	statusCode: number;
	/** @public */
	body: string;
	/** @public */
	json<T = unknown>(): T;
}

/** Accepted turn identity and optional retained result. @public */
export interface AcceptedTurnReference {
	/** @public */
	id: string;
	/** @public */
	instanceId: string;
	/** @public */
	turnId: string;
	/** @public */
	artifact: {
		/** @public */ kind: "turn_result";
		/** @public */
		turnRecordId: string;
	} | null;
}

/** One durably settled worker execution. @public */
export interface IntegrationTurnResult {
	/** @public */
	turn: ProcessTurnRecord | null;
	/** @public */
	outcome: string | null;
	/** @public */
	failure: string | null;
	/** @public */
	prompts: string[];
	/** @public */
	toolResults: {
		/** @public */ name: string;
		/** @public */
		result: unknown;
	}[];
	/** @public */
	result: AcceptedTurnReference["artifact"];
}

/** Durable process commands and observations. @public */
export interface ExtensionIntegrationProcess {
	/** @public */
	readonly id: string;
	/** @public */
	seedAcceptedTurn(fixture: AcceptedTurnFixture): Promise<TestObservation<AcceptedTurnReference>>;
	/** @public */
	snapshot(): TestObservation<ExtensionIntegrationSnapshot>;
	/** @public */
	waitFor(
		condition: (snapshot: TestObservation<ExtensionIntegrationSnapshot>) => boolean,
		options?: {
			/** @public */ timeoutMs?: number;
			/** @public */
			description?: string;
		},
	): Promise<TestObservation<ExtensionIntegrationSnapshot>>;
	/** @public */
	runTurn(script?: IntegrationTurnScript): Promise<TestObservation<IntegrationTurnResult>>;
	/** @public */
	action(id: string, input?: Record<string, unknown>): Promise<ExtensionTestResponse>;
	/** @public */
	retry(): Promise<ExtensionTestResponse>;
	/** @public */
	supplyInput(
		input: IntegrationProcessInput,
	): Promise<TestObservation<ExtensionIntegrationSnapshot>>;
	/** @public */
	answerQuestions(
		id: string,
		answers: readonly {
			/** @public */
			selectedOptionIds: readonly string[];
			/** @public */
			freeText: string;
			/** @public */
			comment: string;
		}[],
	): Promise<ExtensionTestResponse>;
	/** @public */
	respondToApproval(
		id: string,
		response: {
			/** @public */
			action: "accept" | "feedback" | "decline";
			/** @public */
			feedback?: string;
		},
	): Promise<ExtensionTestResponse>;
}

/** Disposable persistent extension test environment. @public */
export interface ExtensionIntegrationHarness {
	/** Detached processes discovered or launched by extensions. @public */
	processes(): TestObservation<ProcessInstance[]>;

	/** @public */
	request(input: ExtensionTestRequest): Promise<ExtensionTestResponse>;
	/** @public */
	process(id: string): ExtensionIntegrationProcess;
	/** @public */
	launch(id: string, input: Record<string, unknown>): Promise<ExtensionIntegrationProcess>;
	/** @public */
	createProcess<TParams, TState>(
		definition: ExtensionProcessDefinition<TParams, TState>,
		input?: Omit<ProcessFixtureOptions<TParams, TState>, "id" | "processId"> & {
			/** @public */
			projects?: readonly ProcessProject[];
		},
	): Promise<ExtensionIntegrationProcess>;
	/** @public */
	restart(options?: {
		/** Update extension wiring on the reopened server. @public */
		extensionConfig?: Readonly<Record<string, unknown>>;
		/** Apply external changes while the server is offline. @public */
		whileStopped?(): void | Promise<void>;
	}): Promise<void>;
	/** @public */
	close(): Promise<void>;
}

/** Own server, workers, and disposable persistent storage. @public */
export async function createExtensionIntegrationHarness(
	options: ExtensionIntegrationHarnessOptions,
): Promise<ExtensionIntegrationHarness> {
	const catalog = await buildExtensionCatalogFromModules([
		...(options.polling === "manual"
			? [
					{
						manifest: { id: "test-support-manual-polling", version: "1" },
						setupServer(api: import("@leitwerk-dev/process-sdk").ServerExtensionAPI) {
							const deps = api.get(coreHostCapabilities.serverSetup);
							if (!deps || Array.isArray(deps)) throw new Error("Missing polling host");
							deps.polling = {
								create(input) {
									return { poll: input.pollOnce };
								},
							};
						},
					},
				]
			: []),
		...options.extensions,
	]);
	const persistent = createPersistentIntegrationFixture("leitwerk-extension-test-", (config) => {
		config.extensions = structuredClone(options.extensionConfig ?? {});
		if (options.hostDocker && config.local_worker) config.local_worker.allow_host_docker = true;
		config.pi.model_profiles = (options.models ?? []).map((model) => ({
			id: model.id,
			provider: model.provider,
			model_id: model.modelId,
			thinking_level: model.thinkingLevel ?? "off",
		}));
		if (options.defaultModel) {
			config.pi.process_title_generation.model_profile = options.defaultModel;
			config.process_configs = Object.fromEntries(
				[...catalog.processes.keys()].map((id) => [
					id,
					{
						default_model_profile: options.defaultModel,
						turn_configs: {},
						watchers: structuredClone(options.watchers?.[id] ?? {}),
					},
				]),
			);
		}
	});
	const manual = options.execution === "manual";
	let closed = false;
	const pending = new Map<string, { turnId: string; resolve(): void }>();
	const permits = new Set<string>();
	const executing = new Set<string>();
	const scripts = new Map<string, IntegrationTurnScript>();
	const observations = new Map<
		string,
		{ prompts: string[]; toolResults: { name: string; result: unknown }[] }
	>();
	const context = () => {
		if (closed) throw new Error("Extension integration harness is closed");
		return persistent.context();
	};
	async function open() {
		const piFactory: StubPiTreeHandleFactory = new StubPiTreeHandleFactory({
			recordSessionTrace: true,
			toolCallScriptResolver: async (input) => {
				const id = input.instanceId;
				if (!id) throw new Error("Scripted prompt has no process identity");
				const observation = observations.get(id) ?? { prompts: [], toolResults: [] };
				observations.set(id, observation);
				const prompt = input.identifiedPromptText ?? input.promptText;
				observation.prompts.push(prompt);
				const session = [...piFactory.sessions]
					.reverse()
					.find((session) => session.treeFile === input.treeFile);
				const history =
					session
						?.getBranch()
						.map((entry) => {
							if (entry.type === "custom_message") return entry.content;
							if (entry.type === "message" && entry.message) return entry.message.content;
							return "";
						})
						.filter((value) => typeof value === "string")
						.join("\n\n") ?? "";
				const script = manual
					? scripts.get(id)
					: await options.script?.(
							id,
							prompt,
							observe({
								turnId: context().deps.processes.getById(id)?.selectedTurnId ?? "",
								cwd: input.sessionCwd ?? input.workspaceRoot ?? "",
								branchId: session?.sessionId ?? "",
								history,
								tools: input.tools.map((tool) => ({
									name: tool.name,
									parameters: tool.parameters,
								})),
							}),
						);
				scripts.delete(id);
				if (!script || (script.tools.length === 0 && script.markdown === undefined))
					throw new Error(
						`Script exhausted for process '${id}' after ${observation.prompts.length} prompt(s)`,
					);
				return {
					thinkingChunks: script.thinking ? [...script.thinking] : undefined,
					textChunks: script.markdown === undefined ? undefined : [script.markdown],
					calls: script.tools.map((call) => ({
						toolName: call.name,
						args: structuredClone(call.arguments),
					})),
					afterToolResult(call, result) {
						observation.toolResults.push({ name: call.toolName, result: structuredClone(result) });
						const next = script.afterToolResult?.(
							{ name: call.toolName, arguments: structuredClone(call.args) },
							structuredClone(result),
						);
						return next ? { toolName: next.name, args: next.arguments } : undefined;
					},
				};
			},
		});
		await persistent.open({
			appOverrides: options.hostDocker
				? { localWorkerDockerPreflightImpl: options.hostDocker.preflight }
				: undefined,
			extensionCatalog: catalog,
			preProvidedCapabilities: options.capabilities,
			inProcessWorkers: {
				piFactory,
				beforeTurnBootstrap: manual
					? (id, turnId, signal) =>
							new Promise<void>((resolve, reject) => {
								if (signal.aborted) {
									return;
								}
								if (permits.delete(id)) {
									resolve();
									return;
								}
								if (pending.has(id)) {
									reject(new Error(`Conflicting pending worker for '${id}'`));
									return;
								}
								const abort = () => {
									pending.delete(id);
								};
								signal.addEventListener("abort", abort, { once: true });
								pending.set(id, {
									turnId,
									resolve() {
										signal.removeEventListener("abort", abort);
										pending.delete(id);
										resolve();
									},
								});
							})
					: undefined,
			},
		});
	}
	try {
		await open();
	} catch (error) {
		await persistent.dispose();
		throw error;
	}
	/** @public */
	async function request(input: ExtensionTestRequest) {
		const response = await context().app.inject({ ...input, method: input.method ?? "GET" });
		return {
			/** @public */
			statusCode: response.statusCode,
			/** @public */
			body: response.body,
			/** @public */
			json<T = unknown>(): T {
				return JSON.parse(response.body) as T;
			},
		};
	}
	async function post(url: string, payload: Record<string, unknown> = {}) {
		const response = await request({ method: "POST", url, payload });
		if (response.statusCode >= 400)
			throw new Error(`POST ${url}: ${response.statusCode} ${response.body}`);
		return response;
	}
	/** @public */
	function processHandle(id: string): ExtensionIntegrationProcess {
		const prefix = `/api/processes/${encodeURIComponent(id)}`;
		/** @public */
		function snapshot(): TestObservation<ExtensionIntegrationSnapshot> {
			const { deps } = context();
			const process = deps.processes.getById(id);
			if (!process) throw new Error(`Unknown process '${id}'`);
			const definition = catalog.processes.get(process.processId);
			return observe({
				workspaceRoot: path.join(context().config.storage.process_workspaces_dir, id),
				events: deps.events.listByInstance(id),
				annotations: deps.turnAnnotations.listByInstance(id),
				leafOutcomes: deps.leafOutcomeSnapshots.listByInstance(id),
				process,
				params: definition?.paramsCodec.parse(JSON.parse(process.paramsJson ?? "null")),
				state: definition?.stateCodec.parse(JSON.parse(process.stateJson ?? "null")),
				projects: deps.projects.listByInstance(id),
				turns: deps.turnRecords.listByInstance(id),
				inputs: deps.inputs.listByInstance(id),
				questions: deps.questionRequests.listByInstance(id),
				approvals: deps.toolApprovalRequests.listByInstance(id),
				writeReceipts: deps.externalWrites.listByInstance(id),
			});
		}
		/** @public */
		async function waitFor(
			condition: (snapshot: TestObservation<ExtensionIntegrationSnapshot>) => boolean,
			options: Parameters<ExtensionIntegrationProcess["waitFor"]>[1] = {},
		) {
			const deadline = Date.now() + (options.timeoutMs ?? 12000);
			for (;;) {
				const current = snapshot();
				if (condition(current)) return current;
				if (Date.now() >= deadline)
					throw new Error(
						`Timed out waiting for ${id}: ${options.description ?? "condition"}; ${JSON.stringify({
							position: {
								selectedTurnId: current.process.selectedTurnId,
								lifecycleStatus: current.process.lifecycleStatus,
							},
							turns: current.turns.map((turn) => ({
								id: turn.id,
								turnId: turn.turnId,
								status: turn.status,
								error: turn.errorSummary,
							})),
							inputs: current.inputs.map((input) => ({
								id: input.id,
								consumedAt: input.consumedAt,
							})),
							questions: current.questions.map((question) => ({
								id: question.id,
								status: question.status,
							})),
							approvals: current.approvals.map((approval) => ({
								id: approval.id,
								status: approval.status,
							})),
						})}`,
					);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		return {
			/** @public */
			id,
			/** Establish correlated accepted records under exclusive server coordination. @public */
			async seedAcceptedTurn(fixture) {
				const ctx = context();
				return ctx.deps.processOperations.runExclusive(id, async () => {
					const process = ctx.deps.processes.getById(id);
					if (!process) throw new Error(`Unknown process '${id}'`);
					const turn = catalog.processes
						.get(process.processId)
						?.turns.get(fixture.turnId)?.definition;
					if (!turn || (turn.kind !== "llm" && turn.kind !== "automatic"))
						throw new Error(`Undeclared worker turn '${fixture.turnId}'`);
					if (process.currentExecution || ctx.deps.leases.getByInstance(id))
						throw new Error("Cannot seed accepted execution while a live execution exists");
					const running = fixture.execution.status === "running";
					if (running && process.selectedTurnId !== fixture.turnId)
						throw new Error("Running fixture must match the selected turn");
					if (
						fixture.execution.status === "succeeded" &&
						!Object.hasOwn(turn.outcomes ?? {}, fixture.execution.outcome) &&
						turn.turnEnd?.outcome !== fixture.execution.outcome
					)
						throw new Error(`Undeclared outcome '${fixture.execution.outcome}'`);
					if (fixture.execution.status === "succeeded" && !fixture.execution.markdown.trim())
						throw new Error("A successful accepted fixture requires non-empty result markdown");
					const prepared =
						turn.kind === "llm"
							? await prepareAcceptedFixtureStart(
									ctx,
									process,
									fixture.turnId,
									catalog.piContributions,
								)
							: null;
					const turnId = `trn_${randomUUID()}`;
					if (prepared)
						await persistPiResourceBundleForStart({
							bundlesDir: path.join(
								ctx.config.storage.process_workspaces_dir,
								id,
								".leitwerk",
								"pi-resource-bundles",
							),
							startRecordId: `tsr_${turnId}`,
							digest: prepared.bundle.digest,
							deliveredBundle: prepared.bundle.bytes,
						});
					return ctx.deps.transaction((repos) => {
						const timestamp = new Date().toISOString();
						const input = {
							id: turnId,
							instanceId: id,
							turnId: fixture.turnId,
							status: fixture.execution.status,
							attemptNumber:
								Math.max(
									0,
									...repos.turnRecords
										.listByInstance(id)
										.filter((record) => record.turnId === fixture.turnId)
										.map((record) => record.attemptNumber),
								) + 1,
							startedAt: timestamp,
							endedAt: running ? null : timestamp,
							turnResultMarkdown:
								fixture.execution.status === "succeeded" ? fixture.execution.markdown : null,
						};
						createAcceptedWorkerTurn(
							{ deps: repos },
							{ ...input, turnType: turn.kind, modelProfileId: prepared?.start.model.profileId },
							{ current: running, preparedStart: prepared?.start },
						);
						if (fixture.execution.status === "succeeded")
							repos.turnAnnotations.create({
								instanceId: id,
								annotationType: "turn_milestone",
								annotationKey: `turn_milestone:${turnId}`,
								references: [{ kind: "turn_record", turnRecordId: turnId, role: "subject" }],
								payload: {
									turnId: fixture.turnId,
									turnType: turn.kind,
									pathType: "primary",
									outcome: fixture.execution.outcome,
								},
							});
						if (running) repos.processes.update(id, { lifecycleStatus: "active" });
						return observe({
							id: turnId,
							instanceId: id,
							turnId: fixture.turnId,
							artifact: running ? null : { kind: "turn_result" as const, turnRecordId: turnId },
						});
					});
				});
			},
			/** Read detached durable business and execution observations. @public */
			snapshot,
			/** Wait with a bounded deadline and final observations on failure. @public */
			waitFor,
			/** Execute one selected worker turn; resolves after durable completion or failure. @public */
			async runTurn(script = { tools: [] }) {
				if (!manual) throw new Error("runTurn requires manual execution mode");
				if (executing.has(id)) throw new Error(`A turn is already running for '${id}'`);
				const before = snapshot();
				const selected = before.process.selectedTurnId;
				const turn = selected
					? catalog.processes.get(before.process.processId)?.turns.get(selected)?.definition
					: undefined;
				if (
					!selected ||
					!turn ||
					(turn.kind !== "llm" && turn.kind !== "automatic") ||
					before.process.lifecycleStatus !== "active"
				)
					throw new Error(`Process '${id}' has no active worker turn: ${JSON.stringify(before)}`);
				executing.add(id);
				const previous = new Set(before.turns.map((turn) => turn.id));
				observations.set(id, { prompts: [], toolResults: [] });
				scripts.set(id, script);
				try {
					const gate = pending.get(id);
					if (gate) {
						if (gate.turnId !== selected)
							throw new Error("Pending turn does not match selected turn");
						gate.resolve();
					} else permits.add(id);
					const after = await waitFor(
						(current) =>
							current.turns.some((turn) => !previous.has(turn.id) && turn.status !== "running") ||
							current.process.lifecycleStatus === "error",
						{ description: `durable outcome of ${selected}` },
					);
					const record = after.turns.find((turn) => !previous.has(turn.id));
					const milestone = record
						? context().deps.turnAnnotations.findByKey(id, `turn_milestone:${record.id}`)
						: null;
					return observe({
						turn: record ?? null,
						outcome:
							typeof milestone?.payload.outcome === "string" ? milestone.payload.outcome : null,
						failure:
							record?.errorSummary ??
							(after.process.lifecycleStatus === "error"
								? "Worker start failed before acceptance"
								: null),
						prompts: observations.get(id)?.prompts ?? [],
						toolResults: observations.get(id)?.toolResults ?? [],
						result:
							record?.status === "succeeded" && record.turnResultMarkdown
								? { kind: "turn_result" as const, turnRecordId: record.id }
								: null,
					});
				} finally {
					executing.delete(id);
					scripts.delete(id);
					permits.delete(id);
				}
			},
			/** Execute an application action. @public */
			action: (actionId, input = {}) =>
				post(`${prefix}/actions/${encodeURIComponent(actionId)}`, { input }),
			/** Retry the failed execution through the application command. @public */
			retry: () => post(`${prefix}/retry`),
			/** Queue an instruction using the application command and normal delivery. @public */
			async supplyInput(input) {
				const result = await context().deps.processEngine.queueInputs(id, [
					{
						source: "app_steer",
						kind: "instruction",
						bodyMarkdown: input.bodyMarkdown,
						...(input.product ? { target: { productName: input.product } } : {}),
					},
				]);
				if (!result.ok) throw new Error(`Input rejected: ${result.message}`);
				return snapshot();
			},
			/** Answer an open question request. @public */
			answerQuestions: (requestId, answers) =>
				post(`${prefix}/question-requests/${encodeURIComponent(requestId)}/answers`, {
					draft: answers,
				}),
			/** Resolve an open tool approval. @public */
			respondToApproval: (requestId, response) =>
				post(`${prefix}/tool-approval-requests/${encodeURIComponent(requestId)}`, response),
		};
	}
	return {
		/** Observe discovered processes. @public */
		processes: () => observe(context().deps.processes.listAll()),
		/** Send an HTTP-shaped request, retaining error status and body. @public */
		request,
		/** Get a handle that remains valid across restart. @public */
		process: processHandle,
		/** Admit work through a registered UI launcher. @public */
		async launch(id, input) {
			const response = await postImmediateLaunch(context().config.server.base_url, id, {
				launcherInput: input,
			});
			const body = (await response.json()) as { process?: { id: string } };
			if (!response.ok || !body.process)
				throw new Error(`Launch '${id}' failed: ${JSON.stringify(body)}`);
			return processHandle(body.process.id);
		},
		/** Create validated business data and start an active position through the engine. @public */
		async createProcess(definition, input = {}) {
			if (catalog.processes.get(definition.id) !== definition)
				throw new Error(`Process '${definition.id}' must be registered by an extension`);
			const fixture = createProcessFixture(input, definition);
			const { deps } = context();
			const process = deps.transaction((repos) => {
				const process = repos.processes.create({
					processId: definition.id,
					title: fixture.title,
					externalId: fixture.externalId,
					externalUrl: fixture.externalUrl,
					metadata: fixture.metadata,
					paramsJson: fixture.paramsJson,
					stateJson: fixture.stateJson,
					selectedTurnId: fixture.selectedTurnId,
					lifecycleStatus:
						fixture.lifecycleStatus === "active" ? "waiting" : fixture.lifecycleStatus,
				});
				if (fixture.planRevision !== 0)
					repos.processes.update(process.id, { planRevision: fixture.planRevision });
				for (const project of input.projects ?? [])
					repos.projects.create({
						instanceId: process.id,
						key: project.key,
						repoLocator: project.repoLocator,
						baseBranch: project.baseBranch,
						workBranch: project.workBranch,
						metadata: project.metadata,
						externalId: project.externalId,
						externalUrl: project.externalUrl,
						pipelineStatus: project.pipelineStatus,
					});
				return process;
			});
			if (fixture.lifecycleStatus === "active" && fixture.selectedTurnId) {
				const result = await deps.processEngine.startProcess(process.id, fixture.selectedTurnId);
				if (!result.ok) throw new Error(`Process start failed: ${result.message}`);
			}
			return processHandle(process.id);
		},
		/** Reopen the same file-backed storage and retain existing handles. @public */
		async restart(restartOptions = {}) {
			if (executing.size) throw new Error("Cannot restart during runTurn");
			const { deps } = context();
			const paused = manual
				? deps.processes.listAll().flatMap((process) => {
						if (
							process.lifecycleStatus !== "active" ||
							process.currentExecution?.kind !== "worker_start"
						)
							return [];
						const start = deps.turnStarts.getById(process.currentExecution.id);
						return start?.state.kind === "starting"
							? [{ instanceId: process.id, startId: start.id }]
							: [];
					})
				: [];
			await persistent.close();
			if (restartOptions.extensionConfig)
				options.extensionConfig = structuredClone(restartOptions.extensionConfig);
			await restartOptions.whileStopped?.();
			pending.clear();
			permits.clear();
			scripts.clear();
			await open();
			for (const pausedStart of paused) {
				if (context().deps.processes.getById(pausedStart.instanceId)?.lifecycleStatus !== "error")
					continue;
				const result = await context().deps.processEngine.retryStartup(
					pausedStart.instanceId,
					pausedStart.startId,
				);
				if (!result.ok)
					throw new Error(`Cannot restore paused turn after restart: ${result.message}`);
			}
		},
		/** Release all resources and remove harness-owned files. @public */
		async close() {
			if (closed) return;
			closed = true;
			try {
				await persistent.dispose();
			} finally {
				pending.clear();
				permits.clear();
				scripts.clear();
			}
		},
	};
}
