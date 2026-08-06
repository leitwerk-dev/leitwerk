import type { WsFrame } from "@leitwerk-dev/protocol";
import { describe, expect, it, vi } from "vitest";
import { createProjectMutationService } from "./project-mutation-service.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

describe("ProjectMutationService", () => {
	it("commits project changes before emitting project.updated", () => {
		const deps = createTestDeps();
		const frames: WsFrame[] = [];
		vi.spyOn(deps.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
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

		expect(deps.projects.getById(project.id)?.pipelineStatus).toBe("passed");
		expect(updated?.pipelineStatus).toBe("passed");
		expect(onProjectMutated).toHaveBeenCalledTimes(2);
		expect(onProjectMutated).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: project.id, pipelineStatus: "passed" }),
		);
		expect(frames.filter((frame) => frame.type === "project.updated")).toEqual([
			expect.objectContaining({
				type: "project.updated",
				instanceId: process.id,
				payload: expect.objectContaining({
					projectId: "app",
					project: expect.objectContaining({
						key: "app",
						pipelineStatus: null,
					}),
				}),
			}),
			expect.objectContaining({
				type: "project.updated",
				instanceId: process.id,
				payload: expect.objectContaining({
					projectId: "app",
					project: expect.objectContaining({
						key: "app",
						pipelineStatus: "passed",
					}),
				}),
			}),
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
