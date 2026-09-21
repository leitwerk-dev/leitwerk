import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSnapshot } from "../scripts/indexer.mjs";
import { buildGraph } from "../src/graph";
import { indexSnapshot, type Snapshot } from "../src/model";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-package-dependencies-"));
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let snapshot: Snapshot;

beforeAll(async () => {
	fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
	fs.symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
	const sources = {
		foundation: {
			"index.ts":
				"/** @public */ export function work() {}\n/** @public */ export interface Contract { value: string; }",
			"local.ts": "import { work } from './index.js';\nwork();\nexport * from './index.js';",
		},
		facade: {
			"index.ts":
				"export { work as task } from '@fixture/foundation';\nimport type { Contract } from '@fixture/foundation';\n/** @public */ export interface Extended extends Contract {}",
		},
		sibling: {
			"index.ts":
				"import type { Contract } from '@fixture/foundation';\n/** @public */ export interface Sibling extends Contract {}",
		},
		consumer: {
			"index.ts":
				"import { task, type Extended } from '@fixture/facade';\nimport * as kit from '@fixture/facade';\ntask();\nkit.task();\ndeclare const value: Extended;\nconsole.log(value.value);",
			"extra.test.ts":
				"import type { Sibling } from '@fixture/sibling';\ndeclare const value: Sibling;\nconsole.log(value.value);",
		},
	};
	for (const [name, files] of Object.entries(sources)) {
		const folder = path.join(root, "packages", name);
		fs.mkdirSync(path.join(folder, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(folder, "package.json"),
			JSON.stringify({
				name: `@fixture/${name}`,
				type: "module",
				exports: { ".": { source: "./src/index.ts", types: "./dist/index.d.ts" } },
			}),
		);
		for (const [file, source] of Object.entries(files))
			fs.writeFileSync(path.join(folder, "src", file), source);
	}
	snapshot = (await createSnapshot(root, path.join(root, ".generated"), {
		extract: false,
	})) as Snapshot;
}, 30000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function overview(current: Snapshot, tests = false) {
	const index = indexSnapshot(current);
	return buildGraph(
		current,
		index,
		{ root: "", limits: {}, expanded: [], hidden: [], siteLimits: {} },
		{
			query: "",
			package: "",
			public: true,
			internal: true,
			kind: "",
			tests,
			internalUsages: false,
		},
	).edges.map((edge) => ({
		from: index.byId.get(edge.source)!.package,
		to: index.byId.get(edge.target)!.package,
		count: Number(edge.label),
	}));
}

it("follows the imported facade for named and namespace calls, without reverse alias dependencies", () => {
	const calls = snapshot.occurrences.filter(
		(o) => o.kind === "call" && o.path === "packages/consumer/src/index.ts",
	);
	expect(calls).toHaveLength(2);
	for (const call of calls) {
		expect(call.targets).toHaveLength(2); // both exported API identities still have evidence
		expect(call.targetPackages).toEqual(["@fixture/facade"]);
	}
	const index = indexSnapshot(snapshot);
	const foundation = snapshot.nodes.find(
		(n) => n.kind === "package" && n.package === "@fixture/foundation",
	)!;
	const facade = snapshot.nodes.find(
		(n) => n.kind === "package" && n.package === "@fixture/facade",
	)!;
	expect(
		index.calls.get(foundation.id)?.every((o) => o.path === "packages/foundation/src/local.ts"),
	).toBe(true);
	expect(index.calls.get(facade.id)).toEqual(calls);
	const edges = overview(snapshot);
	expect(edges.map(({ from, to }) => [from, to]).sort()).toEqual([
		["@fixture/consumer", "@fixture/facade"],
		["@fixture/consumer", "@fixture/foundation"],
		["@fixture/facade", "@fixture/foundation"],
		["@fixture/sibling", "@fixture/foundation"],
	]);
	expect(
		edges.find((edge) => edge.from === "@fixture/consumer" && edge.to === "@fixture/facade")?.count,
	).toBe(5);
});

it("attributes inherited member access to its declaration, not unrelated inheritors", () => {
	const member = snapshot.occurrences.find(
		(o) => o.path === "packages/consumer/src/index.ts" && o.line === 6,
	)!;
	expect(member.targets).toHaveLength(3);
	expect(member.targetPackages).toEqual(["@fixture/foundation"]);
	expect(overview(snapshot, true)).toContainEqual({
		from: "@fixture/consumer",
		to: "@fixture/sibling",
		count: 2,
	});
	expect(overview(snapshot).some((edge) => edge.to === "@fixture/sibling")).toBe(false);
});

it("opens older snapshots without creating reverse dependencies from shared aliases", () => {
	const older = {
		...snapshot,
		occurrences: snapshot.occurrences.map((o) => ({ ...o, targetPackages: undefined })),
	};
	const edges = overview(older);
	expect(edges.length).toBeGreaterThan(0);
	expect(edges.some((edge) => edge.from === "@fixture/foundation")).toBe(false);
	expect(edges.some((edge) => edge.to === "@fixture/sibling")).toBe(false);
	expect(edges.filter((edge) => edge.to === "@fixture/facade").map((edge) => edge.from)).toEqual([
		"@fixture/consumer",
	]);
});
