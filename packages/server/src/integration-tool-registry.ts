import type { Actor } from "@leitwerk-dev/domain";
import {
	type IntegrationToolDefinition,
	type IntegrationToolExecutionContext,
	RESERVED_INTEGRATION_TOOL_NAMES,
	type TicketCreationCapability,
	type TicketCreationDestinationList,
	type TicketCreationDestinationSnapshot,
	type TicketCreationDestinationSummary,
	type TicketCreationReceipt,
} from "@leitwerk-dev/process-sdk";
import type {
	IntegrationToolDeclaration,
	WorkerIntegrationToolCancelPayload,
	WorkerIntegrationToolRequestPayload,
	WorkerIntegrationToolResultPayload,
} from "@leitwerk-dev/worker-protocol";
import * as v from "valibot";
import type { RepositoryBundle } from "./db/repositories.js";
import {
	type ProcessActionRegistry,
	resolveTurnIntegrationToolNames,
} from "./process-action-registry.js";
import type { ToolApprovalGate } from "./tool-approval-gate.js";

type RegisteredIntegrationTool = IntegrationToolDefinition<unknown>;
type TicketCreationTool = RegisteredIntegrationTool & { capability: TicketCreationCapability };
type IntegrationToolExecutionInput = Omit<IntegrationToolExecutionContext, "signal">;

interface PendingIntegrationToolExecution {
	readonly controller: AbortController;
	readonly promise: Promise<unknown>;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED_TOOL_NAMES = new Set<string>(RESERVED_INTEGRATION_TOOL_NAMES);

export interface TicketToolCatalogEntry {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	readonly capability: TicketCreationCapability;
}

function isTicketCreationTool(
	definition: RegisteredIntegrationTool,
): definition is TicketCreationTool {
	return definition.capability?.kind === "ticket_creation";
}

function projectTicketTool(definition: TicketCreationTool): TicketToolCatalogEntry {
	return {
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		capability: { ...definition.capability },
	};
}

function assertJsonPointer(value: string, field: string): void {
	if (value === "") return;
	if (!value.startsWith("/") || /~(?![01])/u.test(value)) {
		throw new Error(`${field} must be a valid RFC 6901 JSON Pointer`);
	}
}

function validateTicketCapability(name: string, value: TicketCreationCapability): void {
	const capability = parseSchema(
		ticketCapabilitySchema,
		value,
		`Integration tool '${name}' has an invalid ticket capability`,
	);
	if (capability.titlePath !== undefined) assertJsonPointer(capability.titlePath, "titlePath");
	if (capability.descriptionPath !== undefined) {
		assertJsonPointer(capability.descriptionPath, "descriptionPath");
	}
	if (capability.destinations) {
		const provider = capability.destinations as Partial<
			Record<"list" | "resolve" | "validate", unknown>
		>;
		for (const method of ["list", "resolve", "validate"] as const) {
			if (typeof provider[method] !== "function") {
				throw new Error(`Integration tool '${name}' destination provider requires ${method}()`);
			}
		}
	}
}

const nonEmptyString = v.pipe(v.string(), v.trim(), v.nonEmpty());
const ticketCapabilitySchema = v.object({
	kind: v.literal("ticket_creation"),
	displayName: nonEmptyString,
	processId: nonEmptyString,
	startTurnId: nonEmptyString,
	titlePath: v.optional(v.string()),
	descriptionPath: v.optional(v.string()),
	destinations: v.optional(v.unknown()),
});
const destinationSummarySchema = v.pipe(
	v.object({
		id: nonEmptyString,
		displayName: nonEmptyString,
		group: v.optional(nonEmptyString),
		description: v.optional(nonEmptyString),
	}),
	v.transform((summary) => ({
		id: summary.id,
		displayName: summary.displayName,
		...(summary.group ? { group: summary.group } : {}),
		...(summary.description ? { description: summary.description } : {}),
	})),
);
const destinationSnapshotSchema = v.object({
	summary: destinationSummarySchema,
	data: v.unknown(),
	agentContext: v.optional(v.string()),
});
const destinationListSchema = v.object({
	destinations: v.array(destinationSummarySchema),
	warnings: v.optional(v.array(v.string())),
});
const ticketReceiptSchema = v.object({
	externalId: nonEmptyString,
	url: v.string(),
	result: v.optional(v.unknown()),
});
const persistedActorSchema = v.object({
	id: v.string(),
	kind: v.picklist(["user", "channel", "system"]),
	provider: v.union([v.null(), v.string()]),
	displayName: v.optional(v.string()),
});

function parseSchema<T>(
	schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>,
	value: unknown,
	message: string,
): T {
	const parsed = v.safeParse(schema, value);
	if (!parsed.success) throw new Error(message);
	return parsed.output;
}

function assertJsonSerializable(value: unknown, seen = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (!value || typeof value !== "object" || seen.has(value)) {
		throw new Error("Ticket destination snapshot must be JSON-serializable");
	}
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		throw new Error("Ticket destination snapshot must be JSON-serializable");
	}
	seen.add(value);
	for (const entry of Array.isArray(value) ? value : Object.values(value)) {
		assertJsonSerializable(entry, seen);
	}
	seen.delete(value);
}

function validateDestinationSnapshot(value: unknown): TicketCreationDestinationSnapshot {
	const snapshot = parseSchema(
		destinationSnapshotSchema,
		value,
		"Ticket destination snapshot must be an object with summary and adapter data",
	);
	const normalized = {
		summary: snapshot.summary,
		data: snapshot.data,
		...(snapshot.agentContext !== undefined ? { agentContext: snapshot.agentContext } : {}),
	};
	assertJsonSerializable(normalized);
	return JSON.parse(JSON.stringify(normalized)) as TicketCreationDestinationSnapshot;
}

export function validateTicketCreationReceipt(value: unknown): TicketCreationReceipt {
	const receipt = parseSchema(
		ticketReceiptSchema,
		value,
		"Ticket tool must return a receipt object",
	);
	let url: URL;
	try {
		url = new URL(receipt.url);
	} catch {
		throw new Error("Ticket receipt url must be a URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("Ticket receipt url must use http or https");
	}
	if (Object.hasOwn(receipt, "result")) assertJsonSerializable(receipt.result);
	return {
		externalId: receipt.externalId,
		url: url.toString(),
		...(Object.hasOwn(receipt, "result") ? { result: receipt.result } : {}),
	};
}

function resolveJsonPointer(value: unknown, pointer: string): unknown {
	if (pointer === "") return value;
	return pointer
		.slice(1)
		.split("/")
		.reduce<unknown>((current, token) => {
			if (!current || typeof current !== "object") return undefined;
			const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
			return (current as Record<string, unknown>)[key];
		}, value);
}

function parseToolArgs(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Integration tool arguments must be an object");
	}
	return value as Record<string, unknown>;
}

function persistedTicketActor(value: unknown): Actor {
	return parseSchema(persistedActorSchema, value, "Ticket creation actor is invalid");
}

function ticketDestinationChoices(paramsJson: string | null): TicketCreationDestinationSummary[] {
	if (!paramsJson) return [];
	try {
		const params = JSON.parse(paramsJson);
		const parsed = v.safeParse(
			v.object({ ticketDestinations: v.optional(v.array(destinationSummarySchema)) }),
			params,
		);
		return parsed.success && parsed.output.ticketDestinations
			? parsed.output.ticketDestinations
			: [];
	} catch {
		return [];
	}
}

function withTicketDestinationParameter(
	parameters: Record<string, unknown>,
	destinations: readonly TicketCreationDestinationSummary[],
): Record<string, unknown> {
	if (destinations.length === 0) return parameters;
	const properties =
		parameters.properties &&
		typeof parameters.properties === "object" &&
		!Array.isArray(parameters.properties)
			? (parameters.properties as Record<string, unknown>)
			: {};
	const required = Array.isArray(parameters.required)
		? parameters.required.filter((value): value is string => typeof value === "string")
		: [];
	return {
		...parameters,
		type: "object",
		properties: {
			...properties,
			destinationId: {
				type: "string",
				description:
					"Ticket destination selected from the available destinations. Ask the operator when their intent is ambiguous.",
				oneOf: destinations.map((destination) => ({
					const: destination.id,
					title: destination.group
						? `${destination.displayName} — ${destination.group}`
						: destination.displayName,
				})),
			},
		},
		required: [...new Set([...required, "destinationId"])],
	};
}

export class IntegrationToolRegistry {
	private readonly tools = new Map<string, RegisteredIntegrationTool>();
	private readonly executions = new Map<string, PendingIntegrationToolExecution>();

	register<TArgs>(definition: IntegrationToolDefinition<TArgs>): void {
		const name = definition.name;
		if (!TOOL_NAME.test(name)) {
			throw new Error(`Integration tool '${definition.name}' must match ${TOOL_NAME}`);
		}
		if (RESERVED_TOOL_NAMES.has(name)) {
			throw new Error(`Integration tool '${name}' uses a reserved tool name`);
		}
		if (definition.description.trim() === "") {
			throw new Error(`Integration tool '${name}' requires a description`);
		}
		if (definition.capability) validateTicketCapability(name, definition.capability);
		if (this.tools.has(name)) throw new Error(`Duplicate integration tool '${name}'`);
		this.tools.set(name, definition as RegisteredIntegrationTool);
	}

	ticketCatalog(): TicketToolCatalogEntry[] {
		return [...this.tools.values()].filter(isTicketCreationTool).map(projectTicketTool);
	}

	findTicketTool(name: string): TicketToolCatalogEntry | null {
		const definition = this.tools.get(name);
		return definition && isTicketCreationTool(definition) ? projectTicketTool(definition) : null;
	}

	resolveTicketTool(name: string): TicketToolCatalogEntry {
		const tool = this.findTicketTool(name);
		if (!tool) throw new Error(`Unknown ticket creation tool '${name}'`);
		return tool;
	}

	private resolveTicketDestinationProvider(name: string) {
		const provider = this.resolveTicketTool(name).capability.destinations;
		if (!provider) throw new Error(`Ticket creation tool '${name}' has no destinations`);
		return provider;
	}

	async listTicketDestinations(name: string, actor: Actor): Promise<TicketCreationDestinationList> {
		const result = parseSchema(
			destinationListSchema,
			await this.resolveTicketDestinationProvider(name).list({ actor }),
			"Ticket destination list is invalid",
		);
		return {
			destinations: result.destinations,
			warnings: (result.warnings ?? []).filter((warning) => warning.trim() !== ""),
		};
	}

	async resolveTicketDestination(
		name: string,
		destinationId: string,
		actor: Actor,
	): Promise<TicketCreationDestinationSnapshot> {
		return validateDestinationSnapshot(
			await this.resolveTicketDestinationProvider(name).resolve({ actor, destinationId }),
		);
	}

	async validateTicketDestination(
		name: string,
		value: unknown,
	): Promise<TicketCreationDestinationSnapshot> {
		const snapshot = validateDestinationSnapshot(value);
		await this.resolveTicketDestinationProvider(name).validate(snapshot);
		return snapshot;
	}

	declarations(
		names: readonly string[],
		context?: { paramsJson: string | null },
	): IntegrationToolDeclaration[] {
		const destinations = ticketDestinationChoices(context?.paramsJson ?? null);
		return names.map((name) => {
			const definition = this.tools.get(name);
			if (!definition) throw new Error(`Unknown integration tool '${name}'`);
			return {
				name: definition.name,
				description: definition.description,
				parameters:
					definition.capability?.kind === "ticket_creation" && definition.capability.destinations
						? withTicketDestinationParameter(definition.parameters, destinations)
						: definition.parameters,
			};
		});
	}

	execute(name: string, args: unknown, ctx: IntegrationToolExecutionInput): Promise<unknown> {
		const definition = this.tools.get(name);
		if (!definition) return Promise.reject(new Error(`Unknown integration tool '${name}'`));
		const existing = this.executions.get(ctx.idempotencyKey);
		if (existing) return existing.promise;
		const controller = new AbortController();
		const promise = Promise.resolve()
			.then(() => {
				if (controller.signal.aborted) {
					throw new Error("Integration tool execution cancelled");
				}
				return definition.execute(
					{ ...ctx, signal: controller.signal },
					definition.parse?.(args) ?? parseToolArgs(args),
				);
			})
			.finally(() => this.executions.delete(ctx.idempotencyKey));
		this.executions.set(ctx.idempotencyKey, { controller, promise });
		return promise;
	}

	cancel(idempotencyKey: string): boolean {
		const execution = this.executions.get(idempotencyKey);
		if (!execution) return false;
		execution.controller.abort();
		return true;
	}
}

function integrationToolIdempotencyKey(input: {
	instanceId: string;
	turnRecordId: string;
	toolCallId: string;
	toolName: string;
}): string {
	return `${input.instanceId}:${input.turnRecordId}:${input.toolCallId}:${input.toolName}`;
}

export function createIntegrationToolRequestService(input: {
	registry: IntegrationToolRegistry;
	repos: Pick<RepositoryBundle, "processes" | "projects" | "turnRecords" | "turnStarts">;
	processActionRegistry: Pick<ProcessActionRegistry, "getTurnDefinition" | "resolveContextData">;
	toolApprovalGate?: ToolApprovalGate;
}) {
	return {
		cancel(instanceId: string, payload: WorkerIntegrationToolCancelPayload): boolean {
			input.toolApprovalGate?.cancelTurn(instanceId, payload.turnRecordId);
			return input.registry.cancel(
				integrationToolIdempotencyKey({
					instanceId,
					turnRecordId: payload.turnRecordId,
					toolCallId: payload.toolCallId,
					toolName: payload.toolName,
				}),
			);
		},
		async handle(
			instanceId: string,
			payload: WorkerIntegrationToolRequestPayload,
		): Promise<WorkerIntegrationToolResultPayload> {
			const fail = (error: string): WorkerIntegrationToolResultPayload => ({
				turnRecordId: payload.turnRecordId,
				toolCallId: payload.toolCallId,
				ok: false,
				error,
			});
			const process = input.repos.processes.getById(instanceId);
			const turn = input.repos.turnRecords.getById(payload.turnRecordId);
			if (!process || !turn || turn.instanceId !== instanceId || turn.status !== "running") {
				return fail("Integration tool call does not belong to the active running turn");
			}
			const currentStart =
				process.currentExecution?.kind === "worker_start"
					? input.repos.turnStarts.getById(process.currentExecution.id)
					: null;
			const expectedTurnRecordId =
				currentStart?.state.kind === "accepted" ? currentStart.state.turnRecordId : null;
			if (expectedTurnRecordId !== payload.turnRecordId) {
				return fail("Integration tool call targets a stale turn record");
			}
			if (process.selectedTurnId !== turn.turnId) {
				return fail("Integration tool call targets a stale turn");
			}
			const authorizedTools = resolveTurnIntegrationToolNames(
				input.processActionRegistry,
				process,
				turn.turnId,
			);
			if (!authorizedTools.includes(payload.toolName)) {
				return fail(`Integration tool '${payload.toolName}' is not authorized for this turn`);
			}
			const projects = input.repos.projects.listByInstance(instanceId);
			const projectKey =
				typeof payload.args.projectKey === "string" ? payload.args.projectKey : null;
			const project = projectKey
				? (projects.find((candidate) => candidate.key === projectKey) ?? null)
				: null;
			if (projectKey && !project) return fail(`Unknown process project '${projectKey}'`);
			try {
				let ticketDestination: TicketCreationDestinationSnapshot | undefined;
				let executionArgs = payload.args;
				const ticketTool = input.registry.findTicketTool(payload.toolName);
				if (ticketTool) {
					if (!input.toolApprovalGate) return fail("Ticket approval gate is unavailable");
					const capability = ticketTool.capability;
					if (capability.destinations) {
						const params = process.paramsJson ? JSON.parse(process.paramsJson) : {};
						if (params.ticketDestination) {
							ticketDestination = await input.registry.validateTicketDestination(
								payload.toolName,
								params.ticketDestination,
							);
						} else {
							const destinationId = parseToolArgs(payload.args).destinationId;
							if (typeof destinationId !== "string" || destinationId.trim() === "") {
								return fail("A ticket destination is required");
							}
							ticketDestination = await input.registry.resolveTicketDestination(
								payload.toolName,
								destinationId,
								persistedTicketActor(params.initiatingActor),
							);
							const { destinationId: _destinationId, ...adapterArgs } = payload.args;
							executionArgs = adapterArgs;
						}
					}
					const proposedTitle = capability.titlePath
						? resolveJsonPointer(executionArgs, capability.titlePath)
						: undefined;
					if (typeof proposedTitle === "string" && proposedTitle.trim()) {
						input.repos.processes.update(instanceId, { title: proposedTitle.trim().slice(0, 240) });
					}
					const decision = await input.toolApprovalGate.review({
						instanceId,
						turnRecordId: payload.turnRecordId,
						toolCallId: payload.toolCallId,
						toolName: payload.toolName,
						arguments: executionArgs,
						...(ticketDestination ? { destination: ticketDestination.summary } : {}),
					});
					if (decision.kind === "feedback") {
						return {
							turnRecordId: payload.turnRecordId,
							toolCallId: payload.toolCallId,
							ok: true,
							result: { ok: false, code: "operator_feedback", feedback: decision.feedback },
						};
					}
					if (decision.kind === "declined")
						return fail("Ticket creation was declined by the operator");
				}
				const result = await input.registry.execute(payload.toolName, executionArgs, {
					process,
					projects,
					turn,
					project,
					...(ticketDestination ? { ticketDestination } : {}),
					idempotencyKey: integrationToolIdempotencyKey({
						instanceId,
						turnRecordId: payload.turnRecordId,
						toolCallId: payload.toolCallId,
						toolName: payload.toolName,
					}),
				});
				const responseResult = ticketTool ? validateTicketCreationReceipt(result) : result;
				if (ticketTool) {
					const receipt = responseResult as TicketCreationReceipt;
					input.repos.processes.update(instanceId, {
						externalId: receipt.externalId,
						externalUrl: receipt.url,
					});
				}
				return {
					turnRecordId: payload.turnRecordId,
					toolCallId: payload.toolCallId,
					ok: true,
					result: responseResult,
				};
			} catch (error) {
				return fail(error instanceof Error ? error.message : "Integration tool execution failed");
			}
		},
	};
}
