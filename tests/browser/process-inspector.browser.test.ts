import type { ExecutionInspectionCapture, ProcessTurnRecord } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import type { AppContext } from "@leitwerk-dev/server";
import { writeProcessSessionSnapshot } from "@leitwerk-dev/server/testing";
import showcase from "@leitwerk-dev/showcase-processes";
import { createAcceptedLlmTurn } from "../helpers/accepted-llm-turn.ts";
import { expect, expectNoPageOverflow, test } from "./fixtures.js";

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-inspector-browser-",
		createExtensionCatalog: () => buildExtensionCatalogFromModules([showcase]),
	},
});

async function investigation(ctx: AppContext) {
	const process = ctx.deps.processes.create({
		processId: "single_prompt_process",
		title: "Recorded context investigation",
		lifecycleStatus: "completed",
		selectedTurnId: null,
	});
	const entries: unknown[] = [
		{
			type: "session",
			version: 3,
			id: `session-${process.id}`,
			timestamp: "2026-09-01T10:00:00Z",
			cwd: "/tmp/synthetic",
		},
	];
	const records: ProcessTurnRecord[] = [];
	const append = (
		record: ProcessTurnRecord,
		id: string,
		fact: ExecutionInspectionCapture["fact"],
	) =>
		ctx.deps.executionInspections.append({
			id: `${record.id}:${id}`,
			version: 1,
			instanceId: process.id,
			turnRecordId: record.id,
			startRecordId: record.turnStartRecordId ?? "missing",
			workerLeaseId: record.acceptedWorkerLeaseId ?? "missing",
			timestamp: record.startedAt,
			fact,
		});
	for (const [index, name] of ["ancestor", "source", "child"].entries()) {
		const parent = index ? `${records[index - 1].id}-middle` : null;
		const id = `${process.id}-${name}`;
		const record = createAcceptedLlmTurn(ctx, {
			id,
			instanceId: process.id,
			turnId: "run_single_prompt",
			turnType: "llm",
			status: "succeeded",
			pathType: index ? "leaf_branch" : "primary",
			forkPiEntryId: parent,
			resultPiEntryId: `${id}-result`,
			turnResultMarkdown: `${name} result`,
			startedAt: `2026-09-01T10:0${index}:00Z`,
			endedAt: `2026-09-01T10:0${index}:30Z`,
		});
		records.push(record);
		append(record, "supplied", {
			kind: "supplied_context",
			origin: {
				contextMode: index ? "full" : "fresh",
				pathType: index ? "leaf_branch" : "primary",
				startTarget: parent ? { kind: "entry", entryId: parent } : { kind: "root" },
				forkPiEntryId: parent,
			},
			products: [],
		});
		entries.push({
			type: "custom_message",
			id: `${id}-prompt`,
			parentId: parent,
			timestamp: record.startedAt,
			customType: "leitwerk",
			content: `Recorded ${name} input`,
			display: false,
			details: { kind: "turn_prompt", startRecordId: record.turnStartRecordId },
		});
		entries.push({
			type: "message",
			id: `${id}-middle`,
			parentId: `${id}-prompt`,
			timestamp: `2026-09-01T10:0${index}:10Z`,
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `Reasoning inside ${name}.` },
					{ type: "text", text: `Intermediate ${name} boundary` },
				],
			},
		});
		entries.push({
			type: "message",
			id: `${id}-result`,
			parentId: `${id}-middle`,
			timestamp: record.endedAt,
			message: {
				role: "assistant",
				content: [
					{
						type: "text",
						text: `Later ${name} activity.\n\n${"A retained paragraph of execution evidence.\n\n".repeat(35)}`,
					},
				],
			},
		});
		append(record, "middle", {
			kind: "entry_link",
			entryId: `${id}-middle`,
			role: "assistant",
			piTurnId: `pi-${name}`,
		});
		append(record, "input", {
			kind: "model_input",
			boundaryEntryId: `${id}-prompt`,
			model: { id: "recorded-model", provider: "synthetic", thinkingLevel: "off" },
			systemPrompt: { state: "redacted", value: "Recorded system prompt [REDACTED]" },
			appendedInstructions: { state: "recorded", value: ["Keep the recorded instruction."] },
			contextFiles: { state: "recorded", value: [] },
			tools: { state: "recorded", value: [] },
			messages: [
				{
					role: "user",
					entryId: `${id}-prompt`,
					content: { state: "recorded", value: `Recorded ${name} input` },
				},
			],
		});
	}
	const human = ctx.deps.turnRecords.create({
		instanceId: process.id,
		turnId: "operator_decision",
		turnType: "human",
		status: "succeeded",
		startedAt: "2026-09-01T10:04:00Z",
		endedAt: "2026-09-01T10:04:01Z",
	});
	await writeProcessSessionSnapshot(ctx, process.id, entries);
	return { process, records, human };
}

for (const width of [1280, 390])
	test(`investigates exact ancestry, history and recorded configuration at ${width}px`, async ({
		page,
		leitwerk,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		const {
			process,
			records: [ancestor, source, child],
			human,
		} = await investigation(leitwerk.ctx);
		const base = `/processes/${process.id}`;
		await page.goto(`${base}?inspect=execution&turnRecordId=${child.id}&section=context`);
		const inspector = page.locator('[data-section="process-inspector"]');
		const scroll = page.locator('[data-role="inspector-scroll"]');
		await expect(inspector.getByRole("heading", { level: 1 })).toContainText("Attempt 1");
		await expect(
			page.getByRole("region", { name: "Process timeline", exact: true }),
		).not.toBeVisible();
		await expect(inspector.getByText("Inherited conversation", { exact: true })).toBeVisible();
		await inspector.getByRole("button", { name: "Open exact source boundary" }).click();
		await expect(page).toHaveURL(
			new RegExp(`turnRecordId=${source.id}.*entryId=${source.id}-middle.*boundaryFor=${child.id}`),
		);
		await expect(inspector.locator("[data-inspection-boundary]")).toBeVisible();
		await expect(inspector).toContainText("Later source activity.");
		await inspector.getByRole("button", { name: "Link to Assistant", exact: true }).last().click();
		await expect(page).toHaveURL(new RegExp(`itemId=entry%3A${source.id}-result`));
		expect(new URL(page.url()).searchParams.has("boundaryFor")).toBe(false);
		await expect(
			inspector.locator(`[data-inspection-item="entry:${source.id}-result"]`),
		).toBeInViewport();

		await inspector.getByRole("button", { name: "Open source boundary", exact: true }).click();
		await expect(page).toHaveURL(
			new RegExp(`turnRecordId=${ancestor.id}.*entryId=${ancestor.id}-middle`),
		);
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`turnRecordId=${source.id}`));
		await page.goForward();
		await expect(page).toHaveURL(new RegExp(`turnRecordId=${ancestor.id}`));
		await inspector.getByRole("button", { name: "Back", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`turnRecordId=${source.id}`));
		await inspector.getByRole("link", { name: "Configuration", exact: true }).click();
		await expect(inspector).toContainText("Recorded system prompt [REDACTED]");
		await expect(inspector).toContainText("Sensitive values were redacted");
		await inspector.getByText("Appended instructions", { exact: true }).click();
		await expect(
			inspector.getByRole("button", { name: "Copy Appended instructions" }),
		).toBeVisible();
		await inspector.getByRole("link", { name: "Context", exact: true }).click();
		await expect(inspector.getByRole("button", { name: "Copy input message" })).toBeVisible();
		await inspector.getByRole("button", { name: "View in context map" }).click();
		await expect(page).toHaveURL(new RegExp(`section=context-map&turnRecordId=${source.id}`));
		await expect(inspector.locator('.tree-node[aria-pressed="true"]')).toBeInViewport();
		await inspector.getByRole("button", { name: "List", exact: true }).click();
		await expect(inspector.locator(".context-list li.selected")).toContainText("Run Prompt");
		await expectNoPageOverflow(page);
		expect(await scroll.evaluate((element) => element.clientHeight)).toBeGreaterThan(100);
		expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
			901,
		);
		await page.goto(`${base}?inspect=execution&turnRecordId=${human.id}&section=configuration`);
		await expect(scroll).toContainText("This human execution does not invoke a model");
		await expect(scroll).not.toContainText("Recorded model selection");
		await inspector.getByRole("button", { name: "Previous execution" }).click();
		await expect(page).toHaveURL(new RegExp(`turnRecordId=${child.id}`));
		await inspector.getByRole("button", { name: "Show in chronicle" }).click();
		await expect(page).toHaveURL(new RegExp(`${process.id}$`));
		await expect(page.getByRole("region", { name: "Process timeline", exact: true })).toBeVisible();
		const chronicle = page.locator('[data-role="chronicle-scroll"]');
		const returnTop = await chronicle.evaluate((element) => element.scrollTop);
		await page.keyboard.press("i");
		await expect(inspector).toBeVisible();
		await inspector.getByRole("button", { name: "Show in chronicle", exact: true }).click();
		await expect
			.poll(async () =>
				Math.abs((await chronicle.evaluate((element) => element.scrollTop)) - returnTop),
			)
			.toBeLessThan(2);

		await expectNoPageOverflow(page);
	});

for (const width of [1280, 390]) {
	test(`keeps a long context map navigable without page scrolling at ${width}px`, async ({
		page,
		leitwerk,
	}) => {
		await page.setViewportSize({ width, height: 844 });
		const process = leitwerk.ctx.deps.processes.create({
			processId: "single_prompt_process",
			title: "Many independent executions",
			lifecycleStatus: "completed",
			selectedTurnId: null,
			externalId: "tracker:demo/project#42",
			externalUrl: "https://issues.example.test/demo/42",
		});
		const records = Array.from({ length: 30 }, (_, index) =>
			leitwerk.ctx.deps.turnRecords.create({
				instanceId: process.id,
				turnId: "delivery",
				turnType: "human",
				status: "succeeded",
				startedAt: new Date(Date.UTC(2026, 8, 1, 10, index)).toISOString(),
				endedAt: new Date(Date.UTC(2026, 8, 1, 10, index, 1)).toISOString(),
			}),
		);
		const selected = records[records.length - 1];
		const base = `/processes/${process.id}`;
		await page.goto(`${base}?inspect=process&section=overview`);
		const inspector = page.locator('[data-section="process-inspector"]');
		const source = inspector.getByRole("link", { name: /tracker:demo\/project#42/ });
		await expect(source).toHaveAttribute("href", "https://issues.example.test/demo/42");
		await expect(source).toHaveAttribute("target", "_blank");
		await expect(inspector.getByRole("link", { name: /Open source/ })).toHaveCount(0);
		await page.goto(`${base}?inspect=process&section=context-map&turnRecordId=${selected.id}`);
		const node = inspector.locator('.tree-node[aria-pressed="true"]');
		await expect(node).toBeInViewport();
		await expect(inspector.locator(".context-list")).toHaveCount(0);
		const pane = page.locator('[data-role="inspector-scroll"]');
		await expect
			.poll(() => pane.evaluate((element) => element.scrollHeight - element.clientHeight))
			.toBeLessThanOrEqual(2);
		await inspector.getByRole("button", { name: "Fit map", exact: true }).click();
		await expect
			.poll(async () => Number.parseInt(await inspector.getByLabel("Map zoom").innerText(), 10))
			.toBeLessThan(100);
		const map = inspector.getByRole("region", { name: "Conversation map", exact: true });
		await expect
			.poll(() => map.evaluate((element) => element.scrollHeight - element.clientHeight))
			.toBeLessThanOrEqual(2);
		await inspector.getByRole("button", { name: "Zoom in", exact: true }).click();
		await inspector.getByRole("button", { name: "Show selected", exact: true }).click();
		await expect(inspector.getByLabel("Map zoom")).toHaveText("100%");
		await expect(node).toBeInViewport();
		await inspector.getByRole("button", { name: "List", exact: true }).click();
		const selectedItem = inspector.locator(".context-list li.selected");
		await expect(selectedItem).toBeInViewport();
		await expect(map).toHaveCount(0);
		await expectNoPageOverflow(page);
		await selectedItem.getByRole("button").focus();
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(
			(url) =>
				url.searchParams.get("inspect") === "execution" &&
				url.searchParams.get("turnRecordId") === selected.id,
		);
	});
}

test("keeps the shell usable for invalid, absent and failed evidence, and ignores an old selection", async ({
	page,
	leitwerk,
}) => {
	const {
		process,
		records: [first, second],
	} = await investigation(leitwerk.ctx);
	const base = `/processes/${process.id}`;
	await page.goto(`${base}?inspect=execution`);
	await expect(page.getByRole("button", { name: "Show in chronicle" })).toBeEnabled();
	await page.goto(`${base}?inspect=execution&turnRecordId=missing&section=trace`);
	await expect(page.locator('[data-section="inspection-load-error"]')).toBeVisible();
	const { promise, resolve } = Promise.withResolvers<void>();
	await page.route(`**/turn-records/${first.id}/inspection?section=trace*`, async (route) => {
		const response = await route.fetch();
		await promise;
		await route.fulfill({ response });
	});
	await page.goto(`${base}?inspect=execution&turnRecordId=${first.id}&section=trace`);
	await expect(page.getByText("Loading trace…", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Next execution" }).click();
	await expect(page.locator('[data-role="inspector-scroll"]')).toContainText(
		"Recorded source input",
	);
	resolve();
	await expect(page).toHaveURL(new RegExp(`turnRecordId=${second.id}`));
	await expect(page.locator('[data-role="inspector-scroll"]')).not.toContainText(
		"Recorded ancestor input",
	);
});
