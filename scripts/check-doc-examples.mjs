// Standalone documentation check. It does not start a server, worker, or provider.
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@leitwerk-dev/server";
import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import ts from "typescript";
import { parse } from "yaml";

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
const docsRoot = path.join(root, "docs");
let fragments = 0;
for await (const entry of glob("**/*.md", {
	cwd: docsRoot,
	exclude: ["**/{examples,assets,images}/**"],
	withFileTypes: true,
})) {
	if (!entry.isFile()) continue;
	const filename = path.relative(docsRoot, path.join(entry.parentPath, entry.name));
	const text = await readFile(path.join(docsRoot, filename), "utf8");
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

for (const runner of ["local", "docker", "kubernetes"]) {
	const filename = path.join(root, "docs/examples", runner, "leitwerk.example.yaml");
	const result = loadConfig(filename);
	assert.equal(result.ok, true, result.ok ? runner : `${runner}: ${result.error}`);
	assert.equal(result.config.workers.runner, runner);
	assert.notEqual(result.config.storage.sqlite_path, ":memory:");
	assert.ok(result.config.pi.model_profiles.length > 0);
	assert.ok(result.config.extension_loading.sources.length > 0);
}
console.log(
	`Configuration: local/Docker/Kubernetes schemas and ${fragments} Markdown fragments passed.`,
);
