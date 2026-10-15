import type { DashboardResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import type { FastifyInstance } from "fastify";
import {
	buildDashboardModelIssues,
	type DashboardModelIssueDeps,
} from "../dashboard-model-issues.js";
import type { RouteDeps } from "./processes.js";

/** @internal */
export type DashboardRouteDeps = DashboardModelIssueDeps &
	Pick<RouteDeps, "turnSummaries" | "skillCatalog">;

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
	const lifecycle: Record<string, number> = Object.fromEntries(
		deps.processes.countOverviewByLifecycle({}).map((row) => [row.lifecycleStatus, row.value]),
	);
	const processTotal = Object.values(lifecycle).reduce((sum, count) => sum + count, 0);
	lifecycle.running = (lifecycle.active ?? 0) + (lifecycle.discovered ?? 0);
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
			total: processTotal,
			byStatus: statuses.map((status) => ({ status, count: lifecycle[status] ?? 0 })),
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
