import path from "node:path";
import { parseArgs } from "node:util";
import { preserveDeclarationAnnotations } from "./api-declarations.js";
import { type ApiSurface, apiPackages, apiProgram, apiSurface } from "./api-surface.js";

export function classificationDiagnostics(surface: ApiSurface): string[] {
	const diagnostics = [...surface.diagnostics];
	for (const item of surface.items) {
		if (!item.tags.length) diagnostics.push(`${item.id}: missing @public or @internal`);
		if (new Set(item.tags).size > 1)
			diagnostics.push(`${item.id}: conflicting @public and @internal`);
		if (!item.tags.includes("public")) continue;
		for (const dependency of [...item.dependencies, ...(item.parent ? [item.parent] : [])])
			if (!dependency.tags.includes("public"))
				diagnostics.push(`${item.id}: supported signature depends on internal ${dependency.id}`);
	}
	return diagnostics;
}

export function checkApi(root: string): string[] {
	const packages = apiPackages(root);
	if (!packages.length)
		return [
			"No typed package entry points found; add package.json exports with source or types conditions.",
		];
	return classificationDiagnostics(apiSurface(apiProgram(packages), packages));
}

export function runApiCheckCli(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: {
			workspace: { type: "string" },
			built: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.info(
			"Usage: leitwerk-dev api:check [--workspace PATH] [--built]\nChecks explicit release tags and supported signature dependencies.\n--built also verifies both classifications survive declaration emission.",
		);
		return;
	}
	const root = path.resolve(values.workspace ?? process.cwd());
	const diagnostics = checkApi(root);
	if (values.built && !diagnostics.length)
		diagnostics.push(...preserveDeclarationAnnotations(root, false));
	if (diagnostics.length) throw new Error(diagnostics.join("\n"));
	console.info("API classification is valid.");
}
