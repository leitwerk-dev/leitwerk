import { tick } from "svelte";
import { navigate } from "../../../lib/router.svelte.js";
import {
	buildInspectorPath,
	buildProcessPath,
	type InspectorRoute,
	type InspectorTarget,
} from "../../../lib/router-logic.js";

interface ReadingPosition {
	anchor: string | null;
	offset: number;
	scrollTop: number;
	disclosures: string[];
	focusId: string | null;
}
interface InspectionHistory {
	instanceId: string;
	depth: number;
	originalExecution: string | null;
	returnPosition: ReadingPosition | null;
	reading?: ReadingPosition;
	reveal?: { turnRecordId?: string; turnId?: string };
}
const itemKey = (el: HTMLElement) => el.dataset.inspectionItem ?? el.dataset.anchorId ?? el.id;
function capture(viewport: HTMLElement | null): ReadingPosition | null {
	if (!viewport) return null;
	const top = viewport.getBoundingClientRect().top;
	const anchors = [
		...viewport.querySelectorAll<HTMLElement>("[data-inspection-item], [data-anchor-id]"),
	];
	const anchor = anchors.find(
		(el) => el.getBoundingClientRect().bottom > top + 8 && el.getBoundingClientRect().height > 0,
	);
	const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	if (active && !active.id) active.id = `inspector-focus-${crypto.randomUUID()}`;
	return {
		anchor: anchor ? itemKey(anchor) : null,
		offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
		scrollTop: viewport.scrollTop,
		disclosures: [...viewport.querySelectorAll<HTMLDetailsElement>("details[open]")]
			.map((el) => el.dataset.disclosureKey ?? el.id)
			.filter(Boolean),
		focusId: active?.id ?? null,
	};
}
function restore(viewport: HTMLElement | null, position: ReadingPosition | null | undefined) {
	if (!viewport || !position) return;
	for (const disclosure of viewport.querySelectorAll<HTMLDetailsElement>(
		"details[data-disclosure-key], details[id]",
	))
		disclosure.open = position.disclosures.includes(
			disclosure.dataset.disclosureKey ?? disclosure.id,
		);
	const anchor = [
		...viewport.querySelectorAll<HTMLElement>("[data-inspection-item], [data-anchor-id]"),
	].find((el) => itemKey(el) === position.anchor);
	viewport.scrollTop = anchor
		? viewport.scrollTop +
			anchor.getBoundingClientRect().top -
			viewport.getBoundingClientRect().top -
			position.offset
		: position.scrollTop;
}

/** URLs select evidence. History owns reading position; progress never selects an execution. */
export function createInspectorNavigation(args: {
	get instanceId(): string;
	get route(): InspectorRoute;
	get path(): string;
	reveal(target: { turnRecordId?: string; turnId?: string }): void;
}) {
	const positions = new Map<string, ReadingPosition>();
	const viewport = () =>
		document.querySelector<HTMLElement>(
			args.route ? '[data-role="inspector-scroll"]' : '[data-role="chronicle-scroll"]',
		);
	const state = (): InspectionHistory | null =>
		history.state?.inspection?.instanceId === args.instanceId ? history.state.inspection : null;
	const write = (inspection: InspectionHistory) =>
		history.replaceState({ ...history.state, inspection }, "");
	function save() {
		const reading = capture(viewport());
		if (!reading) return;
		positions.set(args.path, reading);
		const previous = state();
		if (previous)
			write({ ...previous, ...(args.route ? { reading } : { returnPosition: reading }) });
	}
	function visit(target: InspectorTarget) {
		save();
		const previous = state();
		const returnPosition = args.route ? (previous?.returnPosition ?? null) : capture(viewport());
		const originalExecution = args.route
			? (previous?.originalExecution ?? null)
			: target.scope === "execution"
				? target.turnRecordId
				: null;
		if (!args.route)
			write({ instanceId: args.instanceId, depth: 0, originalExecution, returnPosition });
		const to = buildInspectorPath(args.instanceId, target);
		navigate(to, {
			state: {
				inspection: {
					instanceId: args.instanceId,
					depth: (args.route ? (previous?.depth ?? 0) : 0) + 1,
					returnPosition,
					originalExecution,
					reading: positions.get(to),
				},
			},
		});
	}
	function showChronicle(reveal?: { turnRecordId?: string; turnId?: string }) {
		save();
		const previous = state();
		const selected = args.route?.scope === "execution" ? args.route.turnRecordId : null;
		const target =
			reveal ??
			(selected && selected !== previous?.originalExecution
				? { turnRecordId: selected }
				: undefined);
		navigate(buildProcessPath(args.instanceId), {
			state: { inspection: { ...previous, instanceId: args.instanceId, depth: 0, reveal: target } },
		});
	}
	function back() {
		save();
		if ((state()?.depth ?? 0) > 0) history.back();
		else showChronicle();
	}
	async function restoreRoute() {
		await tick();
		const current = state();
		if (args.route) {
			restore(viewport(), current?.reading ?? positions.get(args.path));
			document.getElementById("inspector-heading")?.focus({ preventScroll: true });
		} else if (current?.reveal) {
			args.reveal(current.reveal);
		} else {
			restore(viewport(), current?.returnPosition);
			if (current?.returnPosition?.focusId)
				document.getElementById(current.returnPosition.focusId)?.focus({ preventScroll: true });
		}
	}
	function observe(element: HTMLElement) {
		element.addEventListener("scroll", save, true);
		element.addEventListener("toggle", save, true);
		return {
			destroy() {
				element.removeEventListener("scroll", save, true);
				element.removeEventListener("toggle", save, true);
			},
		};
	}
	return { visit, back, showChronicle, save, restoreRoute, observe };
}
