import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./prepare-runtime-layout.mjs", import.meta.url));
const roots: string[] = [];

function write(root: string, relativePath: string, content: string) {
	const file = path.join(root, relativePath);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime image layout", () => {
	it("separates stable manifests from changing compiled code", () => {
		const root = mkdtempSync(path.join(tmpdir(), "leitwerk-runtime-layout-"));
		roots.push(root);
		write(root, "package.json", '{"name":"fixture"}');
		write(root, "LICENSE", "license");
		write(root, "packages/server/package.json", '{"name":"server"}');
		write(root, "packages/server/README.md", "server");
		write(root, "packages/server/src/index.ts", "source");
		write(root, "packages/server/dist/index.js", "compiled");
		write(root, "packages/server/migrations/001.sql", "select 1;");
		write(root, "extensions/example/package.json", '{"name":"example"}');
		write(root, "extensions/example/dist/index.js", "extension");

		const output = path.join(root, "runtime");
		execFileSync(process.execPath, [script, output], { cwd: root });

		expect(
			readFileSync(path.join(output, "stable/packages/server/package.json"), "utf8"),
		).toContain("server");
		expect(existsSync(path.join(output, "stable/packages/server/dist"))).toBe(false);
		expect(readFileSync(path.join(output, "app/packages/server/dist/index.js"), "utf8")).toBe(
			"compiled",
		);
		expect(readFileSync(path.join(output, "app/packages/server/migrations/001.sql"), "utf8")).toBe(
			"select 1;",
		);
		expect(existsSync(path.join(output, "app/packages/server/src"))).toBe(false);
	});
});
