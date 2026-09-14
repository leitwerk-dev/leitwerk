import type { CoreServerSetupDeps } from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import type { WoodpeckerIntegration } from "./capability.js";
import type { WoodpeckerClient } from "./client.js";
import { WOODPECKER_PIPELINE_KIND } from "./external.js";
import { createWoodpeckerProvider } from "./provider.js";

function fixture(
	pipelines: Array<{
		number: number;
		status: string;
		event: string;
		branch: string;
		commit: string;
	}>,
	resolved: Record<string, unknown> = {},
) {
	const fire = vi.fn(async () => ({ ok: true }));
	const deps = {
		polling: {
			create: <T>(options: { pollOnce(): Promise<T> }) => ({
				poll: options.pollOnce,
			}),
		},
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
	} as unknown as CoreServerSetupDeps;
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
				{
					number: 6,
					status: "success",
					event: "pull_request",
					branch: "main",
					commit: "other",
				},
				{
					number: 7,
					status: "success",
					event: "manual",
					branch: "feature/change",
					commit: "abc",
				},
				{
					number: 8,
					status: "failure",
					event: "pull_request",
					branch: "main",
					commit: "abc",
				},
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
		const { provider, fire } = fixture([
			{
				number: 8,
				status: "failure",
				event: "push",
				branch: "main",
				commit: "abc",
			},
		]);

		await provider.poll();

		expect(fire).not.toHaveBeenCalled();
	});

	it("waits indefinitely while the newest matching pipeline is running", async () => {
		const { provider, fire } = fixture([
			{
				number: 8,
				status: "failure",
				event: "push",
				branch: "feature/change",
				commit: "abc",
			},
			{
				number: 9,
				status: "running",
				event: "push",
				branch: "feature/change",
				commit: "abc",
			},
		]);

		await provider.poll();

		expect(fire).not.toHaveBeenCalled();
	});

	it("does not poll a CI source already satisfied for the current head", async () => {
		const { provider, fire } = fixture(
			[
				{
					number: 8,
					status: "success",
					event: "push",
					branch: "feature/change",
					commit: "abc",
				},
			],
			{ disabled: true },
		);

		await provider.poll();

		expect(fire).not.toHaveBeenCalled();
	});
});
