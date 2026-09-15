import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import type { AppContext } from "@leitwerk-dev/server";
import singlePromptExtension from "@leitwerk-dev/showcase-processes";
import { createAcceptedLlmTurn as createFixtureAcceptedLlmTurn } from "../helpers/accepted-llm-turn.ts";
import { expect, test } from "./fixtures.js";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
	"base64",
);
let ctx: AppContext | null = null;
let storageRoot = "";

function createAcceptedLlmTurn(input: Parameters<typeof createFixtureAcceptedLlmTurn>[1]) {
	return createFixtureAcceptedLlmTurn(ctx, input, "browser-fixture-digest");
}

function seedRichResult() {
	if (!ctx) throw new Error("Server context not initialized");
	const process = ctx.deps.processes.create({
		processId: "single_prompt_process",
		selectedTurnId: null,
		lifecycleStatus: "completed",
		externalId: "RICH-MARKDOWN-001",
		closedAt: new Date().toISOString(),
	});
	const turnRecordId = `trn_rich_${process.id}`;
	const imageId = "img_fixture.png";
	const imageUrl = `/api/processes/${process.id}/turn-records/${turnRecordId}/result-images/${imageId}`;
	const markdown = [
		"## Rich rendering",
		"```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```",
		"```mermaid\nnot-a-diagram <broken>\n```",
		`![Managed fixture](${imageUrl})`,
	].join("\n\n");
	const anchoredAt = new Date().toISOString();
	createAcceptedLlmTurn({
		id: turnRecordId,
		instanceId: process.id,
		turnId: "run_single_prompt",
		turnType: "llm",
		status: "succeeded",
		pathType: "primary",
		forkPiEntryId: null,
		resultPiEntryId: null,
		turnResultMarkdown: markdown,
		errorSummary: null,
		startedAt: anchoredAt,
		endedAt: anchoredAt,
	});
	ctx.deps.events.create({
		instanceId: process.id,
		eventType: "turn_outcome_recorded",
		data: { turnRecordId, turnId: "run_single_prompt", outcome: "completed", params: {} },
	});
	return { process, turnRecordId, imageId, imageUrl };
}

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-rich-markdown-browser-",
		configure: (config, tempRoot) => {
			config.storage.tree_files_dir = path.join(tempRoot, "trees");
		},
		createExtensionCatalog: () => buildExtensionCatalogFromModules([singlePromptExtension]),
	},
});

test.beforeAll(async ({ leitwerk }) => {
	ctx = leitwerk.ctx;
	storageRoot = leitwerk.ctx.config.storage.tree_files_dir;
});

test("renders real Mermaid success and fallback, then links a managed image", async ({ page }) => {
	const { process, turnRecordId, imageId, imageUrl } = seedRichResult();
	const imageDir = path.join(storageRoot, "result-images", process.id, turnRecordId);
	await mkdir(imageDir, { recursive: true });
	await writeFile(path.join(imageDir, imageId), PNG);
	const imageResponsePromise = page.waitForResponse(
		(response) =>
			response.url().endsWith(imageUrl) && response.request().resourceType() === "image",
	);

	await page.goto(`/processes/${process.id}`);
	await page.waitForSelector('[data-page="process-detail"]');
	const turn = page.locator(
		`[data-section="chronicle-turn"][data-turn-record-id="${turnRecordId}"]`,
	);
	await expect(turn.getByRole("button", { name: "Show summary" })).toBeVisible();
	await expect(turn.locator("[data-mermaid-source]")).toHaveCount(2);
	const diagrams = turn.locator("[data-mermaid-source]");
	await expect(diagrams.nth(0).locator("svg")).toBeVisible({ timeout: 15_000 });
	await expect(diagrams.nth(1).getByRole("status")).toContainText("Diagram could not be rendered", {
		timeout: 15_000,
	});
	await expect(diagrams.nth(1).locator("pre")).toContainText("not-a-diagram <broken>");

	const imageHost = turn.locator("[data-result-image]");
	const image = imageHost.locator("img");
	await expect(image).toBeVisible();
	await expect
		.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
		.toBe(1);
	const imageResponse = await imageResponsePromise;
	expect(imageResponse.status()).toBe(200);
	expect(imageResponse.headers()["cache-control"]).toBe("private, no-store");

	await expect(imageHost.locator("a")).toHaveAttribute("href", imageUrl);
	await expect(imageHost.locator("a")).toHaveAttribute("target", "_blank");
});
