import exampleProcessesExtension from "@leitwerk-dev/example-processes";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { describe, expect, it } from "vitest";
import { getDefaultTestExtensionCatalog } from "./helpers/test-extension-catalog.js";

describe("default extension catalog validation", () => {
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
});
