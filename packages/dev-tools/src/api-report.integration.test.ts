import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runApiReportCli } from "./api-report.js";

const dirs: string[] = [];
const temporary = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "leitwerk-report-"));
	dirs.push(root);
	return root;
};
function put(root: string, file: string, text: string) {
	const target = path.join(root, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, text);
}
function workspace() {
	const root = temporary();
	put(
		root,
		"package.json",
		JSON.stringify({
			name: "consumer",
			version: "1",
			type: "module",
			dependencies: { "@leitwerk-dev/report-fixture": "1.0.0" },
			scripts: { build: "node -e 'process.exit(99)'" },
		}),
	);
	put(
		root,
		"node_modules/@leitwerk-dev/report-fixture/package.json",
		JSON.stringify({
			name: "@leitwerk-dev/report-fixture",
			version: "1.0.0",
			type: "module",
			exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
		}),
	);
	put(
		root,
		"node_modules/@leitwerk-dev/report-fixture/index.d.ts",
		"/** @public */ export declare function consumed(): string;",
	);
	put(
		root,
		"node_modules/@leitwerk-dev/report-fixture/index.js",
		"export function consumed() { return 'hello'; }",
	);
	put(
		root,
		"src/Consumer.svelte",
		'<script lang="ts">\nimport { consumed } from "@leitwerk-dev/report-fixture";\n</script>\n<p>{consumed()}</p>',
	);
	return root;
}
afterEach(() => {
	for (const root of dirs.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it("generates installed-package consumer evidence without a core checkout or build, and replaces it atomically", async () => {
	const root = workspace(),
		output = temporary();
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	manifest.exports = { ".": { source: "./src/index.ts", types: "./src/index.ts" } };
	put(root, "package.json", JSON.stringify(manifest));
	put(root, "src/index.ts", "");
	put(root, "src/external.ts", 'import "missing-external";');
	const args = ["--workspace", root, "--usage-only", "--output-dir", output];
	await runApiReportCli(args);
	const files = fs.readdirSync(output);
	expect(files).toHaveLength(1);
	expect(files[0]).toMatch(/^usage-.*\.json$/);
	const first = JSON.parse(fs.readFileSync(path.join(output, files[0]), "utf8"));
	expect(first.analyzedPackages["@leitwerk-dev/report-fixture"]).toBe("1.0.0");
	expect(first.snapshot.coverage.complete).toBe(true);
	expect(first.snapshot.diagnostics).not.toContainEqual(
		expect.objectContaining({ message: expect.stringContaining("missing-external") }),
	);
	expect(first.snapshot.occurrences).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: "call",
				sourceOrigin: "workspace",
				path: "src/Consumer.svelte",
				line: 4,
				snippet: expect.stringContaining("{consumed()}"),
			}),
		]),
	);
	expect(
		first.snapshot.occurrences.every((o: { snippet: string }) => !o.snippet.includes("__sveltets")),
	).toBe(true);
	put(root, "src/usage.js", 'import { consumed } from "@leitwerk-dev/report-fixture"; consumed();');
	await runApiReportCli(args);
	expect(fs.readdirSync(output)).toEqual(files);
	const second = JSON.parse(fs.readFileSync(path.join(output, files[0]), "utf8"));
	expect(second.source.id).toBe(first.source.id);
	expect(second.source.fingerprint).not.toBe(first.source.fingerprint);
	fs.rmSync(root, { recursive: true, force: true });
	expect(
		JSON.parse(fs.readFileSync(path.join(output, files[0]), "utf8")).snapshot.occurrences.length,
	).toBeGreaterThan(0);
}, 30000);
it("includes only explicitly selected composition packages and test roots", async () => {
	const root = workspace(),
		other = temporary();
	put(other, "package.json", JSON.stringify({ name: "extra", version: "1", type: "module" }));
	put(
		other,
		"src/extra.ts",
		'import { consumed } from "@leitwerk-dev/report-fixture"; consumed();',
	);
	put(
		other,
		"tests/extra.test.ts",
		'import { consumed } from "@leitwerk-dev/report-fixture"; consumed();',
	);
	put(root, "runtime.yaml", "extensions: []");
	put(
		root,
		"composition.yaml",
		`version: 1\nruntime_config: ./runtime.yaml\nextensions:\n  - ${JSON.stringify(other)}\ntest_roots:\n  - ${JSON.stringify(path.join(other, "tests"))}\n`,
	);
	const output = temporary();
	await runApiReportCli([
		"--workspace",
		root,
		"--usage-only",
		"--composition",
		"composition.yaml",
		"--output-dir",
		output,
	]);
	const report = JSON.parse(fs.readFileSync(path.join(output, fs.readdirSync(output)[0]), "utf8"));
	expect(report.snapshot.occurrences).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: "call",
				isTest: true,
				sourceOrigin: "workspace",
				path: expect.stringContaining("extra.test.ts"),
			}),
			expect.objectContaining({
				kind: "call",
				sourceOrigin: "composition",
				path: expect.stringContaining("src/extra.ts"),
			}),
		]),
	);
}, 30000);
it("uses the most-specific root for a nested declared core checkout", async () => {
	const root = workspace(),
		output = temporary(),
		core = path.join(root, ".leitwerk-base"),
		corePackage = path.join(core, "extensions/copied");
	put(core, "package.json", JSON.stringify({ name: "leitwerk", version: "1", type: "module" }));
	put(
		corePackage,
		"package.json",
		JSON.stringify({ name: "copied", version: "1", type: "module" }),
	);
	put(
		corePackage,
		"src/copied.ts",
		'import { consumed } from "@leitwerk-dev/report-fixture"; consumed();',
	);
	put(root, "runtime.yaml", "extensions: []");
	put(
		root,
		"composition.yaml",
		`version: 1\nleitwerk:\n  root: ./.leitwerk-base\nruntime_config: ./runtime.yaml\nextensions:\n  - ./.leitwerk-base/extensions/copied\n`,
	);
	await runApiReportCli([
		"--workspace",
		root,
		"--usage-only",
		"--composition",
		"composition.yaml",
		"--output-dir",
		output,
	]);
	const report = JSON.parse(fs.readFileSync(path.join(output, fs.readdirSync(output)[0]), "utf8"));
	expect(report.snapshot.occurrences).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				path: ".leitwerk-base/extensions/copied/src/copied.ts",
				sourceOrigin: "composition",
			}),
		]),
	);
}, 30000);
it.each([
	"checkout",
	"worktree",
])("excludes a nested %s unless explicitly selected by the composition", async (kind) => {
	const root = fs.realpathSync(workspace()),
		output = temporary();
	const nested = path.join(root, ".copies", kind);
	put(nested, "package.json", JSON.stringify({ name: "nested", version: "1", type: "module" }));
	if (kind === "checkout") fs.mkdirSync(path.join(nested, ".git"));
	else put(nested, ".git", "gitdir: /unused/worktree/metadata\n");
	put(
		nested,
		"src/nested.ts",
		'import { consumed } from "@leitwerk-dev/report-fixture"; consumed();',
	);
	const args = ["--workspace", root, "--usage-only", "--output-dir", output];
	const snapshot = () =>
		JSON.parse(fs.readFileSync(path.join(output, fs.readdirSync(output)[0]), "utf8")).snapshot;
	await runApiReportCli(args);
	const excluded = snapshot();
	expect(excluded.coverage.sourceFiles).toBe(1);
	expect(excluded.occurrences.some((o: { path: string }) => o.path.includes("nested.ts"))).toBe(
		false,
	);
	put(
		root,
		"composition.yaml",
		`version: 1\nruntime_config: ./runtime.yaml\nextensions:\n  - ./.copies/${kind}\n`,
	);
	put(root, "runtime.yaml", "extensions: []");
	await runApiReportCli([...args, "--composition", "composition.yaml"]);
	const included = snapshot();
	expect(included.coverage.sourceFiles).toBe(2);
	expect(included.occurrences).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: "call", path: `.copies/${kind}/src/nested.ts` }),
		]),
	);
}, 30000);
it("does not attribute built-in methods to API aliases while retaining declared and inherited members", async () => {
	const root = workspace(),
		output = temporary();
	put(
		root,
		"node_modules/@leitwerk-dev/report-fixture/index.d.ts",
		`/** @public */ export declare function consumed(): string;
/** @public */ export type Label = string;
/** @public */ export type Status = "ready" | "busy";
/** @public */ export type Count = number;
/** @public */ export type Flag = boolean;
/** @public */ export type Labels = string[];
/** @public */ export type ReadonlyLabels = readonly string[];
/** @public */ export type Pending = Promise<string>;
/** @public */ export interface Base { /** @public */ run(): void; }
/** @public */ export interface Derived extends Base { /** @public */ own(): void; }
/** @public */ export type Alias = Derived;
/** @public */ export interface Custom { /** @public */ replace(): void; }
/** @public */ export declare class List extends Array<string> { /** @public */ own(): void; }
`,
	);
	put(
		root,
		"src/usage.ts",
		`import type { Label, Derived, Alias, Custom, List } from "@leitwerk-dev/report-fixture";
declare const label: Label;
declare const derived: Derived;
declare const alias: Alias;
declare const custom: Custom;
declare const list: List;
label.replace("a", "b");
"unrelated".replace("a", "b");
"unrelated".localeCompare("b");
(1).toFixed();
true.valueOf();
["a"].map(value => value);
Promise.resolve("a").then(value => value);
derived.run();
derived.own();
alias.run();
custom.replace();
list.own();
list.map(value => value);
`,
	);
	await runApiReportCli(["--workspace", root, "--usage-only", "--output-dir", output]);
	const { snapshot } = JSON.parse(
		fs.readFileSync(path.join(output, fs.readdirSync(output)[0]), "utf8"),
	);
	const names = snapshot.nodes.map((n: { qualifiedName?: string }) => n.qualifiedName);
	for (const alias of ["Label", "Status", "Count", "Flag", "Labels", "ReadonlyLabels", "Pending"]) {
		expect(names).toContain(alias);
		expect(names.some((name: string | undefined) => name?.startsWith(`${alias}.`))).toBe(false);
	}
	expect(names).not.toContain("List.map");
	for (const name of [
		"Base.run",
		"Derived.run",
		"Derived.own",
		"Alias.run",
		"Custom.replace",
		"List.own",
	]) {
		expect(names).toContain(name);
		expect(
			snapshot.occurrences.some(
				(o: { kind: string; targets: string[] }) =>
					o.kind === "call" && o.targets.some((id) => id.endsWith(`|${name}`)),
			),
		).toBe(true);
	}
	const lines = snapshot.occurrences
		.filter((o: { kind: string; path: string }) => o.kind === "call" && o.path === "src/usage.ts")
		.map((o: { line: number }) => o.line);
	expect(lines).toEqual([14, 15, 16, 17, 18]);
}, 30000);
it("supports npm --prefix without switching consumer dependencies", () => {
	const root = workspace(),
		output = temporary();
	const checkout = path.resolve(import.meta.dirname, "../../..");
	const before = fs.readFileSync(path.join(root, "package.json"), "utf8");
	execFileSync(
		process.execPath,
		[
			fs.realpathSync(path.join(path.dirname(process.execPath), "npm")),
			"--prefix",
			checkout,
			"run",
			"api:report",
			"--",
			"--workspace",
			root,
			"--usage-only",
			"--output-dir",
			output,
		],
		{ cwd: root, stdio: "pipe", timeout: 30000 },
	);
	expect(fs.readFileSync(path.join(root, "package.json"), "utf8")).toBe(before);
	expect(fs.readdirSync(output)).toHaveLength(1);
}, 30000);
