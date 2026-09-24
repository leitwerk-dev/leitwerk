import { createRepositoryChangeProcess } from "@leitwerk-dev/coding";
import {
	createRepositoryChangeParamsCodec,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchParams,
} from "@leitwerk-dev/coding/repository-change-launch";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { createEmptyStructuralProcessState, flow } from "@leitwerk-dev/process-sdk";
import {
	createDurableWsFrame,
	createEphemeralWsFrame,
	WS_PRIMARY_PATH_TYPES,
} from "@leitwerk-dev/protocol";
import type { AppContext } from "@leitwerk-dev/server";
import showcaseProcesses from "@leitwerk-dev/showcase-processes";
import type { Locator, Page } from "@playwright/test";
import { createAcceptedLlmTurn as createFixtureAcceptedLlmTurn } from "../helpers/accepted-llm-turn.ts";
import { expect, test } from "./fixtures.js";

let ctx: AppContext | null = null;

const browserRepositoryChangeProcessId = "browser_repository_change_process";
const browserPublicationTurnId = "browser_publish";
const browserPublication = flow.fragment<RepositoryChangeLaunchParams, RepositoryChangeState>(
	"browser-publication",
);
browserPublication.turn(
	flow
		.automatic<RepositoryChangeLaunchParams, RepositoryChangeState>(browserPublicationTurnId)
		.description("Publish browser fixture")
		.run(() => ({ outcome: "published" }))
		.outcome("published", (outcome) => outcome.description("Published").complete()),
);
const browserRepositoryChangeProcess = createRepositoryChangeProcess({
	processId: browserRepositoryChangeProcessId,
	displayName: "Browser Repository Change",
	paramsCodec: createRepositoryChangeParamsCodec<RepositoryChangeLaunchParams>({
		normalize: (value) => normalizeRepositoryChangeParamsInput(value, "Browser Repository Change"),
	}),
	finalizeLabel: "Publish change",
	finalizeForm: {
		id: "finalize_change",
		title: "Publish change",
		fields: [],
		submitLabel: "Publish change",
	},
	publication: {
		entryTurnId: browserPublicationTurnId,
		fragment: browserPublication,
		happyPath: [browserPublicationTurnId],
	},
}).process;

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-chronicle-scroll-browser-",
		configure: (config) => {
			config.extension_loading.sources = ["./extensions/showcase-processes"];
		},
		createExtensionCatalog: () =>
			buildExtensionCatalogFromModules([
				showcaseProcesses,
				{
					manifest: { id: "browser-repository-change", version: "1.0.0" },
					setupCatalog(api) {
						api.registerProcess(browserRepositoryChangeProcess);
					},
				},
			]),
		useInProcessWorker: true,
		extensionLoadingStartDir: process.cwd(),
	},
});

test.beforeAll(async ({ leitwerk }) => {
	ctx = leitwerk.ctx;
});

function buildLongReasoningText(lineCount: number): string {
	return Array.from({ length: lineCount }, (_, index) => `Thought line ${index + 1}`).join("\n");
}

function createAcceptedLlmTurn(input: Parameters<typeof createFixtureAcceptedLlmTurn>[1]) {
	return createFixtureAcceptedLlmTurn(ctx, input, "browser-fixture-digest");
}

function createPoemHistory(instanceId: string, ageOffsetMinutes = 0) {
	const turnCount = 10;
	for (let i = 0; i < turnCount; i++) {
		createAcceptedLlmTurn({
			id: `trn_history_${instanceId}_${i}`,
			instanceId,
			turnId: "draft_poem",
			turnType: "llm",
			status: "succeeded",
			turnResultMarkdown:
				`# Poem Draft ${i + 1}\n\nThis is a detailed poem draft for iteration ${i + 1}.\n\n`.repeat(
					5,
				) + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
			startedAt: new Date(Date.now() - (turnCount - i + ageOffsetMinutes) * 60000).toISOString(),
			endedAt: new Date(
				Date.now() - (turnCount - i + ageOffsetMinutes) * 60000 + 30000,
			).toISOString(),
		});
	}
}

function createActivePoemProcess(
	externalId: string,
	historyAgeMinutes = 0,
	startedAt = new Date().toISOString(),
) {
	if (!ctx) throw new Error("Server context not initialized");
	const process = ctx.deps.processes.create({
		processId: "poem_creator_process",
		selectedTurnId: "draft_poem",
		lifecycleStatus: "active",
		externalId,
	});
	createPoemHistory(process.id, historyAgeMinutes);
	const runningTurnId = `trn_running_${process.id}`;
	createAcceptedLlmTurn({
		id: runningTurnId,
		instanceId: process.id,
		turnId: "draft_poem",
		turnType: "llm",
		status: "running",
		turnResultMarkdown: null,
		startedAt,
		endedAt: null,
	});
	return { process, runningTurnId };
}

function markAcceptedLlmTurnExited(turnRecordId: string, exitedAt: string) {
	if (!ctx) throw new Error("Server context not initialized");
	const turnRecord = ctx.deps.turnRecords.getById(turnRecordId);
	if (!turnRecord?.acceptedWorkerLeaseId) {
		throw new Error(`Accepted fixture turn ${turnRecordId} has no worker lease`);
	}
	ctx.deps.leases.update(turnRecord.acceptedWorkerLeaseId, {
		state: "exited",
		exitedAt,
	});
}

function completePoemTurn(instanceId: string, runningTurnId: string) {
	if (!ctx) throw new Error("Server context not initialized");
	const completedAt = new Date().toISOString();
	ctx.deps.turnRecords.update(runningTurnId, {
		status: "succeeded",
		endedAt: completedAt,
		turnResultMarkdown: "# Final Draft\n\nThe poem is complete.",
	});
	markAcceptedLlmTurnExited(runningTurnId, completedAt);
	const process = ctx.deps.processes.update(instanceId, {
		selectedTurnId: "poem_review",
		lifecycleStatus: "waiting",
		currentExecution: null,
	});
	ctx.broadcaster.broadcast(
		createDurableWsFrame({
			type: "process.updated",
			payload: {
				process,
				changedFields: ["selectedTurnId", "lifecycleStatus", "currentExecution"],
			},
			instanceId,
		}),
	);
}

function createReasoningLiveProcess(
	label: string,
	initialThinking = `${buildLongReasoningText(220)}\n`,
) {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}

	const startedAt = new Date(Date.now() - 60_000).toISOString();
	const { process, runningTurnId } = createActivePoemProcess(label, 5, startedAt);
	ctx.deps.events.create({
		instanceId: process.id,
		eventType: "pi.stream.delta",
		data: {
			turnRecordId: runningTurnId,
			turnId: "turn-reasoning",
			streamType: "thinking",
			text: initialThinking,
			timestamp: startedAt,
		},
	});

	return { process, runningTurnId };
}

function buildLargeRailMarkdown(label: string, sectionCount = 36): string {
	return [
		`# ${label}`,
		"",
		...Array.from({ length: sectionCount }, (_, index) => [
			`## ${label} section ${index + 1}`,
			"This intentionally long chronicle result gives the rail-click target enough surrounding content to reveal whether the selected turn is aligned near the top or left in the lower third of the viewport. ".repeat(
				4,
			),
			"",
		]).flat(),
	].join("\n");
}

function buildLargePlanMarkdown() {
	const sections = Array.from({ length: 6 }, (_, index) => ({
		title: `Plan section ${index + 1}`,
		body: "Preserve workspace inspection and review context while simplifying the outcome renderer. ".repeat(
			2,
		),
	}));

	return [
		"# Candidate implementation plan: local repo outcome simplification",
		"",
		...Array.from({ length: 3 }, (_, pass) =>
			sections.flatMap((section, index) => [
				`## ${section.title}${pass > 0 ? ` · Pass ${pass + 1}` : ""}`,
				section.body,
				"",
				`### Detail ${pass * sections.length + index + 1}`,
				`${section.body}\n\n${section.body}\n\n${section.body}\n\n${section.body}`,
				"",
			]),
		).flat(),
		"## Acceptance criteria",
		Array.from(
			{ length: 42 },
			(_, index) =>
				`- Criterion ${index + 1}: ${sections[index % sections.length]?.body ?? "Workspace review remains predictable."}`,
		).join("\n"),
	].join("\n");
}

function createRepositoryChangePlanThenImplementReasoningProcess(label: string) {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}

	const process = ctx.deps.processes.create({
		processId: browserRepositoryChangeProcessId,
		selectedTurnId: "implement",
		lifecycleStatus: "active",
		externalId: label,
		title: "Desktop scroll repro · repository change",
		stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		paramsJson: JSON.stringify({
			repoLocator: "/tmp/leitwerk",
			baseBranch: "main",
			workBranch: "preview-deployment",
			prompt: "Reproduce the long plan + live implement reasoning desktop scroll issue.",
		}),
	});

	createAcceptedLlmTurn({
		id: `trn_generate_plan_${process.id}`,
		instanceId: process.id,
		turnId: "generate_plan",
		turnType: "llm",
		status: "succeeded",
		turnResultMarkdown: buildLargePlanMarkdown(),
		startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
		endedAt: new Date(Date.now() - 19 * 60_000).toISOString(),
	});

	ctx.deps.leafOutcomeSnapshots.create({
		instanceId: process.id,
		leafEntryId: `leaf_generate_plan_${process.id}`,
		turnRecordId: `trn_generate_plan_${process.id}`,
		rendererId: null,
		schemaVersion: null,
		props: null,
		fallbackMarkdown: buildLargePlanMarkdown(),
		status: "ready",
		warningCode: null,
		warningMessage: null,
		anchoredAt: new Date(Date.now() - 19 * 60_000).toISOString(),
	});

	ctx.deps.turnRecords.create({
		id: `trn_plan_decision_${process.id}`,
		instanceId: process.id,
		turnId: "plan_decision",
		turnType: "human",
		status: "succeeded",
		pathType: "primary",
		forkPiEntryId: null,
		resultPiEntryId: null,
		turnResultMarkdown: null,
		errorSummary: null,
		startedAt: new Date(Date.now() - 18 * 60_000).toISOString(),
		endedAt: new Date(Date.now() - 18 * 60_000).toISOString(),
	});

	const runningTurnId = `trn_implement_running_${process.id}`;
	const startedAt = new Date(Date.now() - 60_000).toISOString();
	createAcceptedLlmTurn({
		id: runningTurnId,
		instanceId: process.id,
		turnId: "implement",
		turnType: "llm",
		status: "running",
		turnResultMarkdown: null,
		startedAt,
		endedAt: null,
	});
	ctx.deps.events.create({
		instanceId: process.id,
		eventType: "pi.stream.delta",
		data: {
			turnRecordId: runningTurnId,
			turnId: "turn-implement",
			streamType: "thinking",
			text: "Start implementing the approved outcome simplification flow.\n",
			timestamp: startedAt,
		},
	});

	return { process, runningTurnId };
}

function createWaitingPoemProcess(label: string, withReviewState = true) {
	if (!ctx) throw new Error("Server context not initialized");
	return ctx.deps.processes.create({
		processId: "poem_creator_process",
		selectedTurnId: "poem_review",
		lifecycleStatus: "waiting",
		externalId: label,
		...(withReviewState
			? {
					stateJson: JSON.stringify({
						...createEmptyStructuralProcessState(),
						latestReviewMarkdown: null,
						latestReviewSummary: null,
						latestReviewOutcome: null,
					}),
				}
			: {}),
	});
}

function createRailTurn(
	instanceId: string,
	id: string,
	startedAt: number,
	turnResultMarkdown: string | null = null,
) {
	createAcceptedLlmTurn({
		id,
		instanceId,
		turnId: "draft_poem",
		turnType: "llm",
		status: "succeeded",
		turnResultMarkdown,
		startedAt: new Date(startedAt).toISOString(),
		endedAt: new Date(startedAt + 30_000).toISOString(),
	});
}

function createRailSecondTurnNearTopProcess(label: string) {
	const process = createWaitingPoemProcess(label);
	const firstTurnRecordId = `trn_second_click_first_${process.id}`;
	const secondTurnRecordId = `trn_second_click_target_${process.id}`;
	const fillerTurnRecordId = `trn_second_click_filler_${process.id}`;
	const baseTime = Date.now() - 10 * 60_000;
	for (const [index, turnRecordId] of [
		firstTurnRecordId,
		secondTurnRecordId,
		fillerTurnRecordId,
	].entries()) {
		createRailTurn(
			process.id,
			turnRecordId,
			baseTime + index * 60_000,
			turnRecordId === fillerTurnRecordId
				? buildLargeRailMarkdown("Trailing filler result", 28)
				: null,
		);
	}

	return { process, firstTurnRecordId, secondTurnRecordId };
}

function createRailDeepShortTurnProcess(label: string) {
	if (!ctx) throw new Error("Server context not initialized");
	const process = createWaitingPoemProcess(label);

	const firstTurnRecordId = `trn_deep_click_first_${process.id}`;
	const secondTurnRecordId = `trn_deep_click_target_${process.id}`;
	const trailingTurnRecordId = `trn_deep_click_trailing_${process.id}`;
	const baseTime = Date.now() - 20 * 60_000;

	createRailTurn(process.id, firstTurnRecordId, baseTime);
	ctx.deps.leafOutcomeSnapshots.create({
		instanceId: process.id,
		leafEntryId: `leaf_deep_click_first_${process.id}`,
		turnRecordId: firstTurnRecordId,
		rendererId: null,
		schemaVersion: 1,
		props: null,
		fallbackMarkdown: buildLargeRailMarkdown("Large saved result before target", 48),
		status: "ready",
		warningCode: null,
		warningMessage: null,
		anchoredAt: new Date(baseTime + 45_000).toISOString(),
	});
	createRailTurn(process.id, secondTurnRecordId, baseTime + 60_000);
	createRailTurn(
		process.id,
		trailingTurnRecordId,
		baseTime + 120_000,
		buildLargeRailMarkdown("Trailing result after target", 24),
	);

	return { process, secondTurnRecordId };
}

function createPoemReviewWaitingProcess(label: string) {
	const process = createWaitingPoemProcess(label);

	createPoemHistory(process.id, 5);

	return { process };
}

function emitThinkingDelta(instanceId: string, runningTurnId: string, text: string) {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}
	const data = {
		turnRecordId: runningTurnId,
		streamType: "thinking",
		text,
		timestamp: new Date().toISOString(),
	};
	const event = ctx.deps.events.create({ instanceId, eventType: "pi.stream.delta", data });
	ctx.broadcaster.broadcast(
		createEphemeralWsFrame({
			type: "pi.stream.delta",
			instanceId,
			eventSequence: event.eventSequence,
			payload: data,
		}),
	);
	const summary = ctx.deps.turnSummaries.get(runningTurnId);
	if (!summary) throw new Error("Expected persisted live summary");
	ctx.broadcaster.broadcast(
		createEphemeralWsFrame({
			type: WS_PRIMARY_PATH_TYPES.SUMMARY_UPDATED,
			instanceId,
			eventSequence: event.eventSequence,
			payload: { turnRecordId: runningTurnId, summary },
		}),
	);
}

for (const viewport of [
	{ width: 1280, height: 900 },
	{ width: 390, height: 844 },
]) {
	test(`lazy reasoning keeps four wrapped lines and independent controls at ${viewport.width}px`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport);
		const { process, runningTurnId } = createReasoningLiveProcess(
			`Lazy ${viewport.width}`,
			`Original context.\n\n${"A long paragraph continues with readable reasoning. ".repeat(140)}`,
		);
		let detailRequests = 0;
		page.on("request", (request) => {
			if (request.url().includes("/reasoning?")) detailRequests++;
		});
		await page.goto(`/processes/${process.id}`);
		const preview = page.locator('[data-section="live-tail"] .thinking-preview-copy');
		await expect(preview).toBeVisible();
		const expand = page.locator(
			'[data-section="live-tail"] [data-action="open-reasoning-details"]',
		);
		await expand.hover();
		expect(detailRequests).toBe(0);
		const dimensions = await preview.evaluate((element) => {
			const clip = element.getBoundingClientRect();
			const tops = new Set<number>();
			for (const span of element.querySelectorAll(".thinking-line")) {
				const range = document.createRange();
				range.selectNodeContents(span);
				for (const rect of range.getClientRects()) {
					if (rect.width > 0 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1)
						tops.add(Math.round(rect.top));
				}
			}
			return {
				height: clip.height,
				lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
				lines: tops.size,
				overflow: getComputedStyle(element).overflowY,
			};
		});
		expect(dimensions.lines).toBe(4);
		expect(Math.abs(dimensions.height - 4 * dimensions.lineHeight)).toBeLessThan(1);
		expect(dimensions.overflow).toBe("clip");
		emitThinkingDelta(process.id, runningTurnId, "\n \n\nNew paragraph.");
		await expect(preview).toContainText("New paragraph.");
		expect(await preview.evaluate((element) => element.getBoundingClientRect().height)).toBe(
			dimensions.height,
		);
		await preview
			.locator("..")
			.screenshot({ path: `/tmp/leitwerk-reasoning-preview-${viewport.width}.png` });

		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		let captured = false;
		await page.route("**/reasoning?*", async (route) => {
			const response = await route.fetch();
			captured = true;
			await gate;
			await route.fulfill({ response });
		});
		await expand.click();
		await expect(page.getByText("Loading reasoning…", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Close reasoning details", exact: true }).last(),
		).toBeEnabled();
		await expect.poll(() => captured).toBe(true);
		emitThinkingDelta(process.id, runningTurnId, "\nBuffered while loading.");
		release();
		const overlay = page.locator('[data-section="reasoning-details-overlay"]');
		await expect(overlay).toContainText("Original context.");
		await expect(overlay).toContainText("Buffered while loading.");
		expect((await overlay.textContent())?.match(/Buffered while loading\./g)).toHaveLength(1);
		await overlay.evaluate((element) => {
			element.scrollTop = 100;
			element.dispatchEvent(new Event("scroll"));
		});
		const readingPosition = await overlay.evaluate((element) => element.scrollTop);
		emitThinkingDelta(process.id, runningTurnId, "\nFurther output.");
		await expect(overlay).toContainText("Further output.");
		expect(await overlay.evaluate((element) => element.scrollTop)).toBe(readingPosition);
	});
}

async function relativeBounds(viewport: Locator, selector: string) {
	return viewport.evaluate((element, selector) => {
		const target = element.querySelector(selector);
		if (!target) throw new Error(`Missing scroll target: ${selector}`);
		const bounds = target.getBoundingClientRect();
		const top = element.getBoundingClientRect().top;
		return {
			top: bounds.top - top,
			bottom: bounds.bottom - top,
			clientHeight: element.clientHeight,
		};
	}, selector);
}

async function getScrollMetrics(locator: Locator) {
	return locator.evaluate((el) => ({
		scrollTop: el.scrollTop,
		scrollHeight: el.scrollHeight,
		clientHeight: el.clientHeight,
	}));
}

function bottomGap(metrics: Awaited<ReturnType<typeof getScrollMetrics>>) {
	return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
}

async function wheelAtLocator(
	page: Page,
	locator: Locator,
	deltaY: number,
	position: "center" | "top" = "center",
) {
	if (position === "center") {
		await locator.hover();
	} else {
		const box = await locator.boundingBox();
		if (!box) {
			throw new Error("Expected locator to have a bounding box for wheel scrolling");
		}
		await page.mouse.move(
			box.x + Math.min(24, box.width / 2),
			box.y + Math.min(24, box.height / 2),
		);
	}
	await page.mouse.wheel(0, deltaY);
}

async function wheelToBoundary(
	page: Page,
	locator: Locator,
	boundary: "top" | "bottom",
	thresholdPx = 50,
	position: "center" | "top" = "center",
) {
	// Keep native wheel input, but cover the remaining distance in one gesture.
	// Poll the boundary so an intercepted wheel fails here instead of silently
	// returning a viewport that never reached the requested position.
	await expect
		.poll(
			async () => {
				const metrics = await getScrollMetrics(locator);
				const remaining = boundary === "top" ? metrics.scrollTop : bottomGap(metrics);
				if (remaining > thresholdPx) {
					await wheelAtLocator(
						page,
						locator,
						(boundary === "top" ? -1 : 1) * Math.max(1200, remaining),
						position,
					);
				}
				return remaining;
			},
			{ timeout: 5_000, intervals: [50, 100] },
		)
		.toBeLessThanOrEqual(thresholdPx);
	return getScrollMetrics(locator);
}

async function waitForScrollToSettle(locator: Locator) {
	let previous = (await getScrollMetrics(locator)).scrollTop;
	let stableSamples = 0;
	await expect
		.poll(
			async () => {
				const current = (await getScrollMetrics(locator)).scrollTop;
				stableSamples = Math.abs(current - previous) < 1 ? stableSamples + 1 : 0;
				previous = current;
				return stableSamples;
			},
			{ timeout: 5_000, intervals: [100] },
		)
		.toBeGreaterThanOrEqual(3);
	return getScrollMetrics(locator);
}

async function wheelToApproxScrollTop(
	page: Page,
	locator: Locator,
	targetScrollTop: number,
	position: "center" | "top" = "center",
) {
	let metrics = await waitForScrollToSettle(locator);
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const remaining = targetScrollTop - metrics.scrollTop;
		if (Math.abs(remaining) <= 150) return metrics;
		// Wheel dispatch does not await scrolling. Avoid queued input and overshoot
		// by waiting for each movement to settle before choosing the next delta.
		await wheelAtLocator(page, locator, remaining, position);
		await expect
			.poll(async () => Math.abs((await getScrollMetrics(locator)).scrollTop - metrics.scrollTop))
			.toBeGreaterThan(1);
		metrics = await waitForScrollToSettle(locator);
	}
	expect(Math.abs(metrics.scrollTop - targetScrollTop)).toBeLessThanOrEqual(150);
	return metrics;
}

async function waitForRunningTurnId(instanceId: string, turnId: string, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const currentExecution = ctx?.deps.processes.getById(instanceId)?.currentExecution ?? null;
		const currentTurnRecordId = (() => {
			if (!ctx || !currentExecution) return null;
			const start = ctx.deps.turnStarts.getById(currentExecution.id);
			return start?.state.kind === "accepted" ? start.state.turnRecordId : null;
		})();
		if (currentTurnRecordId) {
			const currentTurn = ctx?.deps.turnRecords.getById(currentTurnRecordId) ?? null;
			if (currentTurn?.turnId === turnId) {
				return currentTurnRecordId;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for running turn ${turnId} on process ${instanceId}`);
}

function synthesizeRunningReviewTurn(instanceId: string) {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}
	const runningTurnId = `trn_synth_review_${instanceId}`;
	const turnRecord = createAcceptedLlmTurn({
		id: runningTurnId,
		instanceId,
		turnId: "review_poem_draft",
		turnType: "llm",
		status: "running",
		pathType: "leaf_branch",
		turnResultMarkdown: null,
		startedAt: new Date().toISOString(),
		endedAt: null,
	});
	const updatedProcess = ctx.deps.processes.update(instanceId, {
		selectedTurnId: "review_poem_draft",
		lifecycleStatus: "active",
	});
	ctx.broadcaster.broadcast(
		createDurableWsFrame({
			type: "process.updated",
			payload: {
				process: updatedProcess,
				changedFields: ["selectedTurnId", "lifecycleStatus", "currentExecution"],
			},
			instanceId,
		}),
	);
	ctx.broadcaster.sendDurable(
		WS_PRIMARY_PATH_TYPES.TURN_STARTED,
		{
			turnRecord,
		},
		instanceId,
	);
	return runningTurnId;
}

async function selectCollapsedRailTurn(page: Page, turnRecordId: string) {
	const repeatedTurns = page.getByRole("button", { name: /Earlier updates/ });
	await expect(repeatedTurns).toHaveAttribute("aria-expanded", "false");
	await repeatedTurns.click();
	const turnButton = page.locator(`.rail-item[data-turn-record-id="${turnRecordId}"]`);
	await expect(turnButton).toBeVisible();
	await turnButton.click();
	return turnButton;
}

test.describe("rail scroll-anchor behavior", () => {
	test("collapses repeated history after scrolling out and reopens it on return", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		const { process, firstTurnRecordId, secondTurnRecordId } = createRailSecondTurnNearTopProcess(
			"RAIL-REPEATED-SCROLL-001",
		);
		await page.goto(`/processes/${process.id}`);
		const repeatedTurns = page.getByRole("button", { name: /Earlier updates/ });
		await expect(repeatedTurns).toHaveAttribute("aria-expanded", "false");
		await repeatedTurns.click();
		const firstTurn = page.locator(`.rail-item[data-turn-record-id="${firstTurnRecordId}"]`);
		const secondTurn = page.locator(`.rail-item[data-turn-record-id="${secondTurnRecordId}"]`);
		await firstTurn.click();
		await expect(firstTurn).toHaveClass(/is-active/);
		await secondTurn.click();
		await expect(secondTurn).toHaveClass(/is-active/);
		await expect(repeatedTurns).toHaveAttribute("aria-expanded", "true");

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		await wheelToBoundary(page, chronicleScroll, "bottom");
		await expect(repeatedTurns).toHaveAttribute("aria-expanded", "false");
		await expect(secondTurn).toHaveCount(0);
		const currentTurn = page.locator('[data-section="action-required-indicator"]');
		await expect(currentTurn).toHaveClass(/is-active/);
		// Collapsing history must not leave keyboard focus on a removed button.
		const focusedRailItem = page.locator(".rail-item:focus");
		await expect(focusedRailItem).toBeVisible();

		// Compact history requires reaching the actual start, not the helper’s 50px tolerance.
		const returnedViewport = await wheelToBoundary(page, chronicleScroll, "top", 0);
		expect(returnedViewport.scrollTop).toBe(0);
		await expect(repeatedTurns).toHaveAttribute("aria-expanded", "true");
		await expect(
			page.locator('[data-section="repeated-turns"] .rail-item.is-active'),
		).toBeVisible();
	});

	test("clicking turn button moves the active rail highlight", async ({ page }) => {
		const process = createWaitingPoemProcess("RAIL-TURN-CLEAR-001", false);

		createPoemHistory(process.id);

		await page.goto(`/processes/${process.id}`);

		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });

		const actionRequiredButton = page.locator('[data-section="action-required-indicator"]');
		await expect(actionRequiredButton).toBeVisible();

		const firstTurnButton = page.locator(".rail-item[data-turn-record-id]").first();
		await expect(firstTurnButton).toBeVisible();

		await expect(actionRequiredButton).toHaveClass(/is-active/);

		await firstTurnButton.click();

		// The clicked turn button should now be the only active rail item.
		await expect(actionRequiredButton).not.toHaveClass(/is-active/);
		await expect(firstTurnButton).toHaveClass(/is-active/);
	});

	test("clicking the second turn rail item moves the second turn near the top instead of leaving the first turn dominant", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1920, height: 1080 });
		const { process, firstTurnRecordId, secondTurnRecordId } = createRailSecondTurnNearTopProcess(
			"RAIL-SECOND-NEAR-TOP-001",
		);

		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="chronicle-flow"]');

		const secondTurnButton = await selectCollapsedRailTurn(page, secondTurnRecordId);
		await page.waitForTimeout(100);

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		const first = await relativeBounds(
			chronicleScroll,
			`[data-section="chronicle-turn"][data-turn-record-id="${firstTurnRecordId}"]`,
		);
		const second = await relativeBounds(
			chronicleScroll,
			`[data-section="chronicle-turn"][data-turn-record-id="${secondTurnRecordId}"]`,
		);
		expect(second.top).toBeGreaterThanOrEqual(0);
		expect(second.top).toBeLessThanOrEqual(80);
		expect(first.bottom).toBeLessThanOrEqual(80);
		await expect(secondTurnButton).toHaveClass(/is-active/);
	});

	test("clicking a short turn after a large result keeps the focused turn out of the lower third", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1920, height: 1080 });
		const { process, secondTurnRecordId } = createRailDeepShortTurnProcess(
			"RAIL-DEEP-SHORT-TURN-001",
		);

		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="leaf-outcome"]');

		const secondTurnButton = await selectCollapsedRailTurn(page, secondTurnRecordId);
		await page.waitForTimeout(100);

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		const position = await relativeBounds(
			chronicleScroll,
			`[data-section="chronicle-turn"][data-turn-record-id="${secondTurnRecordId}"]`,
		);
		expect(position.top).toBeGreaterThanOrEqual(0);
		expect(position.top).toBeLessThanOrEqual(96);
		expect(position.top).toBeLessThan(position.clientHeight / 3);
		await expect(secondTurnButton).toHaveClass(/is-active/);
	});

	test("keeps multi-line operator-decision rail items expanded when the rail overflows", async ({
		page,
	}) => {
		const { process } = createPoemReviewWaitingProcess("RAIL-ACTION-DETAIL-001");

		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });

		const actionRequiredButton = page.locator('[data-section="action-required-indicator"]');
		await expect(actionRequiredButton).toBeVisible();

		const layout = await actionRequiredButton.evaluate((element) => {
			const detail = element.querySelector<HTMLElement>(".rail-detail");
			return {
				clientHeight: element.clientHeight,
				scrollHeight: element.scrollHeight,
				detailHeight: detail?.getBoundingClientRect().height ?? 0,
			};
		});

		expect(layout.detailHeight).toBeGreaterThan(0);
		expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight + 1);
	});

	test("clicking a completed turn keeps its saved result fully visible near the top", async ({
		page,
	}) => {
		const process = createWaitingPoemProcess("RAIL-TURN-RESULT-001", false);

		createPoemHistory(process.id);

		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		const firstTurnButton = page.locator(".rail-item[data-turn-record-id]").first();
		const turnRecordId = await firstTurnButton.getAttribute("data-turn-record-id");
		if (!turnRecordId) {
			throw new Error("Expected first turn button to include a turn record id");
		}

		await firstTurnButton.click();
		await page.waitForTimeout(100);

		const resultPosition = await relativeBounds(
			chronicleScroll,
			`[data-section="chronicle-turn"][data-turn-record-id="${turnRecordId}"] [data-section="turn-result"]`,
		);
		expect(resultPosition.top).toBeGreaterThanOrEqual(0);
		expect(resultPosition.top).toBeLessThanOrEqual(80);
	});
});

for (const { width, running } of [
	{ width: 390, running: false },
	{ width: 1440, running: false },
	{ width: 390, running: true },
	{ width: 1440, running: true },
]) {
	test(`retry history stays collapsible at ${width}px (running: ${running})`, async ({ page }) => {
		if (!ctx) throw new Error("Server context not initialized");
		const process = ctx.deps.processes.create({
			processId: "poem_creator_process",
			selectedTurnId: running ? "draft_poem" : "review_poem",
			lifecycleStatus: running ? "active" : "waiting",
			externalId: `RETRY-COLLAPSE-${width}`,
		});
		const ids = Array.from({ length: 6 }, (_, index) => `trn_retry_${process.id}_${index}`);
		for (const [index, id] of ids.entries()) {
			createAcceptedLlmTurn({
				id,
				instanceId: process.id,
				turnId: "draft_poem",
				turnType: "llm",
				status: index < 5 ? "failed" : running ? "running" : "succeeded",
				parentTurnRecordId: index ? ids[index - 1] : null,
				turnResultMarkdown: index < 5 ? null : "A quiet garden grows.",
				errorSummary: index < 5 ? "Preparation failed: dependency installation failed." : null,
				startedAt: new Date(Date.now() - (6 - index) * 60_000).toISOString(),
				endedAt:
					index === 5 && running
						? null
						: new Date(Date.now() - (6 - index) * 60_000 + 1_000).toISOString(),
			});
		}
		let progressAt = "";
		if (running) {
			progressAt = ctx.deps.events.create({
				instanceId: process.id,
				eventType: "turn.progress",
				data: {
					turnRecordId: ids[5],
					revision: 1,
					report: {
						title: "Draft progress",
						summary: "Reworking the poem",
						steps: [{ id: "draft", label: "Draft", status: "in_progress" }],
					},
				},
			}).createdAt;
		}

		await page.setViewportSize({ width, height: 844 });
		await page.goto(`/processes/${process.id}`);
		const history = page.locator('[data-section="retry-history"]');
		const summary = history.locator("summary");
		await expect(summary).toHaveText("5 earlier attempts");
		if (running) {
			await expect(page.locator('[data-section="live-tail"]')).toBeVisible();
			await expect(page.locator('[data-section="live-tail"]')).toContainText("Reworking the poem");
			await expect(
				page.locator(`[data-section="live-tail"] time[datetime="${progressAt}"]`),
			).toBeVisible();
			await expect(history.locator('[data-section="live-tail"]')).toHaveCount(0);
		}
		await summary.scrollIntoViewIfNeeded();
		await expect(history).not.toHaveAttribute("open", "");
		await summary.click();
		await expect(history).toHaveAttribute("open", "");
		await expect(history.locator('[data-section="chronicle-turn"]')).toHaveCount(5);
		await summary.click();
		await expect(history).not.toHaveAttribute("open", "");
		await summary.focus();
		await page.keyboard.press("Enter");
		await expect(history).toHaveAttribute("open", "");
		await page.keyboard.press("Enter");
		await expect(history).not.toHaveAttribute("open", "");
		if (width < 1024) await page.getByRole("button", { name: /^Quick nav/ }).click();
		const historyToggle = page.getByRole("button", { name: /^Earlier attempts/ });
		if ((await historyToggle.getAttribute("aria-expanded")) !== "true") await historyToggle.click();
		await page.getByRole("button", { name: /Attempt 3 of 6/ }).click();
		await expect(history).toHaveAttribute("open", "");
		await expect(history.locator(`[data-turn-record-id="${ids[2]}"]`)).toBeInViewport();
		await summary.scrollIntoViewIfNeeded();
		await summary.click();
		await expect(history).not.toHaveAttribute("open", "");
	});
}

async function openReasoningLiveProcess(page: Page, label: string) {
	const fixture = createReasoningLiveProcess(label);
	await page.goto(`/processes/${fixture.process.id}`);
	await page.waitForSelector('[data-section="live-tail"]');
	await page.waitForSelector('[data-section="live-tail"] [data-section="thinking-preview"]');
	await expect(
		page.locator('[data-section="live-tail"] [data-section="reasoning-timeline"]'),
	).toHaveCount(0);
	const livePreview = page.locator('[data-section="live-tail"] [data-section="thinking-preview"]');
	return { ...fixture, livePreview };
}

async function openRepositoryReasoningProcess(page: Page, label: string) {
	await page.setViewportSize({ width: 1920, height: 1080 });
	const fixture = createRepositoryChangePlanThenImplementReasoningProcess(label);
	await page.goto(`/processes/${fixture.process.id}`);
	const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
	const liveTail = page.locator('[data-section="live-tail"]');
	await expect(chronicleScroll).toBeVisible();
	await expect(
		page.locator('[data-section="leaf-outcome"][data-renderer-mode="fallback"]'),
	).toHaveCount(1);
	await expect(page.locator('[data-section="leaf-outcome"]')).toContainText(
		"Candidate implementation plan",
	);
	return { ...fixture, chronicleScroll, liveTail };
}

async function expectChronicleOverflow(chronicleScroll: Locator) {
	await expect(chronicleScroll).toBeVisible();
	const metrics = await getScrollMetrics(chronicleScroll);
	expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
	return metrics;
}

test.describe("chronicle scroll behavior", () => {
	test("keeps live reasoning in the preview card instead of creating an inline nested scroller", async ({
		page,
	}) => {
		const { process, runningTurnId, livePreview } = await openReasoningLiveProcess(
			page,
			"SCROLL-REASONING-INNER-001",
		);
		await expect(livePreview).toContainText("Thought line");

		emitThinkingDelta(process.id, runningTurnId, "New live thought after render.\n");
		await expect(livePreview).toContainText("New live thought after render.");

		await expect(
			page.locator('[data-section="live-tail"] [data-section="reasoning-timeline"]'),
		).toHaveCount(0);
	});

	test("keeps the outer chronicle manually scrollable while live reasoning streams", async ({
		page,
	}) => {
		const { process, runningTurnId, livePreview } = await openReasoningLiveProcess(
			page,
			"SCROLL-REASONING-OUTER-001",
		);
		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		await expectChronicleOverflow(chronicleScroll);

		await wheelToBoundary(page, chronicleScroll, "top", 50, "top");
		await page.waitForTimeout(150);

		emitThinkingDelta(process.id, runningTurnId, "More streamed reasoning after page scroll.\n");
		await expect(livePreview).toContainText("More streamed reasoning after page scroll.");
		// Observe after rendering too: streaming must not trigger a delayed snap-back.
		await page.waitForTimeout(300);

		const afterMetrics = await getScrollMetrics(chronicleScroll);

		expect(afterMetrics.scrollTop).toBeLessThan(50);
	});

	test("keeps a mid-history desktop chronicle position stable while repository-change reasoning streams", async ({
		page,
	}) => {
		const { process, runningTurnId, chronicleScroll } = await openRepositoryReasoningProcess(
			page,
			"SCROLL-DESKTOP-LONG-PLAN-LIVE-IMPLEMENT-001",
		);
		await page.waitForSelector('[data-section="live-tail"]');
		const livePreview = page.locator(
			'[data-section="live-tail"] [data-section="thinking-preview"]',
		);
		await expect(livePreview).toContainText(
			"Start implementing the approved outcome simplification flow.",
		);
		await chronicleScroll.evaluate((element) => {
			element.scrollTop = Math.max((element.scrollHeight - element.clientHeight) / 2, 0);
			element.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		await page.waitForTimeout(150);
		const beforeMetrics = await getScrollMetrics(chronicleScroll);
		await page.waitForTimeout(300);
		const stableBeforeDeltaMetrics = await getScrollMetrics(chronicleScroll);
		expect(Math.abs(stableBeforeDeltaMetrics.scrollTop - beforeMetrics.scrollTop)).toBeLessThan(20);

		emitThinkingDelta(process.id, runningTurnId, "Desktop reasoning delta 1.\n");
		await expect(livePreview).toContainText("Desktop reasoning delta 1.");
		emitThinkingDelta(process.id, runningTurnId, "Desktop reasoning delta 2.\n");
		await expect(livePreview).toContainText("Desktop reasoning delta 2.");
		await page.waitForTimeout(300);

		const afterMetrics = await getScrollMetrics(chronicleScroll);
		expect(Math.abs(afterMetrics.scrollTop - beforeMetrics.scrollTop)).toBeLessThan(150);
	});

	test("keeps a followed live tail pinned to the bottom when earlier result content grows", async ({
		page,
	}) => {
		const { chronicleScroll, liveTail } = await openRepositoryReasoningProcess(
			page,
			"SCROLL-LIVE-TAIL-PRIOR-GROWTH-001",
		);
		await expect(liveTail).toBeVisible();

		await expect
			.poll(async () => bottomGap(await getScrollMetrics(chronicleScroll)))
			.toBeLessThanOrEqual(24);
		await expect(chronicleScroll).toHaveAttribute("data-layout-observer-ready", "true");

		await page
			.locator('[data-section="leaf-outcome"]')
			.first()
			.evaluate((element) => {
				const lateContent = document.createElement("div");
				lateContent.setAttribute("data-test-id", "late-result-growth");
				lateContent.style.minHeight = "1800px";
				lateContent.textContent =
					"Late renderer/layout growth above the live tail should not move the followed turn out of view.";
				element.appendChild(lateContent);
			});

		// The followed live tail re-pins via a resize observer, which can take a
		// few frames to fire under load. Poll for the settled bottom gap instead
		// of asserting after a fixed wait.
		await expect
			.poll(async () => bottomGap(await getScrollMetrics(chronicleScroll)))
			.toBeLessThanOrEqual(80);
		await expect(liveTail).toBeInViewport();
		await expect(page.locator('.rail-item[data-turn-status="in_progress"]')).toHaveAttribute(
			"data-active",
			"true",
		);
	});

	test("keeps the outer chronicle scrollable through auto-review placeholder-to-streaming transition", async ({
		page,
	}) => {
		const { process } = createPoemReviewWaitingProcess("SCROLL-AUTO-REVIEW-TRANSITION-001");

		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-section="leaf-outcome-actions"]');

		const runAutoReviewButton = page.locator('[data-action-id="run_poem_auto_review"]');
		await expect(runAutoReviewButton).toBeVisible();
		await runAutoReviewButton.click();

		const runningTurnId = await waitForRunningTurnId(process.id, "review_poem_draft", 1_500).catch(
			() => synthesizeRunningReviewTurn(process.id),
		);

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		const liveTail = page.locator('[data-section="live-tail"][data-turn-id="review_poem_draft"]');
		await expect(liveTail).toBeVisible();
		await wheelToBoundary(page, chronicleScroll, "bottom", 50, "top");
		await expect(liveTail).toBeInViewport();
		await expect(
			page.locator('[data-section="live-tail"] [data-section="reasoning-timeline"]'),
		).toHaveCount(0);
		await wheelToBoundary(page, chronicleScroll, "top", 50, "top");
		await page.waitForTimeout(150);
		const waitingScrollMetrics = await getScrollMetrics(chronicleScroll);
		expect(waitingScrollMetrics.scrollTop).toBeLessThan(50);

		emitThinkingDelta(process.id, runningTurnId, "Streaming thought 1 after placeholder.\n");
		await page.waitForSelector('[data-section="live-tail"] [data-section="thinking-preview"]');
		await expect(
			page.locator('[data-section="live-tail"] [data-section="reasoning-timeline"]'),
		).toHaveCount(0);
		await page.waitForTimeout(150);

		await wheelToBoundary(page, chronicleScroll, "bottom", 50, "top");
		await page.waitForTimeout(100);
		expect(bottomGap(await getScrollMetrics(chronicleScroll))).toBeLessThan(100);

		emitThinkingDelta(process.id, runningTurnId, "Streaming thought 2 while still running.\n");
		await page.waitForTimeout(150);

		await wheelToBoundary(page, chronicleScroll, "top", 50, "top");
		await page.waitForTimeout(150);
		const finalMetrics = await getScrollMetrics(chronicleScroll);
		expect(finalMetrics.scrollTop).toBeLessThan(50);
	});

	test("can scroll up during live render while turn is running", async ({ page }) => {
		const { process } = createActivePoemProcess("SCROLL-LIVE-001");
		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="live-tail"]', { timeout: 5000 });

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		const initialMetrics = await expectChronicleOverflow(chronicleScroll);
		expect(bottomGap(initialMetrics)).toBeLessThan(50);

		await wheelToBoundary(page, chronicleScroll, "top", 50, "top");
		await page.waitForTimeout(300);
		const afterScrollMetrics = await getScrollMetrics(chronicleScroll);
		expect(afterScrollMetrics.scrollTop).toBeLessThan(50);
	});

	test("action section stays in view when turn completes", async ({ page }) => {
		const { process, runningTurnId } = createActivePoemProcess("SCROLL-FOCUS-001");
		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-section="live-tail"]', { timeout: 5000 });

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		expect(bottomGap(await getScrollMetrics(chronicleScroll))).toBeLessThan(50);

		completePoemTurn(process.id, runningTurnId);
		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });
		await expect
			.poll(async () => bottomGap(await getScrollMetrics(chronicleScroll)))
			.toBeLessThan(200);
		const actionSection = page.locator('[data-section="leaf-outcome-actions"]');
		await expect(actionSection).toBeInViewport();
		expect(bottomGap(await getScrollMetrics(chronicleScroll))).toBeLessThan(200);
	});

	test("can scroll up when action section appears dynamically after turn completes", async ({
		page,
	}) => {
		const { process, runningTurnId } = createActivePoemProcess("SCROLL-DYNAMIC-001");
		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="chronicle-flow"]');
		const actionSectionBefore = await page.$('[data-section="leaf-outcome-actions"]');
		expect(actionSectionBefore).toBeNull();

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		await expectChronicleOverflow(chronicleScroll);

		completePoemTurn(process.id, runningTurnId);
		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });
		await expect
			.poll(async () => bottomGap(await getScrollMetrics(chronicleScroll)))
			.toBeLessThan(200);
		await wheelToBoundary(page, chronicleScroll, "top", 50, "top");
		await page.waitForTimeout(200);
		const afterScrollMetrics = await getScrollMetrics(chronicleScroll);
		expect(afterScrollMetrics.scrollTop).toBeLessThan(50);
	});

	test("can scroll up when action section is visible with enough content", async ({ page }) => {
		const process = createWaitingPoemProcess("SCROLL-TEST-001", false);

		createPoemHistory(process.id);

		await page.goto(`/processes/${process.id}`);

		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="chronicle-flow"]');

		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		await expectChronicleOverflow(chronicleScroll);

		// The bug: scroll should not be stuck at the bottom. Aim at the center
		// so sticky content near the top edge cannot intercept the wheel input.
		await wheelToBoundary(page, chronicleScroll, "top", 50);

		await page.waitForTimeout(100);

		const afterScrollMetrics = await getScrollMetrics(chronicleScroll);

		expect(afterScrollMetrics.scrollTop).toBeLessThan(50);

		await wheelToBoundary(page, chronicleScroll, "bottom", 50);
		await page.waitForTimeout(100);

		await chronicleScroll.hover();
		// Poll until the wheel-up registers; under load a single wheel event plus a
		// fixed wait can race the scroll handler, so retry until it moves off bottom.
		let afterWheelMetrics = await getScrollMetrics(chronicleScroll);
		for (let attempt = 0; attempt < 20; attempt += 1) {
			afterWheelMetrics = await getScrollMetrics(chronicleScroll);
			if (bottomGap(afterWheelMetrics) > 100) {
				break;
			}
			await page.mouse.wheel(0, -500);
			await page.waitForTimeout(50);
		}

		expect(bottomGap(afterWheelMetrics)).toBeGreaterThan(100);
	});

	test("scroll position is not locked when action section appears after content", async ({
		page,
	}) => {
		const process = createWaitingPoemProcess("SCROLL-TEST-002", false);

		for (let i = 0; i < 5; i++) {
			createAcceptedLlmTurn({
				id: `trn_lock_${process.id}_${i}`,
				instanceId: process.id,
				turnId: "draft_poem",
				turnType: "llm",
				status: "succeeded",
				turnResultMarkdown:
					`## Poem Section ${i + 1}\n\n${"This is paragraph content that takes up space. ".repeat(50)}\n\n`.repeat(
						3,
					),
				startedAt: new Date(Date.now() - (5 - i) * 60000).toISOString(),
				endedAt: new Date(Date.now() - (5 - i) * 60000 + 30000).toISOString(),
			});
		}

		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');

		const canScroll = await chronicleScroll.evaluate((el) => {
			return el.scrollHeight > el.clientHeight;
		});
		expect(canScroll).toBe(true);

		// Try to scroll to a middle position using wheel scrolling only
		await wheelToBoundary(page, chronicleScroll, "top", 50, "top");
		const topMetrics = await getScrollMetrics(chronicleScroll);
		const targetScrollTop = (topMetrics.scrollHeight - topMetrics.clientHeight) / 2;
		const reachedMetrics = await wheelToApproxScrollTop(
			page,
			chronicleScroll,
			targetScrollTop,
			"top",
		);

		await page.waitForTimeout(100);

		// Verify scroll position is maintained (not snapped back to bottom)
		const actualScrollTop = await chronicleScroll.evaluate((el) => el.scrollTop);

		// Allow some tolerance for wheel-based positioning
		expect(Math.abs(actualScrollTop - reachedMetrics.scrollTop)).toBeLessThan(150);
	});
});
