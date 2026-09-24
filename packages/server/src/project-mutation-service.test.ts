import type { WsFrame } from "@leitwerk-dev/protocol";
import { describe, expect, it, vi } from "vitest";
import { createProjectMutationService } from "./project-mutation-service.js";
import { createOwnedTestDeps as createTestDeps } from "./test-helpers/owned-test-deps.js";

describe("ProjectMutationService", () => {
	it("commits project changes before emitting project.updated", () => {
		const deps = createTestDeps();
		const frames: WsFrame[] = [];
		const observedProjects: unknown[] = [];
		vi.spyOn(deps.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
			if (frame.type === "project.updated")
				observedProjects.push(
					deps.projects.getByInstanceAndKey(frame.instanceId ?? "", frame.payload.projectId),
				);
		});
		const onProjectMutated = vi.fn();
		const service = createProjectMutationService({ ...deps, onProjectMutated });
		const process = deps.processes.create({ processId: "demo_process" });

		const project = service.create({
			instanceId: process.id,
			key: "app",
			repoLocator: "https://example.com/app.git",
			baseBranch: "main",
			workBranch: "feature/demo",
		});
		const updated = service.update(project.id, { pipelineStatus: "passed" });

		expect(updated?.pipelineStatus).toBe("passed");
		expect(observedProjects).toEqual([
			expect.objectContaining({ id: project.id, pipelineStatus: null }),
			expect.objectContaining({ id: project.id, pipelineStatus: "passed" }),
		]);
		expect(onProjectMutated).toHaveBeenCalledTimes(2);
		expect(onProjectMutated).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: project.id, pipelineStatus: "passed" }),
		);
		expect(frames).toMatchObject([
			{
				type: "project.updated",
				instanceId: process.id,
				payload: { projectId: "app", project: { pipelineStatus: null } },
			},
			{
				type: "project.updated",
				instanceId: process.id,
				payload: { projectId: "app", project: { pipelineStatus: "passed" } },
			},
		]);
	});

	it("does not emit when updating a missing project", () => {
		const deps = createTestDeps();
		const frames: WsFrame[] = [];
		vi.spyOn(deps.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});
		const service = createProjectMutationService(deps);

		expect(service.update("missing", { pipelineStatus: "failed" })).toBeNull();
		expect(frames).toEqual([]);
	});
});
