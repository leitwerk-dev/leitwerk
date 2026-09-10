import type { ProcessAttentionTarget } from "@leitwerk-dev/protocol";
import { tick } from "svelte";
import type { ChronicleProjection } from "../../chronicle/lib/chronicle-projection.js";
import {
	CHRONICLE_ACTION_SECTION_ANCHOR_ID,
	CHRONICLE_PROCESS_ERROR_SECTION_ANCHOR_ID,
	type ChronicleSelectableItem,
	findChronicleSelectableItem,
	resolveChronicleRailAnchorIdFromActiveAnchor,
	resolveSelectableTurnAnchorId,
} from "../../chronicle/lib/chronicle-selectable-items.js";
import {
	type ChronicleAnchorLayout,
	collectAnchorLayouts,
	isNearChronicleBottom,
	scrollTopForAnchor,
	selectActiveAnchorId,
} from "../../chronicle/lib/scroll-sync.js";
import type { ProcessDetailData } from "../../lib/api.js";
import {
	clearPendingProcessToastFocus,
	type PendingProcessToastFocus,
	pendingProcessToastFocusStore,
} from "../../lib/process-toast-focus.svelte.js";
import {
	CHRONICLE_CLICK_TARGET_TOP_PADDING_PX,
	findOpenActionFormElement,
	getChronicleViewportMetrics,
	isAtChronicleBottom,
	readScrollableElementLayout,
	resolveScrollTargetLayout,
} from "./process-detail-chronicle-dom.js";

interface ProcessDetailChronicleScrollArgs {
	get instanceId(): string;
	get detail(): ProcessDetailData | null;
	get projection(): ChronicleProjection;
	get railItems(): readonly ChronicleSelectableItem[];
	get viewport(): HTMLDivElement | null;
	get openActionFormId(): string | null;
	onCloseBlockingDetailOverlays: () => void;
}

function createTimeoutScheduler(callback: () => void, delayMs = 0) {
	let timerId: ReturnType<typeof setTimeout> | null = null;
	return {
		schedule(options: { force?: boolean } = {}) {
			if (options.force && timerId !== null) {
				clearTimeout(timerId);
				timerId = null;
			}
			if (timerId !== null) {
				return;
			}
			timerId = setTimeout(() => {
				timerId = null;
				callback();
			}, delayMs);
		},
		cancel() {
			if (timerId === null) {
				return;
			}
			clearTimeout(timerId);
			timerId = null;
		},
	};
}

function createFrameScheduler<T>(callback: (value: T) => void) {
	let frameId: number | null = null;
	let frameValue: T | null = null;
	function cancel() {
		if (frameId === null) {
			return;
		}
		cancelAnimationFrame(frameId);
		frameId = null;
		frameValue = null;
	}
	return {
		schedule(value: T, options: { force?: boolean } = {}) {
			if (options.force || (frameId !== null && frameValue !== value)) {
				cancel();
			}
			if (frameId !== null) {
				return;
			}
			frameValue = value;
			frameId = requestAnimationFrame(() => {
				const scheduledValue = frameValue;
				frameId = null;
				frameValue = null;
				if (scheduledValue !== null) {
					callback(scheduledValue);
				}
			});
		},
		cancel,
	};
}

function setViewportScrollTop(
	viewport: HTMLDivElement,
	top: number,
	behavior: ScrollBehavior = "auto",
) {
	if (typeof viewport.scrollTo === "function") {
		viewport.scrollTo({ top, behavior });
		return;
	}
	viewport.scrollTop = top;
}

function observeChronicleLayoutInvalidation(
	viewport: HTMLDivElement,
	onInvalidate: () => void,
): () => void {
	const cleanups: Array<() => void> = [];
	const anchors = () => viewport.querySelectorAll<HTMLElement>("[data-anchor-id]");

	if (typeof ResizeObserver !== "undefined") {
		const observer = new ResizeObserver(onInvalidate);
		observer.observe(viewport);
		if (viewport.parentElement instanceof HTMLElement) {
			observer.observe(viewport.parentElement);
		}
		for (const anchor of anchors()) {
			observer.observe(anchor);
		}
		cleanups.push(() => observer.disconnect());
	}

	if (typeof MutationObserver !== "undefined") {
		const observer = new MutationObserver(onInvalidate);
		observer.observe(viewport, { childList: true });
		const chronicleFlow = viewport.querySelector<HTMLElement>('[data-section="chronicle-flow"]');
		if (chronicleFlow) {
			observer.observe(chronicleFlow, { childList: true });
		}
		for (const anchor of anchors()) {
			observer.observe(anchor, { childList: true });
		}
		cleanups.push(() => observer.disconnect());
	}

	return () => {
		for (const cleanup of cleanups) {
			cleanup();
		}
	};
}

export function createProcessDetailChronicleScroll(args: ProcessDetailChronicleScrollArgs) {
	let activeAnchorId = $state<string | null>(null);
	let activeAnchorOverrideId = $state<string | null>(null);
	let isNearBottom = $state(true);
	let isViewportAboveOpenActionForm = $state(false);
	let observedProcessId = $state<string | null>(null);
	let hasObservedManualChronicleScroll = $state(false);
	let isProgrammaticChronicleScroll = $state(false);
	let programmaticChronicleScrollTargetTop = $state<number | null>(null);
	let shouldFollowLiveTail = $state(false);
	let isLayoutObserverReady = $state(false);
	let initialBottomPinStableFrameCount = $state(0);
	let initialBottomPinLastScrollHeight = $state<number | null>(null);
	let isInitializingToBottom = $state(false);
	let previousHadLiveTail = $state(false);
	let pendingToastFocus = $state<PendingProcessToastFocus | null>(null);

	const activeAnchorSyncScheduler = createTimeoutScheduler(syncActiveAnchorFromViewportNow);
	const programmaticScrollResetScheduler = createTimeoutScheduler(() => {
		isProgrammaticChronicleScroll = false;
		programmaticChronicleScrollTargetTop = null;
	});
	const chronicleLayoutScheduler = createFrameScheduler(runChronicleLayoutPass);
	const initialBottomPinScheduler = createFrameScheduler(() => continueInitialBottomPin());

	const showJumpToLatest = $derived.by(() => {
		if (!args.detail || args.projection.timelineItems.length === 0) {
			return false;
		}
		if (args.openActionFormId && !isViewportAboveOpenActionForm) {
			return false;
		}
		if (args.projection.liveTail) {
			return !shouldFollowLiveTail || !isNearBottom;
		}
		return !isNearBottom;
	});

	const _anchorLayoutSignature = $derived.by(() => {
		const timelineAnchorIds = new Set<string>();
		const timelineSignatureParts = args.projection.timelineItems.map((item) => {
			if ("anchorId" in item) {
				timelineAnchorIds.add(item.anchorId);
				return item.anchorId;
			}
			return `${item.kind}`;
		});
		const nonTimelineRailAnchors = args.railItems
			.map((item) => item.anchorId)
			.filter((anchorId) => !timelineAnchorIds.has(anchorId));
		return [...timelineSignatureParts, ...nonTimelineRailAnchors].join("|");
	});

	$effect(() => {
		const processId = args.detail?.process.id ?? null;
		args.railItems;
		if (!processId) {
			observedProcessId = null;
			activeAnchorId = null;
			activeAnchorOverrideId = null;
			stopInitialBottomPin();
			return;
		}
		if (observedProcessId !== processId) {
			observedProcessId = processId;
			activeAnchorId = null;
			activeAnchorOverrideId = null;
			hasObservedManualChronicleScroll = false;
			shouldFollowLiveTail = args.projection.liveTail !== null;
			startInitialBottomPin();
		}
		queueMicrotask(() => {
			if (args.detail?.process.id !== processId) {
				return;
			}
			if (isInitializingToBottom) {
				scheduleInitialBottomPin({ force: true });
				return;
			}
			scheduleActiveAnchorSync({ force: true });
		});
	});

	$effect(() => {
		args.railItems;
		if (
			activeAnchorOverrideId &&
			!findChronicleSelectableItem(args.railItems, activeAnchorOverrideId)
		) {
			activeAnchorOverrideId = null;
		}
	});

	$effect(() => {
		const liveTail = args.projection.liveTail;
		if (!args.viewport || !liveTail || !shouldFollowLiveTail) {
			return;
		}
		const metrics = getChronicleViewportMetrics(args.viewport);
		if (metrics && hasObservedManualChronicleScroll && !isNearChronicleBottom(metrics)) {
			shouldFollowLiveTail = false;
			return;
		}
		queueMicrotask(() => {
			if (!args.viewport || !shouldFollowLiveTail) {
				return;
			}
			pinChronicleToBottomNow();
		});
	});

	$effect(() => {
		const hasLiveTail = args.projection.liveTail !== null;
		const wasFollowingLiveTail = shouldFollowLiveTail;

		if (previousHadLiveTail && !hasLiveTail && wasFollowingLiveTail) {
			shouldFollowLiveTail = false;
			queueMicrotask(() => {
				if (!args.viewport) {
					return;
				}
				pinChronicleToBottomNow();
			});
		}

		if (previousHadLiveTail && !hasLiveTail && shouldFollowLiveTail) {
			shouldFollowLiveTail = false;
		}

		previousHadLiveTail = hasLiveTail;
	});

	$effect(() => {
		const viewport = args.viewport;
		_anchorLayoutSignature;
		if (!viewport) {
			return;
		}

		void tick().then(() => {
			if (args.viewport !== viewport) {
				return;
			}
			scheduleChronicleLayoutPass(viewport);
		});
	});

	$effect(() => {
		const viewport = args.viewport;
		_anchorLayoutSignature;
		if (!viewport) {
			isLayoutObserverReady = false;
			return;
		}

		isLayoutObserverReady = false;
		const cleanup = observeChronicleLayoutInvalidation(viewport, () => {
			scheduleChronicleLayoutPass(viewport);
		});
		isLayoutObserverReady = true;
		return () => {
			isLayoutObserverReady = false;
			cleanup();
		};
	});

	$effect(() => {
		return pendingProcessToastFocusStore.subscribe((focusRequest) => {
			pendingToastFocus = focusRequest;
		});
	});

	$effect(() => {
		const focusRequest = pendingToastFocus;
		if (
			!focusRequest ||
			focusRequest.instanceId !== args.instanceId ||
			!args.detail ||
			!args.viewport
		) {
			return;
		}
		if (focusRequest.target.kind === "question_request") {
			const request = args.detail.questionRequests.find(
				(candidate) => candidate.id === focusRequest.target.requestId,
			);
			if (!request) return;
			if (request.status !== "open") {
				clearPendingProcessToastFocus();
				return;
			}
			args.onCloseBlockingDetailOverlays();
			void tick().then(() => {
				if (args.projection.liveTail) jumpToAnchor(args.projection.liveTail.anchorId);
				document
					.querySelector<HTMLElement>(
						`#question-request-${request.id} input:not(:disabled), #question-request-${request.id} textarea:not(:disabled)`,
					)
					?.focus();
				clearPendingProcessToastFocus();
			});
			return;
		}
		const targetAnchorId = resolveToastFocusAnchorId(focusRequest.target);
		if (!targetAnchorId) return;
		args.onCloseBlockingDetailOverlays();
		void tick().then(() => {
			jumpToAnchor(targetAnchorId);
			clearPendingProcessToastFocus();
		});
	});

	$effect(() => {
		const actionId = args.openActionFormId;
		if (!actionId) {
			isViewportAboveOpenActionForm = false;
			return;
		}
		void tick().then(() => {
			if (args.openActionFormId !== actionId) {
				return;
			}
			updateOpenActionFormViewportPosition();
			scheduleActiveAnchorSync({ force: true });
		});
	});

	$effect(() => {
		return () => {
			activeAnchorSyncScheduler.cancel();
			programmaticScrollResetScheduler.cancel();
			chronicleLayoutScheduler.cancel();
			stopInitialBottomPin();
		};
	});

	function runChronicleLayoutPass(viewport: HTMLDivElement) {
		if (args.viewport !== viewport) {
			return;
		}
		if (isInitializingToBottom || shouldAutoPinChronicle()) {
			pinChronicleToBottomNow();
			if (isInitializingToBottom) {
				scheduleInitialBottomPin({ force: true });
			}
			return;
		}
		syncActiveAnchorFromViewportNow();
	}

	function scheduleChronicleLayoutPass(
		viewport: HTMLDivElement,
		options: { force?: boolean } = {},
	) {
		chronicleLayoutScheduler.schedule(viewport, options);
	}

	function stopInitialBottomPin() {
		isInitializingToBottom = false;
		initialBottomPinStableFrameCount = 0;
		initialBottomPinLastScrollHeight = null;
		initialBottomPinScheduler.cancel();
	}

	function startInitialBottomPin() {
		isInitializingToBottom = true;
		initialBottomPinStableFrameCount = 0;
		initialBottomPinLastScrollHeight = null;
		scheduleInitialBottomPin({ force: true });
	}

	function scheduleInitialBottomPin(options: { force?: boolean } = {}) {
		if (!isInitializingToBottom) {
			return;
		}
		initialBottomPinScheduler.schedule(undefined, options);
	}

	function continueInitialBottomPin() {
		if (!isInitializingToBottom) {
			return;
		}
		if (!args.viewport) {
			scheduleInitialBottomPin();
			return;
		}
		pinChronicleToBottomNow();
		const metrics = getChronicleViewportMetrics(args.viewport);
		if (!metrics) {
			scheduleInitialBottomPin();
			return;
		}
		const stableHeight = initialBottomPinLastScrollHeight === metrics.scrollHeight;
		const atBottom = isAtChronicleBottom(metrics, 1);
		initialBottomPinStableFrameCount =
			stableHeight && atBottom ? initialBottomPinStableFrameCount + 1 : 0;
		initialBottomPinLastScrollHeight = metrics.scrollHeight;
		if (hasObservedManualChronicleScroll || initialBottomPinStableFrameCount >= 2) {
			stopInitialBottomPin();
			return;
		}
		scheduleInitialBottomPin();
	}

	function shouldAutoPinChronicle() {
		const metrics = getChronicleViewportMetrics(args.viewport);
		if (isInitializingToBottom) {
			return true;
		}
		if (args.projection.liveTail && (shouldFollowLiveTail || isNearBottom)) {
			return true;
		}
		if (!metrics) {
			return !hasObservedManualChronicleScroll;
		}
		if (hasObservedManualChronicleScroll && !isNearChronicleBottom(metrics)) {
			return false;
		}
		return !hasObservedManualChronicleScroll;
	}

	function resolveToastFocusAnchorId(target: ProcessAttentionTarget): string | null {
		const actionSectionAnchorId = findChronicleSelectableItem(
			args.railItems,
			CHRONICLE_ACTION_SECTION_ANCHOR_ID,
		)
			? CHRONICLE_ACTION_SECTION_ANCHOR_ID
			: null;
		const processErrorSectionAnchorId = findChronicleSelectableItem(
			args.railItems,
			CHRONICLE_PROCESS_ERROR_SECTION_ANCHOR_ID,
		)
			? CHRONICLE_PROCESS_ERROR_SECTION_ANCHOR_ID
			: null;
		if (target.kind === "action_required") {
			return actionSectionAnchorId;
		}
		const failedTurnRecordId = args.detail?.recovery?.turnRecordId ?? null;
		const failedTurnAnchorId = failedTurnRecordId
			? resolveSelectableTurnAnchorId(args.projection, failedTurnRecordId)
			: null;
		if (target.kind === "turn_failed") {
			return failedTurnAnchorId ?? actionSectionAnchorId ?? processErrorSectionAnchorId;
		}
		return (
			processErrorSectionAnchorId ??
			failedTurnAnchorId ??
			actionSectionAnchorId ??
			args.railItems.at(-1)?.anchorId ??
			null
		);
	}

	function resolveActiveAnchorIdFromViewport(
		nextAnchorLayouts: readonly ChronicleAnchorLayout[],
		viewportMetrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
	): string | null {
		if (viewportMetrics.scrollTop <= 5 && args.projection.promptItem) {
			return args.projection.promptItem.anchorId;
		}
		const atBottom = isAtChronicleBottom(viewportMetrics, 40);
		if (viewportMetrics.scrollTop <= 5 && !atBottom) {
			return resolveChronicleRailAnchorIdFromActiveAnchor(
				args.projection,
				args.railItems,
				nextAnchorLayouts[0]?.anchorId ?? null,
			);
		}
		const pendingRailItem = args.railItems.find(
			(item) => item.anchorId === CHRONICLE_ACTION_SECTION_ANCHOR_ID,
		);
		if (atBottom && pendingRailItem && !args.projection.liveTail) {
			return CHRONICLE_ACTION_SECTION_ANCHOR_ID;
		}
		if (atBottom && !args.projection.liveTail) {
			return args.railItems.at(-1)?.anchorId ?? args.projection.promptItem?.anchorId ?? null;
		}
		const viewportAnchorId = selectActiveAnchorId(nextAnchorLayouts, viewportMetrics);
		return resolveChronicleRailAnchorIdFromActiveAnchor(
			args.projection,
			args.railItems,
			viewportAnchorId,
		);
	}

	function syncActiveAnchorFromViewportNow() {
		const viewport = args.viewport;
		if (!viewport) {
			activeAnchorId = null;
			return;
		}
		const viewportMetrics = {
			scrollTop: viewport.scrollTop,
			clientHeight: viewport.clientHeight,
			scrollHeight: viewport.scrollHeight,
		};
		const nextAnchorLayouts = collectAnchorLayouts(viewport);
		isNearBottom = isNearChronicleBottom(viewportMetrics);
		updateOpenActionFormViewportPosition(viewportMetrics);
		const viewportActiveAnchorId = resolveActiveAnchorIdFromViewport(
			nextAnchorLayouts,
			viewportMetrics,
		);
		activeAnchorId =
			(activeAnchorOverrideId && findChronicleSelectableItem(args.railItems, activeAnchorOverrideId)
				? activeAnchorOverrideId
				: null) ?? viewportActiveAnchorId;
		if (args.projection.liveTail && shouldFollowLiveTail && !isNearBottom) {
			shouldFollowLiveTail = false;
		}
	}

	function scheduleActiveAnchorSync(options: { force?: boolean } = {}) {
		activeAnchorSyncScheduler.schedule(options);
	}

	function markProgrammaticChronicleScroll(targetTop: number | null = null) {
		isProgrammaticChronicleScroll = true;
		programmaticChronicleScrollTargetTop = targetTop;
		programmaticScrollResetScheduler.schedule({ force: true });
	}

	function pinChronicleToBottomNow() {
		if (!args.viewport) {
			return;
		}
		scrollChronicleToBottom("auto");
		isNearBottom = true;
		syncActiveAnchorFromViewportNow();
	}

	function scrollChronicleToBottom(behavior: ScrollBehavior = "auto") {
		const viewport = args.viewport;
		if (!viewport) {
			return false;
		}
		const targetTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
		const shouldScroll = Math.abs(viewport.scrollTop - targetTop) > 1;
		if (shouldScroll) {
			markProgrammaticChronicleScroll(targetTop);
		}
		setViewportScrollTop(viewport, targetTop, behavior);
		return shouldScroll;
	}

	function jumpToLatest() {
		if (!args.viewport) {
			return;
		}
		activeAnchorOverrideId = null;
		shouldFollowLiveTail = args.projection.liveTail !== null;
		hasObservedManualChronicleScroll = false;
		startInitialBottomPin();
		scrollChronicleToBottom("auto");
		isNearBottom = true;
		syncActiveAnchorFromViewportNow();
		scheduleActiveAnchorSync({ force: true });
	}

	function updateOpenActionFormViewportPosition(
		viewportMetrics: {
			scrollTop: number;
			clientHeight: number;
			scrollHeight: number;
		} | null = getChronicleViewportMetrics(args.viewport),
	) {
		const viewport = args.viewport;
		if (!args.openActionFormId || !viewportMetrics || !viewport) {
			isViewportAboveOpenActionForm = false;
			return;
		}
		const formElement = findOpenActionFormElement(viewport, args.openActionFormId);
		const formLayout = formElement ? readScrollableElementLayout(viewport, formElement) : null;
		if (!formLayout) {
			isViewportAboveOpenActionForm = false;
			return;
		}
		isViewportAboveOpenActionForm =
			viewportMetrics.scrollTop + viewportMetrics.clientHeight < formLayout.top - 1;
	}

	function scrollToAnchor(anchorId: string, behavior: ScrollBehavior = "auto") {
		const anchor = document.getElementById(anchorId);
		const collapsedBody =
			anchor?.closest(".turn-body[hidden]") ?? anchor?.querySelector(".turn-body[hidden]");
		const failureToggle = collapsedBody?.parentElement?.querySelector<HTMLButtonElement>(
			'[data-action="toggle-failed-turn"][aria-expanded="false"]',
		);
		if (failureToggle) {
			failureToggle.click();
			void tick().then(() => scrollToAnchor(anchorId, behavior));
			return;
		}
		const viewport = args.viewport;
		if (!viewport) {
			return false;
		}
		const targetLayout = resolveScrollTargetLayout(viewport, anchorId);
		if (targetLayout) {
			const top = scrollTopForAnchor(targetLayout, viewport.clientHeight, {
				align: targetLayout.align,
				startPaddingPx:
					targetLayout.align === "start" ? CHRONICLE_CLICK_TARGET_TOP_PADDING_PX : undefined,
				scrollHeight: viewport.scrollHeight,
			});
			const shouldScroll = Math.abs(viewport.scrollTop - top) > 1;
			if (shouldScroll) {
				markProgrammaticChronicleScroll(top);
			}
			setViewportScrollTop(viewport, top, behavior);
			return shouldScroll;
		}
		const element = document.getElementById(anchorId);
		if (!element) {
			return false;
		}
		markProgrammaticChronicleScroll();
		element.scrollIntoView?.({ behavior, block: "end" });
		return true;
	}

	function jumpToAnchor(anchorId: string) {
		const activeItem = findChronicleSelectableItem(args.railItems, anchorId);
		if (!activeItem) {
			return;
		}
		hasObservedManualChronicleScroll = true;
		stopInitialBottomPin();
		shouldFollowLiveTail = args.projection.liveTail?.anchorId === activeItem.anchorId;
		const targetAnchorId = activeItem.anchorId;
		activeAnchorOverrideId = targetAnchorId;
		activeAnchorId = targetAnchorId;
		scrollToAnchor(targetAnchorId, "auto");
		syncActiveAnchorFromViewportNow();
		scheduleActiveAnchorSync({ force: true });
	}

	function handleScroll() {
		const viewportMetrics = getChronicleViewportMetrics(args.viewport);
		const isProgrammaticScrollAtTarget =
			isProgrammaticChronicleScroll &&
			viewportMetrics !== null &&
			(programmaticChronicleScrollTargetTop === null ||
				Math.abs(viewportMetrics.scrollTop - programmaticChronicleScrollTargetTop) <= 1);
		if (!isProgrammaticScrollAtTarget) {
			activeAnchorOverrideId = null;
			hasObservedManualChronicleScroll = true;
			stopInitialBottomPin();
		}
		if (viewportMetrics) {
			isNearBottom = isNearChronicleBottom(viewportMetrics);
			updateOpenActionFormViewportPosition(viewportMetrics);
			if (args.projection.liveTail) {
				shouldFollowLiveTail = isAtChronicleBottom(viewportMetrics);
			}
		} else {
			isViewportAboveOpenActionForm = false;
		}
		scheduleActiveAnchorSync();
	}

	return {
		get activeAnchorId() {
			return activeAnchorId;
		},
		get showJumpToLatest() {
			return showJumpToLatest;
		},
		get isLayoutObserverReady() {
			return isLayoutObserverReady;
		},
		handleScroll,
		jumpToAnchor,
		jumpToLatest,
	};
}
