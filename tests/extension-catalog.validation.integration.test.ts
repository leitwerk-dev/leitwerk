import exampleProcessesExtension from "@leitwerk-dev/example-processes";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	toProcessGraphView,
	validateProcessGraphEntryTurns,
	validateProcessGraphTurnTransitions,
	validateTurnDefinition,
} from "@leitwerk-dev/process-sdk";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { describe, expect, it } from "vitest";
import { getDefaultTestExtensionCatalog } from "./helpers/test-extension-catalog.js";

describe("default extension catalog validation", () => {
	it("validates every registered process turn graph", async () => {
		const catalog = await getDefaultTestExtensionCatalog();

		for (const [processId, processDef] of catalog.processes) {
			const graph = toProcessGraphView(processDef);
			const entryErrors = validateProcessGraphEntryTurns(graph);
			expect(entryErrors, `Process '${processId}' has invalid entryTurnIds`).toEqual([]);
			const transitionErrors = validateProcessGraphTurnTransitions(graph);
			expect(transitionErrors, `Process '${processId}' has invalid turnTransitions`).toEqual([]);
		}
	});

	it("loads poem and example processes independently and together", async () => {
		const showcase = await buildExtensionCatalogFromModules([showcaseProcessesExtension]);
		const examples = await buildExtensionCatalogFromModules([exampleProcessesExtension]);
		expect([...showcase.processes.keys()]).toEqual(["poem_creator_process"]);
		expect([...examples.processes.keys()].sort()).toEqual([
			"k8s_smoke_long_process",
			"k8s_smoke_process",
			"k8s_smoke_specialized_process",
			"single_prompt_external_complete_process",
			"single_prompt_process",
			"single_prompt_with_tool_process",
		]);
		const catalog = await getDefaultTestExtensionCatalog();

		expect(catalog.processes.has("single_prompt_process")).toBe(true);
		expect(catalog.processes.has("poem_creator_process")).toBe(true);
		expect(catalog.processes.get("single_prompt_process")?.turns.has("run_single_prompt")).toBe(
			true,
		);
	});

	it("validates every registered turn definition", async () => {
		const catalog = await getDefaultTestExtensionCatalog();

		for (const processDef of catalog.processes.values()) {
			for (const [turnId, binding] of processDef.turns) {
				const errors = validateTurnDefinition(turnId, binding.definition);
				expect(errors, `Turn '${processDef.id}:${turnId}' has validation errors`).toEqual([]);
			}
		}
	});

	it("resolves every turn-graph reference to a registered turn", async () => {
		const catalog = await getDefaultTestExtensionCatalog();

		for (const [processId, processDef] of catalog.processes) {
			const graph = toProcessGraphView(processDef);
			for (const turnId of graph.entryTurnIds) {
				expect(
					processDef.turns.has(turnId),
					`Process '${processId}' entry turn '${turnId}' is not declared`,
				).toBe(true);
			}

			for (const turnId of graph.turns.keys()) {
				expect(
					processDef.turns.has(turnId),
					`Process '${processId}' declared turn '${turnId}' is not registered`,
				).toBe(true);
			}

			for (const [turnId, turn] of graph.turns) {
				expect(
					processDef.turns.has(turnId),
					`Process '${processId}' transition source '${turnId}' is not registered`,
				).toBe(true);
				for (const transition of turn.transitions ?? []) {
					if (!transition.nextTurnId) {
						continue;
					}
					expect(
						processDef.turns.has(transition.nextTurnId),
						`Process '${processId}' transition from '${turnId}' references unregistered next turn '${transition.nextTurnId}'`,
					).toBe(true);
				}
			}
		}
	});
});
