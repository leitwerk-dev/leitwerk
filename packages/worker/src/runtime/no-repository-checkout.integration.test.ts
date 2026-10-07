import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedWorkerProcess } from "@leitwerk-dev/extension-runtime";
import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import { automaticTurn } from "@leitwerk-dev/process-sdk";
import { StubPiTreeHandleFactory } from "@leitwerk-dev/test-support/worker-testing";
import type { WorkerStartPayload } from "@leitwerk-dev/worker-protocol";
import { expect, it, onTestFinished, vi } from "vitest";
import type { RunRootGitOps } from "../workspace/run-root.js";
import { nodeWorkerRuntimeScheduler } from "./adapters.js";
import { bootstrapWorkerRuntime } from "./bootstrap.js";

it.each([
	false,
	true,
])("keeps authorized projects and retained storage without repository preparation (resume=%s)", async (resume) => {
	const root = mkdtempSync(path.join(tmpdir(), "no-checkout-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const workspaceRoot = path.join(root, "workspace");
	mkdirSync(path.join(workspaceRoot, ".leitwerk"), { recursive: true });
	writeFileSync(path.join(workspaceRoot, ".leitwerk", "components.json"), "retained manifest");
	writeFileSync(path.join(root, "tree.jsonl"), "retained tree");
	const gitCalls = vi.fn(() => {
		throw new Error("Repository access must not occur");
	});
	const gitOps = Object.fromEntries(
		[
			"clone",
			"checkout",
			"createBranch",
			"branchExists",
			"getHeadSha",
			"readFile",
			"listFiles",
			"writeFile",
		].map((name) => [name, gitCalls]),
	) as unknown as RunRootGitOps;
	const credentials = vi.fn();
	gitOps.configureRepositoryCredentials = credentials;
	const resolved = {
		processId: "inspect",
		params: {},
		state: {},
		runtime: { repositoryCheckout: "none" },
		turns: new Map([
			[
				"read",
				{
					definition: automaticTurn({
						description: "Read",
						run: async () => ({ outcome: "done" }),
						outcomes: { done: { complete: true } },
					}),
				},
			],
		]),
	} as unknown as ResolvedWorkerProcess;
	const processSnapshot = createTestProcessInstance({
		id: "process",
		processId: "inspect",
		selectedTurnId: "read",
	});
	const payload = {
		bootstrap: { kind: "automatic" },
		processSnapshot,
		projectSnapshots: [
			{
				key: "repo",
				instanceId: "process",
				repoLocator: "https://forge.test/team/repo.git",
				baseBranch: "main",
				workBranch: "main",
				metadata: { inspection: { profile: "test", repositoryId: 7 } },
			},
		],
		workerLeaseId: "lease",
		turnStart: { id: "start", state: { kind: "starting", start: { kind: "automatic" } } },
		treePaths: { workspaceRoot, primaryTreeFile: path.join(root, "tree.jsonl") },
		resume,
	} as unknown as WorkerStartPayload;
	const result = await bootstrapWorkerRuntime({
		instanceId: "process",
		payload,
		gitOps,
		piFactory: new StubPiTreeHandleFactory(),
		scheduler: nodeWorkerRuntimeScheduler,
		resolveWorkerProcess: () => resolved,
	});
	expect(result.projectSnapshots).toHaveLength(1);
	expect(result.projectSnapshots[0].metadata).toMatchObject({ inspection: { repositoryId: 7 } });
	expect(gitCalls).not.toHaveBeenCalled();
	expect(credentials).toHaveBeenCalledWith([]);
	expect(existsSync(path.join(workspaceRoot, "repo"))).toBe(false);
	expect(readFileSync(path.join(workspaceRoot, ".leitwerk", "components.json"), "utf8")).toBe(
		"retained manifest",
	);
	expect(readFileSync(path.join(root, "tree.jsonl"), "utf8")).toBe("retained tree");
});
