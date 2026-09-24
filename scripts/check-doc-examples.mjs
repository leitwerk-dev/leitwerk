// Standalone documentation check. It does not start a server, worker, or provider.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@leitwerk-dev/server";
import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import ts from "typescript";
import { parse, stringify } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const examplePath = path.join(root, "docs/examples/first-process.ts");
const options = {
	noEmit: true,
	strict: true,
	skipLibCheck: true,
	target: ts.ScriptTarget.ES2023,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	types: ["node"],
};
const program = ts.createProgram([examplePath], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
	throw new Error(
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCurrentDirectory: () => root,
			getCanonicalFileName: (name) => name,
			getNewLine: () => "\n",
		}),
	);
}

const { default: extension, firstProcess } = await import("../docs/examples/first-process.ts");
const harness = await createExtensionTestHarness({ extensions: [extension] });
try {
	const fixture = harness.process(firstProcess, { params: { prompt: "Draft a response" } });
	const description = fixture.describe();
	assert.equal(description.entryTurnId, "draft");
	assert.deepEqual(
		description.turns.map((turn) => [turn.id, turn.kind]),
		[
			["draft", "llm"],
			["review", "human"],
		],
	);
	assert.deepEqual(description.transitions, [
		{ from: "draft", nextTurnId: "review", outcome: "draft" },
		{ from: "review", lifecycleStatus: "completed", trigger: "accept" },
	]);
	assert.deepEqual(await fixture.resolveLaunch("first_process.start", { prompt: "  Hello  " }), {
		ok: true,
		launchConfig: { processId: "first_process", startTurnId: "draft", params: { prompt: "Hello" } },
	});
	assert.equal((await fixture.resolveLaunch("first_process.start", { prompt: " " })).ok, false);
	assert.throws(() => firstProcess.paramsCodec.parse({ prompt: 42 }), /nonempty string/);
} finally {
	await harness.close();
}
console.log("Tutorial: TypeScript, module loading, graph, and launcher checks passed.");

// Markdown fragments are syntax-checked, not treated as complete configurations.
const markdown = new Map();
let fragments = 0;
for (const filename of (await readdir(path.join(root, "docs"))).sort()) {
	if (!filename.endsWith(".md")) continue;
	const text = await readFile(path.join(root, "docs", filename), "utf8");
	markdown.set(filename, text);
	for (const match of text.matchAll(/^```(json|yaml)\n([\s\S]*?)^```/gm)) {
		try {
			if (match[1] === "json") JSON.parse(match[2]);
			else parse(match[2]);
		} catch (error) {
			throw new Error(`Invalid ${match[1]} fragment in docs/${filename}`, { cause: error });
		}
		fragments += 1;
	}
}

const directory = await mkdtemp(path.join(tmpdir(), "leitwerk-doc-examples-"));
try {
	const base = parse(await readFile(path.join(root, "leitwerk.yaml.example"), "utf8"));
	const localBlock = markdown.get("introduction.md").match(/^```yaml\n([\s\S]*?)^```/m);
	assert.ok(localBlock, "Local walkthrough must include its YAML overrides");
	const local = parse(localBlock[1]);
	const merged = { ...base, ...local };
	for (const key of ["workers", "pi", "extensions"]) merged[key] = { ...base[key], ...local[key] };
	const configurations = [["local", merged]];
	for (const runner of ["docker", "kubernetes"]) {
		configurations.push([
			runner,
			parse(
				await readFile(path.join(root, `docs/examples/${runner}/leitwerk.example.yaml`), "utf8"),
			),
		]);
	}
	for (const [name, configuration] of configurations) {
		const filename = path.join(directory, `${name}.yaml`);
		await writeFile(filename, stringify(configuration));
		const result = loadConfig(filename);
		assert.equal(result.ok, true, result.ok ? name : `${name}: ${result.error}`);
		assert.equal(result.config.workers.runner, name);
		assert.notEqual(result.config.storage.sqlite_path, ":memory:");
		assert.ok(result.config.pi.model_profiles.length > 0);
		assert.ok(result.config.extension_loading.sources.length > 0);
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
console.log(
	`Configuration: local/Docker/Kubernetes schemas and ${fragments} Markdown fragments passed.`,
);
