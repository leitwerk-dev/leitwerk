import {
	createWriteIdentity,
	type ExternalWriteLogRepoLike,
	ensureWrite,
} from "@leitwerk-dev/external-writes";
import type {
	IntegrationToolExecutionContext,
	ServerExtensionAPI,
} from "@leitwerk-dev/process-sdk";
import { resolveWoodpeckerProjectBinding } from "./binding.js";
import type { WoodpeckerIntegration } from "./capability.js";

function stringArg(args: Record<string, unknown>, name: string) {
	const value = args[name];
	if (typeof value !== "string" || !value.trim())
		throw new Error(`'${name}' must be a non-empty string`);
	return value.trim();
}
function numberArg(args: Record<string, unknown>, name: string) {
	const value = args[name];
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
		throw new Error(`'${name}' must be a positive integer`);
	return value;
}

function target(ctx: IntegrationToolExecutionContext, _args: Record<string, unknown>) {
	const binding = resolveWoodpeckerProjectBinding(ctx);
	return { fullName: `${binding.owner}/${binding.repo}`, profile: binding.profile };
}

export function registerWoodpeckerTools(
	api: ServerExtensionAPI,
	integration: WoodpeckerIntegration,
	writes: ExternalWriteLogRepoLike,
) {
	const schema = {
		type: "object",
		properties: { projectKey: { type: "string" } },
		required: ["projectKey"],
	};
	const register = (definition: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		execute(ctx: IntegrationToolExecutionContext, args: Record<string, unknown>): Promise<unknown>;
	}) => api.tool(definition);
	register({
		name: "woodpecker_lookup_repository",
		description: "Resolve the current process repository in Woodpecker",
		parameters: schema,
		async execute(ctx, args) {
			const t = target(ctx, args);
			return integration.client(t.profile).lookupRepository(t.fullName, ctx.signal);
		},
	});
	register({
		name: "woodpecker_list_pipelines",
		description: "List recent Woodpecker pipelines for the current process repository",
		parameters: schema,
		async execute(ctx, args) {
			const t = target(ctx, args);
			const client = integration.client(t.profile);
			const repo = await client.lookupRepository(t.fullName, ctx.signal);
			return client.listPipelines(repo.id, ctx.signal);
		},
	});
	for (const name of ["woodpecker_get_pipeline", "woodpecker_restart_pipeline"] as const) {
		register({
			name,
			description: name.endsWith("restart_pipeline")
				? "Restart a diagnosed Woodpecker pipeline"
				: "Read a Woodpecker pipeline",
			parameters: {
				...schema,
				properties: {
					...schema.properties,
					pipelineNumber: { type: "integer" },
					...(name === "woodpecker_restart_pipeline"
						? {
								diagnosis: {
									type: "string",
									description:
										"Why this is an infrastructure or flaky failure rather than a repository defect",
								},
								logEvidence: {
									type: "string",
									description: "Concrete bounded-log evidence supporting a restart",
								},
							}
						: {}),
				},
				required:
					name === "woodpecker_restart_pipeline"
						? ["projectKey", "pipelineNumber", "diagnosis", "logEvidence"]
						: ["projectKey", "pipelineNumber"],
			},
			async execute(ctx, args) {
				const t = target(ctx, args);
				const client = integration.client(t.profile);
				const repo = await client.lookupRepository(t.fullName, ctx.signal);
				const number = numberArg(args, "pipelineNumber");
				if (name === "woodpecker_get_pipeline")
					return client.getPipeline(repo.id, number, ctx.signal);
				const diagnosis = stringArg(args, "diagnosis");
				const logEvidence = stringArg(args, "logEvidence");
				await ensureWrite(
					writes,
					ctx.process.id,
					createWriteIdentity("woodpecker.restart", ctx.idempotencyKey),
					async () => {
						await client.restartPipeline(repo.id, number, ctx.signal);
						return { repoId: repo.id, number, diagnosis, logEvidence };
					},
				);
				return { ok: true };
			},
		});
	}
	register({
		name: "woodpecker_get_step_logs",
		description: "Read bounded logs for a Woodpecker pipeline step",
		parameters: {
			...schema,
			properties: {
				...schema.properties,
				pipelineNumber: { type: "integer" },
				stepId: { type: "integer" },
				tailLines: { type: "integer" },
				maxBytes: { type: "integer" },
			},
			required: ["projectKey", "pipelineNumber", "stepId"],
		},
		async execute(ctx, args) {
			const t = target(ctx, args);
			const client = integration.client(t.profile);
			const repo = await client.lookupRepository(t.fullName, ctx.signal);
			return client.getStepLogs(
				repo.id,
				numberArg(args, "pipelineNumber"),
				numberArg(args, "stepId"),
				typeof args.tailLines === "number" ? args.tailLines : 400,
				typeof args.maxBytes === "number" ? args.maxBytes : 262_144,
				ctx.signal,
			);
		},
	});
}
