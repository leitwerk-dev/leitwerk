import type { ProcessInstance, ProcessLifecycleStatus, ProcessProject } from "./domain-model.js";

/** @internal */
export interface ProcessRowSlot {
	/** @internal */
	instanceId: string;
	/** @internal */
	processId: string;
	/** @internal */
	title: string;
	/** @internal */
	subtitle: string;
	/** @internal */
	selectedTurnId: string | null;
	/** @internal */
	lifecycleStatus: ProcessLifecycleStatus;
	/** @internal */
	statusCategory: "error" | "active" | "waiting" | "terminal" | "discovered";
	/** @internal */
	projectCount: number;
	/** @internal */
	externalId: string | null;
	/** @internal */
	externalLinkCount: number;
}

/** @internal */
export function getProcessStatusCategory(
	lifecycleStatus: ProcessLifecycleStatus,
): ProcessRowSlot["statusCategory"] {
	if (lifecycleStatus === "error") return "error";
	if (lifecycleStatus === "active") return "active";
	if (lifecycleStatus === "waiting") return "waiting";
	if (lifecycleStatus === "completed" || lifecycleStatus === "aborted") return "terminal";
	return "discovered";
}

/** @internal */
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

/** @internal */
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
