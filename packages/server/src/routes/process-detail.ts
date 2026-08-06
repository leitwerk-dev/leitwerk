import type {
	ProcessesListResponseBody,
	ProcessListItem,
} from "@leitwerk-dev/protocol/http-contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { buildFutureExecutionSummaries } from "../future-execution-presenter.js";
import { getProcessDisplayName } from "../process-operator-attention.js";
import {
	buildProcessBrowse,
	buildProcessesOverview,
	type ProcessBrowseQuery,
} from "../process-overview-presenter.js";
import { ProcessUiSnapshotAssembler } from "../process-ui-snapshot-presenter.js";
import { ProcessDiagnosticsAssembler } from "./process-diagnostics-assembler.js";
import { sendEngineFailure } from "./process-engine-http.js";
import { ProcessPrimaryPathAssembler } from "./process-primary-path-assembler.js";
import { type RouteDeps, resolveActor } from "./process-route-helpers.js";

export function registerProcessDetailRoutes(app: FastifyInstance, deps: RouteDeps) {
	const diagnosticsAssembler = new ProcessDiagnosticsAssembler(deps);
	const primaryPathAssembler = new ProcessPrimaryPathAssembler(deps);
	const uiSnapshotAssembler = new ProcessUiSnapshotAssembler(deps);

	app.get("/api/processes", async () => {
		const instances = deps.processes.listAll();
		const processes: ProcessListItem[] = instances.map((process) => ({
			process,
			projects: deps.projects.listByInstance(process.id),
			workerLease: deps.leases.getByInstance(process.id),
			processDisplayName: getProcessDisplayName(deps, process.processId),
		}));
		const futureExecutions = buildFutureExecutionSummaries(deps, deps.futureExecutions.listAll());
		const body = { processes, futureExecutions } satisfies ProcessesListResponseBody;
		return body;
	});

	app.delete<{ Params: { instanceId: string } }>(
		"/api/processes/:instanceId",
		async (req, reply) => {
			const result = await deps.processDeletion.deleteProcess(
				req.params.instanceId,
				resolveActor(req),
			);
			if (result.ok) return reply.code(204).send();
			if (result.kind === "not_found") {
				return reply.code(404).send({ error: "Process not found" });
			}
			if (result.kind === "abort_failed") {
				return sendEngineFailure(reply, result.failure, "abort");
			}
			return reply.code(500).send({ error: result.message });
		},
	);

	app.get("/api/processes/overview", async (_req, reply) => {
		const startedAt = performance.now();
		const body = buildProcessesOverview(deps);
		reply.header("Server-Timing", `overview;dur=${(performance.now() - startedAt).toFixed(1)}`);
		return body;
	});

	app.get<{
		Querystring: {
			limit?: string;
			offset?: string;
			query?: string;
			processType?: string;
			status?: ProcessBrowseQuery["status"];
			sortKey?: ProcessBrowseQuery["sortKey"];
			sortDirection?: ProcessBrowseQuery["sortDirection"];
		};
	}>("/api/processes/browse", async (req, reply) => {
		const startedAt = performance.now();
		const numeric = (value: string | undefined): number | undefined => {
			if (value === undefined || value.trim() === "") return undefined;
			const parsed = Number(value);
			return Number.isSafeInteger(parsed) ? parsed : undefined;
		};
		const body = buildProcessBrowse(deps, {
			limit: numeric(req.query.limit),
			offset: numeric(req.query.offset),
			query: req.query.query,
			processType: req.query.processType,
			status: req.query.status,
			sortKey: req.query.sortKey,
			sortDirection: req.query.sortDirection,
		});
		reply.header("Server-Timing", `browse;dur=${(performance.now() - startedAt).toFixed(1)}`);
		return body;
	});

	const sendDiagnostics = async (instanceId: string, reply: FastifyReply) => {
		const diagnostics = await diagnosticsAssembler.assembleDetail(instanceId);
		return diagnostics ?? reply.code(404).send({ error: "Process not found" });
	};
	for (const url of ["/api/processes/:instanceId", "/api/processes/:instanceId/diagnostics"]) {
		app.get<{ Params: { instanceId: string } }>(url, (req, reply) =>
			sendDiagnostics(req.params.instanceId, reply),
		);
	}

	app.get<{ Params: { instanceId: string } }>(
		"/api/processes/:instanceId/ui-snapshot",
		async (req, reply) => {
			const startedAt = performance.now();
			const snapshot = await uiSnapshotAssembler.assemble(req.params.instanceId);
			reply.header(
				"Server-Timing",
				`ui-snapshot;dur=${(performance.now() - startedAt).toFixed(1)}`,
			);
			if (!snapshot) {
				return reply.code(404).send({ error: "Process not found" });
			}
			return snapshot;
		},
	);

	app.get<{
		Params: { instanceId: string; turnRecordId: string };
		Querystring: { sessionSignature?: string };
	}>("/api/processes/:instanceId/turn-records/:turnRecordId/reasoning", async (req, reply) => {
		const startedAt = performance.now();
		const detail = await uiSnapshotAssembler.assembleReasoningDetail(req.params);
		reply.header("Server-Timing", `reasoning;dur=${(performance.now() - startedAt).toFixed(1)}`);
		if (!detail) {
			return reply.code(404).send({ error: "Reasoning details not found" });
		}
		if (
			req.query.sessionSignature !== undefined &&
			req.query.sessionSignature !== (detail.sessionSignature ?? "")
		) {
			return reply.code(409).send({ error: "Process session changed" });
		}
		return detail;
	});

	app.get<{ Params: { instanceId: string } }>(
		"/api/processes/:instanceId/primary-path",
		async (req, reply) => {
			const snapshot = await primaryPathAssembler.assemble(req.params.instanceId);
			if (!snapshot) {
				return reply.code(404).send({ error: "Process not found" });
			}
			return snapshot;
		},
	);

	app.get<{ Params: { instanceId: string } }>(
		"/api/processes/:instanceId/retry-config",
		async (req, reply) => {
			const retryConfig = await diagnosticsAssembler.assembleRetryConfig(req.params.instanceId);
			if (!retryConfig) {
				const process = deps.processes.getById(req.params.instanceId);
				return reply.code(404).send({
					error: process ? "No launcher found for this process type" : "Process not found",
				});
			}
			return retryConfig;
		},
	);
}
