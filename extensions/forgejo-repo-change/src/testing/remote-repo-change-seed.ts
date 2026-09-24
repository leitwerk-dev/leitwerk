import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import { TemporaryGitRemote } from "./remote-repo-change-fixture.js";

/** Own a pristine seed for this suite; each scenario copies it before use. @internal */
export function useRemoteRepoChangeSeed(): () => TemporaryGitRemote {
	let root: string | undefined;
	let seed: TemporaryGitRemote | undefined;
	beforeAll(async () => {
		root = await mkdtemp(path.join(tmpdir(), "leitwerk-forgejo-seed-"));
		seed = new TemporaryGitRemote(root);
	});
	afterAll(async () => {
		try {
			if (!seed) return;
			expect(seed.branches()).toEqual(["main"]);
			expect(seed.head("main")).toBe(seed.initialSha);
		} finally {
			if (root) await rm(root, { recursive: true, force: true });
		}
	});
	return () => {
		if (!seed) throw new Error("Git seed has not been initialized");
		return seed;
	};
}
