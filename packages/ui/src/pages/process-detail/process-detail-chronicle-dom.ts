import type { ChronicleViewportMetrics } from "../../chronicle/lib/scroll-sync.js";

export const CHRONICLE_CLICK_TARGET_TOP_PADDING_PX = 28;

export type ChronicleScrollTargetLayout = {
	top: number;
	height: number;
	align: "focus" | "start";
};

export function getChronicleViewportMetrics(
	viewport: HTMLElement | null,
): ChronicleViewportMetrics | null {
	if (!viewport) {
		return null;
	}
	return {
		scrollTop: viewport.scrollTop,
		clientHeight: viewport.clientHeight,
		scrollHeight: viewport.scrollHeight,
	};
}

export function isAtChronicleBottom(
	viewport: Pick<ChronicleViewportMetrics, "scrollTop" | "clientHeight" | "scrollHeight">,
	thresholdPx = 24,
) {
	return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= thresholdPx;
}

export function readScrollableElementLayout(viewport: HTMLElement, element: HTMLElement) {
	const fallbackHeight = element.offsetHeight;
	const elementRect = element.getBoundingClientRect();
	const viewportRect = viewport.getBoundingClientRect();
	if (
		Number.isFinite(elementRect.top) &&
		Number.isFinite(viewportRect.top) &&
		elementRect.height > 0 &&
		viewport.clientHeight > 0
	) {
		return {
			top: elementRect.top - viewportRect.top + viewport.scrollTop,
			height: elementRect.height,
		};
	}
	let top = 0;
	let current: HTMLElement | null = element;
	const visited = new Set<HTMLElement>();
	while (current && current !== viewport && !visited.has(current)) {
		visited.add(current);
		if (Number.isFinite(current.offsetTop)) {
			top += current.offsetTop;
		}
		current =
			current.offsetParent instanceof HTMLElement ? current.offsetParent : current.parentElement;
	}
	if (!Number.isFinite(top) || !Number.isFinite(fallbackHeight) || fallbackHeight <= 0) {
		return null;
	}
	return { top, height: fallbackHeight };
}

export function findOpenActionFormElement(
	viewport: HTMLElement,
	openActionFormId: string | null,
): HTMLElement | null {
	if (!openActionFormId) {
		return null;
	}
	const forms = viewport.querySelectorAll<HTMLElement>("[data-action-form-id]");
	for (const form of forms) {
		if (form.dataset.actionFormId === openActionFormId) {
			return form;
		}
	}
	return null;
}

export function resolveScrollTargetLayout(
	viewport: HTMLElement,
	anchorId: string,
): ChronicleScrollTargetLayout | null {
	const anchorElement = document.getElementById(anchorId);
	if (!(anchorElement instanceof HTMLElement) || !viewport.contains(anchorElement)) {
		return null;
	}
	if (anchorElement.dataset.section === "chronicle-turn") {
		const turnResultSection = anchorElement.querySelector<HTMLElement>(
			'[data-section="turn-result"]',
		);
		const turnResultLayout = turnResultSection
			? readScrollableElementLayout(viewport, turnResultSection)
			: null;
		if (turnResultLayout) {
			return { ...turnResultLayout, align: "start" };
		}
		const turnLayout = readScrollableElementLayout(viewport, anchorElement);
		return turnLayout ? { ...turnLayout, align: "start" } : null;
	}
	const anchorLayout = readScrollableElementLayout(viewport, anchorElement);
	return anchorLayout ? { ...anchorLayout, align: "focus" } : null;
}

/** Keep the narrow chronicle and its composer inside the visible viewport. */
export function fitChronicleToViewport(element: HTMLElement) {
	const resize = () => {
		if (window.innerWidth > 1024) {
			element.style.removeProperty("max-height");
			return;
		}
		const viewport = window.visualViewport;
		const bottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
		const available = bottom - element.getBoundingClientRect().top - 14;
		element.style.maxHeight = `${Math.max(240, available)}px`;
	};
	const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
	if (element.parentElement?.parentElement) observer?.observe(element.parentElement.parentElement);
	window.addEventListener("resize", resize);
	window.visualViewport?.addEventListener("resize", resize);
	resize();
	return {
		destroy() {
			observer?.disconnect();
			window.removeEventListener("resize", resize);
			window.visualViewport?.removeEventListener("resize", resize);
		},
	};
}
