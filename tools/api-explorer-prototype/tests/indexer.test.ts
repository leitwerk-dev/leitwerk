import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSnapshot, discover } from "../scripts/indexer.mjs";
import { buildGraph } from "../src/graph";
import { type Filters, indexSnapshot, type Snapshot, usageInfo } from "../src/model";
import { makeNote, markdownExport, mergeNotes } from "../src/notes";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ts = createRequire(path.join(repository, "package.json"))("typescript");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-explorer-fixture-"));
const put = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), text);
};
let snapshot: Snapshot;
const filters: Filters = {
	query: "",
	package: "",
	public: true,
	internal: true,
	kind: "",
	tests: false,
	internalUsages: false,
};

beforeAll(async () => {
	put("package.json", '{"name":"fixture","type":"module"}');
	fs.symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
	put(
		"packages/a/package.json",
		JSON.stringify({
			name: "@fixture/a",
			type: "module",
			leitwerk: {
				extension: { source: "./src/index.ts", import: "./dist/index.js" },
				discover: false,
			},
			exports: {
				".": { source: "./src/index.ts", types: "./dist/index.d.ts" },
				"./extra/*": { source: "./src/extra/*.ts", types: "./dist/extra/*.d.ts" },
				"./alias": { source: "./src/alias.ts", types: "./dist/alias.d.ts" },
			},
		}),
	);
	put(
		"packages/a/src/index.ts",
		`/** A public contract. @public */
export interface Shape {
  /** @public */
  size: number;
  /** @internal */
  debug?: boolean;
}
/** @public */
export class Widget {
  /** @internal */ secret = 1;
  /** @public */ constructor(public shape: Shape) {}
  /** @public */ run(value: string): string;
  /** @public */ run(value: number): number;
  run(value: string | number) { return value; }
  /** @public */ static make(shape: Shape) { return new Widget(shape); }
}
/** @internal */
export function hidden(): void {}
/** @public */
export function overloaded(value: string): string;
/** @public */
export function overloaded(value: number): number;
export function overloaded(value: string | number) { return value; }
/** @public */
export function createExtension() {
  function configure(value: boolean) { return value; }
  return { extension: { setup() { configure(true); } }, configure };
}
/** @internal */
export const { extension: defaultExtension, configure: configureAlias } = createExtension();
export default defaultExtension;
/** @public */
export interface Hook { /** @public */ run(): void; }
`,
	);
	put("packages/a/src/extra/thing.ts", "/** @public */\nexport const thing = 42;");
	put("packages/a/src/alias.ts", "export { Widget as Alias, overloaded } from './index.js';");
	put("tests/usage.test.ts", "import { Widget } from '@fixture/a';\nnew Widget({size: 2}).run(1);");
	put("packages/b/package.json", '{"name":"@fixture/b","type":"module"}');
	put(
		"packages/b/src/caller.ts",
		"import { Widget, overloaded } from '@fixture/a';\noverloaded('external');\nnew Widget({size: 3}).run(2);",
	);
	put(
		"packages/b/src/another-caller.ts",
		"import { overloaded } from '@fixture/a/alias';\noverloaded(2);",
	);
	put("scripts/consumer.ts", "import { overloaded } from '@fixture/a';\noverloaded('repository');");
	put("packages/a/src/widget.test.ts", "import { overloaded } from '@fixture/a';\noverloaded(99);");
	put(
		"packages/b/src/wiring.ts",
		"import extension, { createExtension } from '@fixture/a';\nextension.setup();\ncreateExtension().configure(false);",
	);
	put(
		"packages/a/src/usage.ts",
		`import { Widget as Renamed, overloaded, type Shape } from '@fixture/a';
import { Alias } from '@fixture/a/alias';
export { hidden as hiddenAgain } from '@fixture/a';
const shape: Shape = {size: 1};
const w = new Renamed(shape);
w.run('text');
w.run(123);
const other = new Alias(shape);
Renamed.make(shape);
overloaded(1);
const reference = overloaded;
console.log(reference, other, { overloaded });
`,
	);
	put(
		"packages/a/src/usage.js",
		"import { overloaded } from '@fixture/a';\noverloaded('javascript');\noverloaded(1);\noverloaded(2);",
	);
	put(
		"packages/b/src/View.svelte",
		'<script lang="ts">import { hidden } from "@fixture/a";</script>\n<button onclick={() => hidden()}>Run</button>',
	);
	put("packages/a/src/barrel.ts", "export * from './index.js';");
	put(
		"packages/b/src/shapes.ts",
		"import type { Shape as Contract } from '@fixture/a';\nexport function size(shape: Contract) { return shape.size; }\nexport function debug(shape: Contract) { return shape.debug; }",
	);
	put("packages/b/src/shapes-barrel.ts", "export type { Shape as Contract } from '@fixture/a';");
	put(
		"packages/b/src/shape.test.ts",
		"import type { Shape } from '@fixture/a';\nconst shape: Shape = { size: 1 };\nconsole.log(shape.size);",
	);
	put(
		"packages/a/src/shape-internal.ts",
		"import type { Shape } from '@fixture/a';\nexport function size(shape: Shape) { return shape.size + shape.size + shape.size + shape.size + shape.size; }",
	);
	put(
		"packages/b/src/hooks.ts",
		"import type { Hook } from '@fixture/a';\ndeclare const hook: Hook;\nhook.run();",
	);
	const base = path.join(root, "packages/a");
	const program = ts.createProgram(
		[
			path.join(base, "src/index.ts"),
			path.join(base, "src/alias.ts"),
			path.join(base, "src/extra/thing.ts"),
		],
		{
			declaration: true,
			emitDeclarationOnly: true,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			rootDir: path.join(base, "src"),
			outDir: path.join(base, "dist"),
			skipLibCheck: true,
		},
	);
	program.emit();
	snapshot = (await createSnapshot(root, path.join(root, ".generated"))) as Snapshot;
}, 60000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const find = (name: string) =>
	snapshot.nodes.find((n) => n.qualifiedName === name && n.entry === ".")!;
const usages = (name: string) =>
	snapshot.occurrences.filter((o) => o.targets.includes(find(name).id));

describe("real Extractor and source compiler pipeline", () => {
	it("discovers wildcard entries and retains public/internal members", () => {
		expect(discover(root).entries.map((e) => e.entry)).toEqual([".", "./extra/thing", "./alias"]);
		expect(snapshot.coverage.extractedEntryPoints).toBe(3);
		expect(find("Widget").extraction).toBe("extractor");
		expect(find("Widget.secret").release).toBe("internal");
		expect(find("Shape").release).toBe("public");
		expect(find("hidden").release).toBe("internal");
		expect(find("Widget.run").signatures).toHaveLength(2);
		expect(snapshot.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
	});
	it("resolves aliases, re-exports, overloads, methods, constructors, types and JS", () => {
		expect(usages("Widget").some((o) => o.kind === "import")).toBe(true);
		expect(
			usages("Widget.constructor").filter((o) => o.kind === "call").length,
		).toBeGreaterThanOrEqual(3);
		expect(usages("Widget.run").filter((o) => o.kind === "call")).toHaveLength(4);
		expect(usages("Widget.static:make").some((o) => o.kind === "call")).toBe(true);
		expect(usages("Widget").find((o) => o.path.endsWith("usage.ts") && o.line === 9)?.kind).toBe(
			"other",
		);
		expect(usages("hidden").some((o) => o.kind === "re-export")).toBe(true);
		expect(usages("Shape").some((o) => o.kind === "type")).toBe(true);
		expect(usages("overloaded").filter((o) => o.kind === "other")).toHaveLength(2);
		expect(
			usages("Widget").some((o) => o.path.endsWith("barrel.ts") && o.kind === "re-export"),
		).toBe(true);
		expect(usages("overloaded").some((o) => o.path.endsWith("usage.js") && o.kind === "call")).toBe(
			true,
		);
		const alias = snapshot.nodes.find((n) => n.qualifiedName === "Alias")!;
		expect(
			snapshot.occurrences.some(
				(o) => o.targets.includes(alias.id) && o.targets.includes(find("Widget").id),
			),
		).toBe(true);
		expect(snapshot.relationships.some((r) => r.to === find("Shape").id)).toBe(true);
	});
	it("explains extension entries and shared implementations without inventing alias callers", () => {
		const entry = find("defaultExtension"),
			alias = find("configureAlias");
		expect(entry.callable).toBe(false);
		expect(entry.release).toBe("internal");
		expect(alias.release).toBe("internal");
		expect(entry.evidence?.map((e) => e.kind)).toEqual(
			expect.arrayContaining(["binding", "default-export", "extension-entry"]),
		);
		expect(usages("defaultExtension").some((o) => o.kind === "re-export")).toBe(true);
		expect(alias.callable).toBe(true);
		const implementationCalls =
			alias.evidence?.filter((e) => e.kind === "implementation-call") ?? [];
		expect(implementationCalls.some((e) => e.source.path === "packages/b/src/wiring.ts")).toBe(
			true,
		);
		expect(implementationCalls.some((e) => e.source.path === "packages/a/src/index.ts")).toBe(true);
		expect(usages("configureAlias").filter((o) => o.kind === "call")).toEqual([]);
		const index = indexSnapshot(snapshot);
		expect(usageInfo(entry, index, 0).label).toBe("Extension entry");
		expect(usageInfo(alias, index, 0)).toMatchObject({
			label: "Shared implementation",
			external: 0,
			internal: 0,
		});
		expect(usageInfo(find("overloaded"), index, 0).label).toBe("Calls filtered");
	});
	it("hides tests by default, expands incrementally, and collapses branches", () => {
		const view = {
			root: find("Widget.run").id,
			limits: {},
			expanded: [],
			hidden: [],
			siteLimits: {},
		};
		const index = indexSnapshot(snapshot);
		expect(buildGraph(snapshot, index, view, filters).nodes.some((n) => n.kind === "file")).toBe(
			false,
		);
		const withCalls = { ...view, siteLimits: { [view.root]: 6 } };
		const without = buildGraph(snapshot, index, withCalls, filters);
		const withTests = buildGraph(snapshot, index, withCalls, { ...filters, tests: true });
		expect(without.nodes.some((n) => n.isTest)).toBe(false);
		expect(
			buildGraph(snapshot, index, { ...view, hidden: [view.root] }, filters).nodes,
		).toHaveLength(0);
		expect(withTests.nodes.some((n) => n.isTest)).toBe(true);
		expect(
			buildGraph(snapshot, index, { ...view, limits: { [view.root]: 0 } }, filters).nodes,
		).toHaveLength(1);
		const file = without.nodes.find((n) => n.kind === "file")!;
		expect(without.edges.some((e) => e.source === file.id && e.target === view.root)).toBe(true);
		expect(
			buildGraph(snapshot, index, { ...withCalls, hidden: [file.id] }, filters).nodes.some(
				(n) => n.id === file.id,
			),
		).toBe(false);
	});
	it("connects packages directly to exports across all subpaths", () => {
		const index = indexSnapshot(snapshot);
		const pkg = snapshot.nodes.find((n) => n.kind === "package")!;
		const view = {
			root: pkg.id,
			limits: { [pkg.id]: 30 },
			expanded: [],
			hidden: [],
			siteLimits: {},
		};
		const graph = buildGraph(snapshot, index, view, filters);
		expect(graph.nodes.some((n) => n.kind === "entry")).toBe(false);
		for (const name of ["Widget", "Alias", "thing"]) {
			const api = graph.nodes.find((n) => n.label === name)!;
			expect(api).toBeDefined();
			expect(graph.edges).toContainEqual({
				id: `${pkg.id}->${api.id}`,
				source: pkg.id,
				target: api.id,
				label: "contains",
			});
		}
		// Existing entry identities and notes remain in the snapshot.
		const entry = snapshot.nodes.find((n) => n.kind === "entry")!;
		expect(
			buildGraph(snapshot, index, { ...view, root: entry.id }, filters).nodes.some(
				(n) => n.kind === "entry",
			),
		).toBe(false);
	});
	it("shows external callers by default with a separate file budget", () => {
		const index = indexSnapshot(snapshot),
			api = find("overloaded");
		const view = {
			root: api.id,
			limits: { [api.id]: 0 },
			expanded: [],
			hidden: [],
			siteLimits: { [api.id]: 1 },
		};
		const first = buildGraph(snapshot, index, view, filters);
		expect(first.siteCounts[api.id]).toBe(3);
		expect(first.moreSites[api.id]).toBe(2);
		expect(first.nodes.filter((n) => n.kind === "file")).toHaveLength(1);
		const all = buildGraph(snapshot, index, { ...view, siteLimits: { [api.id]: 6 } }, filters);
		expect(all.nodes.filter((n) => n.kind === "file")).toHaveLength(3);
		expect(all.nodes.filter((n) => n.kind === "file").every((n) => n.package !== api.package)).toBe(
			true,
		);
		expect([...all.fileScopes.values()]).toEqual(["external", "external", "external"]);
		expect(all.nodes.some((n) => n.source?.path === "scripts/consumer.ts")).toBe(true);
		expect([...all.fileOccurrences.values()].flat().every((o) => o.kind === "call")).toBe(true);
		expect(all.nodes.some((n) => n.source?.path.endsWith("barrel.ts"))).toBe(false);
		expect(buildGraph(snapshot, index, { ...view, siteLimits: {} }, filters).nodes).toHaveLength(1);
	});
	it("labels internal callers when included and prioritizes external callers over call volume", () => {
		const index = indexSnapshot(snapshot),
			api = find("overloaded");
		const view = {
			root: api.id,
			limits: { [api.id]: 0 },
			expanded: [],
			hidden: [],
			siteLimits: { [api.id]: 1 },
		};
		const withInternal = { ...filters, internalUsages: true };
		const first = buildGraph(snapshot, index, view, withInternal);
		expect(first.nodes.find((n) => n.kind === "file")?.package).toBe("@fixture/b");
		const all = buildGraph(
			snapshot,
			index,
			{ ...view, siteLimits: { [api.id]: 20 } },
			withInternal,
		);
		expect(all.nodes.filter((n) => n.kind === "file")).toHaveLength(5);
		const edges = all.edges.filter((e) => e.usageScope);
		expect(edges.map((e) => e.usageScope)).toEqual([
			"external",
			"external",
			"external",
			"internal",
			"internal",
		]);
		expect(
			edges.find((e) => index.byId.get(e.source)?.source?.path.endsWith("usage.js"))?.label,
		).toBe("3 internal");
		for (const edge of edges) expect(all.fileScopes.get(edge.source)).toBe(edge.usageScope);
		expect(all.occurrencesFor(api)).toHaveLength(7);
	});
	it("shows interface usages without calls, with scope, test, visibility and file limits", () => {
		const index = indexSnapshot(snapshot),
			api = find("Shape");
		const view = {
			root: api.id,
			limits: { [api.id]: 0 },
			expanded: [],
			hidden: [],
			siteLimits: { [api.id]: 1 },
		};
		expect(index.calls.get(api.id) ?? []).toHaveLength(0);
		const first = buildGraph(snapshot, index, view, filters);
		expect(first.siteCounts[api.id]).toBeGreaterThan(0);
		expect(first.nodes.filter((n) => n.kind === "file")).toHaveLength(1);
		expect(first.moreSites[api.id]).toBe(1);
		const expanded = { ...view, siteLimits: { [api.id]: 30 } };
		const external = buildGraph(snapshot, index, expanded, filters);
		expect(
			external.nodes
				.filter((n) => n.kind === "file")
				.map((n) => n.source?.path)
				.sort(),
		).toEqual(["packages/b/src/shapes-barrel.ts", "packages/b/src/shapes.ts"]);
		const occurrences = [...external.fileOccurrences.values()].flat();
		expect(new Set(occurrences.map((o) => o.kind))).toEqual(
			new Set(["type", "other", "import", "re-export"]),
		);
		expect(occurrences.some((o) => o.targets.includes(find("Shape.size").id))).toBe(true);
		expect(external.edges.every((e) => e.label.endsWith("external usages"))).toBe(true);
		expect([...external.fileModes.values()]).toEqual(["usages", "usages"]);
		expect(usageInfo(api, index, external.siteCounts[api.id])).toMatchObject({
			label: "Indexed usages",
			mode: "usages",
			external: occurrences.length,
		});
		expect(usageInfo(api, index, 0).label).toBe("Usages filtered");
		expect(find("Shape.debug").release).toBe("internal");
		const publicOnly = buildGraph(snapshot, index, expanded, { ...filters, internal: false });
		expect(publicOnly.siteCounts[api.id]).toBe(external.siteCounts[api.id] - 1);
		expect(
			publicOnly.occurrencesFor(api).some((o) => o.targets.includes(find("Shape.debug").id)),
		).toBe(false);
		const tests = buildGraph(snapshot, index, expanded, { ...filters, tests: true });
		expect(tests.nodes.some((n) => n.source?.path === "packages/b/src/shape.test.ts")).toBe(true);
		const all = buildGraph(snapshot, index, expanded, { ...filters, internalUsages: true });
		expect(all.nodes.some((n) => n.source?.path === "packages/a/src/shape-internal.ts")).toBe(true);
		expect(all.nodes.some((n) => n.isTest)).toBe(false);
		expect(
			buildGraph(snapshot, index, view, { ...filters, internalUsages: true }).nodes.find(
				(n) => n.kind === "file",
			)?.package,
		).toBe("@fixture/b");
		expect(buildGraph(snapshot, index, { ...view, siteLimits: {} }, filters).nodes).toHaveLength(1);
		const file = external.nodes.find((n) => n.kind === "file")!;
		expect(
			buildGraph(snapshot, index, { ...expanded, hidden: [file.id] }, filters).nodes.some(
				(n) => n.id === file.id,
			),
		).toBe(false);
	});
	it("includes interface member calls once alongside type references", () => {
		const index = indexSnapshot(snapshot),
			api = find("Hook");
		const graph = buildGraph(
			snapshot,
			index,
			{
				root: api.id,
				limits: { [api.id]: 0 },
				expanded: [],
				hidden: [],
				siteLimits: { [api.id]: 6 },
			},
			filters,
		);
		const occurrences = graph.occurrencesFor(api);
		expect(occurrences.filter((o) => o.kind === "call")).toHaveLength(1);
		expect(occurrences.some((o) => o.kind === "type")).toBe(true);
		expect(new Set(occurrences.map((o) => o.id)).size).toBe(occurrences.length);
		expect([...graph.fileOccurrences.values()].flat()).toEqual(occurrences);
	});
	it("can include member calls on a collapsed box and deduplicates package aliases", () => {
		const index = indexSnapshot(snapshot),
			pkg = snapshot.nodes.find((n) => n.kind === "package")!,
			widget = find("Widget");
		const view = {
			root: pkg.id,
			limits: { [pkg.id]: 30 },
			expanded: [],
			hidden: [],
			siteLimits: { [widget.id]: 6 },
		};
		const graph = buildGraph(snapshot, index, view, filters);
		expect(graph.nodes.some((n) => n.id === find("Widget.run").id)).toBe(false);
		expect(
			[...graph.fileOccurrences.values()]
				.flat()
				.some((o) => o.targets.includes(find("Widget.run").id)),
		).toBe(true);
		const packageCalls = buildGraph(
			snapshot,
			index,
			{ ...view, siteLimits: { [pkg.id]: 6 } },
			filters,
		);
		const expected = snapshot.occurrences.filter(
			(o) => o.kind === "call" && !o.isTest && index.byId.get(o.fileId)?.package !== pkg.package,
		);
		expect(packageCalls.siteCounts[pkg.id]).toBe(expected.length);
		for (const internalUsages of [false, true]) {
			const withTests = buildGraph(
				snapshot,
				index,
				{ ...view, siteLimits: { [pkg.id]: 30 } },
				{ ...filters, tests: true, internalUsages },
			);
			const files = withTests.nodes.filter((n) => n.kind === "file");
			expect(files.length).toBeGreaterThan(0);
			expect(files.every((n) => n.package !== pkg.package)).toBe(true);
			expect(files.some((n) => n.source?.path === "tests/usage.test.ts")).toBe(true);
			expect([...withTests.fileScopes.values()].every((scope) => scope === "external")).toBe(true);
		}
	});
	it("keeps identities and notes across moved declarations, and retains removed nodes", async () => {
		const before = find("Widget.run");
		const note = makeNote(before, "## Keep this\n\n**Exact** Markdown.");
		const source = path.join(root, "packages/a/src/index.ts");
		fs.writeFileSync(source, `\n\n// moved source\n${fs.readFileSync(source, "utf8")}`);
		const next = (await createSnapshot(root, path.join(root, ".generated"))) as Snapshot;
		expect(next.nodes.map((n) => n.id)).toEqual(snapshot.nodes.map((n) => n.id));
		expect(next.nodes.find((n) => n.id === before.id)?.source?.line).toBe(before.source!.line + 3);
		fs.writeFileSync(
			source,
			fs
				.readFileSync(source, "utf8")
				.split("\n")
				.filter((line) => !line.includes("run(value:"))
				.join("\n"),
		);
		const remaining = (await createSnapshot(root, path.join(root, ".generated"), {
			extract: false,
		})) as Snapshot;
		expect(remaining.nodes.some((n) => n.id === before.id)).toBe(false);
		const merged = mergeNotes({ [note.nodeId]: note }, {});
		const markdown = markdownExport(merged, remaining);
		expect(markdown).toContain("Absent from the current snapshot.");
		expect(markdown).toContain(note.text);
	}, 60000);
});

it("maps Svelte template-only calls to original source", () => {
	const call = usages("hidden").find((o) => o.kind === "call" && o.path.endsWith("View.svelte"));
	expect(call?.line).toBe(2);
	expect(call?.snippet).toContain("onclick={() => hidden()}");
	expect(call?.snippet).not.toContain("__sveltets");
});
