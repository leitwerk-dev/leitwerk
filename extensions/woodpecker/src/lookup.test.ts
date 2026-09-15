import { expect, it, vi } from "vitest";
import type { WoodpeckerClientLike } from "./capability.js";
import type { WoodpeckerPipeline } from "./client.js";
import { findLatestPipeline } from "./provider.js";

const config = { profile: "ci", owner: "team", repo: "repo", branch: "feature", headSha: "head" };
function fixture(count: number, matchingIndex = -1) {
	const pipelines: WoodpeckerPipeline[] = Array.from({ length: count }, (_, i) => ({
		id: count - i,
		number: count - i,
		status: "success",
		branch: "feature",
		event: "push",
		commit: i === matchingIndex ? "head" : "unrelated",
	}));
	const listPipelines = vi.fn(async (_id, _signal, { page, perPage }) =>
		pipelines.slice((page - 1) * perPage, page * perPage),
	);
	return { pipelines, listPipelines, client: { listPipelines } as unknown as WoodpeckerClientLike };
}
it("finds older matching pipelines and selects the newest match even while pending", async () => {
	const f = fixture(240, 150);
	expect((await findLatestPipeline(f.client, 1, config))?.number).toBe(90);
	expect(f.listPipelines).toHaveBeenCalledTimes(2);
	f.pipelines[149].commit = "head";
	f.pipelines[149].status = "running";
	expect((await findLatestPipeline(f.client, 1, config))?.status).toBe("running");
});
it("distinguishes exhausted history from an inconclusive lookup window", async () => {
	expect(await findLatestPipeline(fixture(230).client, 1, config)).toBeNull();
	const f = fixture(1200, 1100);
	await expect(findLatestPipeline(f.client, 1, config)).rejects.toThrow("1000 pipelines");
	expect(f.listPipelines).toHaveBeenCalledTimes(10);
	f.listPipelines.mockClear();
	expect(
		await findLatestPipeline(f.client, 1, { ...config, afterPipelineNumber: 1150 }),
	).toBeNull();
	expect(f.listPipelines).toHaveBeenCalledTimes(1);
});
