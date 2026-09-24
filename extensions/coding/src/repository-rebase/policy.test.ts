import { describe, expect, it } from "vitest";
import type { ConflictEvidence } from "./index.js";
import {
	type RebaseRecord,
	rebasePublicationDecision,
	requireRebaseHead,
	requireRebaseOrigin,
	requireRebaseTarget,
	requireRebaseWorktree,
} from "./policy.js";

const conflict: ConflictEvidence = {
	owner: "team",
	repo: "service",
	prNumber: 7,
	headBranch: "work",
	baseBranch: "main",
	headSha: "original-head",
	baseSha: "original-base",
	url: "https://git.test/team/service/pulls/7",
};
const record: RebaseRecord = {
	key: "retained-evidence",
	branch: "work",
	originalHead: "original-head",
	baseSha: "fetched-base",
	status: "prepared",
	originUrl: "/repos/service.git",
	originPushUrl: "/repos/service-write.git",
	baseBranch: "main",
};

describe("rebase preparation policy", () => {
	it("accepts matching evidence and observed heads on a clean tracked checkout", () => {
		expect(() => {
			requireRebaseTarget("work", conflict, record);
			requireRebaseOrigin(record, {
				originUrl: "/repos/service.git",
				originPushUrl: "/repos/service-write.git",
			});
			requireRebaseWorktree("work", { branch: "work", dirty: false });
			requireRebaseHead("original-head", "original-head", "original-head");
		}).not.toThrow();
	});

	it.each([
		{
			condition: "different evidence head branch",
			evidence: { ...conflict, headBranch: "other" },
			retained: record,
		},
		{
			condition: "base equals work branch",
			evidence: { ...conflict, baseBranch: "work" },
			retained: record,
		},
		{
			condition: "changed prepared base branch",
			evidence: { ...conflict, baseBranch: "release" },
			retained: record,
		},
		{
			condition: "different retained branch",
			evidence: conflict,
			retained: { ...record, branch: "other" },
		},
		{
			condition: "different retained original head",
			evidence: conflict,
			retained: { ...record, originalHead: "other-head" },
		},
	])("rejects $condition", ({ evidence, retained }) => {
		expect(() => requireRebaseTarget("work", evidence, retained)).toThrow();
	});

	it.each([
		{
			condition: "fetch endpoint changed",
			originUrl: "/repos/other.git",
			originPushUrl: "/repos/service-write.git",
		},
		{
			condition: "push endpoint changed",
			originUrl: "/repos/service.git",
			originPushUrl: "/repos/other.git",
		},
	])("rejects preparation reuse when $condition", ({ originUrl, originPushUrl }) => {
		expect(() => requireRebaseOrigin(record, { originUrl, originPushUrl })).toThrow();
	});

	it("accepts legacy preparation without optional identity fields", () => {
		const legacy: RebaseRecord = {
			key: "retained-evidence",
			branch: "work",
			originalHead: "original-head",
			baseSha: "fetched-base",
			status: "rebasing",
		};
		expect(() => {
			requireRebaseTarget("work", conflict, legacy);
			requireRebaseOrigin(legacy, {});
		}).not.toThrow();
	});

	it.each([
		{ condition: "wrong checkout", branch: "main", dirty: false },
		{ condition: "dirty checkout", branch: "work", dirty: true },
	])("rejects a $condition", ({ branch, dirty }) => {
		expect(() => requireRebaseWorktree("work", { branch, dirty })).toThrow();
	});

	it.each([
		{ condition: "local head moved", local: "new-head", remote: "original-head" },
		{ condition: "remote head moved", local: "original-head", remote: "new-head" },
		{ condition: "both heads moved together", local: "new-head", remote: "new-head" },
	])("rejects stale evidence when $condition", ({ local, remote }) => {
		expect(() => requireRebaseHead("original-head", local, remote)).toThrow();
	});
});

describe("rebase publication policy", () => {
	it("publishes a changed result only while the remote retains the original head", () => {
		expect(rebasePublicationDecision("original-head", "repaired-head", "original-head")).toBe(
			"push",
		);
		expect(() =>
			rebasePublicationDecision("original-head", "repaired-head", "concurrent-head"),
		).toThrow();
	});

	it.each([
		{ condition: "lost publication response", original: "original-head", result: "repaired-head" },
		{ condition: "no repair needed", original: "original-head", result: "original-head" },
	])("does not push again after $condition", ({ original, result }) => {
		expect(rebasePublicationDecision(original, result, result)).toBe("already_published");
	});
});
