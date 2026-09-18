import { existsSync } from "node:fs";
import path from "node:path";
import { run } from "./command.js";
import {
	assertSelection,
	type DevelopmentOptions,
	localComposition,
	useLocal,
	useRelease,
	workspaceRoot,
} from "./selection.js";
import { orderedPackages, packageDirectory, readJson, workspacePackages } from "./workspace.js";

/** @internal */
export type DevelopmentCommand =
	| "dev"
	| "build"
	| "typecheck"
	| "test:full"
	| "core:use-local"
	| "core:use-release"
	| "core:status";

export async function build(root: string): Promise<void> {
	for (const entry of orderedPackages(workspacePackages(root))) {
		for (const script of ["build", "build:ext-ui"]) {
			if (entry.scripts?.[script]) await run("npm", ["run", script], { cwd: entry.dir });
		}
	}
}

async function tool(root: string, name: string, bin: string, args: string[]) {
	const directory = packageDirectory(name, root);
	const manifest = readJson(path.join(directory, "package.json"));
	const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
	if (!entry) throw new Error(`${name} does not expose ${bin}`);
	await run(process.execPath, [path.resolve(directory, entry), ...args], { cwd: root });
}

async function hook(root: string, name: string) {
	if (readJson(path.join(root, "package.json")).scripts?.[name])
		await run("npm", ["run", name], { cwd: root });
}

/** Run against installed dependencies unless source mode was explicitly selected. */
/** @internal */
export async function runDevelopment(
	command: DevelopmentCommand,
	options: DevelopmentOptions = {},
): Promise<void> {
	if (command === "core:use-local") return useLocal(options);
	if (command === "core:use-release") return useRelease(options);
	const root = workspaceRoot(options);
	const selection = assertSelection(options);
	if (command === "core:status") {
		console.info(
			selection.mode === "local" ? `Local core: ${selection.checkout}` : "Released npm packages",
		);
		return;
	}
	if (!["dev", "build", "typecheck", "test:full"].includes(command))
		throw new Error(`Unknown command: ${command}`);
	if (command === "test:full") {
		await tool(root, "@biomejs/biome", "biome", ["ci", "."]);
		await hook(root, "leitwerk:before-test");
	}
	if (selection.mode === "local") {
		const checkout = selection.checkout as string;
		await run("npm", ["run", command], {
			cwd: checkout,
			env: { ...process.env, LEITWERK_COMPOSITION_PATH: localComposition(options, checkout) },
		});
	} else if (command === "dev") {
		await (await import("./dev.js")).develop(options);
	} else if (command === "build") {
		await build(root);
	} else {
		if (command === "test:full") await build(root);
		await tool(root, "typescript", "tsc", ["-b", "--force"]);
		if (command === "test:full") {
			await tool(root, "vitest", "vitest", ["run"]);
			if (
				["ts", "mts", "js", "mjs", "cts", "cjs"].some((extension) =>
					existsSync(path.join(root, `playwright.config.${extension}`)),
				)
			)
				await tool(root, "@playwright/test", "playwright", ["test"]);
		}
	}
	if (["typecheck", "test:full"].includes(command)) await hook(root, "leitwerk:after-typecheck");
}
