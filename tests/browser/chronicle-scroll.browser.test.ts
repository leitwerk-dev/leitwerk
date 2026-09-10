import { loadExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import { createEmptyStructuralProcessState } from "@leitwerk-dev/process-sdk";
import {
	createDurableWsFrame,
	createEphemeralWsFrame,
	WS_PRIMARY_PATH_TYPES,
} from "@leitwerk-dev/protocol";
import type { AppContext } from "@leitwerk-dev/server";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

let ctx: AppContext | null = null;

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-chronicle-scroll-browser-",
		configure: (config) => {
			config.extension_loading.sources = [
				"./extensions/showcase-processes",
				"./extensions/local-repo-change",
			];
		},
		createExtensionCatalog: (config) =>
			loadExtensionCatalog({
				startDir: process.cwd(),
				sources: config.extension_loading.sources,
			}),
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

type AcceptedLlmTurnFixtureInput = Parameters<AppContext["deps"]["turnRecords"]["create"]>[0] & {
	id: string;
	turnType: "llm";
};

function createAcceptedLlmTurn(input: AcceptedLlmTurnFixtureInput) {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}
	const running = input.status === "running";
	const lease = ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: `wkr_fixture_${input.id}`,
		state: running ? "busy" : "exited",
	});
	const start = ctx.deps.turnStarts.create({
		id: `tsr_fixture_${input.id}`,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		proposedTurnRecordId: input.id,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {
				kind: "llm",
				model: {
					profileId: input.modelProfileId ?? "test",
					providerId: "test",
					modelId: "test",
					thinkingLevel: "off",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "browser-fixture-digest",
				workerRuntimeProfileId: "test",
				piSettings: {},
			},
			turnRecordId: input.id,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	const turnRecord = ctx.deps.turnRecords.create({
		...input,
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
	});
	if (running) {
		ctx.deps.processes.update(input.instanceId, {
			currentExecution: { kind: "worker_start", id: start.id },
		});
	} else {
		ctx.deps.leases.update(lease.id, {
			exitedAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
		});
	}
	return turnRecord;
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

function createReasoningLiveProcess(
	label: string,
	initialThinking = `${buildLongReasoningText(220)}\n`,
) {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}

	const process = ctx.deps.processes.create({
		processId: "poem_creator_process",
		selectedTurnId: "draft_poem",
		lifecycleStatus: "active",
		externalId: label,
	});

	const turnCount = 10;
	for (let i = 0; i < turnCount; i++) {
		createAcceptedLlmTurn({
			id: `trn_reasoning_history_${process.id}_${i}`,
			instanceId: process.id,
			turnId: "draft_poem",
			turnType: "llm",
			status: "succeeded",
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
			turnResultMarkdown:
				`# Historic Draft ${i + 1}\n\nThis is a detailed historic draft ${i + 1}.\n\n`.repeat(5) +
				"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
			errorSummary: null,
			startedAt: new Date(Date.now() - (turnCount - i + 5) * 60000).toISOString(),
			endedAt: new Date(Date.now() - (turnCount - i + 5) * 60000 + 30000).toISOString(),
		});
	}

	const runningTurnId = `trn_reasoning_running_${process.id}`;
	const startedAt = new Date(Date.now() - 60_000).toISOString();
	createAcceptedLlmTurn({
		id: runningTurnId,
		instanceId: process.id,
		turnId: "draft_poem",
		turnType: "llm",
		status: "running",
		pathType: "primary",
		forkPiEntryId: null,
		resultPiEntryId: null,
		turnResultMarkdown: null,
		errorSummary: null,
		startedAt,
		endedAt: null,
	});
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
	const sections = [
		{
			title: "Short summary",
			body: "Simplify the local repo outcome card by keeping repository metadata while leaving deployment, editor launch controls, and preview environments to external systems.",
		},
		{
			title: "What the repo already gives us",
			body: "The existing process already clones a full workspace, materializes leaf outcomes, and exposes operator actions around the selected turn. That gives us a stable surface for review without adding a deployment plane.",
		},
		{
			title: "Proposed implementation",
			body: "Remove repo-owned deployment hooks, editor launch links, workspace-path probing, and server-side diff probing from the renderer and process state, then let deterministic finalization complete directly.",
		},
		{
			title: "Docs to keep aligned",
			body: "Keep process-workspace, configuration, user flows, technical flows, and outcome-tools docs in sync so deployment remains explicitly out of scope while the product remains pre-alpha.",
		},
		{
			title: "Test plan",
			body: "Cover outcome rendering, finalization completion, and UI regression coverage for live-scroll behavior while the implementation turn is still streaming.",
		},
		{
			title: "Risks / watchpoints",
			body: "The simplified flow must preserve workspace inspection and review context while avoiding server-side port proxies, background process cleanup, and deployment-specific state.",
		},
	];

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

function createLocalRepoChangePlanThenImplementReasoningProcess(label: string) {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}

	const process = ctx.deps.processes.create({
		processId: "local_repo_change_process",
		selectedTurnId: "implement",
		lifecycleStatus: "active",
		externalId: label,
		title: "Desktop scroll repro · local repo change",
		stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		paramsJson: JSON.stringify({
			launchKind: "requested_change",
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
		pathType: "primary",
		forkPiEntryId: null,
		resultPiEntryId: null,
		turnResultMarkdown: buildLargePlanMarkdown(),
		errorSummary: null,
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
		pathType: "primary",
		forkPiEntryId: null,
		resultPiEntryId: null,
		turnResultMarkdown: null,
		errorSummary: null,
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

function createRailSecondTurnNearTopProcess(label: string) {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}

	const process = ctx.deps.processes.create({
		processId: "poem_creator_process",
		selectedTurnId: "poem_review",
		lifecycleStatus: "waiting",
		externalId: label,
		stateJson: JSON.stringify({
			...createEmptyStructuralProcessState(),
			latestReviewMarkdown: null,
			latestReviewSummary: null,
			latestReviewOutcome: null,
		}),
	});

	const firstTurnRecordId = `trn_second_click_first_${process.id}`;
	const secondTurnRecordId = `trn_second_click_target_${process.id}`;
	const fillerTurnRecordId = `trn_second_click_filler_${process.id}`;
	const baseTime = Date.now() - 10 * 60_000;
	for (const [index, turnRecordId] of [
		firstTurnRecordId,
		secondTurnRecordId,
		fillerTurnRecordId,
	].entries()) {
		createAcceptedLlmTurn({
			id: turnRecordId,
			instanceId: process.id,
			turnId: "draft_poem",
			turnType: "llm",
			status: "succeeded",
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
			turnResultMarkdown:
				turnRecordId === fillerTurnRecordId
					? buildLargeRailMarkdown("Trailing filler result", 28)
					: null,
			errorSummary: null,
			startedAt: new Date(baseTime + index * 60_000).toISOString(),
			endedAt: new Date(baseTime + index * 60_000 + 30_000).toISOString(),
		});
	}

	return { process, firstTurnRecordId, secondTurnRecordId };
}

function createRailDeepShortTurnProcess(label: string) {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}

	const process = ctx.deps.processes.create({
		processId: "poem_creator_process",
		selectedTurnId: "poem_review",
		lifecycleStatus: "waiting",
		externalId: label,
		stateJson: JSON.stringify({
			...createEmptyStructuralProcessState(),
			latestReviewMarkdown: null,
			latestReviewSummary: null,
			latestReviewOutcome: null,
		}),
	});

	const firstTurnRecordId = `trn_deep_click_first_${process.id}`;
	const secondTurnRecordId = `trn_deep_click_target_${process.id}`;
	const trailingTurnRecordId = `trn_deep_click_trailing_${process.id}`;
	const baseTime = Date.now() - 20 * 60_000;

	createAcceptedLlmTurn({
		id: firstTurnRecordId,
		instanceId: process.id,
		turnId: "draft_poem",
		turnType: "llm",
		status: "succeeded",
		pathType: "primary",
		forkPiEntryId: null,
		resultPiEntryId: null,
		turnResultMarkdown: null,
		errorSummary: null,
		startedAt: new Date(baseTime).toISOString(),
		endedAt: new Date(baseTime + 30_000).toISOString(),
	});
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
	createAcceptedLlmTurn({
		id: secondTurnRecordId,
		instanceId: process.id,
		turnId: "draft_poem",
		turnType: "llm",
		status: "succeeded",
		pathType: "primary",
		forkPiEntryId: null,
		resultPiEntryId: null,
		turnResultMarkdown: null,
		errorSummary: null,
		startedAt: new Date(baseTime + 60_000).toISOString(),
		endedAt: new Date(baseTime + 90_000).toISOString(),
	});
	createAcceptedLlmTurn({
		id: trailingTurnRecordId,
		instanceId: process.id,
		turnId: "draft_poem",
		turnType: "llm",
		status: "succeeded",
		pathType: "primary",
		forkPiEntryId: null,
		resultPiEntryId: null,
		turnResultMarkdown: buildLargeRailMarkdown("Trailing result after target", 24),
		errorSummary: null,
		startedAt: new Date(baseTime + 120_000).toISOString(),
		endedAt: new Date(baseTime + 150_000).toISOString(),
	});

	return { process, secondTurnRecordId };
}

function createPoemReviewWaitingProcess(label: string) {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}

	const process = ctx.deps.processes.create({
		processId: "poem_creator_process",
		selectedTurnId: "poem_review",
		lifecycleStatus: "waiting",
		externalId: label,
		stateJson: JSON.stringify({
			...createEmptyStructuralProcessState(),
			latestReviewMarkdown: null,
			latestReviewSummary: null,
			latestReviewOutcome: null,
		}),
	});

	for (let i = 0; i < 10; i += 1) {
		createAcceptedLlmTurn({
			id: `trn_poem_review_history_${process.id}_${i}`,
			instanceId: process.id,
			turnId: "draft_poem",
			turnType: "llm",
			status: "succeeded",
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
			turnResultMarkdown:
				`# Reviewable Draft ${i + 1}\n\nThis is a detailed poem draft for review ${i + 1}.\n\n`.repeat(
					5,
				) + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
			errorSummary: null,
			startedAt: new Date(Date.now() - (15 - i) * 60000).toISOString(),
			endedAt: new Date(Date.now() - (15 - i) * 60000 + 30000).toISOString(),
		});
	}

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

		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
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

async function getScrollMetrics(locator: Locator) {
	return locator.evaluate((el) => ({
		scrollTop: el.scrollTop,
		scrollHeight: el.scrollHeight,
		clientHeight: el.clientHeight,
	}));
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

async function wheelToTop(
	page: Page,
	locator: Locator,
	thresholdPx = 50,
	position: "center" | "top" = "center",
) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const metrics = await getScrollMetrics(locator);
		if (metrics.scrollTop <= thresholdPx) {
			return metrics;
		}
		await wheelAtLocator(page, locator, -1200, position);
		await page.waitForTimeout(40);
	}
	return getScrollMetrics(locator);
}

async function wheelToBottom(
	page: Page,
	locator: Locator,
	thresholdPx = 50,
	position: "center" | "top" = "center",
) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const metrics = await getScrollMetrics(locator);
		const maxScroll = metrics.scrollHeight - metrics.clientHeight;
		if (metrics.scrollTop >= maxScroll - thresholdPx) {
			return metrics;
		}
		await wheelAtLocator(page, locator, 1200, position);
		await page.waitForTimeout(40);
	}
	return getScrollMetrics(locator);
}

async function wheelToApproxScrollTop(
	page: Page,
	locator: Locator,
	targetScrollTop: number,
	position: "center" | "top" = "center",
) {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const metrics = await getScrollMetrics(locator);
		if (Math.abs(metrics.scrollTop - targetScrollTop) <= 150) {
			return metrics;
		}
		await wheelAtLocator(page, locator, metrics.scrollTop < targetScrollTop ? 900 : -900, position);
		await page.waitForTimeout(40);
	}
	return getScrollMetrics(locator);
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
		forkPiEntryId: null,
		resultPiEntryId: null,
		turnResultMarkdown: null,
		errorSummary: null,
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

test.describe("rail scroll-anchor behavior", () => {
	test("collapses repeated history after scrolling out and reopens it on return", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1440, height: 1000 });
		const { process, firstTurnRecordId, secondTurnRecordId } = createRailSecondTurnNearTopProcess(
			"RAIL-REPEATED-SCROLL-001",
		);
		await page.goto(`/processes/${process.id}`);
		const repeatedTurns = page.getByRole("button", { name: /Repeated Turns/ });
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
		await wheelToBottom(page, chronicleScroll);
		await expect(repeatedTurns).toHaveAttribute("aria-expanded", "false");
		await expect(secondTurn).toHaveCount(0);
		const currentTurn = page.locator('[data-section="action-required-indicator"]');
		await expect(currentTurn).toHaveClass(/is-active/);
		// Collapsing history must not leave keyboard focus on a removed button.
		const focusedRailItem = page.locator(".rail-item:focus");
		await expect(focusedRailItem).toBeVisible();

		await wheelToTop(page, chronicleScroll);
		await expect(repeatedTurns).toHaveAttribute("aria-expanded", "true");
		await expect(
			page.locator('[data-section="repeated-turns"] .rail-item.is-active'),
		).toBeVisible();
	});

	test("clicking turn button moves the active rail highlight", async ({ page }) => {
		if (!ctx) {
			throw new Error("Server context not initialized");
		}

		// Create a process in waiting state with actions visible
		const process = ctx.deps.processes.create({
			processId: "poem_creator_process",
			selectedTurnId: "poem_review",
			lifecycleStatus: "waiting",
			externalId: "RAIL-TURN-CLEAR-001",
		});

		// Create multiple completed turn records
		const turnCount = 10;
		for (let i = 0; i < turnCount; i++) {
			createAcceptedLlmTurn({
				id: `trn_rail_turn_${process.id}_${i}`,
				instanceId: process.id,
				turnId: "draft_poem",
				turnType: "llm",
				status: "succeeded",
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: null,
				turnResultMarkdown:
					`# Poem Draft ${i + 1}\n\nThis is a detailed poem draft for iteration ${i + 1}.\n\n`.repeat(
						5,
					) + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
				errorSummary: null,
				startedAt: new Date(Date.now() - (turnCount - i) * 60000).toISOString(),
				endedAt: new Date(Date.now() - (turnCount - i) * 60000 + 30000).toISOString(),
			});
		}

		// Navigate to the process detail page
		await page.goto(`/processes/${process.id}`);

		// Wait for the page to load with action section visible
		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });

		// Wait for the rail to render
		const actionRequiredButton = page.locator('[data-section="action-required-indicator"]');
		await expect(actionRequiredButton).toBeVisible();

		// Get the first turn button in the rail (not the prompt)
		const firstTurnButton = page.locator(".rail-item[data-turn-record-id]").first();
		await expect(firstTurnButton).toBeVisible();

		// Verify the action required button is initially highlighted
		await expect(actionRequiredButton).toHaveClass(/is-active/);

		// Click the first turn button in the rail
		await firstTurnButton.click();

		// Wait for the jump to settle
		await page.waitForTimeout(100);

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

		const repeatedTurns = page.getByRole("button", { name: /Repeated Turns/ });
		await expect(repeatedTurns).toHaveAttribute("aria-expanded", "false");
		await repeatedTurns.click();
		const secondTurnButton = page.locator(
			`.rail-item[data-turn-record-id="${secondTurnRecordId}"]`,
		);
		await expect(secondTurnButton).toBeVisible();

		await secondTurnButton.click();
		await page.waitForTimeout(100);

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		const positions = await chronicleScroll.evaluate(
			(element, ids) => {
				const scrollRect = element.getBoundingClientRect();
				const firstTurn = element.querySelector<HTMLElement>(
					`[data-section="chronicle-turn"][data-turn-record-id="${ids.firstTurnRecordId}"]`,
				);
				const secondTurn = element.querySelector<HTMLElement>(
					`[data-section="chronicle-turn"][data-turn-record-id="${ids.secondTurnRecordId}"]`,
				);
				if (!firstTurn || !secondTurn) {
					return null;
				}
				const firstRect = firstTurn.getBoundingClientRect();
				const secondRect = secondTurn.getBoundingClientRect();
				return {
					clientHeight: element.clientHeight,
					firstBottom: firstRect.bottom - scrollRect.top,
					secondTop: secondRect.top - scrollRect.top,
				};
			},
			{ firstTurnRecordId, secondTurnRecordId },
		);

		expect(positions).toBeTruthy();
		expect(positions?.secondTop).toBeGreaterThanOrEqual(0);
		expect(positions?.secondTop).toBeLessThanOrEqual(80);
		expect(positions?.firstBottom).toBeLessThanOrEqual(80);
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

		const repeatedTurns = page.getByRole("button", { name: /Repeated Turns/ });
		await expect(repeatedTurns).toHaveAttribute("aria-expanded", "false");
		await repeatedTurns.click();
		const secondTurnButton = page.locator(
			`.rail-item[data-turn-record-id="${secondTurnRecordId}"]`,
		);
		await expect(secondTurnButton).toBeVisible();

		await secondTurnButton.click();
		await page.waitForTimeout(100);

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		const position = await chronicleScroll.evaluate((element, turnRecordId) => {
			const scrollRect = element.getBoundingClientRect();
			const selectedTurn = element.querySelector<HTMLElement>(
				`[data-section="chronicle-turn"][data-turn-record-id="${turnRecordId}"]`,
			);
			if (!selectedTurn) {
				return null;
			}
			const selectedRect = selectedTurn.getBoundingClientRect();
			return {
				clientHeight: element.clientHeight,
				top: selectedRect.top - scrollRect.top,
				bottom: selectedRect.bottom - scrollRect.top,
			};
		}, secondTurnRecordId);

		expect(position).toBeTruthy();
		expect(position?.top).toBeGreaterThanOrEqual(0);
		expect(position?.top).toBeLessThanOrEqual(96);
		expect(position?.top ?? Number.POSITIVE_INFINITY).toBeLessThan(
			(position?.clientHeight ?? 0) / 3,
		);
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
		if (!ctx) {
			throw new Error("Server context not initialized");
		}

		const process = ctx.deps.processes.create({
			processId: "poem_creator_process",
			selectedTurnId: "poem_review",
			lifecycleStatus: "waiting",
			externalId: "RAIL-TURN-RESULT-001",
		});

		const turnCount = 10;
		for (let i = 0; i < turnCount; i++) {
			createAcceptedLlmTurn({
				id: `trn_rail_result_${process.id}_${i}`,
				instanceId: process.id,
				turnId: "draft_poem",
				turnType: "llm",
				status: "succeeded",
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: null,
				turnResultMarkdown:
					`# Poem Draft ${i + 1}\n\nThis is a detailed poem draft for iteration ${i + 1}.\n\n`.repeat(
						5,
					) + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
				errorSummary: null,
				startedAt: new Date(Date.now() - (turnCount - i) * 60000).toISOString(),
				endedAt: new Date(Date.now() - (turnCount - i) * 60000 + 30000).toISOString(),
			});
		}

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

		const resultPosition = await chronicleScroll.evaluate((element, currentTurnRecordId) => {
			const scrollRect = element.getBoundingClientRect();
			const turnResult = element.querySelector<HTMLElement>(
				`[data-section="chronicle-turn"][data-turn-record-id="${currentTurnRecordId}"] [data-section="turn-result"]`,
			);
			if (!turnResult) {
				return null;
			}
			const resultRect = turnResult.getBoundingClientRect();
			return {
				top: resultRect.top - scrollRect.top,
				bottom: resultRect.bottom - scrollRect.top,
				clientHeight: element.clientHeight,
			};
		}, turnRecordId);
		expect(resultPosition).toBeTruthy();
		expect(resultPosition?.top).toBeGreaterThanOrEqual(0);
		expect(resultPosition?.top).toBeLessThanOrEqual(80);
	});
});

test.describe("chronicle scroll behavior", () => {
	test("keeps live reasoning in the preview card instead of creating an inline nested scroller", async ({
		page,
	}) => {
		const { process, runningTurnId } = createReasoningLiveProcess("SCROLL-REASONING-INNER-001");

		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-section="live-tail"]');
		await page.waitForSelector('[data-section="live-tail"] [data-section="thinking-preview"]');
		await expect(
			page.locator('[data-section="live-tail"] [data-section="reasoning-timeline"]'),
		).toHaveCount(0);

		const livePreview = page.locator(
			'[data-section="live-tail"] [data-section="thinking-preview"]',
		);
		await expect(livePreview).toContainText("Thought line");

		emitThinkingDelta(process.id, runningTurnId, "New live thought after render.\n");
		await page.waitForTimeout(300);

		await expect(
			page.locator('[data-section="live-tail"] [data-section="reasoning-timeline"]'),
		).toHaveCount(0);
		await expect(livePreview).toContainText("New live thought after render.");
	});

	test("keeps the outer chronicle manually scrollable while live reasoning streams", async ({
		page,
	}) => {
		const { process, runningTurnId } = createReasoningLiveProcess("SCROLL-REASONING-OUTER-001");

		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-section="live-tail"]');
		await page.waitForSelector('[data-section="live-tail"] [data-section="thinking-preview"]');
		await expect(
			page.locator('[data-section="live-tail"] [data-section="reasoning-timeline"]'),
		).toHaveCount(0);

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		await expect(chronicleScroll).toBeVisible();

		const initialMetrics = await getScrollMetrics(chronicleScroll);
		expect(initialMetrics.scrollHeight).toBeGreaterThan(initialMetrics.clientHeight);

		await wheelToTop(page, chronicleScroll, 50, "top");
		await page.waitForTimeout(150);

		emitThinkingDelta(process.id, runningTurnId, "More streamed reasoning after page scroll.\n");
		await page.waitForTimeout(300);
		await expect(
			page.locator('[data-section="live-tail"] [data-section="thinking-preview"]'),
		).toContainText("More streamed reasoning after page scroll.");

		const afterMetrics = await chronicleScroll.evaluate((el) => ({
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}));

		expect(afterMetrics.scrollTop).toBeLessThan(50);
	});

	test("keeps a mid-history desktop chronicle position stable while local-repo-change reasoning streams", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1920, height: 1080 });
		const { process, runningTurnId } = createLocalRepoChangePlanThenImplementReasoningProcess(
			"SCROLL-DESKTOP-LONG-PLAN-LIVE-IMPLEMENT-001",
		);

		await page.goto(`/processes/${process.id}`);
		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		const livePreview = page.locator(
			'[data-section="live-tail"] [data-section="thinking-preview"]',
		);
		await expect(chronicleScroll).toBeVisible();
		await page.waitForSelector('[data-section="live-tail"]');
		await expect(livePreview).toContainText(
			"Start implementing the approved outcome simplification flow.",
		);
		await expect(
			page.locator('[data-section="leaf-outcome"][data-renderer-mode="fallback"]'),
		).toHaveCount(1);
		await expect(page.locator('[data-section="leaf-outcome"]')).toContainText(
			"Candidate implementation plan",
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
		await page.setViewportSize({ width: 1920, height: 1080 });
		const { process } = createLocalRepoChangePlanThenImplementReasoningProcess(
			"SCROLL-LIVE-TAIL-PRIOR-GROWTH-001",
		);

		await page.goto(`/processes/${process.id}`);
		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		const liveTail = page.locator('[data-section="live-tail"]');
		await expect(chronicleScroll).toBeVisible();
		await expect(liveTail).toBeVisible();
		await expect(
			page.locator('[data-section="leaf-outcome"][data-renderer-mode="fallback"]'),
		).toHaveCount(1);
		await expect(page.locator('[data-section="leaf-outcome"]')).toContainText(
			"Candidate implementation plan",
		);

		await expect
			.poll(async () => {
				const metrics = await getScrollMetrics(chronicleScroll);
				return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
			})
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
			.poll(async () => {
				const metrics = await getScrollMetrics(chronicleScroll);
				return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
			})
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
		await wheelToBottom(page, chronicleScroll, 50, "top");
		await expect(liveTail).toBeInViewport();
		await expect(
			page.locator('[data-section="live-tail"] [data-section="reasoning-timeline"]'),
		).toHaveCount(0);
		await wheelToTop(page, chronicleScroll, 50, "top");
		await page.waitForTimeout(150);
		const waitingScrollMetrics = await getScrollMetrics(chronicleScroll);
		expect(waitingScrollMetrics.scrollTop).toBeLessThan(50);

		emitThinkingDelta(process.id, runningTurnId, "Streaming thought 1 after placeholder.\n");
		await page.waitForSelector('[data-section="live-tail"] [data-section="thinking-preview"]');
		await expect(
			page.locator('[data-section="live-tail"] [data-section="reasoning-timeline"]'),
		).toHaveCount(0);
		await page.waitForTimeout(150);

		await wheelToBottom(page, chronicleScroll, 50, "top");
		await page.waitForTimeout(100);
		const bottomMetrics = await getScrollMetrics(chronicleScroll);
		const maxScroll = bottomMetrics.scrollHeight - bottomMetrics.clientHeight;
		expect(bottomMetrics.scrollTop).toBeGreaterThan(maxScroll - 100);

		emitThinkingDelta(process.id, runningTurnId, "Streaming thought 2 while still running.\n");
		await page.waitForTimeout(150);

		await wheelToTop(page, chronicleScroll, 50, "top");
		await page.waitForTimeout(150);
		const finalMetrics = await getScrollMetrics(chronicleScroll);
		expect(finalMetrics.scrollTop).toBeLessThan(50);
	});

	test("can scroll up during live render while turn is running", async ({ page }) => {
		if (!ctx) {
			throw new Error("Server context not initialized");
		}

		// Create a process with an ACTIVE turn (live tail visible)
		const process = ctx.deps.processes.create({
			processId: "poem_creator_process",
			selectedTurnId: "draft_poem",
			lifecycleStatus: "active",
			externalId: "SCROLL-LIVE-001",
		});

		// Create multiple completed turn records to generate enough content for scrolling
		const turnCount = 10;
		for (let i = 0; i < turnCount; i++) {
			createAcceptedLlmTurn({
				id: `trn_live_${process.id}_${i}`,
				instanceId: process.id,
				turnId: "draft_poem",
				turnType: "llm",
				status: "succeeded",
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: null,
				turnResultMarkdown:
					`# Poem Draft ${i + 1}\n\nThis is a detailed poem draft for iteration ${i + 1}.\n\n`.repeat(
						5,
					) + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
				errorSummary: null,
				startedAt: new Date(Date.now() - (turnCount - i) * 60000).toISOString(),
				endedAt: new Date(Date.now() - (turnCount - i) * 60000 + 30000).toISOString(),
			});
		}

		// Create a currently running turn record
		const runningTurnId = `trn_running_live_${process.id}`;
		createAcceptedLlmTurn({
			id: runningTurnId,
			instanceId: process.id,
			turnId: "draft_poem",
			turnType: "llm",
			status: "running",
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
			turnResultMarkdown: null,
			errorSummary: null,
			startedAt: new Date().toISOString(),
			endedAt: null,
		});

		// Navigate to the process detail page
		await page.goto(`/processes/${process.id}`);

		// Wait for the chronicle to load with the live tail
		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="live-tail"]', { timeout: 5000 });

		// Get the chronicle scroll container
		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		await expect(chronicleScroll).toBeVisible();

		// Verify there's enough content to scroll
		const initialMetrics = await chronicleScroll.evaluate((el) => ({
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}));
		expect(initialMetrics.scrollHeight).toBeGreaterThan(initialMetrics.clientHeight);

		// The scroll should be at the bottom initially (following live tail)
		const maxScroll = initialMetrics.scrollHeight - initialMetrics.clientHeight;
		expect(initialMetrics.scrollTop).toBeGreaterThan(maxScroll - 50);

		// Now try to scroll up while the live tail is still active
		await wheelToTop(page, chronicleScroll, 50, "top");

		await page.waitForTimeout(300);

		// Check if we successfully scrolled to the top
		const afterScrollMetrics = await getScrollMetrics(chronicleScroll);

		// The scroll position should be at or near the top (0)
		// If the bug exists, scrollTop will be snapped back to the bottom
		expect(afterScrollMetrics.scrollTop).toBeLessThan(50);
	});

	test("action section stays in view when turn completes", async ({ page }) => {
		if (!ctx) {
			throw new Error("Server context not initialized");
		}

		// Create a process with an ACTIVE turn
		const process = ctx.deps.processes.create({
			processId: "poem_creator_process",
			selectedTurnId: "draft_poem",
			lifecycleStatus: "active",
			externalId: "SCROLL-FOCUS-001",
		});

		// Create multiple completed turn records
		const turnCount = 10;
		for (let i = 0; i < turnCount; i++) {
			createAcceptedLlmTurn({
				id: `trn_focus_${process.id}_${i}`,
				instanceId: process.id,
				turnId: "draft_poem",
				turnType: "llm",
				status: "succeeded",
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: null,
				turnResultMarkdown:
					`# Poem Draft ${i + 1}\n\nThis is a detailed poem draft for iteration ${i + 1}.\n\n`.repeat(
						5,
					) + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
				errorSummary: null,
				startedAt: new Date(Date.now() - (turnCount - i) * 60000).toISOString(),
				endedAt: new Date(Date.now() - (turnCount - i) * 60000 + 30000).toISOString(),
			});
		}

		// Create a currently running turn record
		const runningTurnId = `trn_running_focus_${process.id}`;
		createAcceptedLlmTurn({
			id: runningTurnId,
			instanceId: process.id,
			turnId: "draft_poem",
			turnType: "llm",
			status: "running",
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
			turnResultMarkdown: null,
			errorSummary: null,
			startedAt: new Date().toISOString(),
			endedAt: null,
		});

		// Navigate to the process detail page
		await page.goto(`/processes/${process.id}`);

		// Wait for the live tail to appear
		await page.waitForSelector('[data-section="live-tail"]', { timeout: 5000 });

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');

		// Verify scroll is at bottom (following live tail)
		const beforeMetrics = await chronicleScroll.evaluate((el) => ({
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}));
		const maxScrollBefore = beforeMetrics.scrollHeight - beforeMetrics.clientHeight;
		expect(beforeMetrics.scrollTop).toBeGreaterThan(maxScrollBefore - 50);

		// Now simulate the turn completing
		const completedAt = new Date().toISOString();
		ctx.deps.turnRecords.update(runningTurnId, {
			status: "succeeded",
			endedAt: completedAt,
			turnResultMarkdown: "# Final Draft\n\nThe poem is complete.",
		});
		markAcceptedLlmTurnExited(runningTurnId, completedAt);

		const updatedProcess = ctx.deps.processes.update(process.id, {
			selectedTurnId: "poem_review",
			lifecycleStatus: "waiting",
			currentExecution: null,
		});

		// Broadcast the process update
		ctx.broadcaster.broadcast(
			createDurableWsFrame({
				type: "process.updated",
				payload: {
					process: updatedProcess,
					changedFields: ["selectedTurnId", "lifecycleStatus", "currentExecution"],
				},
				instanceId: process.id,
			}),
		);

		// Wait for the action section to appear
		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });

		// Give the UI time to settle
		await page.waitForTimeout(500);

		// The action section should be visible (scroll should be near the bottom)
		const actionSection = page.locator('[data-section="leaf-outcome-actions"]');
		await expect(actionSection).toBeInViewport();

		// Verify scroll is still near the bottom (action section in view)
		const afterMetrics = await chronicleScroll.evaluate((el) => ({
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}));
		const maxScrollAfter = afterMetrics.scrollHeight - afterMetrics.clientHeight;

		// Scroll should be near the bottom (within 200px of max)
		expect(afterMetrics.scrollTop).toBeGreaterThan(maxScrollAfter - 200);
	});

	test("can scroll up when action section appears dynamically after turn completes", async ({
		page,
	}) => {
		if (!ctx) {
			throw new Error("Server context not initialized");
		}

		// Create a process with an ACTIVE turn (no action section visible yet)
		const process = ctx.deps.processes.create({
			processId: "poem_creator_process",
			selectedTurnId: "draft_poem",
			lifecycleStatus: "active",
			externalId: "SCROLL-DYNAMIC-001",
		});

		// Create multiple completed turn records to generate enough content for scrolling
		const turnCount = 10;
		for (let i = 0; i < turnCount; i++) {
			createAcceptedLlmTurn({
				id: `trn_dynamic_${process.id}_${i}`,
				instanceId: process.id,
				turnId: "draft_poem",
				turnType: "llm",
				status: "succeeded",
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: null,
				turnResultMarkdown:
					`# Poem Draft ${i + 1}\n\nThis is a detailed poem draft for iteration ${i + 1}.\n\n`.repeat(
						5,
					) + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
				errorSummary: null,
				startedAt: new Date(Date.now() - (turnCount - i) * 60000).toISOString(),
				endedAt: new Date(Date.now() - (turnCount - i) * 60000 + 30000).toISOString(),
			});
		}

		// Create a currently running turn record
		const runningTurnId = `trn_running_${process.id}`;
		createAcceptedLlmTurn({
			id: runningTurnId,
			instanceId: process.id,
			turnId: "draft_poem",
			turnType: "llm",
			status: "running",
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
			turnResultMarkdown: null,
			errorSummary: null,
			startedAt: new Date().toISOString(),
			endedAt: null,
		});

		// Navigate to the process detail page
		await page.goto(`/processes/${process.id}`);

		// Wait for the chronicle to load with the live tail (no action section yet)
		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="chronicle-flow"]');

		// Verify action section is NOT visible yet (turn is still running)
		const actionSectionBefore = await page.$('[data-section="leaf-outcome-actions"]');
		expect(actionSectionBefore).toBeNull();

		// Get the chronicle scroll container
		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		await expect(chronicleScroll).toBeVisible();

		// Verify there's enough content to scroll
		const initialMetrics = await chronicleScroll.evaluate((el) => ({
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}));
		expect(initialMetrics.scrollHeight).toBeGreaterThan(initialMetrics.clientHeight);

		// Now simulate the turn completing - update the process state
		const completedAt = new Date().toISOString();
		ctx.deps.turnRecords.update(runningTurnId, {
			status: "succeeded",
			endedAt: completedAt,
			turnResultMarkdown: "# Final Draft\n\nThe poem is complete.",
		});
		markAcceptedLlmTurnExited(runningTurnId, completedAt);

		const updatedProcess = ctx.deps.processes.update(process.id, {
			selectedTurnId: "poem_review",
			lifecycleStatus: "waiting",
			currentExecution: null,
		});

		// Broadcast the process update to notify the UI
		ctx.broadcaster.broadcast(
			createDurableWsFrame({
				type: "process.updated",
				payload: {
					process: updatedProcess,
					changedFields: ["selectedTurnId", "lifecycleStatus", "currentExecution"],
				},
				instanceId: process.id,
			}),
		);

		// Wait for the action section to appear dynamically
		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });

		// Give the UI a moment to settle after the dynamic update
		await page.waitForTimeout(500);

		// THIS IS THE BUG: After the action section appears, try to scroll up
		// The bug is that scrolling up should work but doesn't
		await wheelToTop(page, chronicleScroll, 50, "top");

		await page.waitForTimeout(200);

		// Check if we successfully scrolled to the top
		const afterScrollMetrics = await getScrollMetrics(chronicleScroll);

		// The scroll position should be at or near the top (0)
		// If the bug exists, scrollTop will still be near the bottom
		expect(afterScrollMetrics.scrollTop).toBeLessThan(50);
	});

	test("can scroll up when action section is visible with enough content", async ({ page }) => {
		if (!ctx) {
			throw new Error("Server context not initialized");
		}

		// Use poem_creator_process which has actions defined
		// Set it to the poem_review turn (human turn) in waiting state
		const process = ctx.deps.processes.create({
			processId: "poem_creator_process",
			selectedTurnId: "poem_review",
			lifecycleStatus: "waiting",
			externalId: "SCROLL-TEST-001",
		});

		// Create multiple completed turn records to generate enough content for scrolling
		const turnCount = 10;
		for (let i = 0; i < turnCount; i++) {
			createAcceptedLlmTurn({
				id: `trn_scroll_${process.id}_${i}`,
				instanceId: process.id,
				turnId: "draft_poem",
				turnType: "llm",
				status: "succeeded",
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: null,
				turnResultMarkdown:
					`# Poem Draft ${i + 1}\n\nThis is a detailed poem draft for iteration ${i + 1}.\n\n`.repeat(
						5,
					) + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
				errorSummary: null,
				startedAt: new Date(Date.now() - (turnCount - i) * 60000).toISOString(),
				endedAt: new Date(Date.now() - (turnCount - i) * 60000 + 30000).toISOString(),
			});
		}

		// Navigate to the process detail page
		await page.goto(`/processes/${process.id}`);

		// Wait for the chronicle to load
		await page.waitForSelector('[data-page="process-detail"]');
		await page.waitForSelector('[data-section="chronicle-flow"]');

		// Wait for the action section to appear (indicates process is in waiting state with actions)
		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });

		// Get the chronicle scroll container
		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');
		await expect(chronicleScroll).toBeVisible();

		// Get initial scroll position and dimensions
		const initialMetrics = await chronicleScroll.evaluate((el) => ({
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}));

		// Verify there's enough content to scroll (scrollHeight > clientHeight)
		expect(initialMetrics.scrollHeight).toBeGreaterThan(initialMetrics.clientHeight);

		// The bug: scroll should not be stuck at the bottom. Aim at the center
		// so sticky content near the top edge cannot intercept the wheel input.
		await wheelToTop(page, chronicleScroll, 50);

		// Wait a bit for scroll to settle
		await page.waitForTimeout(100);

		// Get the new scroll position
		const afterScrollMetrics = await getScrollMetrics(chronicleScroll);

		// The scroll position should be at or near the top (0)
		// If the bug exists, scrollTop will still be near the bottom
		expect(afterScrollMetrics.scrollTop).toBeLessThan(50);

		// Also verify we can scroll using mouse wheel simulation.
		// First scroll back to bottom.
		await wheelToBottom(page, chronicleScroll, 50);
		await page.waitForTimeout(100);

		// Now try to scroll up using wheel event
		await chronicleScroll.hover();
		// Poll until the wheel-up registers; under load a single wheel event plus a
		// fixed wait can race the scroll handler, so retry until it moves off bottom.
		let afterWheelMetrics = await getScrollMetrics(chronicleScroll);
		for (let attempt = 0; attempt < 20; attempt += 1) {
			afterWheelMetrics = await getScrollMetrics(chronicleScroll);
			const maxScrollAttempt = afterWheelMetrics.scrollHeight - afterWheelMetrics.clientHeight;
			if (afterWheelMetrics.scrollTop < maxScrollAttempt - 100) {
				break;
			}
			await page.mouse.wheel(0, -500);
			await page.waitForTimeout(50);
		}

		// After scrolling up with wheel, scrollTop should be less than max scroll
		const maxScroll = afterWheelMetrics.scrollHeight - afterWheelMetrics.clientHeight;
		expect(afterWheelMetrics.scrollTop).toBeLessThan(maxScroll - 100);
	});

	test("scroll position is not locked when action section appears after content", async ({
		page,
	}) => {
		if (!ctx) {
			throw new Error("Server context not initialized");
		}

		// Use poem_creator_process which has actions defined
		const process = ctx.deps.processes.create({
			processId: "poem_creator_process",
			selectedTurnId: "poem_review",
			lifecycleStatus: "waiting",
			externalId: "SCROLL-TEST-002",
		});

		// Create turn records with long content
		for (let i = 0; i < 5; i++) {
			createAcceptedLlmTurn({
				id: `trn_lock_${process.id}_${i}`,
				instanceId: process.id,
				turnId: "draft_poem",
				turnType: "llm",
				status: "succeeded",
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: null,
				turnResultMarkdown:
					`## Poem Section ${i + 1}\n\n${"This is paragraph content that takes up space. ".repeat(50)}\n\n`.repeat(
						3,
					),
				errorSummary: null,
				startedAt: new Date(Date.now() - (5 - i) * 60000).toISOString(),
				endedAt: new Date(Date.now() - (5 - i) * 60000 + 30000).toISOString(),
			});
		}

		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-section="leaf-outcome-actions"]', { timeout: 10000 });

		const chronicleScroll = page.locator('[data-role="chronicle-scroll"]');

		// Verify the content is scrollable
		const canScroll = await chronicleScroll.evaluate((el) => {
			return el.scrollHeight > el.clientHeight;
		});
		expect(canScroll).toBe(true);

		// Try to scroll to a middle position using wheel scrolling only
		await wheelToTop(page, chronicleScroll, 50, "top");
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
