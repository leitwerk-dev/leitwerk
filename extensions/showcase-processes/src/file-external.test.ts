import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type CoreServerSetupDeps,
	createFileExternalSourceProvider,
	type ExternalSourceArmingLike,
	type FileExternalInput,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { FILE_EXTERNAL_INSTRUCTION_KIND, fileExternal } from "./file-external.js";

const providerOptions = {
	id: "showcase-file-external",
	kind: FILE_EXTERNAL_INSTRUCTION_KIND,
	inputMode: "instruction" as const,
};

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

async function tempDirectory() {
	const dir = await mkdtemp(path.join(tmpdir(), "o2-file-external-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function arming(
	source: ExternalSourceArmingLike["source"],
	filePath: string,
	instanceId = "agt_a",
): ExternalSourceArmingLike {
	return {
		id: "poem_review:poem_review_file",
		instanceId,
		processId: "poem_creator_process",
		turnId: "poem_review",
		externalActionId: "poem_review_file",
		source,
		resolved: { ...(source.config as FileExternalInput), path: filePath },
	};
}

describe("file external source provider", () => {
	it("resolves instance-specific paths from source templates", () => {
		const source = fileExternal.instruction({
			path: "/tmp/poem-review-{instanceId}",
			pollInterval: "1s",
			consume: "delete",
		});

		expect(source.kind).toBe(FILE_EXTERNAL_INSTRUCTION_KIND);
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
		const dir = await tempDirectory();
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
			armings: [arming(source, pathA), arming(source, pathB, "agt_b")],
		});
		const provider = createFileExternalSourceProvider(deps, providerOptions);
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
	});

	it("honors per-arming poll intervals", async ({ onTestFinished }) => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		onTestFinished(() => clock.mockRestore());
		const dir = await tempDirectory();
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
			armings: [arming(source, triggerPath)],
		});
		const provider = createFileExternalSourceProvider(deps, providerOptions);

		await provider.poll();
		await provider.poll();
		expect(fires).toHaveLength(1);

		clock.mockReturnValue(1060);
		await provider.poll();
		expect(fires).toHaveLength(2);
	});
});

it("retains trigger files after rejected admission and consumes only after success", async () => {
	const dir = await tempDirectory();
	const filePath = path.join(dir, "trigger");
	const source = fileExternal.instruction({
		path: filePath,
		pollInterval: "1ms",
		consume: "delete",
	});
	const deps = createDeps({
		fires: [],
		armings: [arming(source, filePath)],
	});
	deps.externalSources.fire = async () => ({ ok: false, error: "admission rejected" });
	// A missing trigger is ignored.
	expect((await createFileExternalSourceProvider(deps, providerOptions).poll()).errors).toEqual([]);
	await writeFile(filePath, "Revise", "utf8");
	expect((await createFileExternalSourceProvider(deps, providerOptions).poll()).created).toEqual(
		[],
	);
	expect(await readFile(filePath, "utf8")).toBe("Revise");
	deps.externalSources.fire = async () => ({ ok: true });
	expect((await createFileExternalSourceProvider(deps, providerOptions).poll()).created).toEqual([
		"poem_review:poem_review_file",
	]);
	await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
