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
	scrollers?: { key: string; top: number; left: number }[];
	disclosures: string[];
	focusId: string | null;
}
interface InspectionHistory {
	instanceId: string;
	returnPosition: ReadingPosition | null;
	reading?: ReadingPosition;
	reveal?: ChronicleTarget;
}
/** @internal */
export type ChronicleTarget = { turnRecordId: string } | { turnId: string };
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
		scrollers: [...viewport.querySelectorAll<HTMLElement>("[data-reading-scroll]")].map((el) => ({
			key: el.dataset.readingScroll ?? "",
			top: el.scrollTop,
			left: el.scrollLeft,
		})),
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
	for (const scroller of viewport.querySelectorAll<HTMLElement>("[data-reading-scroll]")) {
		const saved = position.scrollers?.find((item) => item.key === scroller.dataset.readingScroll);
		if (saved) {
			scroller.scrollTop = saved.top;
			scroller.scrollLeft = saved.left;
		}
	}
}

/** URLs select evidence. History owns reading position; progress never selects an execution. */
export function createInspectorNavigation(args: {
	get instanceId(): string;
	get route(): InspectorRoute;
	get path(): string;
	reveal(target: ChronicleTarget): void;
}) {
	const positions = new Map<string, ReadingPosition>();
	let restoredPath: string | null = null;
	let pendingPosition: ReadingPosition | null | undefined;
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
		if (!args.route) write({ instanceId: args.instanceId, returnPosition });
		const to = buildInspectorPath(args.instanceId, target);
		navigate(to, {
			state: {
				inspection: {
					instanceId: args.instanceId,
					returnPosition,
					reading: positions.get(to),
				},
			},
		});
	}
	function leaveInspector(reveal?: ChronicleTarget) {
		save();
		navigate(buildProcessPath(args.instanceId), {
			state: {
				inspection: {
					instanceId: args.instanceId,
					returnPosition: state()?.returnPosition ?? null,
					reveal,
				},
			},
		});
	}
	function returnToProcess() {
		leaveInspector();
	}
	function showChronicle(target: ChronicleTarget) {
		leaveInspector(target);
	}
	async function restoreRoute() {
		restoredPath = null;
		pendingPosition = state()?.reading ?? positions.get(args.path);
		await tick();
		const current = state();
		if (args.route) {
			restore(viewport(), current?.reading ?? positions.get(args.path));
			document.getElementById("inspector-heading")?.focus({ preventScroll: true });
		} else if (current?.reveal) {
			args.reveal(current.reveal);
		} else if (current) {
			restore(viewport(), current.returnPosition);
			const focus = current.returnPosition?.focusId
				? document.getElementById(current.returnPosition.focusId)
				: null;
			if (focus) focus.focus({ preventScroll: true });
			else {
				const heading = document.querySelector<HTMLElement>(
					'[data-page="process-detail"] .page-shell h1',
				);
				if (heading) {
					heading.tabIndex = -1;
					heading.focus({ preventScroll: true });
				}
			}
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
	return {
		visit,
		returnToProcess,
		showChronicle,
		save,
		restoreRoute,
		observe,
		restoreContent() {
			if (restoredPath === args.path) return false;
			restoredPath = args.path;
			restore(viewport(), pendingPosition);
			return Boolean(pendingPosition);
		},
	};
}
