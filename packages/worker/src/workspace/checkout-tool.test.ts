import { FakeGitOps } from "@leitwerk-dev/test-support/fakes";
import { expect, it } from "vitest";
import { planRunRoot, prepareOnDemandRunRoot } from "./run-root.js";

it("defers clones until requested and preserves earlier checkouts on worker replacement", async () => {
	const git = new FakeGitOps(
		new Map([
			["https://git.test/one", { "AGENTS.md": "one instructions" }],
			["https://git.test/two", { "AGENTS.md": "two instructions" }],
		]),
	);
	const plan = planRunRoot(
		"/work/split",
		"instance",
		["one", "two"].map((key) => ({
			key,
			repoLocator: `https://git.test/${key}`,
			baseBranch: "main",
			workBranch: "main",
		})),
	);
	await prepareOnDemandRunRoot(plan, git);
	expect(git.operations.filter((operation) => operation.startsWith("clone:"))).toEqual([]);
	await prepareOnDemandRunRoot(plan, git, "one");
	await git.writeFile("/work/split/one", "retained.txt", "keep me");
	await prepareOnDemandRunRoot(plan, git);
	const result = await prepareOnDemandRunRoot(plan, git, "two");
	expect(git.operations.filter((operation) => operation.startsWith("clone:"))).toEqual([
		"clone:one",
		"clone:two",
	]);
	expect(await git.readFile("/work/split/one", "retained.txt")).toBe("keep me");
	expect(result.manifest.components.map((component) => component.key)).toEqual(["one", "two"]);
	await expect(prepareOnDemandRunRoot(plan, git, "unauthorized")).rejects.toThrow(
		"authorized scope",
	);
});
