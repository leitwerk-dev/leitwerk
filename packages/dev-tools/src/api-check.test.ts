import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { checkApi, classificationDiagnostics, interfaceReport } from "./api-check.js";
import { preserveDeclarationAnnotations } from "./api-declarations.js";
import { apiPackages, apiProgram, apiSurface } from "./api-surface.js";
import { consumerUsage, supportedClosure, usageInput } from "./api-usage.js";

const dirs: string[] = [];
function fixture(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "leitwerk-api-"));
	dirs.push(dir);
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), text);
	}
	return dir;
}
const manifest = (name: string) =>
	JSON.stringify({
		name,
		type: "module",
		exports: { ".": { source: "./src/index.ts", types: "./dist/index.d.ts" } },
	});
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("API classification", () => {
	it("classifies owned fields projected through a dependency's mapped type", () => {
		const root = fixture({
			"package.json": manifest("@leitwerk-dev/sdk"),
			"node_modules/schema/package.json": '{"name":"schema","types":"index.d.ts"}',
			"node_modules/schema/index.d.ts":
				"export type Output<T> = { [K in keyof T]: T[K] extends { value: infer V } ? V : never };",
			"src/index.ts": `
import type { Output } from 'schema';
const schema = { used: { value: 'a' }, unused: { value: 1 } };
export type Result = Output<typeof schema>;
`,
		});
		const consumer = fixture({
			"package.json": '{"name":"consumer","type":"module"}',
			"consumer.ts":
				"import type { Result } from '@leitwerk-dev/sdk'; declare const result: Result; result.used;",
		});
		const packages = apiPackages(root);
		const input = usageInput([consumer]);
		const surface = apiSurface(apiProgram(packages, input.files), packages);
		expect(surface.items.some((item) => item.name === "Output")).toBe(false);
		const used = consumerUsage(surface, [consumer], input, packages);
		const names = [...supportedClosure(used.used).keys()].map((item) => item.name);
		expect(names).toContain("schema.used");
		expect(names).toContain("schema");
		expect(names).not.toContain("schema.unused");
		expect(classificationDiagnostics(surface).join("\n")).toContain("schema.unused: missing");
	});

	it("attributes nested workspace declarations to their own package, including installed roots", () => {
		const container = fixture({
			"node_modules/@example/root/package.json": JSON.stringify({
				...JSON.parse(manifest("@example/root")),
				workspaces: ["packages/*"],
			}),
			"node_modules/@example/root/src/index.ts":
				"export { Shared } from '../packages/child/src/index.js';",
			"node_modules/@example/root/packages/child/package.json": manifest("@example/child"),
			"node_modules/@example/root/packages/child/src/index.ts":
				"/** @public */ export interface Shared {\n/** @internal */ unused: string;\n}",
		});
		const packages = apiPackages(path.join(container, "node_modules/@example/root"));
		const surface = apiSurface(apiProgram(packages), packages);
		expect(classificationDiagnostics(surface)).toEqual([]);
		expect(surface.items.map((item) => item.id)).toEqual([
			"@example/child/src/index.ts#Shared",
			"@example/child/src/index.ts#Shared.unused",
		]);
		expect(surface.exports.get("@example/root#Shared")).toEqual(
			surface.exports.get("@example/child#Shared"),
		);
	});

	it("requires individual tags, checks conflicts and signature dependencies across re-exports", () => {
		const root = fixture({
			"package.json": manifest("@example/sdk"),
			"src/index.ts": `/** @internal */ export { Contract as Renamed, exposed } from './contract.js';`,
			"src/contract.ts": `
/** @internal */ export interface Detail { /** @internal */ value: string }
/** @public */ export interface Contract {
  /** @public */ used(): Detail;
  /** @internal */ unused(): void;
  missing(): void;
}
/** @public @internal */ export function exposed(): void {}
`,
		});
		const packages = apiPackages(root);
		const surface = apiSurface(apiProgram(packages), packages);
		const errors = classificationDiagnostics(surface).join("\n");
		expect(errors).toContain("Contract.missing: missing");
		expect(errors).toContain("Renamed: conflicting re-export annotation");
		expect(errors).toContain("exposed: conflicting");
		expect(errors).toContain("Contract.used: supported signature depends on internal");
		expect(errors).not.toContain("Contract.unused: supported");
		expect(interfaceReport(surface, packages[0])).toContain("@example/sdk#Renamed");
	});

	it("reports signature, classification and export drift while allowing internal APIs", () => {
		const root = fixture({
			"package.json": manifest("@example/sdk"),
			"src/index.ts":
				"/** @internal */ export function helper(value: string): string { return value; }",
		});
		expect(checkApi(root).join("\n")).toContain("interface report drift");
		expect(checkApi(root, true)).toEqual([]);
		expect(checkApi(root)).toEqual([]);
		writeFileSync(
			path.join(root, "src/index.ts"),
			"/** @public */ export function helper(value: number): number { return value; }",
		);
		expect(checkApi(root).join("\n")).toContain("interface report drift");
	});

	it("traces capability returns, callbacks, supplied contracts, inheritance and indexed types individually", () => {
		const root = fixture({
			"package.json": manifest("@leitwerk-dev/sdk"),
			"src/index.ts": `
export interface Options { tools?: string[]; guard?: () => void; }
export interface Client { used(): void; unused(): void; callback(run: (options: Options) => void): void; }
export interface Token<T> { type?: T }
export declare const client: Token<Client>;
export declare function get<T>(token: Token<T>): T;
export declare function supply(value: Client): void;
export class Base { inherited(): void {} untouched(): void {} }
export const API_VERSION = 1;
export default { setup() {} };
`,
		});
		const consumer = fixture({
			"package.json": JSON.stringify({ name: "consumer", type: "module", workspaces: ["local"] }),
			"local/package.json": manifest("@private/sdk"),
			"local/src/index.ts": "export class Base { untouched(): void {} }",
			"consumer.ts": `
import { get, client, supply, Base, type Options, type Client } from '@leitwerk-dev/sdk';
import { Base as Private } from '@private/sdk';
get(client).used();
const { callback } = get(client);
callback(options => options.tools);
type Tools = Options['tools'];
get(client)['used']();
const forward = (options: Options) => ({ ...options, tools: options.tools });
const supplied = { used() {}, unused() {}, callback(run: (options: Options) => void) {} };
supply(supplied);
class Derived extends Base { inherited() {} }
new Derived().inherited();
new Private().untouched();
const { API_VERSION } = await import('@leitwerk-dev/sdk');
`,
			"script.mjs":
				'const code = `const { API_VERSION } = await import("@leitwerk-dev/sdk"); console.log(API_VERSION);`;',
			"leitwerk.composition.yaml": "extensions:\n  - '@leitwerk-dev/sdk'\n",
			"node_modules/ignored.ts":
				"import { Base } from '@leitwerk-dev/sdk'; new Base().untouched();",
			"dist/ignored.ts": "import { Base } from '@leitwerk-dev/sdk'; new Base().untouched();",
			"docs/ignored.ts": "import { Base } from '@leitwerk-dev/sdk'; new Base().untouched();",
			".github/check.ts":
				"import { API_VERSION } from '@leitwerk-dev/sdk'; console.log(API_VERSION);",
			"core-copy/package.json": '{"name":"leitwerk","workspaces":["packages/*"]}',
			"core-copy/ignored.ts": "import { Base } from '@leitwerk-dev/sdk'; new Base().untouched();",
		});
		const packages = apiPackages(root);
		const input = usageInput([consumer]);
		const program = apiProgram([...packages, ...apiPackages(consumer)], input.files, input.virtual);
		expect(input.files).toContain(path.join(consumer, ".github/check.ts"));
		expect(input.files).not.toContain(path.join(consumer, "core-copy/ignored.ts"));
		const surface = apiSurface(program, packages);
		const result = consumerUsage(surface, [consumer], input, packages);
		const names = [...supportedClosure(result.used).keys()].map((item) => item.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"get",
				"Client.used",
				"Client.callback",
				"Client.unused",
				"Options.tools",
				"Base.inherited",
				"API_VERSION",
			]),
		);
		expect(names).not.toContain("Options.guard");
		expect(names).not.toContain("Base.untouched");
		expect(
			[...result.used].some(
				([item, evidence]) =>
					item.name === "API_VERSION" && evidence.some((e) => e.kind.startsWith("embedded ")),
			),
		).toBe(true);
		expect([...result.used.values()].flat().some((e) => e.kind === "composition loading")).toBe(
			true,
		);
	});

	it("diagnoses unresolved imports and members without attributing usage to a similarly named API", () => {
		const root = fixture({
			"package.json": manifest("@leitwerk-dev/sdk"),
			"src/index.ts": "export const actual = { sameName() {} };",
		});
		const consumer = fixture({
			"package.json": '{"name":"consumer","type":"module"}',
			"consumer.ts":
				"import { missing, actual } from '@leitwerk-dev/sdk'; missing.sameName(); actual.absent();",
		});
		const packages = apiPackages(root);
		const input = usageInput([consumer]);
		const surface = apiSurface(apiProgram(packages, input.files), packages);
		const usage = consumerUsage(surface, [consumer], input, packages);
		expect(usage.diagnostics.some((d) => d.message.includes("#missing"))).toBe(true);
		expect(usage.diagnostics.some((d) => d.message.includes("absent"))).toBe(true);
		expect([...usage.used.keys()].map((i) => i.name)).not.toContain("actual.sameName");
	});

	it("preserves public and internal declarations, including inferred members, through declaration emit", () => {
		const root = fixture({
			"package.json": manifest("@example/sdk"),
			"src/index.ts": `
/** @public */
export const api = {
  /** @public */
  supported(value: string) { return value; },
  /** @internal */
  internal(value: number) { return value; },
};
/** @public */
export const projected = { ...api };
`,
		});
		const program = ts.createProgram([path.join(root, "src/index.ts")], {
			declaration: true,
			declarationMap: true,
			outDir: path.join(root, "dist"),
			skipLibCheck: true,
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ESNext,
		});
		expect(program.emit().emitSkipped).toBe(false);
		const declaration = readFileSync(path.join(root, "dist/index.d.ts"), "utf8");
		expect(declaration).toContain("@public");
		expect(declaration).toContain("@internal");
		expect(declaration).toContain("supported(value: string): string");
		expect(declaration).toContain("internal(value: number): number");
		expect(preserveDeclarationAnnotations(root, true)).toEqual([]);
		expect(preserveDeclarationAnnotations(root, false)).toEqual([]);
		const packages = apiPackages(root, "types");
		const surface = apiSurface(apiProgram(packages), packages);
		expect(surface.items.find((i) => i.name === "projected.internal")?.tags).toEqual(["internal"]);
		expect(surface.items.find((i) => i.name === "projected.supported")?.tags).toEqual(["public"]);
		writeFileSync(
			path.join(root, "use.ts"),
			"import { api, projected } from './dist/index.js'; const a: string = api.supported('a'); const b: number = api.internal(1); const c: number = projected.internal(2);",
		);
		const consumer = ts.createProgram([path.join(root, "use.ts")], {
			noEmit: true,
			skipLibCheck: true,
			strict: true,
		});
		expect(consumer.getSemanticDiagnostics()).toEqual([]);
	});
});
