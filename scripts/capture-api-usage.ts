import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
	annotationNode,
	apiPackages,
	apiProgram,
	apiSurface,
} from "../packages/dev-tools/src/api-surface.js";
import {
	consumerUsage,
	supportedClosure,
	usageInput,
} from "../packages/dev-tools/src/api-usage.js";

const { values } = parseArgs({
	options: {
		consumer: { type: "string", multiple: true },
		annotate: { type: "boolean" },
		output: { type: "string" },
	},
});
const roots = (values.consumer ?? []).map((root) => path.resolve(root));
if (!roots.length) throw new Error("Pass --consumer PATH for each consumer working tree.");
const root = process.cwd();
const output = path.resolve(values.output ?? "api-reports/initial-usage.json");
if (values.annotate && existsSync(output))
	throw new Error(
		"Initial evidence already exists. Later classifications require explicit review; usage loss never demotes a public API.",
	);
const packages = apiPackages(root);
const input = usageInput(roots);
console.info(
	`Inspecting ${input.files.length} source files and ${input.virtual.size} embedded programs`,
);
const program = apiProgram(
	[...packages, ...roots.flatMap((consumer) => apiPackages(consumer))],
	input.files,
	input.virtual,
);
const surface = apiSurface(program, packages);
console.info(`Found ${surface.items.length} exposed declarations and members`);
const usage = consumerUsage(surface, roots, input, packages);
const support = supportedClosure(usage.used);
const snapshot = (consumer: string) => ({
	consumer: path.basename(consumer),
	head: execFileSync("git", ["-C", consumer, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	workingTree: execFileSync("git", ["-C", consumer, "status", "--short"], { encoding: "utf8" })
		.trim()
		.split("\n")
		.filter(Boolean),
});
const report = {
	policy:
		"Initial working-tree usage, including supplied contracts and named supporting types. Later absence of usage does not revoke @public compatibility.",
	consumers: roots.map(snapshot),
	sourceFiles: input.files.length,
	embeddedPrograms: input.virtual.size,
	entryPoints: usage.imports,
	composition: input.composition.map(({ file, entry }) => ({
		file: path.relative(path.dirname(root), file),
		entry,
	})),
	diagnostics: usage.diagnostics,
	public: Object.fromEntries(
		[...support]
			.sort(([a], [b]) => a.id.localeCompare(b.id))
			.map(([item, reasons]) => [item.id, { reasons, evidence: usage.used.get(item) ?? [] }]),
	),
};
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.info(
	`${support.size} public, ${surface.items.length - support.size} internal, ${usage.diagnostics.length} unresolved diagnostics; ${output}`,
);
if (values.annotate) {
	const edits = new Map<string, Map<number, string>>();
	for (const item of surface.items) {
		if (item.tags.length) continue;
		const node = annotationNode(item.node);
		const source = node.getSourceFile();
		const start = node.getStart();
		const prefix = source.text.slice(source.text.lastIndexOf("\n", start - 1) + 1, start);
		const indentation = prefix.match(/^\s*/)?.[0] ?? "";
		const tag = support.has(item) ? "public" : "internal";
		const text = /^\s*$/.test(prefix)
			? `/** @${tag} */\n${indentation}`
			: `\n${indentation}\t/** @${tag} */\n${indentation}\t`;
		const fileEdits = edits.get(source.fileName) ?? new Map<number, string>();
		if (fileEdits.has(start) && fileEdits.get(start) !== text)
			throw new Error(`Split mixed variable declaration ${item.id} before annotating`);
		fileEdits.set(start, text);
		edits.set(source.fileName, fileEdits);
	}
	for (const [file, changes] of edits) {
		let text = readFileSync(file, "utf8");
		for (const [offset, insertion] of [...changes].sort(([a], [b]) => b - a))
			text = text.slice(0, offset) + insertion + text.slice(offset);
		writeFileSync(file, text);
	}
}
