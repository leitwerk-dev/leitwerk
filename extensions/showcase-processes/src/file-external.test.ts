import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreServerSetupDeps, ExternalSourceArmingLike } from "@leitwerk-dev/process-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFileExternalSourceProvider,
	FILE_EXTERNAL_INSTRUCTION_KIND,
	fileExternal,
} from "./file-external.js";

function createDeps(input: { armings: ExternalSourceArmingLike[]; fires: unknown[] }) {
	return {
		polling: {
			create: <T>(options: { pollOnce(): Promise<T> }) => ({ poll: options.pollOnce }),
		},
		externalSources: {
			listArmed(kind: string) {
				return input.armings.filter((arming) => arming.source.kind === kind);
			},
			async fire(fireInput: Parameters<CoreServerSetupDeps["externalSources"]["fire"]>[0]) {
				input.fires.push(fireInput);
				return { ok: true, process: null } as const;
			},
		},
	} as CoreServerSetupDeps;
}

describe("file external source provider", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves instance-specific paths from source templates", () => {
		const source = fileExternal.instruction({
			path: "/tmp/poem-review-{instanceId}",
			pollInterval: "1s",
			consume: "delete",
		});

		expect(
			source.resolve?.({
				process: { id: "agt_a" } as never,
				projects: [],
				params: {},
				state: {},
			}),
		).toMatchObject({ path: "/tmp/poem-review-agt_a", pollInterval: "1s" });
		expect(
			source.resolve?.({
				process: { id: "agt_b" } as never,
				projects: [],
				params: {},
				state: {},
			}),
		).toMatchObject({ path: "/tmp/poem-review-agt_b", pollInterval: "1s" });
	});

	it("fires only the instance whose resolved file is written and includes top-level diagnostics", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "o2-file-external-"));
		try {
			const pathA = path.join(dir, "a");
			const pathB = path.join(dir, "b");
			const source = fileExternal.instruction({
				path: "/tmp/ignored-{instanceId}",
				pollInterval: "50ms",
				consume: "keep",
			});
			const fires: unknown[] = [];
			const deps = createDeps({
				fires,
				armings: [
					{
						id: "poem_review:poem_review_file",
						instanceId: "agt_a",
						processId: "poem_creator_process",
						turnId: "poem_review",
						externalActionId: "poem_review_file",
						source,
						resolved: { path: pathA, pollInterval: "50ms", consume: "keep" },
					},
					{
						id: "poem_review:poem_review_file",
						instanceId: "agt_b",
						processId: "poem_creator_process",
						turnId: "poem_review",
						externalActionId: "poem_review_file",
						source,
						resolved: { path: pathB, pollInterval: "50ms", consume: "keep" },
					},
				],
			});
			const provider = createFileExternalSourceProvider(deps);
			await writeFile(pathB, "Revise B", "utf8");

			await provider.poll();

			expect(fires).toEqual([
				expect.objectContaining({
					instanceId: "agt_b",
					armingId: "poem_review:poem_review_file",
					input: { instruction: "Revise B" },
					event: { path: pathB, pollInterval: "50ms" },
					mergeKey: pathB,
				}),
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("honors per-arming poll intervals", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "o2-file-external-interval-"));
		try {
			const triggerPath = path.join(dir, "trigger");
			await writeFile(triggerPath, "Revise", "utf8");
			const source = fileExternal.instruction({
				path: triggerPath,
				pollInterval: "50ms",
				consume: "keep",
			});
			const fires: unknown[] = [];
			const deps = createDeps({
				fires,
				armings: [
					{
						id: "poem_review:poem_review_file",
						instanceId: "agt_a",
						processId: "poem_creator_process",
						turnId: "poem_review",
						externalActionId: "poem_review_file",
						source,
						resolved: { path: triggerPath, pollInterval: "50ms", consume: "keep" },
					},
				],
			});
			const provider = createFileExternalSourceProvider(deps);

			await provider.poll();
			await provider.poll();
			expect(fires).toHaveLength(1);

			await new Promise((resolve) => setTimeout(resolve, 60));
			await provider.poll();
			expect(fires).toHaveLength(2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("uses the instruction source kind for armings", () => {
		expect(
			fileExternal.instruction({ path: "/tmp/x", pollInterval: "1s", consume: "delete" }).kind,
		).toBe(FILE_EXTERNAL_INSTRUCTION_KIND);
	});
});
