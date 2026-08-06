import {
	buildProcessRowSlot,
	type FutureExecution,
	type ProcessInstance,
	type ProcessProject,
} from "@leitwerk-dev/domain";
import {
	extractInitialPromptPreviewFromParamsJson,
	type FutureExecutionOverviewItem,
	type ProcessOverviewItem,
	projectFutureExecutionOverview,
} from "@leitwerk-dev/protocol";
import type { ProcessOverviewStatusFilter } from "./db/process-instance-repo.js";
import { buildFutureExecutionSummaries } from "./future-execution-presenter.js";
import { getProcessDisplayName } from "./process-operator-attention.js";
import type { RouteDeps } from "./routes/process-route-helpers.js";

export const PROCESS_OVERVIEW_SIDEBAR_LIMIT = 100;
export const PROCESS_BROWSE_MAX_PAGE_SIZE = 100;

export function buildProcessOverviewItem(input: {
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	processDisplayName: string | null;
}): ProcessOverviewItem {
	const row = buildProcessRowSlot(input.process, input.projects);
	return {
		...row,
		processDisplayName: input.processDisplayName,
		processTitle: input.process.title,
		initialPromptPreview: extractInitialPromptPreviewFromParamsJson(input.process.paramsJson),
		createdAt: input.process.createdAt,
		updatedAt: input.process.updatedAt,
		closedAt: input.process.closedAt ?? null,
	};
}

export function buildFutureExecutionOverviewItems(
	deps: Pick<
		RouteDeps,
		"futureExecutions" | "processes" | "launcherService" | "processActionRegistry"
	>,
	executions: readonly FutureExecution[],
): FutureExecutionOverviewItem[] {
	return buildFutureExecutionSummaries(deps, executions).map(projectFutureExecutionOverview);
}

function buildOverviewItems(deps: RouteDeps, processes: readonly ProcessInstance[]) {
	const instanceIds = processes.map((process) => process.id);
	const projectsByInstanceId = new Map<string, ProcessProject[]>();
	for (const project of deps.projects.listByInstances(instanceIds)) {
		const projects = projectsByInstanceId.get(project.instanceId) ?? [];
		projects.push(project);
		projectsByInstanceId.set(project.instanceId, projects);
	}
	return processes.map((process) =>
		buildProcessOverviewItem({
			process,
			projects: projectsByInstanceId.get(process.id) ?? [],
			processDisplayName: getProcessDisplayName(deps, process.processId),
		}),
	);
}

export function buildProcessesOverview(deps: RouteDeps) {
	const processTotal = deps.processes.countCurrent();
	const processes = deps.processes.listCurrent(PROCESS_OVERVIEW_SIDEBAR_LIMIT);
	const futureExecutionPage = deps.futureExecutions.listOverviewPage({
		limit: PROCESS_OVERVIEW_SIDEBAR_LIMIT,
		offset: 0,
		status: "scheduled",
	});
	return {
		processes: buildOverviewItems(deps, processes),
		futureExecutions: buildFutureExecutionOverviewItems(deps, futureExecutionPage.items),
		truncated:
			processTotal > PROCESS_OVERVIEW_SIDEBAR_LIMIT ||
			futureExecutionPage.total > PROCESS_OVERVIEW_SIDEBAR_LIMIT,
	};
}

export type ProcessBrowseSortKey = "status" | "title" | "timeline";
export type ProcessBrowseSortDirection = "asc" | "desc";

export interface ProcessBrowseQuery {
	limit?: number;
	offset?: number;
	query?: string;
	processType?: string;
	status?: ProcessOverviewStatusFilter;
	sortKey?: ProcessBrowseSortKey;
	sortDirection?: ProcessBrowseSortDirection;
}

function boundedNonNegativeInteger(value: number | undefined, fallback: number): number {
	return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value as number) : fallback;
}

function launcherBrowseMetadata(deps: RouteDeps, query: string | undefined) {
	const launchers = deps.launcherService.listUiLaunchers();
	const terms = query?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
	return {
		matchingIdsByTerm: terms.map((term) =>
			launchers
				.filter((launcher) =>
					`${launcher.id} ${launcher.label} ${launcher.card.title ?? ""}`
						.toLocaleLowerCase()
						.includes(term),
				)
				.map((launcher) => launcher.id),
		),
		fallbackTitles: Object.fromEntries(
			launchers.map((launcher) => [launcher.id, launcher.card.title ?? launcher.label]),
		),
	};
}

function lifecycleStatusRank(status: ProcessInstance["lifecycleStatus"]): number {
	if (status === "waiting" || status === "error") return 0;
	if (status === "discovered" || status === "active") return 1;
	if (status === "completed") return 3;
	return 4;
}

function timestamp(value: string | null | undefined): number {
	const parsed = Date.parse(value ?? "");
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function buildProcessBrowse(deps: RouteDeps, input: ProcessBrowseQuery) {
	const limit = Math.min(
		PROCESS_BROWSE_MAX_PAGE_SIZE,
		Math.max(1, boundedNonNegativeInteger(input.limit, PROCESS_BROWSE_MAX_PAGE_SIZE)),
	);
	const offset = boundedNonNegativeInteger(input.offset, 0);
	const sortKey: ProcessBrowseSortKey =
		input.sortKey === "status" || input.sortKey === "title" ? input.sortKey : "timeline";
	const sortDirection: ProcessBrowseSortDirection = input.sortDirection === "asc" ? "asc" : "desc";
	const launcherMetadata = launcherBrowseMetadata(deps, input.query);
	const sharedQuery = {
		query: input.query,
		processType: input.processType,
		status: input.status ?? "all",
	};
	// The first offset + limit rows from each independently sorted source are
	// sufficient to construct that same window from their globally sorted merge.
	const windowLimit = offset + limit;
	const processWindow = deps.processes.listOverviewWindow({
		...sharedQuery,
		limit: windowLimit,
		sortKey,
		sortDirection,
	});
	const futureExecutionWindow = deps.futureExecutions.listOverviewWindow({
		...sharedQuery,
		matchingLauncherIdsByTerm: launcherMetadata.matchingIdsByTerm,
		launcherFallbackTitles: launcherMetadata.fallbackTitles,
		limit: windowLimit,
		sortKey,
		sortDirection,
	});
	const futureOverviewWindow = buildFutureExecutionOverviewItems(deps, futureExecutionWindow);
	const unifiedWindow = [
		...processWindow.map((process) => ({
			kind: "process" as const,
			value: process,
			id: process.id,
			title: process.title ?? process.externalId ?? process.id,
			statusRank: lifecycleStatusRank(process.lifecycleStatus),
			timeline: timestamp(
				process.lifecycleStatus === "completed" || process.lifecycleStatus === "aborted"
					? (process.closedAt ?? process.updatedAt)
					: process.updatedAt,
			),
		})),
		...futureOverviewWindow.map((execution) => ({
			kind: "future" as const,
			value: execution,
			id: execution.id,
			title: execution.title,
			statusRank: 2,
			timeline: timestamp(execution.nextRunAt),
		})),
	].sort((a, b) => {
		let primary = 0;
		if (sortKey === "status") primary = a.statusRank - b.statusRank;
		if (sortKey === "title") primary = a.title.localeCompare(b.title);
		if (sortKey === "timeline") primary = a.timeline - b.timeline;
		if (sortDirection === "desc") primary = -primary;
		return primary || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
	});
	const page = unifiedWindow.slice(offset, offset + limit);
	const processOverviewById = new Map(
		buildOverviewItems(
			deps,
			page.flatMap((row) => (row.kind === "process" ? [row.value] : [])),
		).map((item) => [(item as ProcessOverviewItem & { instanceId: string }).instanceId, item]),
	);
	const items = page.map((row) => {
		if (row.kind === "future") return { kind: "future" as const, item: row.value };
		const item = processOverviewById.get(row.id);
		if (!item) throw new Error(`Missing overview projection for process '${row.id}'`);
		return { kind: "process" as const, item };
	});
	const processTotal = deps.processes.countOverview(sharedQuery);
	const futureExecutionTotal = deps.futureExecutions.countOverview({
		...sharedQuery,
		matchingLauncherIdsByTerm: launcherMetadata.matchingIdsByTerm,
	});
	const total = processTotal + futureExecutionTotal;
	const lifecycleCounts = Object.fromEntries(
		deps.processes
			.countOverviewByLifecycle({ query: input.query, processType: input.processType })
			.map((row) => [row.lifecycleStatus, row.value]),
	) as Record<string, number>;
	const allFutureCount = deps.futureExecutions.countOverview({
		query: input.query,
		processType: input.processType,
		status: "all",
		matchingLauncherIdsByTerm: launcherMetadata.matchingIdsByTerm,
	});
	const scheduledCount = deps.futureExecutions.countOverview({
		query: input.query,
		processType: input.processType,
		status: "scheduled",
		matchingLauncherIdsByTerm: launcherMetadata.matchingIdsByTerm,
	});
	const blockedFutureCount = deps.futureExecutions.countOverview({
		query: input.query,
		processType: input.processType,
		status: "needs_attention",
		matchingLauncherIdsByTerm: launcherMetadata.matchingIdsByTerm,
	});
	const processTypeCounts = new Map<string, number>();
	for (const row of deps.processes.listOverviewProcessTypes({
		query: input.query,
		status: input.status ?? "all",
	})) {
		processTypeCounts.set(row.processId, row.value);
	}
	for (const row of deps.futureExecutions.listOverviewProcessTypes({
		query: input.query,
		status: input.status ?? "all",
		matchingLauncherIdsByTerm: launcherMetadata.matchingIdsByTerm,
	})) {
		processTypeCounts.set(row.processId, (processTypeCounts.get(row.processId) ?? 0) + row.value);
	}
	const runningCount = (lifecycleCounts.discovered ?? 0) + (lifecycleCounts.active ?? 0);
	const needsAttentionCount =
		(lifecycleCounts.waiting ?? 0) + (lifecycleCounts.error ?? 0) + blockedFutureCount;
	const processCount = Object.values(lifecycleCounts).reduce((total, value) => total + value, 0);
	return {
		items,
		pagination: {
			limit,
			offset,
			total,
			processTotal,
			futureExecutionTotal,
			hasMore: offset + page.length < total,
		},
		facets: {
			statusCounts: {
				all: processCount + allFutureCount,
				running: runningCount,
				scheduled: scheduledCount,
				needs_attention: needsAttentionCount,
				completed: lifecycleCounts.completed ?? 0,
				aborted: lifecycleCounts.aborted ?? 0,
			},
			processTypes: [...processTypeCounts.entries()].map(([value, count]) => ({
				value,
				label: getProcessDisplayName(deps, value) ?? value,
				count,
			})),
		},
	};
}
