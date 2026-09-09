import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import { createLoadedExtensionModuleForTest } from "@leitwerk-dev/extension-runtime/testing";
import type { AppContext } from "@leitwerk-dev/server";
import singlePromptExtension from "@leitwerk-dev/showcase-processes";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.js";

const rendererModuleSource = `
const TAG = 'o2-browser-sidebar-reflow-outcome';
if (!customElements.get(TAG)) {
	customElements.define(TAG, class extends HTMLElement {
		connectedCallback() {
			const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
			const payload = this.payload ?? {};
			const title = typeof payload.title === 'string' ? payload.title : 'Result';
			const body = typeof payload.body === 'string' ? payload.body : '';
			root.innerHTML = \
				'<style>' +
				':host{display:block;width:100%;min-width:0;color:inherit;}' +
				'article{display:grid;gap:12px;min-width:0;}' +
				'h4{margin:0;font:600 1rem/1.3 system-ui,sans-serif;color:inherit;}' +
				'p{margin:0;font:400 14px/1.6 system-ui,sans-serif;white-space:normal;overflow-wrap:anywhere;color:inherit;}' +
				'</style>' +
				'<article data-renderer="sidebar-reflow"><h4></h4><p></p></article>';
			const heading = root.querySelector('h4');
			const paragraph = root.querySelector('p');
			if (heading) heading.textContent = title;
			if (paragraph) paragraph.textContent = body;
			this.dispatchEvent(new CustomEvent('o2-leaf-outcome-ready', { bubbles: true, composed: true }));
		}
	});
}
export {};
`;

let ctx: AppContext | null = null;

async function createSinglePromptUiFixture(dir: string): Promise<string> {
	await mkdir(path.join(dir, "dist/ui/assets"), { recursive: true });
	await writeFile(
		path.join(dir, "package.json"),
		JSON.stringify(
			{
				name: "@leitwerk-dev/showcase-processes",
				private: true,
				type: "module",
				leitwerk: {
					extension: {
						source: "./src/index.ts",
						import: "./src/index.ts",
					},
					ui: {
						source: "./dist/ui/manifest.json",
						import: "./dist/ui/manifest.json",
					},
				},
			},
			null,
			2,
		),
	);
	await writeFile(
		path.join(dir, "dist/ui/manifest.json"),
		JSON.stringify(
			{
				apiVersion: 1,
				extensionManifestId: "showcase-processes",
				renderers: {
					"@leitwerk-dev/showcase-processes:single_prompt_process.leaf_outcome": {
						kind: "custom_element",
						tagName: "o2-browser-sidebar-reflow-outcome",
						module: "./assets/sidebar-reflow.js",
						rendererApiVersion: 1,
					},
				},
			},
			null,
			2,
		),
	);
	await writeFile(path.join(dir, "dist/ui/assets/sidebar-reflow.js"), rendererModuleSource);
	return dir;
}

async function buildSinglePromptCatalogWithUiFixture(packageDir: string) {
	return buildExtensionCatalog([
		createLoadedExtensionModuleForTest(singlePromptExtension, {
			packageName: "@leitwerk-dev/showcase-processes",
			packageDir,
		}),
	]);
}

function buildLongBody(title: string, sentenceCount: number): string {
	return Array.from(
		{ length: sentenceCount },
		(_, index) =>
			`${title} sentence ${index + 1} keeps wrapping as the chronicle column widens and narrows during sidebar toggles.`,
	).join(" ");
}

type AcceptedLlmTurnFixtureInput = Parameters<AppContext["deps"]["turnRecords"]["create"]>[0] & {
	id: string;
	turnType: "llm";
};

function createAcceptedLlmTurn(input: AcceptedLlmTurnFixtureInput) {
	if (!ctx) throw new Error("Server context not initialized");
	const lease = ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: `wkr_fixture_${input.id}`,
		state: "exited",
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
	ctx.deps.leases.update(lease.id, {
		exitedAt: input.endedAt ?? input.startedAt ?? new Date().toISOString(),
	});
	return turnRecord;
}

function seedSidebarReflowProcess(label: string) {
	if (!ctx) {
		throw new Error("Server context not initialized");
	}

	const process = ctx.deps.processes.create({
		processId: "single_prompt_process",
		selectedTurnId: null,
		lifecycleStatus: "completed",
		externalId: label,
	});

	for (let index = 0; index < 4; index += 1) {
		const turnRecordId = `trn_sidebar_history_${process.id}_${index}`;
		const anchoredAt = new Date(Date.UTC(2026, 3, 18, 10, index, 0)).toISOString();
		createAcceptedLlmTurn({
			id: turnRecordId,
			instanceId: process.id,
			turnId: "run_single_prompt",
			turnType: "llm",
			status: "succeeded",
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
			turnResultMarkdown: `# Historic result ${index + 1}\n\n${buildLongBody(`Historic result ${index + 1}`, 10)}`,
			errorSummary: null,
			startedAt: anchoredAt,
			endedAt: anchoredAt,
		});
		ctx.deps.events.create({
			instanceId: process.id,
			eventType: "turn_outcome_recorded",
			data: {
				turnRecordId,
				turnId: "run_single_prompt",
				outcome: "completed",
				params: {},
			},
		});
	}

	const targetTurnRecordId = `trn_sidebar_leaf_${process.id}`;
	const targetLeafEntryId = `assistant-sidebar-leaf-${process.id}`;
	const targetAnchoredAt = new Date(Date.UTC(2026, 3, 18, 10, 30, 0)).toISOString();
	createAcceptedLlmTurn({
		id: targetTurnRecordId,
		instanceId: process.id,
		turnId: "run_single_prompt",
		turnType: "llm",
		status: "succeeded",
		pathType: "primary",
		forkPiEntryId: null,
		resultPiEntryId: targetLeafEntryId,
		turnResultMarkdown: `# Sidebar reflow target\n\n${buildLongBody("Target result", 12)}`,
		errorSummary: null,
		startedAt: targetAnchoredAt,
		endedAt: targetAnchoredAt,
	});
	ctx.deps.events.create({
		instanceId: process.id,
		eventType: "turn_outcome_recorded",
		data: {
			turnRecordId: targetTurnRecordId,
			turnId: "run_single_prompt",
			outcome: "completed",
			params: {},
		},
	});
	const snapshot = ctx.deps.leafOutcomeSnapshots.create({
		instanceId: process.id,
		leafEntryId: targetLeafEntryId,
		turnRecordId: targetTurnRecordId,
		rendererId: "@leitwerk-dev/showcase-processes:single_prompt_process.leaf_outcome",
		schemaVersion: 1,
		props: {
			title: "Sidebar reflow target",
			body: buildLongBody("Target result", 12),
		},
		fallbackMarkdown: `# Sidebar reflow target\n\n${buildLongBody("Target result", 12)}`,
		status: "ready",
		anchoredAt: targetAnchoredAt,
	});

	return {
		process,
		targetSnapshotId: snapshot.id,
		targetTurnRecordId,
	};
}

async function getBoxMetrics(locator: Locator) {
	return locator.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		return {
			width: Number(rect.width.toFixed(1)),
			height: Number(rect.height.toFixed(1)),
		};
	});
}

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-sidebar-reflow-browser-",
		createExtensionCatalog: async (_config, tempRoot) => {
			const packageDir = await createSinglePromptUiFixture(
				path.join(tempRoot, "showcase-processes"),
			);
			return buildSinglePromptCatalogWithUiFixture(packageDir);
		},
		useInProcessWorker: true,
	},
});

test.beforeAll(async ({ leitwerk }) => {
	ctx = leitwerk.ctx;
});

test.describe("sidebar result reflow", () => {
	test("ready leaf outcome cards resize when the sidebar collapses and expands", async ({
		page,
	}) => {
		const { process, targetSnapshotId, targetTurnRecordId } =
			seedSidebarReflowProcess("SIDEBAR-REFLOW-001");
		const leafOutcomeSection = page.locator(
			`[data-section="leaf-outcome"][data-snapshot-id="${targetSnapshotId}"]`,
		);
		const rendererHost = leafOutcomeSection.locator('[data-role="leaf-outcome-renderer-host"]');
		// Leaf outcomes are no longer standalone rail waypoints. The owning turn's
		// rail item is highlighted when the result scrolls into view.
		const parentRailItem = page.locator(
			`[data-rail-kind="turn"][data-turn-record-id="${targetTurnRecordId}"]`,
		);

		await page.goto(`/processes/${process.id}`);
		await page.waitForSelector('[data-page="process-detail"]');
		await expect(rendererHost).toHaveAttribute("data-renderer-state", "ready", {
			timeout: 10_000,
		});
		// Navigate away from initial bottom-following before measuring reflow.
		await parentRailItem.click();
		await leafOutcomeSection.scrollIntoViewIfNeeded();
		await expect(parentRailItem).toHaveAttribute("data-active", "true");
		await expect(leafOutcomeSection).toBeInViewport();

		const expandedMetrics = await getBoxMetrics(rendererHost);
		expect(expandedMetrics.height).toBeGreaterThan(140);

		await page.locator('[data-action="toggle-sidebar"]').first().click();
		await expect(page.locator('[data-sidebar-state="collapsed"]')).toBeVisible();
		await expect
			.poll(async () => (await getBoxMetrics(rendererHost)).width)
			.toBeGreaterThan(expandedMetrics.width + 120);
		const collapsedMetrics = await getBoxMetrics(rendererHost);
		expect(collapsedMetrics.height).toBeLessThan(expandedMetrics.height - 40);
		await expect(parentRailItem).toHaveAttribute("data-active", "true");
		await expect(leafOutcomeSection).toBeInViewport();

		await page.locator('[data-action="toggle-sidebar"]').first().click();
		await expect(page.locator('[data-sidebar-state="expanded"]')).toBeVisible();
		await expect
			.poll(async () => (await getBoxMetrics(rendererHost)).width)
			.toBeLessThan(collapsedMetrics.width - 120);
		const reexpandedMetrics = await getBoxMetrics(rendererHost);
		expect(Math.abs(reexpandedMetrics.height - expandedMetrics.height)).toBeLessThanOrEqual(30);
		await expect(parentRailItem).toHaveAttribute("data-active", "true");
		await expect(leafOutcomeSection).toBeInViewport();
	});
});
