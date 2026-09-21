import {
	type IntegrationToolExecutionContext,
	numberArg,
	projectParameters,
	type ServerExtensionAPI,
	stringArg,
} from "@leitwerk-dev/process-sdk";
import { resolveWoodpeckerProjectBinding } from "./binding.js";
import type { WoodpeckerIntegration } from "./capability.js";

function target(ctx: IntegrationToolExecutionContext) {
	const binding = resolveWoodpeckerProjectBinding(ctx);
	return { fullName: `${binding.owner}/${binding.repo}`, profile: binding.profile };
}

export function registerWoodpeckerTools(
	api: ServerExtensionAPI,
	integration: WoodpeckerIntegration,
) {
	const schema = projectParameters();
	api.tool<Record<string, unknown>>({
		name: "woodpecker_lookup_repository",
		description: "Resolve the current process repository in Woodpecker",
		parameters: schema,
		async execute(ctx) {
			const t = target(ctx);
			return integration.client(t.profile).lookupRepository(t.fullName, ctx.signal);
		},
	});
	api.tool<Record<string, unknown>>({
		name: "woodpecker_list_pipelines",
		description: "List recent Woodpecker pipelines for the current process repository",
		parameters: schema,
		async execute(ctx) {
			const t = target(ctx);
			const client = integration.client(t.profile);
			const repo = await client.lookupRepository(t.fullName, ctx.signal);
			return client.listPipelines(repo.id, ctx.signal);
		},
	});
	for (const name of ["woodpecker_get_pipeline", "woodpecker_restart_pipeline"] as const) {
		api.tool<Record<string, unknown>>({
			name,
			description: name.endsWith("restart_pipeline")
				? "Restart a diagnosed Woodpecker pipeline"
				: "Read a Woodpecker pipeline",
			parameters: projectParameters({
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
			}),
			async execute(ctx, args) {
				const t = target(ctx);
				const client = integration.client(t.profile);
				const repo = await client.lookupRepository(t.fullName, ctx.signal);
				const number = numberArg(args, "pipelineNumber");
				if (name === "woodpecker_get_pipeline")
					return client.getPipeline(repo.id, number, ctx.signal);
				const diagnosis = stringArg(args, "diagnosis");
				const logEvidence = stringArg(args, "logEvidence");
				await ctx.externalWrites.logOnly(
					{ writeType: "woodpecker.restart", dedupKey: ctx.idempotencyKey },
					async () => {
						await client.restartPipeline(repo.id, number, ctx.signal);
						return { repoId: repo.id, number, diagnosis, logEvidence };
					},
				);
				return { ok: true };
			},
		});
	}
	api.tool<Record<string, unknown>>({
		name: "woodpecker_get_step_logs",
		description: "Read bounded logs for a Woodpecker pipeline step",
		parameters: projectParameters(
			{
				pipelineNumber: { type: "integer" },
				stepId: { type: "integer" },
				tailLines: { type: "integer" },
				maxBytes: { type: "integer" },
			},
			["pipelineNumber", "stepId"],
		),
		async execute(ctx, args) {
			const t = target(ctx);
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
