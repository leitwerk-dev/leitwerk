import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import { createLoadedExtensionModuleForTest } from "@leitwerk-dev/extension-runtime/testing";
import singlePromptExtension from "@leitwerk-dev/showcase-processes";
import { afterEach, describe, expect, it } from "vitest";
import { createAcceptedLlmTurn } from "../helpers/accepted-llm-turn.ts";
import {
	type MountedUiHarness,
	setupMountedUiHarness,
	teardownMountedUiHarness,
	waitFor,
} from "../helpers/ui-harness.ts";

const tempDirs: string[] = [];

async function createSinglePromptUiFixture(options: {
	tagName: string;
	moduleBasename: string;
	moduleSource: string;
}): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "o2-showcase-processes-ui-"));
	tempDirs.push(dir);
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
						tagName: options.tagName,
						module: `./assets/${options.moduleBasename}.js`,
						rendererApiVersion: 1,
					},
				},
			},
			null,
			2,
		),
	);
	await writeFile(
		path.join(dir, `dist/ui/assets/${options.moduleBasename}.js`),
		options.moduleSource,
	);
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

function seedSinglePromptProcess(
	testApp: NonNullable<MountedUiHarness<Record<string, never>>["testApp"]>,
	instanceIdRef: { value: string },
	snapshots: Array<{
		turnRecordId: string;
		leafEntryId: string;
		anchoredAt: string;
		rendererId: string | null;
		props: Record<string, unknown> | null;
		fallbackMarkdown: string | null;
	}>,
) {
	const process = testApp.ctx.deps.processes.create({
		processId: "single_prompt_process",
		selectedTurnId: null,
		lifecycleStatus: "completed",
		externalId: "CHRON-P4",
	});
	instanceIdRef.value = process.id;

	for (const snapshot of snapshots) {
		createAcceptedLlmTurn(testApp.ctx, {
			id: snapshot.turnRecordId,
			instanceId: process.id,
			turnId: "run_single_prompt",
			turnType: "llm",
			status: "succeeded",
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: snapshot.leafEntryId,
			turnResultMarkdown: snapshot.fallbackMarkdown,
			errorSummary: null,
			startedAt: snapshot.anchoredAt,
			endedAt: snapshot.anchoredAt,
		});
		testApp.ctx.deps.events.create({
			instanceId: process.id,
			eventType: "turn_outcome_recorded",
			data: {
				turnRecordId: snapshot.turnRecordId,
				turnId: "run_single_prompt",
				outcome: "completed",
				params: {},
			},
		});
		testApp.ctx.deps.leafOutcomeSnapshots.create({
			instanceId: process.id,
			leafEntryId: snapshot.leafEntryId,
			turnRecordId: snapshot.turnRecordId,
			rendererId: snapshot.rendererId,
			schemaVersion: 1,
			props: snapshot.props,
			fallbackMarkdown: snapshot.fallbackMarkdown,
			status: "ready",
			anchoredAt: snapshot.anchoredAt,
		});
	}
}

const successModuleSource = `
const TAG = 'o2-test-runtime-leaf-outcome';
if (!customElements.get(TAG)) {
	customElements.define(TAG, class extends HTMLElement {
		connectedCallback() {
			const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
			const payload = this.payload ?? {};
			const markdown = typeof payload.markdown === 'string' ? payload.markdown : '';
			const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
			root.innerHTML =
				'<section data-renderer="runtime-success"><p>' +
				prompt +
				'</p><div>' +
				this.runtime.markdown.render(markdown) +
				'</div></section>';
			this.dispatchEvent(new CustomEvent('o2-leaf-outcome-ready', { bubbles: true, composed: true }));
		}
	});
}
export {};
`;

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("chronicle step 4 runtime outcome renderers", () => {
	it("loads runtime custom elements for ready leaf outcomes", async () => {
		let harness: MountedUiHarness<Record<string, never>> | null = null;
		const packageDir = await createSinglePromptUiFixture({
			tagName: "o2-test-runtime-leaf-outcome",
			moduleBasename: "runtime-success",
			moduleSource: successModuleSource,
		});
		const extensionCatalog = await buildSinglePromptCatalogWithUiFixture(packageDir);

		try {
			const instanceId = { value: "" };
			harness = await setupMountedUiHarness({
				extensionCatalog,
				route: () => `/processes/${instanceId.value}`,
				async prepare(testApp) {
					seedSinglePromptProcess(testApp, instanceId, [
						{
							turnRecordId: "trn_render_1",
							leafEntryId: "assistant-render-1",
							anchoredAt: "2026-04-18T12:00:00.000Z",
							rendererId: "@leitwerk-dev/showcase-processes:single_prompt_process.leaf_outcome",
							props: {
								prompt: "Runtime render one",
								markdown: "## Runtime one\n\nFirst rendered outcome",
							},
							fallbackMarkdown: "## Runtime one\n\nFirst rendered outcome",
						},
						{
							turnRecordId: "trn_render_2",
							leafEntryId: "assistant-render-2",
							anchoredAt: "2026-04-18T12:02:00.000Z",
							rendererId: "@leitwerk-dev/showcase-processes:single_prompt_process.leaf_outcome",
							props: {
								prompt: "Runtime render two",
								markdown: "## Runtime two\n\nSecond rendered outcome",
							},
							fallbackMarkdown: "## Runtime two\n\nSecond rendered outcome",
						},
					]);
				},
			});

			await waitFor(() =>
				expect(
					document.querySelectorAll(
						'[data-role="leaf-outcome-renderer-host"][data-renderer-state="ready"]',
					).length,
				).toBe(2),
			);
			const renderedElements = document.querySelectorAll("o2-test-runtime-leaf-outcome");
			expect(renderedElements).toHaveLength(2);
			const firstRenderer = renderedElements[0] as HTMLElement & { shadowRoot: ShadowRoot | null };
			const secondRenderer = renderedElements[1] as HTMLElement & { shadowRoot: ShadowRoot | null };
			await waitFor(() =>
				expect(firstRenderer.shadowRoot?.textContent ?? "").toContain("Runtime render one"),
			);
			await waitFor(() =>
				expect(secondRenderer.shadowRoot?.textContent ?? "").toContain("Second rendered outcome"),
			);
			expect(document.querySelector("[data-warning-code]")).toBeNull();
		} finally {
			await teardownMountedUiHarness(harness);
		}
	});
});
