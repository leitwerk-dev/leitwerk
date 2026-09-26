import type { FastifyInstance } from "fastify";
import { actorForRequest } from "../auth/fastify-auth.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ProcessOperationCoordinator } from "../process-operation-coordinator.js";
import type { ScopedSettingsService } from "../scoped-settings-service.js";
import { SettingsError } from "../scoped-settings-service.js";

type Change = {
	subjectId: string;
	key: string;
	value?: unknown;
	mode?: "append" | "replace";
	reset?: boolean;
	expectedRevision: number;
};

function parseChange(value: unknown): Change {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new SettingsError("Expected a settings change", 400);
	const raw = value as Record<string, unknown>;
	if (
		typeof raw.subjectId !== "string" ||
		typeof raw.key !== "string" ||
		!Number.isSafeInteger(raw.expectedRevision) ||
		Number(raw.expectedRevision) < 0 ||
		(raw.mode !== undefined && raw.mode !== "append" && raw.mode !== "replace") ||
		(raw.reset !== undefined && typeof raw.reset !== "boolean") ||
		(!raw.reset && !Object.hasOwn(raw, "value"))
	)
		throw new SettingsError(
			"Provide subjectId, key, value, and expectedRevision; mode must be append or replace",
			400,
		);
	return raw as Change;
}

/** @internal */
export function registerSettingsRoutes(
	app: FastifyInstance,
	settings: ScopedSettingsService,
	repos: Pick<RepositoryBundle, "processes" | "turnStarts" | "projects" | "events"> & {
		processOperations: ProcessOperationCoordinator;
		broadcaster: import("../ws/broadcast.js").Broadcaster;
		onSettingsChanged?: () => Promise<void>;
	},
) {
	app.get("/api/settings/definitions", async () => ({ definitions: settings.definitions() }));
	app.get("/api/settings/scopes", async () => settings.listScopes());
	app.post("/api/settings/scopes/refresh", async () => {
		const scopes = await settings.refresh();
		await repos.onSettingsChanged?.();
		repos.broadcaster.sendDurable("settings.updated", { subjectId: "instance" });
		return scopes;
	});
	app.get<{ Querystring: { subjectId?: string } }>("/api/settings/preview", async (request) =>
		settings.preview(request.query.subjectId ?? "instance"),
	);
	app.post("/api/settings/preview", async (request) => {
		const change = parseChange(request.body);
		return settings.previewDraft({
			...change,
			value: change.value,
			reset: change.reset ?? false,
			mode:
				change.mode ??
				(settings.definitions().find((field) => field.key === change.key)?.merge === "instructions"
					? "append"
					: "replace"),
			actor: actorForRequest(request),
		});
	});
	app.put("/api/settings/overrides", async (request) => {
		const change = parseChange(request.body);
		settings.write({
			...change,
			value: change.value,
			reset: change.reset ?? false,
			mode:
				change.mode ??
				(settings.definitions().find((field) => field.key === change.key)?.merge === "instructions"
					? "append"
					: "replace"),
			actor: actorForRequest(request),
		});
		await repos.onSettingsChanged?.();
		repos.broadcaster.sendDurable("settings.updated", { subjectId: change.subjectId });
		return settings.preview(change.subjectId);
	});
	app.put<{
		Params: { instanceId: string };
		Body: { primaryRepositoryKey: string | null; expectedPrimaryRepositoryKey: string | null };
	}>("/api/settings/processes/:instanceId/primary-repository", async (request) => {
		const result = await repos.processOperations.runExclusive(request.params.instanceId, () => {
			const process = repos.processes.getById(request.params.instanceId);
			if (!process) throw new SettingsError("Process not found", 404);
			const body = request.body;
			if (
				!body ||
				(body.primaryRepositoryKey !== null && typeof body.primaryRepositoryKey !== "string") ||
				(body.expectedPrimaryRepositoryKey !== null &&
					typeof body.expectedPrimaryRepositoryKey !== "string")
			)
				throw new SettingsError(
					"Provide primaryRepositoryKey and expectedPrimaryRepositoryKey",
					400,
				);
			if ((process.metadata?.primaryRepositoryKey ?? null) !== body.expectedPrimaryRepositoryKey)
				throw new SettingsError("Primary repository changed. Reload before saving again.", 409);
			if (
				body.primaryRepositoryKey !== null &&
				!repos.projects
					.listByInstance(process.id)
					.some((project) => project.key === body.primaryRepositoryKey)
			)
				throw new SettingsError("Primary repository must belong to this process");
			repos.processes.update(process.id, {
				metadata: { ...process.metadata, primaryRepositoryKey: body.primaryRepositoryKey },
			});
			repos.events.create({
				instanceId: process.id,
				eventType: "settings.primary_repository_changed",
				data: { primaryRepositoryKey: body.primaryRepositoryKey, actor: actorForRequest(request) },
			});
			return { primaryRepositoryKey: body.primaryRepositoryKey };
		});
		// Future execution coordination must run after releasing the process lock.
		await repos.onSettingsChanged?.();
		repos.broadcaster.sendDurable("settings.updated", { subjectId: "instance" });
		return result;
	});

	app.get<{ Params: { instanceId: string } }>(
		"/api/settings/processes/:instanceId",
		async (request) => {
			const process = repos.processes.getById(request.params.instanceId);
			if (!process) throw new SettingsError("Process not found", 404);
			const context = settings.forProcess(process);
			let next = null;
			let error: string | null = null;
			try {
				next = process.selectedTurnId
					? (settings.capture(process, process.selectedTurnId) ?? null)
					: null;
			} catch (caught) {
				error = caught instanceof Error ? caught.message : "Invalid scoped settings";
			}
			return {
				primaryRepositoryKey: process.metadata?.primaryRepositoryKey ?? null,
				future: settings.previewProcess(process),
				context: context.context,
				explanations: context.explanations,
				repositories: context.subjects.map(({ project, subject }) => ({
					key: project.key,
					subjectId: subject.id,
					label: subject.label,
				})),
				next,
				error,
				captured: repos.turnStarts.listByInstance(process.id).flatMap((record) =>
					record.state.kind !== "preparation_failed" &&
					record.state.start?.kind === "llm" &&
					record.state.start.scopedSettings
						? [
								{
									startRecordId: record.id,
									turnId: record.turnId,
									createdAt: record.createdAt,
									state: record.state.kind,
									settings: record.state.start.scopedSettings,
								},
							]
						: [],
				),
			};
		},
	);
}
