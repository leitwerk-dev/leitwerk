import type { CoreServerSetupDeps } from "@leitwerk-dev/process-sdk";
import { createTestServerSetupCapability } from "@leitwerk-dev/test-support";
import { describe, expect, it, vi } from "vitest";
import type { WoodpeckerIntegration } from "./capability.js";
import type { WoodpeckerClient, WoodpeckerPipeline } from "./client.js";
import { WOODPECKER_PIPELINE_KIND } from "./external.js";
import { createWoodpeckerProvider } from "./provider.js";

type Pipeline = Pick<WoodpeckerPipeline, "number" | "status" | "event" | "branch" | "commit">;
function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
	return {
		number: 8,
		status: "failure",
		event: "push",
		branch: "feature/change",
		commit: "abc",
		...overrides,
	};
}

function fixture(pipelines: Pipeline[], resolved: Record<string, unknown> = {}) {
	const fire = vi.fn(async () => ({ ok: true }));
	const deps = createTestServerSetupCapability({
		externalSources: {
			listArmed: (kind: string) =>
				kind === WOODPECKER_PIPELINE_KIND
					? [
							{
								id: "pipeline-arm",
								instanceId: "process-1",
								resolved: {
									profile: "primary",
									owner: "team",
									repo: "repo",
									branch: "feature/change",
									headSha: "abc",
									pollInterval: "1s",
									...resolved,
								},
							},
						]
					: [],
			fire,
		},
	} as unknown as Partial<CoreServerSetupDeps>);
	const client = {
		lookupRepository: vi.fn(async () => ({ id: 9, full_name: "team/repo" })),
		listPipelines: vi.fn(async () => pipelines),
	} as unknown as WoodpeckerClient;
	const integration = { client: () => client } satisfies WoodpeckerIntegration;
	return { provider: createWoodpeckerProvider(deps, integration), fire };
}

describe("createWoodpeckerProvider", () => {
	it("fires for a pull-request pipeline whose reported branch is the target branch", async () => {
		const { provider, fire } = fixture(
			[
				pipeline({
					number: 6,
					status: "success",
					event: "pull_request",
					branch: "main",
					commit: "other",
				}),
				pipeline({ number: 7, status: "success", event: "manual" }),
				pipeline({ event: "pull_request", branch: "main" }),
			],
			{ afterPipelineNumber: 7 },
		);

		const result = await provider.poll();

		expect(result.errors).toEqual([]);
		expect(fire).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({
					repositoryId: 9,
					pipeline: expect.objectContaining({ number: 8 }),
				}),
				mergeKey: "8:failure",
			}),
		);
	});

	it("still requires the configured branch for push pipelines", async () => {
		const { provider, fire } = fixture([pipeline({ event: "push", branch: "main" })]);

		await provider.poll();

		expect(fire).not.toHaveBeenCalled();
	});

	it("waits while the newest matching pipeline is running", async () => {
		const { provider, fire } = fixture([pipeline(), pipeline({ number: 9, status: "running" })]);

		await provider.poll();

		expect(fire).not.toHaveBeenCalled();
	});

	it("does not fire a disabled CI source", async () => {
		const { provider, fire } = fixture([pipeline({ status: "success" })], { disabled: true });

		await provider.poll();

		expect(fire).not.toHaveBeenCalled();
	});
});
