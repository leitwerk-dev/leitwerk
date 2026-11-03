import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import { afterAll, onTestFinished } from "vitest";

/** @internal */
export function runGit(cwd: string, args: string[], env = process.env): string {
	return execFileSync(resolveGitBinary(), args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env,
	}).trim();
}

/** Copy immutable Git templates; callers rewire origins to the private copies. @internal */
export function createGitFixture<T, K>(build: (root: string, key?: K) => T) {
	const templatesRoot = mkdtempSync(join(tmpdir(), "coding-git-templates-"));
	const templates = new Map<K | undefined, { root: string; data: T }>();
	afterAll(() => rmSync(templatesRoot, { recursive: true, force: true }));
	return (key?: K) => {
		let template = templates.get(key);
		if (!template) {
			const root = mkdtempSync(join(templatesRoot, "template-"));
			template = { root, data: build(root, key) };
			templates.set(key, template);
		}
		const root = mkdtempSync(join(tmpdir(), "coding-git-fixture-"));
		onTestFinished(() => rmSync(root, { recursive: true, force: true }));
		// Copy checkouts and remotes, never sharing mutable Git state between tests.
		cpSync(template.root, root, { recursive: true });
		return { root, data: template.data };
	};
}
