import type { DashboardResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import type { FastifyInstance } from "fastify";
import { buildDashboardModelIssues } from "../dashboard-model-issues.js";
import type { ProcessWatcherServiceLike } from "../process-watcher-registry.js";
import type { RouteDeps } from "./processes.js";

/** @internal */
export type DashboardRouteDeps = Pick<
	RouteDeps,
	| "processes"
	| "turnSummaries"
	| "processGraphs"
	| "skillCatalog"
	| "config"
	| "processModelPolicy"
	| "modelStatusCache"
	| "futureExecutions"
	| "scopedSettingsService"
> & { /** @internal */ processWatchers?: ProcessWatcherServiceLike };

/** Aggregate each accepted LLM turn once, including active, failed and retry branches. @internal */
export function aggregateDashboardCosts(
	rows: readonly {
		/** @internal */ providerId: string | null;
		/** @internal */ modelId: string | null;
		/** @internal */ costUsd: number | null;
	}[],
): DashboardResponseBody["costs"] {
	const groups = new Map<string, DashboardResponseBody["costs"]["byModel"][number]>();
	let totalUsd = 0;
	let pricedTurnCount = 0;
	for (const row of rows) {
		if (typeof row.costUsd !== "number" || !Number.isFinite(row.costUsd)) continue;
		const providerId = row.providerId && row.modelId ? row.providerId : null;
		const modelId = providerId ? row.modelId : null;
		const key = JSON.stringify([providerId, modelId]);
		const group = groups.get(key) ?? { providerId, modelId, costUsd: 0, turnCount: 0 };
		group.turnCount += 1;
		group.costUsd += row.costUsd;
		totalUsd += row.costUsd;
		pricedTurnCount += 1;
		groups.set(key, group);
	}
	const missingCostTurnCount = rows.length - pricedTurnCount;
	return {
		totalUsd: rows.length > 0 && pricedTurnCount === 0 ? null : totalUsd,
		totalLlmTurnCount: rows.length,
		pricedTurnCount,
		missingCostTurnCount,
		isPartial: missingCostTurnCount > 0,
		byModel: [...groups.values()].sort(
			(a, b) =>
				b.costUsd - a.costUsd ||
				(a.providerId ?? "").localeCompare(b.providerId ?? "") ||
				(a.modelId ?? "").localeCompare(b.modelId ?? ""),
		),
	};
}

/** @internal */
export function buildDashboard(deps: DashboardRouteDeps): DashboardResponseBody {
	const items = [...deps.processGraphs.values()]
		.map((process) => ({ id: process.id, name: process.displayName }))
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	const watchers = (deps.processWatchers?.listAll() ?? [])
		.map((watcher) => ({
			id: `${watcher.processId}.${watcher.watcherId}`,
			name: watcher.watcherLabel,
			enabled: watcher.enabled,
		}))
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	const skills = deps.skillCatalog?.list().installedSkills ?? [];
	const bundled = skills.filter((skill) => skill.registrationKind === "bundled").length;
	const lifecycle = deps.processes.countOverviewByLifecycle({});
	const statuses = ["running", "waiting", "error", "completed", "aborted"] as const;
	return {
		generatedAt: new Date().toISOString(),
		definitions: { total: items.length, items },
		watchers: {
			total: watchers.length,
			enabled: watchers.filter((watcher) => watcher.enabled).length,
			items: watchers,
		},
		skills: { total: skills.length, installed: skills.length - bundled, bundled },
		processes: {
			total: deps.processes.countOverview({ status: "all" }),
			byStatus: statuses.map((status) => ({
				status,
				count: lifecycle
					.filter((row) =>
						status === "running"
							? ["active", "discovered"].includes(row.lifecycleStatus)
							: row.lifecycleStatus === status,
					)
					.reduce((sum, row) => sum + row.value, 0),
			})),
			byDefinition: deps.processes
				.listOverviewProcessTypes({ status: "all" })
				.map((row) => ({
					processId: row.processId,
					name: deps.processGraphs.get(row.processId)?.displayName ?? row.processId,
					count: row.value,
				}))
				.sort(
					(a, b) =>
						b.count - a.count ||
						a.name.localeCompare(b.name) ||
						a.processId.localeCompare(b.processId),
				),
		},
		costs: aggregateDashboardCosts(deps.turnSummaries.listDashboardCosts()),
		configuration: { issues: buildDashboardModelIssues(deps) },
	};
}

/** @internal */
export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardRouteDeps): void {
	app.get("/api/dashboard", async () => buildDashboard(deps));
}
