import type { ProcessInstance, ProcessProject, TurnId } from "@leitwerk-dev/domain";
import type {
	ActionExecutionResultLike,
	ExternalActionSource,
	ExternalSourceArmingLike,
	ExternalSourceFireInput,
	ExternalSourceServiceLike,
	ExternalSourceTransition,
	ProcessEffectPlan,
	ProcessHumanTurnExternalActionSpec,
	ServerTransitionRequest,
} from "@leitwerk-dev/process-sdk";
import {
	getExternalActionArmingId,
	getExternalActionTransitionTrigger,
	getExternalSourceTransitionId,
	isExternalTurnDefinition,
	isHumanTurnDefinition,
} from "@leitwerk-dev/process-sdk";
import { generateId, now } from "./db/repo-helpers.js";
import type { PendingExternalSourceFire, RepositoryBundle } from "./db/repositories.js";
import type { ProcessActionRegistry } from "./process-action-registry.js";
import { accept, reject } from "./process-engine/decision.js";
import { defineOperation } from "./process-engine/operation.js";
import type { ProcessEngine } from "./process-engine/types.js";
import { buildServerTransitionWrites } from "./process-engine/writes/build-server-transition-writes.js";
import { createDeferredExtensionEvent } from "./process-engine/writes/deferred-extension-events.js";
import { appendProcessEffects } from "./process-engine/writes/process-effects.js";
import {
	applyProcessPatchField,
	createWrites,
	isWriteBuildFailure,
	mergeWrites,
	type Writes,
} from "./process-engine/writes/writes.js";
import { validateQueuedProcessInput } from "./process-input-dispatch.js";
import { mergeProductRefPatchIntoStateJson } from "./product-ref-state.js";

interface ExternalTransitionRuntime<TParams = unknown, TState = unknown> {
	to?: TurnId;
	complete?: boolean;
	lifecycleStatus?: "completed" | "aborted";
	effect?: ExternalSourceTransition<TParams, TState>["effect"];
	publishInput?: ProcessHumanTurnExternalActionSpec<TParams, TState>["publishInput"];
}

interface ResolvedExternalSourceArming extends ExternalSourceArmingLike {
	transitionIndex: number;
	transition: ExternalTransitionRuntime;
	transitionTrigger: string;
	label: string | null;
	description: string | null;
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	params: unknown;
	state: unknown;
}

interface KnownExternalArming {
	turnId: string;
	externalActionId: string;
	sourceKind: string;
}

export interface ExternalSourceServiceDeps
	extends Pick<RepositoryBundle, "processes" | "projects" | "pendingExternalSourceFires"> {
	commands: ProcessEngine;
	processActionRegistry: ProcessActionRegistry;
}

export interface ExternalSourceService extends ExternalSourceServiceLike {
	drainQueued(instanceId: string): Promise<void>;
	invalidateArmings(instanceId: string): void;
	reconcileArmings(instanceId: string): Promise<void>;
	reconcileAllArmings(): Promise<void>;
}

const TERMINAL_STATUSES = new Set(["completed", "aborted"]);

function normalizeRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};
}

function sourceLabel(source: ExternalActionSource): string | null {
	return typeof source.label === "string" && source.label.trim() !== "" ? source.label : null;
}

function sourceDescription(source: ExternalActionSource): string | null {
	return typeof source.description === "string" && source.description.trim() !== ""
		? source.description
		: null;
}

function resolveSource(input: {
	source: ExternalActionSource;
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	params: unknown;
	state: unknown;
}): unknown {
	return input.source.resolve?.({
		process: input.process,
		projects: input.projects,
		params: input.params,
		state: input.state,
	});
}

function isSelectedWaitingTurn(process: ProcessInstance): boolean {
	return process.selectedTurnId !== null && process.lifecycleStatus === "waiting";
}

function transitionTarget(input: {
	transition: ExternalTransitionRuntime;
	trigger: string;
}): Omit<ServerTransitionRequest, "state"> {
	if (input.transition.to !== undefined) {
		return { turnId: input.transition.to, trigger: input.trigger };
	}
	if (input.transition.complete === true) {
		return { turnId: null, lifecycleStatus: "completed", trigger: input.trigger };
	}
	return {
		turnId: null,
		lifecycleStatus: input.transition.lifecycleStatus,
		trigger: input.trigger,
	};
}

function appendExternalSourceEvent(
	writes: Writes,
	instanceId: string,
	eventType:
		| "external_source_consumed"
		| "external_source_failed"
		| "external_source_queued"
		| "external_source_dropped",
	data: Record<string, unknown>,
): void {
	writes.events.push({ instanceId, eventType, data });
	writes.broadcasts.push({
		type: "process.event",
		payload: {
			eventType,
			level:
				eventType === "external_source_failed" || eventType === "external_source_dropped"
					? "warn"
					: "info",
			message:
				eventType === "external_source_failed"
					? "External source failed"
					: eventType === "external_source_queued"
						? "External source queued"
						: eventType === "external_source_dropped"
							? "External source dropped"
							: "External source consumed",
		},
		instanceId,
	});
}

function flattenProviderDiagnostics(provider: Record<string, unknown>): Record<string, unknown> {
	const diagnostics: Record<string, unknown> = {};
	for (const key of [
		"path",
		"pollInterval",
		"projectId",
		"iid",
		"mergedAt",
		"mergedBy",
		"webUrl",
	]) {
		if (provider[key] !== undefined) {
			diagnostics[key] = provider[key];
		}
	}
	return diagnostics;
}

function buildExternalSourceEventPayload(input: {
	armingId: string;
	instanceId: string;
	turnId: string;
	externalActionId: string;
	sourceKind: string;
	label: string | null;
	description: string | null;
	resolved?: unknown;
	provider?: Record<string, unknown>;
	fireInput?: Record<string, unknown>;
	code?: string;
	message?: string;
	queuedCount?: number;
	publishedProduct?: string | null;
}): Record<string, unknown> {
	const provider = input.provider ?? {};
	return {
		...flattenProviderDiagnostics(provider),
		armingId: input.armingId,
		instanceId: input.instanceId,
		turnId: input.turnId,
		externalActionId: input.externalActionId,
		sourceKind: input.sourceKind,
		label: input.label,
		description: input.description,
		...(input.resolved !== undefined ? { resolved: input.resolved } : {}),
		...(Object.keys(provider).length > 0 ? { provider } : {}),
		...(input.fireInput && Object.keys(input.fireInput).length > 0
			? { input: input.fireInput }
			: {}),
		...(input.code ? { code: input.code } : {}),
		...(input.message ? { message: input.message } : {}),
		...(input.queuedCount !== undefined ? { queuedCount: input.queuedCount } : {}),
		...(input.publishedProduct ? { publishedProduct: input.publishedProduct } : {}),
	};
}

function readPublishedInput(input: {
	arming: ResolvedExternalSourceArming;
	fireInput: Record<string, unknown>;
}):
	| { productName: string; markdown: string }
	| null
	| { ok: false; code: string; message: string } {
	const publication = input.arming.transition.publishInput;
	if (!publication) {
		return null;
	}
	const value = input.fireInput[publication.inputField];
	const markdown = typeof value === "string" ? value.trim() : "";
	if (!markdown) {
		return {
			ok: false,
			code: "external_source_input_missing",
			message: `External action '${input.arming.externalActionId}' fired without non-empty '${publication.inputField}' input`,
		};
	}
	return { productName: publication.productName, markdown };
}

async function buildExternalSourceEffectWrites(input: {
	arming: ResolvedExternalSourceArming;
	fireInput: Record<string, unknown>;
	fireEvent: Record<string, unknown>;
}): Promise<Writes | { ok: false; code: string; message: string }> {
	const writes = createWrites();
	let effectResult: ProcessEffectPlan | undefined;
	if (input.arming.transition.effect) {
		try {
			effectResult = await input.arming.transition.effect({
				process: input.arming.process,
				projects: input.arming.projects,
				params: input.arming.params,
				state: input.arming.state,
				event: input.fireEvent,
				input: input.fireInput,
			});
		} catch (error) {
			return {
				ok: false,
				code: "external_source_effect_failed",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	for (const queuedInput of effectResult?.queueInput ?? []) {
		const validationError = validateQueuedProcessInput(queuedInput);
		if (validationError) {
			return { ok: false, code: "invalid_process_state", message: validationError };
		}
	}
	writes.queuedInputs.push(...(effectResult?.queueInput ?? []));

	if (effectResult) {
		if (effectResult.state !== undefined) {
			applyProcessPatchField(
				writes,
				{ stateJson: input.arming.process.stateJson },
				"stateJson",
				JSON.stringify(effectResult.state),
			);
		}
		appendProcessEffects(writes, input.arming.process, effectResult);
		for (const emitted of effectResult.emit ?? []) {
			const data = normalizeRecord(emitted.data);
			writes.events.push({
				instanceId: input.arming.instanceId,
				eventType: emitted.type,
				data,
			});
			writes.extensionEvents.push(
				createDeferredExtensionEvent(input.arming.instanceId, emitted.type, data as never),
			);
		}
	}

	return writes;
}

function parseNewExternalActionArmingId(armingId: string): {
	turnId: string;
	externalActionId: string;
} | null {
	const separator = armingId.indexOf(":");
	if (separator <= 0 || separator === armingId.length - 1) {
		return null;
	}
	return {
		turnId: armingId.slice(0, separator),
		externalActionId: armingId.slice(separator + 1),
	};
}

function mergeInstructionText(values: readonly Record<string, unknown>[]): string | null {
	const parts: string[] = [];
	for (const input of values) {
		for (const key of ["instruction", "bodyMarkdown", "message", "text", "content"]) {
			const value = input[key];
			if (typeof value === "string" && value.trim() !== "") {
				parts.push(value.trim());
				break;
			}
		}
	}
	return parts.length > 0 ? parts.join("\n\n") : null;
}

function providerEventsFrom(event: Record<string, unknown>): Record<string, unknown>[] {
	const nested = event.providerEvents;
	if (Array.isArray(nested)) {
		return nested.map(normalizeRecord).filter((entry) => Object.keys(entry).length > 0);
	}
	return Object.keys(event).length > 0 ? [event] : [];
}

function providerInputsFrom(input: Record<string, unknown>): Record<string, unknown>[] {
	const nested = input.providerInputs;
	if (Array.isArray(nested)) {
		return nested.map(normalizeRecord).filter((entry) => Object.keys(entry).length > 0);
	}
	return Object.keys(input).length > 0 ? [input] : [];
}

function mergePendingFires(fires: readonly PendingExternalSourceFire[]): {
	input: Record<string, unknown>;
	event: Record<string, unknown>;
	queuedCount: number;
} {
	if (fires.length === 0) {
		return { input: {}, event: {}, queuedCount: 0 };
	}
	const [first] = fires;
	const mergedInput = { ...(first?.input ?? {}) };
	const instruction = mergeInstructionText(fires.map((fire) => fire.input));
	if (instruction !== null) {
		for (const key of ["instruction", "bodyMarkdown", "message", "text", "content"]) {
			if (Object.hasOwn(mergedInput, key)) {
				mergedInput[key] = instruction;
			}
		}
		if (
			!Object.keys(mergedInput).some((key) =>
				["instruction", "bodyMarkdown", "message", "text", "content"].includes(key),
			)
		) {
			mergedInput.instruction = instruction;
		}
	}
	const providerInputs = fires.flatMap((fire) => providerInputsFrom(fire.input));
	if (providerInputs.length > 0) {
		mergedInput.providerInputs = providerInputs;
	}
	const providerEvents = fires.flatMap((fire) => providerEventsFrom(fire.event));
	return {
		input: mergedInput,
		event: {
			...(providerEvents[0] ?? first?.event ?? {}),
			providerEvents,
		},
		queuedCount: fires.reduce((sum, fire) => sum + fire.queuedCount, 0),
	};
}

function terminal(process: ProcessInstance): boolean {
	return TERMINAL_STATUSES.has(process.lifecycleStatus);
}

export function createExternalSourceService(
	deps: ExternalSourceServiceDeps,
): ExternalSourceService {
	const armedIdsByInstance = new Map<string, Set<string>>();
	// Providers may poll every 50ms. Startup and after-success reconciliation keep
	// this cache current so polling does not repeatedly decode every process row.
	const currentArmingsByInstance = new Map<string, readonly ResolvedExternalSourceArming[]>();
	const invalidatedArmingInstances = new Set<string>();
	let allArmingsReconciled = false;
	const reconcilingArmingInstances = new Set<string>();
	const reconcileArmingsAgain = new Set<string>();
	const drainingInstances = new Set<string>();
	const drainAgain = new Set<string>();

	function listArmingsForProcess(process: ProcessInstance): ResolvedExternalSourceArming[] {
		if (!isSelectedWaitingTurn(process)) {
			return [];
		}
		const armed: ResolvedExternalSourceArming[] = [];
		const turnId = process.selectedTurnId as TurnId;
		const turnDef = deps.processActionRegistry.getTurnDefinition(process.processId, turnId);
		if (!turnDef) {
			return [];
		}
		const { params, state } = deps.processActionRegistry.resolveContextData(
			process.processId,
			process,
		);
		const projects = deps.projects.listByInstance(process.id);

		if (isExternalTurnDefinition(turnDef)) {
			turnDef.transitions.forEach((transition, transitionIndex) => {
				const id = getExternalSourceTransitionId({
					turnId,
					source: transition.source,
					index: transitionIndex,
				});
				armed.push({
					id,
					instanceId: process.id,
					processId: process.processId,
					turnId,
					externalActionId: `${transition.source.kind}:${transitionIndex}`,
					source: transition.source,
					resolved: resolveSource({
						source: transition.source,
						process,
						projects,
						params,
						state,
					}),
					transitionIndex,
					transition,
					transitionTrigger: id,
					label: sourceLabel(transition.source),
					description: sourceDescription(transition.source),
					process,
					projects,
					params,
					state,
				});
			});
			return armed;
		}

		if (!isHumanTurnDefinition(turnDef) && turnDef.kind !== "automatic") {
			return [];
		}
		for (const [externalActionId, action] of Object.entries(turnDef.externalActions ?? {})) {
			if (action.when && !action.when({ process, projects, params, state })) {
				continue;
			}
			const id = getExternalActionArmingId({ turnId, externalActionId });
			armed.push({
				id,
				instanceId: process.id,
				processId: process.processId,
				turnId,
				externalActionId,
				source: action.source,
				resolved: resolveSource({
					source: action.source,
					process,
					projects,
					params,
					state,
				}),
				transitionIndex: 0,
				transition: action,
				transitionTrigger: getExternalActionTransitionTrigger({ externalActionId }),
				label: action.label ?? sourceLabel(action.source),
				description: action.description ?? sourceDescription(action.source),
				process,
				projects,
				params,
				state,
			});
		}
		return armed;
	}

	function cacheCurrentArmings(
		instanceId: string,
		currentArmings: readonly ResolvedExternalSourceArming[],
	): void {
		invalidatedArmingInstances.delete(instanceId);
		if (currentArmings.length === 0) {
			currentArmingsByInstance.delete(instanceId);
		} else {
			currentArmingsByInstance.set(instanceId, currentArmings);
		}
	}

	function refreshInvalidatedArmings(): void {
		for (const instanceId of [...invalidatedArmingInstances]) {
			const process = deps.processes.getById(instanceId);
			cacheCurrentArmings(instanceId, process ? listArmingsForProcess(process) : []);
		}
	}

	function listAllArmed(): ResolvedExternalSourceArming[] {
		if (!allArmingsReconciled) {
			return deps.processes.listAll().flatMap((process) => listArmingsForProcess(process));
		}
		refreshInvalidatedArmings();
		return [...currentArmingsByInstance.values()].flat();
	}

	function resolveArming(
		instanceId: string,
		armingId: string,
	): ResolvedExternalSourceArming | null {
		const process = deps.processes.getById(instanceId);
		if (!process) {
			return null;
		}
		return listArmingsForProcess(process).find((entry) => entry.id === armingId) ?? null;
	}

	function findKnownArming(processId: string, armingId: string): KnownExternalArming | null {
		const processDef = deps.processActionRegistry.getProcessGraph(processId);
		if (!processDef) {
			return null;
		}
		for (const [turnId, binding] of processDef.turns) {
			const turnDef = binding.definition;
			if (isHumanTurnDefinition(turnDef) || turnDef.kind === "automatic") {
				for (const [externalActionId, action] of Object.entries(turnDef.externalActions ?? {})) {
					if (getExternalActionArmingId({ turnId, externalActionId }) === armingId) {
						return { turnId, externalActionId, sourceKind: action.source.kind };
					}
				}
			}
			if (isExternalTurnDefinition(turnDef)) {
				for (const [index, transition] of turnDef.transitions.entries()) {
					const id = getExternalSourceTransitionId({
						turnId,
						source: transition.source,
						index,
					});
					if (id === armingId) {
						return {
							turnId,
							externalActionId: `${transition.source.kind}:${index}`,
							sourceKind: transition.source.kind,
						};
					}
				}
			}
		}
		return null;
	}

	function setRegisteredArmings(instanceId: string, armingIds: ReadonlySet<string>): void {
		if (armingIds.size === 0) {
			armedIdsByInstance.delete(instanceId);
			return;
		}
		armedIdsByInstance.set(instanceId, new Set(armingIds));
	}

	const RecordExternalSourceArmings = defineOperation<
		"record_external_source_armings",
		{ instanceId: string; registeredArmingIds: readonly string[] },
		{ currentArmingIds: string[]; recordedArmingIds: string[] }
	>({
		kind: "record_external_source_armings",
		label: "Record external source armings",
		decide(ctx, input) {
			const registered = new Set(input.registeredArmingIds);
			const currentArmings = listArmingsForProcess(ctx.process);
			const writes = createWrites();
			const recordedArmingIds: string[] = [];
			for (const entry of currentArmings) {
				if (registered.has(entry.id)) {
					continue;
				}
				writes.events.push({
					instanceId: entry.instanceId,
					eventType: "external_source_armed",
					data: buildExternalSourceEventPayload({
						armingId: entry.id,
						instanceId: entry.instanceId,
						turnId: entry.turnId,
						externalActionId: entry.externalActionId,
						sourceKind: entry.source.kind,
						label: entry.label,
						description: entry.description,
						resolved: entry.resolved,
						provider: normalizeRecord(entry.resolved),
					}),
				});
				recordedArmingIds.push(entry.id);
			}
			return accept({
				writes,
				data: {
					currentArmingIds: currentArmings.map((entry) => entry.id),
					recordedArmingIds,
				},
			});
		},
	});

	async function reconcileInstanceArmings(
		instanceId: string,
		currentArmings: readonly ResolvedExternalSourceArming[],
	): Promise<void> {
		cacheCurrentArmings(instanceId, currentArmings);
		const previousIds = new Set(armedIdsByInstance.get(instanceId) ?? []);
		const currentIds = new Set(currentArmings.map((entry) => entry.id));
		const hasNewArmings = currentArmings.some((entry) => !previousIds.has(entry.id));
		setRegisteredArmings(instanceId, currentIds);
		if (!hasNewArmings) {
			return;
		}

		const result = await (async () => {
			try {
				return await deps.commands.run(RecordExternalSourceArmings, {
					instanceId,
					registeredArmingIds: [...previousIds],
				});
			} catch (error) {
				setRegisteredArmings(instanceId, previousIds);
				throw error;
			}
		})();
		if (result.ok) {
			setRegisteredArmings(instanceId, new Set(result.data.currentArmingIds));
			return;
		}
		if (result.stage === "post_commit" && result.data) {
			setRegisteredArmings(instanceId, new Set(result.data.currentArmingIds));
		} else {
			setRegisteredArmings(instanceId, previousIds);
		}
		throw new Error(result.message);
	}

	async function reconcileArmings(instanceId: string): Promise<void> {
		if (reconcilingArmingInstances.has(instanceId)) {
			reconcileArmingsAgain.add(instanceId);
			return;
		}
		reconcilingArmingInstances.add(instanceId);
		try {
			let iterations = 0;
			do {
				reconcileArmingsAgain.delete(instanceId);
				iterations += 1;
				if (iterations > 20) {
					return;
				}
				const process = deps.processes.getById(instanceId);
				await reconcileInstanceArmings(instanceId, process ? listArmingsForProcess(process) : []);
			} while (reconcileArmingsAgain.has(instanceId));
		} finally {
			reconcilingArmingInstances.delete(instanceId);
			reconcileArmingsAgain.delete(instanceId);
		}
	}

	async function reconcileAllArmings(): Promise<void> {
		const currentProcesses = deps.processes.listAll();
		const currentInstanceIds = new Set(currentProcesses.map((process) => process.id));
		for (const process of currentProcesses) {
			await reconcileArmings(process.id);
		}
		for (const instanceId of [...armedIdsByInstance.keys()]) {
			if (!currentInstanceIds.has(instanceId)) {
				armedIdsByInstance.delete(instanceId);
			}
		}
		for (const instanceId of [...currentArmingsByInstance.keys()]) {
			if (!currentInstanceIds.has(instanceId)) {
				currentArmingsByInstance.delete(instanceId);
			}
		}
		for (const instanceId of [...invalidatedArmingInstances]) {
			if (!currentInstanceIds.has(instanceId)) {
				invalidatedArmingInstances.delete(instanceId);
			}
		}
		allArmingsReconciled = true;
	}

	const FireExternalSource = defineOperation<
		"fire_external_source",
		{
			instanceId: string;
			armingId: string;
			input: Record<string, unknown>;
			event: Record<string, unknown>;
			queuedCount?: number;
			pendingFireIds?: readonly string[];
		},
		Record<string, unknown>
	>({
		kind: "fire_external_source",
		label: "Fire external source",
		async decide(ctx, input) {
			const arming = resolveArming(input.instanceId, input.armingId);
			if (!arming) {
				return reject(
					"external_source_not_armed",
					`External source '${input.armingId}' is not armed for this process`,
				);
			}
			if (
				ctx.process.selectedTurnId !== arming.turnId ||
				ctx.process.lifecycleStatus !== "waiting"
			) {
				return reject(
					"external_source_stale",
					`External source '${input.armingId}' is stale for selected turn '${String(ctx.process.selectedTurnId)}'`,
				);
			}

			const effectWrites = await buildExternalSourceEffectWrites({
				arming,
				fireInput: input.input,
				fireEvent: input.event,
			});
			if (isWriteBuildFailure(effectWrites)) {
				const failedWrites = createWrites();
				appendExternalSourceEvent(
					failedWrites,
					arming.instanceId,
					"external_source_failed",
					buildExternalSourceEventPayload({
						armingId: arming.id,
						instanceId: arming.instanceId,
						turnId: arming.turnId,
						externalActionId: arming.externalActionId,
						sourceKind: arming.source.kind,
						label: arming.label,
						description: arming.description,
						provider: input.event,
						fireInput: input.input,
						code: effectWrites.code,
						message: effectWrites.message,
					}),
				);
				return accept({ writes: failedWrites, data: { ok: false, code: effectWrites.code } });
			}

			const recordedAt = now();
			const turnRecordId = generateId("trn");
			const publishedInput = readPublishedInput({ arming, fireInput: input.input });
			if (publishedInput && "ok" in publishedInput && publishedInput.ok === false) {
				const failedWrites = createWrites();
				appendExternalSourceEvent(
					failedWrites,
					arming.instanceId,
					"external_source_failed",
					buildExternalSourceEventPayload({
						armingId: arming.id,
						instanceId: arming.instanceId,
						turnId: arming.turnId,
						externalActionId: arming.externalActionId,
						sourceKind: arming.source.kind,
						label: arming.label,
						description: arming.description,
						provider: input.event,
						fireInput: input.input,
						code: publishedInput.code,
						message: publishedInput.message,
					}),
				);
				return accept({ writes: failedWrites, data: { ok: false, code: publishedInput.code } });
			}

			const externalWrites = createWrites({
				turnRecordWrites: [
					{
						kind: "create",
						input: {
							id: turnRecordId,
							instanceId: arming.instanceId,
							turnId: arming.turnId,
							turnType: "external",
							status: "succeeded",
							pathType: "primary",
							...(publishedInput && !("ok" in publishedInput)
								? {
										resultPiEntryId: `external:${turnRecordId}:${publishedInput.productName}`,
										turnResultMarkdown: publishedInput.markdown,
									}
								: {}),
							startedAt: recordedAt,
							endedAt: recordedAt,
						},
					},
				],
				turnAnnotationWrites: [
					{
						kind: "create",
						input: {
							instanceId: arming.instanceId,
							annotationType: "external_trigger",
							annotationKey: `external_source:${turnRecordId}`,
							references: [{ kind: "turn_record", turnRecordId, role: "subject" }],
							payload: {
								turnId: arming.turnId,
								externalActionId: arming.externalActionId,
								armingId: arming.id,
								sourceKind: arming.source.kind,
								label: arming.label,
								description: arming.description,
								event: input.event,
								...(publishedInput && !("ok" in publishedInput)
									? { publishedProduct: publishedInput.productName }
									: {}),
							},
							createdAt: recordedAt,
							updatedAt: recordedAt,
						},
					},
				],
			});

			if (publishedInput && !("ok" in publishedInput)) {
				const baseStateJson = effectWrites.processPatch.stateJson ?? ctx.process.stateJson;
				const patchedStateJson = mergeProductRefPatchIntoStateJson(
					baseStateJson,
					{
						[publishedInput.productName]: {
							entryId: `external:${turnRecordId}:${publishedInput.productName}`,
							turnRecordId,
						},
					},
					{ fallbackStateJson: ctx.process.stateJson },
				);
				if (patchedStateJson !== null) {
					applyProcessPatchField(
						externalWrites,
						{ stateJson: baseStateJson },
						"stateJson",
						patchedStateJson,
					);
				}
			}

			for (const pendingFireId of input.pendingFireIds ?? []) {
				externalWrites.pendingExternalSourceFireWrites.push({
					kind: "delete",
					id: pendingFireId,
				});
			}

			appendExternalSourceEvent(
				externalWrites,
				arming.instanceId,
				"external_source_consumed",
				buildExternalSourceEventPayload({
					armingId: arming.id,
					instanceId: arming.instanceId,
					turnId: arming.turnId,
					externalActionId: arming.externalActionId,
					sourceKind: arming.source.kind,
					label: arming.label,
					description: arming.description,
					resolved: arming.resolved,
					provider: input.event,
					fireInput: input.input,
					queuedCount: input.queuedCount,
					publishedProduct:
						publishedInput && !("ok" in publishedInput) ? publishedInput.productName : null,
				}),
			);

			const processForTransition = {
				...ctx.process,
				...effectWrites.processPatch,
				...externalWrites.processPatch,
			};
			const transitionWrites = buildServerTransitionWrites(
				ctx.deps.processGraphs,
				processForTransition,
				transitionTarget({ transition: arming.transition, trigger: arming.transitionTrigger }),
			);
			if (isWriteBuildFailure(transitionWrites)) {
				return reject(transitionWrites.code, transitionWrites.message);
			}

			return accept({
				writes: mergeWrites(effectWrites, externalWrites, transitionWrites),
				data: {
					armingId: arming.id,
					turnId: arming.turnId,
					externalActionId: arming.externalActionId,
					sourceKind: arming.source.kind,
				},
			});
		},
	});

	const QueueExternalSourceFire = defineOperation<
		"queue_external_source_fire",
		{
			instanceId: string;
			armingId: string;
			known: KnownExternalArming;
			fireInput: Record<string, unknown>;
			fireEvent: Record<string, unknown>;
			mergeKey?: string | null;
		},
		{ queued: true; armingId: string; queuedCount: number }
	>({
		kind: "queue_external_source_fire",
		label: "Queue external source fire",
		decide(ctx, input) {
			if (terminal(ctx.process)) {
				return reject(
					"external_source_terminal",
					"External source fired after the process reached a terminal state",
				);
			}
			const writes = createWrites();
			const mergeKey =
				typeof input.mergeKey === "string" && input.mergeKey.trim() !== ""
					? input.mergeKey.trim()
					: null;
			const existing = mergeKey
				? ctx.deps.pendingExternalSourceFires.getByMergeKey(
						input.instanceId,
						input.armingId,
						mergeKey,
					)
				: null;
			let queuedCount = 1;
			if (existing) {
				const merged = mergePendingFires([
					existing,
					{
						id: "pending:new",
						instanceId: input.instanceId,
						armingId: input.armingId,
						turnId: input.known.turnId,
						externalActionId: input.known.externalActionId,
						sourceKind: input.known.sourceKind,
						input: input.fireInput,
						event: input.fireEvent,
						mergeKey,
						queuedCount: 1,
						createdAt: now(),
						updatedAt: now(),
					},
				]);
				queuedCount = merged.queuedCount;
				writes.pendingExternalSourceFireWrites.push({
					kind: "update",
					id: existing.id,
					input: {
						input: merged.input,
						event: merged.event,
						queuedCount,
					},
				});
			} else {
				writes.pendingExternalSourceFireWrites.push({
					kind: "create",
					input: {
						instanceId: input.instanceId,
						armingId: input.armingId,
						turnId: input.known.turnId,
						externalActionId: input.known.externalActionId,
						sourceKind: input.known.sourceKind,
						input: input.fireInput,
						event: input.fireEvent,
						mergeKey,
						queuedCount,
					},
				});
			}
			appendExternalSourceEvent(
				writes,
				input.instanceId,
				"external_source_queued",
				buildExternalSourceEventPayload({
					armingId: input.armingId,
					instanceId: input.instanceId,
					turnId: input.known.turnId,
					externalActionId: input.known.externalActionId,
					sourceKind: input.known.sourceKind,
					label: null,
					description: null,
					provider: input.fireEvent,
					fireInput: input.fireInput,
					queuedCount,
				}),
			);
			return accept({ writes, data: { queued: true, armingId: input.armingId, queuedCount } });
		},
	});

	const DropExternalSourceFire = defineOperation<
		"drop_external_source_fire",
		{
			instanceId: string;
			armingId: string;
			known: KnownExternalArming;
			code: string;
			message: string;
			fireInput?: Record<string, unknown>;
			fireEvent?: Record<string, unknown>;
			pendingFireId?: string;
		},
		void
	>({
		kind: "drop_external_source_fire",
		label: "Drop external source fire",
		decide(_ctx, input) {
			const writes = createWrites();
			if (input.pendingFireId) {
				writes.pendingExternalSourceFireWrites.push({ kind: "delete", id: input.pendingFireId });
			}
			appendExternalSourceEvent(
				writes,
				input.instanceId,
				"external_source_dropped",
				buildExternalSourceEventPayload({
					armingId: input.armingId,
					instanceId: input.instanceId,
					turnId: input.known.turnId,
					externalActionId: input.known.externalActionId,
					sourceKind: input.known.sourceKind,
					label: null,
					description: null,
					provider: input.fireEvent,
					fireInput: input.fireInput,
					code: input.code,
					message: input.message,
				}),
			);
			return accept({ writes });
		},
	});

	async function queueFire(input: {
		process: ProcessInstance;
		known: KnownExternalArming;
		armingId: string;
		fireInput: Record<string, unknown>;
		fireEvent: Record<string, unknown>;
		mergeKey?: string | null;
	}): Promise<ActionExecutionResultLike> {
		const result = await deps.commands.run(QueueExternalSourceFire, {
			instanceId: input.process.id,
			armingId: input.armingId,
			known: input.known,
			fireInput: input.fireInput,
			fireEvent: input.fireEvent,
			mergeKey: input.mergeKey ?? null,
		});
		if (!result.ok) {
			if (result.stage === "post_commit" && result.process) {
				return {
					ok: false,
					stage: "post_commit",
					process: result.process,
					code: result.code,
					error: result.message,
				};
			}
			return {
				ok: false,
				stage: "pre_commit",
				code: result.code,
				error: result.message,
			};
		}
		return {
			ok: true,
			process: result.process,
			data: normalizeRecord(result.data),
		};
	}

	async function dropPendingFire(input: {
		instanceId: string;
		armingId: string;
		known: KnownExternalArming;
		fireInput?: Record<string, unknown>;
		fireEvent?: Record<string, unknown>;
		code: string;
		message: string;
		pendingFireId?: string;
	}): Promise<void> {
		await deps.commands.run(DropExternalSourceFire, {
			instanceId: input.instanceId,
			armingId: input.armingId,
			known: input.known,
			fireInput: input.fireInput,
			fireEvent: input.fireEvent,
			code: input.code,
			message: input.message,
			pendingFireId: input.pendingFireId,
		});
	}

	async function fireImmediate(input: {
		instanceId: string;
		armingId: string;
		fireInput: Record<string, unknown>;
		fireEvent: Record<string, unknown>;
		queuedCount?: number;
		pendingFireIds?: readonly string[];
	}): Promise<ActionExecutionResultLike> {
		const result = await deps.commands.run(FireExternalSource, {
			instanceId: input.instanceId,
			armingId: input.armingId,
			input: input.fireInput,
			event: input.fireEvent,
			queuedCount: input.queuedCount,
			pendingFireIds: input.pendingFireIds,
		});
		if (!result.ok) {
			if (result.stage === "post_commit" && result.process) {
				return {
					ok: false,
					stage: "post_commit",
					process: result.process,
					code: result.code,
					error: result.message,
				};
			}
			return {
				ok: false,
				stage: "pre_commit",
				code: result.code,
				error: result.message,
			};
		}
		if ((result.data as { ok?: unknown }).ok === false) {
			return {
				ok: false,
				stage: "pre_commit",
				code: String((result.data as { code?: unknown }).code ?? "external_source_failed"),
				error: "External source failed",
			};
		}
		return { ok: true, process: result.process, data: normalizeRecord(result.data) };
	}

	async function queueOrDrop(input: {
		instanceId: string;
		armingId: string;
		fireInput: Record<string, unknown>;
		fireEvent: Record<string, unknown>;
		mergeKey?: string | null;
		code?: string;
		message?: string;
	}): Promise<ActionExecutionResultLike> {
		const process = deps.processes.getById(input.instanceId);
		if (!process) {
			return {
				ok: false,
				stage: "pre_commit",
				code: "external_source_not_armed",
				error: `External source '${input.armingId}' is not armed`,
			};
		}
		const known = findKnownArming(process.processId, input.armingId);
		if (!known) {
			return {
				ok: false,
				stage: "pre_commit",
				code: "external_source_not_armed",
				error: `External source '${input.armingId}' is not armed for this process`,
			};
		}
		if (terminal(process)) {
			await dropPendingFire({
				instanceId: input.instanceId,
				armingId: input.armingId,
				known,
				fireInput: input.fireInput,
				fireEvent: input.fireEvent,
				code: "external_source_terminal",
				message: "External source fired after the process reached a terminal state",
			});
			return {
				ok: false,
				stage: "pre_commit",
				code: "external_source_not_armed",
				error: "External source fired after the process reached a terminal state",
			};
		}
		return queueFire({
			process,
			known,
			armingId: input.armingId,
			fireInput: input.fireInput,
			fireEvent: input.fireEvent,
			mergeKey: input.mergeKey,
		});
	}

	async function drainQueued(instanceId: string): Promise<void> {
		if (drainingInstances.has(instanceId)) {
			drainAgain.add(instanceId);
			return;
		}
		drainingInstances.add(instanceId);
		try {
			let iterations = 0;
			do {
				drainAgain.delete(instanceId);
				iterations += 1;
				if (iterations > 20) {
					return;
				}
				const process = deps.processes.getById(instanceId);
				const pending = deps.pendingExternalSourceFires.listByInstance(instanceId);
				if (!process || pending.length === 0) {
					continue;
				}
				if (terminal(process)) {
					for (const pendingFire of pending) {
						await dropPendingFire({
							instanceId,
							armingId: pendingFire.armingId,
							known: pendingFire,
							fireInput: pendingFire.input,
							fireEvent: pendingFire.event,
							code: "external_source_terminal",
							message: "Queued external source was dropped because the process is terminal",
							pendingFireId: pendingFire.id,
						});
					}
					continue;
				}
				await reconcileArmings(instanceId);
				const active = process ? listArmingsForProcess(process) : [];
				const activeIds = new Set(active.map((entry) => entry.id));
				const drainable = pending.find((entry) => activeIds.has(entry.armingId));
				if (!drainable) {
					if (process.lifecycleStatus === "waiting") {
						for (const pendingFire of pending) {
							await dropPendingFire({
								instanceId,
								armingId: pendingFire.armingId,
								known: pendingFire,
								fireInput: pendingFire.input,
								fireEvent: pendingFire.event,
								code: "external_source_no_longer_exposed",
								message:
									"Queued external source was dropped because the selected turn no longer exposes that external action",
								pendingFireId: pendingFire.id,
							});
						}
					}
					continue;
				}
				const group = pending.filter(
					(entry) => entry.armingId === drainable.armingId && entry.mergeKey === drainable.mergeKey,
				);
				const merged = mergePendingFires(group);
				const result = await fireImmediate({
					instanceId,
					armingId: drainable.armingId,
					fireInput: merged.input,
					fireEvent: merged.event,
					queuedCount: merged.queuedCount,
					pendingFireIds: group.map((pendingFire) => pendingFire.id),
				});
				if (!result.ok) {
					for (const pendingFire of group) {
						await dropPendingFire({
							instanceId,
							armingId: pendingFire.armingId,
							known: pendingFire,
							fireInput: pendingFire.input,
							fireEvent: pendingFire.event,
							code: result.code ?? "external_source_failed",
							message: result.error,
							pendingFireId: pendingFire.id,
						});
					}
				}
			} while (drainAgain.has(instanceId));
		} finally {
			drainingInstances.delete(instanceId);
			drainAgain.delete(instanceId);
		}
	}

	return {
		listArmed(kind: string) {
			const armed = listAllArmed();
			return armed
				.filter((entry) => entry.source.kind === kind)
				.map(
					({
						transition: _transition,
						transitionIndex: _transitionIndex,
						transitionTrigger: _transitionTrigger,
						label: _label,
						description: _description,
						process: _process,
						projects: _projects,
						params: _params,
						state: _state,
						...entry
					}) => entry,
				);
		},
		async fire(input: ExternalSourceFireInput): Promise<ActionExecutionResultLike> {
			const fireInput = normalizeRecord(input.input);
			const fireEvent = normalizeRecord(input.event);
			const active = resolveArming(input.instanceId, input.armingId);
			if (!active) {
				return queueOrDrop({
					instanceId: input.instanceId,
					armingId: input.armingId,
					fireInput,
					fireEvent,
					mergeKey: input.mergeKey,
				});
			}
			const result = await fireImmediate({
				instanceId: input.instanceId,
				armingId: input.armingId,
				fireInput,
				fireEvent,
			});
			if (
				!result.ok &&
				(result.code === "external_source_stale" || result.code === "external_source_not_armed")
			) {
				return queueOrDrop({
					instanceId: input.instanceId,
					armingId: input.armingId,
					fireInput,
					fireEvent,
					mergeKey: input.mergeKey,
					code: result.code,
					message: result.error,
				});
			}
			if (result.ok) {
				await drainQueued(input.instanceId);
			}
			return result;
		},
		drainQueued,
		invalidateArmings(instanceId: string) {
			if (allArmingsReconciled) invalidatedArmingInstances.add(instanceId);
		},
		reconcileArmings,
		reconcileAllArmings,
	};
}

void parseNewExternalActionArmingId;
