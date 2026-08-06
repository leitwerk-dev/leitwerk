export interface ChronicleAnchorLayout {
	anchorId: string;
	top: number;
	height: number;
}

export interface ChronicleViewportMetrics {
	scrollTop: number;
	clientHeight: number;
	scrollHeight: number;
}

const CHRONICLE_ACTIVE_FOCUS_RATIO = 0.76;

export function collectAnchorLayouts(
	container: ParentNode,
	selector = "[data-anchor-id]",
): ChronicleAnchorLayout[] {
	return [...container.querySelectorAll<HTMLElement>(selector)]
		.map((element) => ({
			anchorId: element.dataset.anchorId ?? element.id,
			top: element.offsetTop,
			height: element.offsetHeight,
		}))
		.filter(
			(layout) =>
				layout.anchorId.length > 0 && Number.isFinite(layout.top) && Number.isFinite(layout.height),
		);
}

export function scrollTopForAnchor(
	layout: Pick<ChronicleAnchorLayout, "top"> & Partial<Pick<ChronicleAnchorLayout, "height">>,
	clientHeight: number,
	options: {
		focusRatio?: number;
		scrollHeight?: number;
		align?: "focus" | "start";
		startPaddingPx?: number;
	} = {},
): number {
	const align = options.align ?? "focus";
	let targetTop = 0;
	if (align === "start") {
		targetTop = Math.max(layout.top - Math.max(options.startPaddingPx ?? 0, 0), 0);
	} else {
		const focusRatio = options.focusRatio ?? CHRONICLE_ACTIVE_FOCUS_RATIO;
		const sectionHeight = Math.max(layout.height ?? 0, 0);
		const focusTargetTop = Math.max(layout.top - clientHeight * focusRatio, 0);
		const visibilityTargetTop = Math.max(layout.top + sectionHeight - clientHeight, 0);
		const sectionFitsWithinViewport = sectionHeight > 0 && sectionHeight <= clientHeight;
		targetTop = sectionFitsWithinViewport
			? Math.max(focusTargetTop, visibilityTargetTop)
			: focusTargetTop;
	}
	if (options.scrollHeight !== undefined && Number.isFinite(options.scrollHeight)) {
		targetTop = Math.min(targetTop, Math.max(options.scrollHeight - clientHeight, 0));
	}
	return targetTop;
}

export function selectActiveAnchorId(
	layouts: readonly ChronicleAnchorLayout[],
	viewport: Pick<ChronicleViewportMetrics, "scrollTop" | "clientHeight">,
): string | null {
	if (layouts.length === 0) {
		return null;
	}
	const focusLine = viewport.scrollTop + viewport.clientHeight * CHRONICLE_ACTIVE_FOCUS_RATIO;
	let activeAnchorId = layouts[0]?.anchorId ?? null;
	for (const layout of layouts) {
		if (focusLine >= layout.top - 1) {
			activeAnchorId = layout.anchorId;
			continue;
		}
		break;
	}
	return activeAnchorId;
}

export function isNearChronicleBottom(
	viewport: ChronicleViewportMetrics,
	thresholdPx = 120,
): boolean {
	if (!Number.isFinite(viewport.scrollHeight) || viewport.scrollHeight <= 0) {
		return false;
	}
	return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= thresholdPx;
}
