import type { ProcessInstance, ProcessLifecycleStatus, ProcessProject } from "./domain-model.js";

export interface ProcessRowSlot {
	instanceId: string;
	processId: string;
	title: string;
	subtitle: string;
	selectedTurnId: string | null;
	lifecycleStatus: ProcessLifecycleStatus;
	statusCategory: "error" | "active" | "waiting" | "terminal" | "discovered";
	projectCount: number;
	externalId: string | null;
	externalLinkCount: number;
}

export function getProcessStatusCategory(
	lifecycleStatus: ProcessLifecycleStatus,
): ProcessRowSlot["statusCategory"] {
	if (lifecycleStatus === "error") return "error";
	if (lifecycleStatus === "active") return "active";
	if (lifecycleStatus === "waiting") return "waiting";
	if (lifecycleStatus === "completed" || lifecycleStatus === "aborted") return "terminal";
	return "discovered";
}

export function buildProcessRowSlot(
	process: ProcessInstance,
	projects: ReadonlyArray<ProcessProject>,
): ProcessRowSlot {
	const externalLinkCount = projects.filter((p) => p.externalId !== null).length;

	const title = process.title ?? process.externalId ?? process.id;
	const subtitle = `${process.processId} \u00b7 ${projects.length} component${projects.length !== 1 ? "s" : ""}`;

	return {
		instanceId: process.id,
		processId: process.processId,
		title,
		subtitle,
		selectedTurnId: process.selectedTurnId,
		lifecycleStatus: process.lifecycleStatus,
		statusCategory: getProcessStatusCategory(process.lifecycleStatus),
		projectCount: projects.length,
		externalId: process.externalId,
		externalLinkCount,
	};
}

export function sortProcessRows(rows: ProcessRowSlot[]): ProcessRowSlot[] {
	const categoryOrder: Record<string, number> = {
		error: 0,
		active: 1,
		waiting: 2,
		discovered: 3,
		terminal: 4,
	};

	return [...rows].sort((a, b) => {
		const catA = categoryOrder[a.statusCategory] ?? 4;
		const catB = categoryOrder[b.statusCategory] ?? 4;
		if (catA !== catB) return catA - catB;
		return a.title.localeCompare(b.title);
	});
}
