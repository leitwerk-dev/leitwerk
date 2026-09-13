import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { conflictKey, sameSubscription, validateConflict } from "./index.js";

const evidence = {
	owner: "owner",
	repo: "repo",
	prNumber: 1,
	headBranch: "work",
	baseBranch: "main",
	headSha: "a".repeat(40),
	baseSha: "b".repeat(40),
	url: "https://example.test/pr/1",
};
test("validates captured evidence and preserves conflict deduplication keys", () => {
	expect(validateConflict(evidence, evidence)).toEqual(evidence);
	expect(conflictKey(evidence)).toBe(
		JSON.stringify(["owner", "repo", 1, evidence.headSha, evidence.baseSha]),
	);
	expect(() => validateConflict(evidence, evidence, conflictKey(evidence))).toThrow(/Stale/);
	expect(() => validateConflict({ ...evidence, headSha: "c".repeat(40) }, evidence)).toThrow();
	for (const value of [
		null,
		[],
		{ ...evidence, reason: "unknown" },
		{ ...evidence, baseSha: 3 },
		{ ...evidence, prNumber: 0 },
	])
		expect(() => validateConflict(value, evidence)).toThrow();
});
test("compares subscription identity, generation and resolved evidence after polling", () => {
	const captured = { id: "sub", instanceId: "process", generation: "1", resolved: evidence };
	expect(sameSubscription(captured, structuredClone(captured))).toBe(true);
	expect(sameSubscription(captured, { ...captured, generation: "2" })).toBe(false);
	expect(
		sameSubscription(captured, { ...captured, resolved: { ...evidence, headSha: "c".repeat(40) } }),
	).toBe(false);
});
test("root import loads neither Git execution nor repair prompts", () => {
	// Exercise the packaged import graph in a fresh process, rejecting forbidden loads.
	const script = `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
 if (/child_process|git-binary|\\/git\\.|\\/prompt\\./.test(specifier)) throw new Error('Unexpected execution dependency: ' + specifier);
 return next(specifier, context);
}});
const root = await import('@leitwerk-dev/repository-rebase');
if (root.prepareRebase || root.rebasePrompt || !root.validateConflict) throw new Error('Invalid evidence entrypoint');`;
	expect(() =>
		execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: new URL("..", import.meta.url),
			stdio: "pipe",
		}),
	).not.toThrow();
});
