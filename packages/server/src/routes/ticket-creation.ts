import type { ProcessRelation } from "@leitwerk-dev/domain";
import type {
	LaunchTicketCreationRequestBody,
	LaunchTicketCreationResponseBody,
	ResolveToolApprovalRequestBody,
	TicketCreationToolSummary,
} from "@leitwerk-dev/protocol";
import type { FastifyInstance } from "fastify";
import type { IntegrationToolRegistry } from "../integration-tool-registry.js";
import { hasProcessGraph } from "../process-graph.js";
import { type RouteDeps, resolveActor } from "./process-route-helpers.js";

function parseParentPrompt(paramsJson: string | null): string {
	if (!paramsJson) return "";
	try {
		const params = JSON.parse(paramsJson) as Record<string, unknown>;
		for (const key of ["prompt", "request", "instructions"]) {
			if (typeof params[key] === "string") return params[key];
		}
	} catch {
		/* persisted validation is handled at process boundaries */
	}
	return "";
}

function normalizeSelection(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function assembleContext(
	deps: RouteDeps,
	parentInstanceId: string,
	body: LaunchTicketCreationRequestBody,
) {
	const parent = deps.processes.getById(parentInstanceId);
	if (!parent) throw Object.assign(new Error("Parent process not found"), { statusCode: 404 });
	const results = deps.turnRecords
		.listByInstance(parentInstanceId)
		.filter((turn) => turn.status === "succeeded" && typeof turn.turnResultMarkdown === "string")
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
		.map((turn) => ({ id: turn.id, markdown: turn.turnResultMarkdown as string }));
	let durableText: string | null = null;
	if (body.artifact.kind === "turn_result" && body.artifact.turnRecordId) {
		durableText =
			results.find((result) => result.id === body.artifact.turnRecordId)?.markdown ?? null;
	} else if (body.artifact.kind === "leaf_outcome" && body.artifact.leafEntryId) {
		const snapshot = deps.leafOutcomeSnapshots.getByInstanceAndLeafEntryId(
			parentInstanceId,
			body.artifact.leafEntryId,
		);
		if (snapshot?.status === "ready") {
			durableText =
				snapshot.fallbackMarkdown ??
				(snapshot.props ? `\`\`\`json\n${JSON.stringify(snapshot.props, null, 2)}\n\`\`\`` : null);
		}
	}
	if (!durableText)
		throw Object.assign(new Error("Referenced result is not a durable artifact"), {
			statusCode: 400,
		});
	const excerpt = body.focus.kind === "excerpt" ? normalizeSelection(body.focus.excerpt ?? "") : "";
	if (
		body.focus.kind === "excerpt" &&
		(!excerpt || !normalizeSelection(durableText).includes(excerpt))
	) {
		throw Object.assign(new Error("Selected excerpt does not belong to the durable result"), {
			statusCode: 400,
		});
	}
	return {
		parent,
		context: {
			focusedResult: body.focus.kind === "excerpt" ? excerpt : durableText,
			parentPrompt: parseParentPrompt(parent.paramsJson),
			durableResults: results.map((result) => result.markdown),
			additionalInstructions: body.additionalInstructions?.trim() ?? "",
			capturedAt: new Date().toISOString(),
		},
	};
}

export function registerTicketCreationRoutes(
	app: FastifyInstance,
	deps: RouteDeps,
	registry: Pick<
		IntegrationToolRegistry,
		"ticketCatalog" | "resolveTicketTool" | "listTicketDestinations"
	>,
): void {
	app.get(
		"/api/ticket-creation/tools",
		async (): Promise<{ tools: TicketCreationToolSummary[] }> => ({
			tools: registry.ticketCatalog().map((tool) => ({
				name: tool.name,
				displayName: tool.capability.displayName,
			})),
		}),
	);

	app.post<{ Params: { instanceId: string }; Body: LaunchTicketCreationRequestBody }>(
		"/api/processes/:instanceId/ticket-creation",
		async (req, reply) => {
			try {
				const tool = registry.resolveTicketTool(req.body.toolName);
				const { processId, startTurnId } = tool.capability;
				if (!hasProcessGraph(deps.processGraphs, processId)) {
					throw Object.assign(new Error("Ticket creation process is not available"), {
						statusCode: 503,
					});
				}
				const actor = resolveActor(req);
				const destinationList = tool.capability.destinations
					? await registry.listTicketDestinations(req.body.toolName, actor)
					: undefined;
				const { parent, context } = assembleContext(deps, req.params.instanceId, req.body);
				const committed = deps.transaction((repos) => {
					const child = repos.processes.create({
						processId,
						title: `Ticket from ${parent.title ?? parent.id}`,
						defaultModelProfileId: req.body.modelProfileId ?? null,
						metadata: { _leitwerk: { requiresExternalReceipt: true } },
						paramsJson: JSON.stringify({
							parentInstanceId: parent.id,
							artifact: req.body.artifact,
							focus: req.body.focus,
							context,
							additionalInstructions: req.body.additionalInstructions?.trim() ?? "",
							toolName: req.body.toolName,
							initiatingActor: actor,
							...(destinationList
								? {
										ticketDestinations: destinationList.destinations,
										ticketDestinationWarnings: destinationList.warnings,
									}
								: {}),
							...(req.body.modelProfileId ? { launchModelProfileId: req.body.modelProfileId } : {}),
						}),
						stateJson: JSON.stringify({ semanticEntryRefs: {} }),
					});
					const relation = repos.processRelations.create({
						parentInstanceId: parent.id,
						childInstanceId: child.id,
						purpose: "ticket_creation",
						createdBy: actor,
					});
					return { child, relation };
				});
				const started = await deps.processEngine.startProcess(committed.child.id, startTurnId, {
					actor,
				});
				if (!started.ok) {
					if (started.stage === "pre_commit") {
						deps.transaction((repos) => {
							const child = repos.processes.getById(committed.child.id);
							if (
								child &&
								child.lifecycleStatus === "discovered" &&
								child.selectedTurnId === null &&
								child.currentExecution === null
							) {
								repos.processes.delete(committed.child.id);
							}
						});
					}
					return reply
						.code(500)
						.send({ error: started.message, childInstanceId: committed.child.id });
				}
				return {
					childInstanceId: committed.child.id,
					relation: committed.relation,
				} satisfies LaunchTicketCreationResponseBody;
			} catch (error) {
				const status = (error as { statusCode?: number }).statusCode ?? 400;
				return reply
					.code(status)
					.send({ error: error instanceof Error ? error.message : String(error) });
			}
		},
	);

	app.get<{ Params: { instanceId: string } }>(
		"/api/processes/:instanceId/tool-approval-requests",
		async (req) => ({ requests: deps.toolApprovalGate.listOpen(req.params.instanceId) }),
	);
	app.post<{
		Params: { instanceId: string; requestId: string };
		Body: ResolveToolApprovalRequestBody;
	}>("/api/processes/:instanceId/tool-approval-requests/:requestId", async (req, reply) => {
		const action = req.body?.action;
		if (action !== "accept" && action !== "feedback" && action !== "decline") {
			return reply.code(400).send({ error: "Unknown approval action" });
		}
		const feedback = req.body.feedback?.trim() ?? "";
		if (action === "feedback" && !feedback) {
			return reply.code(400).send({ error: "Feedback is required" });
		}
		const decision =
			action === "accept"
				? { kind: "accepted" as const }
				: action === "decline"
					? { kind: "declined" as const }
					: { kind: "feedback" as const, feedback };
		const request = await deps.toolApprovalGate.resolve(
			req.params.instanceId,
			req.params.requestId,
			decision,
			resolveActor(req),
		);
		if (!request) return reply.code(409).send({ error: "Approval request is no longer open" });
		if (action === "decline") {
			await deps.processEngine.abortProcess(req.params.instanceId, { actor: resolveActor(req) });
		}
		return { request };
	});

	app.get<{ Params: { instanceId: string } }>(
		"/api/processes/:instanceId/relations",
		async (req) =>
			({
				parent: deps.processRelations.getByChild(req.params.instanceId),
				children: deps.processRelations.listByParent(req.params.instanceId),
			}) satisfies { parent: ProcessRelation | null; children: ProcessRelation[] },
	);
}
