import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { checkApi, classificationDiagnostics } from "./api-check.js";
import { preserveDeclarationAnnotations } from "./api-declarations.js";
import { apiPackages, apiProgram, apiSurface } from "./api-surface.js";

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
	});

	it("accepts classified internal APIs and rejects missing classifications", () => {
		const root = fixture({
			"package.json": manifest("@example/sdk"),
			"src/index.ts":
				"/** @internal */ export function helper(value: string): string { return value; }",
		});
		expect(checkApi(root)).toEqual([]);
		writeFileSync(
			path.join(root, "src/index.ts"),
			"export function helper(value: number): number { return value; }",
		);
		expect(checkApi(root).join("\n")).toContain("missing @public or @internal");
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
