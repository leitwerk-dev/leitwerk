import type {
	IntegrationToolDefinition,
	IntegrationToolExecutionContext,
} from "@leitwerk-dev/process-sdk";
import type {
	IntegrationToolDeclaration,
	WorkerIntegrationToolRequestPayload,
	WorkerIntegrationToolResultPayload,
} from "@leitwerk-dev/worker-protocol";
import type { RepositoryBundle } from "./db/repositories.js";
import type { ProcessActionRegistry } from "./process-action-registry.js";

type RegisteredIntegrationTool = IntegrationToolDefinition<unknown>;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function parseToolArgs(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Integration tool arguments must be an object");
	}
	return value as Record<string, unknown>;
}

export class IntegrationToolRegistry {
	private readonly tools = new Map<string, RegisteredIntegrationTool>();
	private readonly executions = new Map<string, Promise<unknown>>();

	register<TArgs>(definition: IntegrationToolDefinition<TArgs>): void {
		const name = definition.name;
		if (!TOOL_NAME.test(name)) {
			throw new Error(`Integration tool '${definition.name}' must match ${TOOL_NAME}`);
		}
		if (definition.description.trim() === "") {
			throw new Error(`Integration tool '${name}' requires a description`);
		}
		if (this.tools.has(name)) throw new Error(`Duplicate integration tool '${name}'`);
		this.tools.set(name, definition as RegisteredIntegrationTool);
	}

	declarations(names: readonly string[]): IntegrationToolDeclaration[] {
		return names.map((name) => {
			const definition = this.tools.get(name);
			if (!definition) throw new Error(`Unknown integration tool '${name}'`);
			return {
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
			};
		});
	}

	execute(name: string, args: unknown, ctx: IntegrationToolExecutionContext): Promise<unknown> {
		const definition = this.tools.get(name);
		if (!definition) return Promise.reject(new Error(`Unknown integration tool '${name}'`));
		const existing = this.executions.get(ctx.idempotencyKey);
		if (existing) return existing;
		const execution = Promise.resolve()
			.then(() => definition.execute(ctx, definition.parse?.(args) ?? parseToolArgs(args)))
			.finally(() => this.executions.delete(ctx.idempotencyKey));
		this.executions.set(ctx.idempotencyKey, execution);
		return execution;
	}
}

export function createIntegrationToolRequestService(input: {
	registry: IntegrationToolRegistry;
	repos: Pick<RepositoryBundle, "processes" | "projects" | "turnRecords" | "turnStarts">;
	processActionRegistry: Pick<ProcessActionRegistry, "getTurnDefinition">;
}) {
	return {
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
			const turnDefinition = input.processActionRegistry.getTurnDefinition(
				process.processId,
				turn.turnId,
			);
			if (
				turnDefinition?.kind !== "llm" ||
				!turnDefinition.integrationTools?.includes(payload.toolName)
			) {
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
				const result = await input.registry.execute(payload.toolName, payload.args, {
					process,
					projects,
					turn,
					project,
					idempotencyKey: `${instanceId}:${payload.turnRecordId}:${payload.toolCallId}:${payload.toolName}`,
				});
				return {
					turnRecordId: payload.turnRecordId,
					toolCallId: payload.toolCallId,
					ok: true,
					result,
				};
			} catch (error) {
				return fail(error instanceof Error ? error.message : "Integration tool execution failed");
			}
		},
	};
}
