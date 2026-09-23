import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { run } from "./command.js";
import { loadWorkspaceComposition } from "./composition.js";
import { isInside, packageDirectory, readJson, workspacePackages } from "./workspace.js";

/** @internal */
export interface DevelopmentOptions {
	/** @internal */
	workspaceRoot?: string;
	/** @internal */
	compositionPath?: string;
	/** @internal */
	checkout?: string;
	/** @internal */
	repository?: string;
	/** @internal */
	revision?: string;
}

interface Selection {
	mode: "release" | "local" | "switching";
	checkout?: string;
	privateLock?: string;
	publicLock?: string;
}

export function workspaceRoot(options: DevelopmentOptions): string {
	return realpathSync(path.resolve(options.workspaceRoot ?? process.cwd()));
}

export function compositionPath(options: DevelopmentOptions): string {
	return path.resolve(
		workspaceRoot(options),
		options.compositionPath ?? "leitwerk.composition.yaml",
	);
}

function statePath(root: string) {
	return path.join(root, ".leitwerk", "development.json");
}
function hash(file: string) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function consumers(root: string) {
	return [root, ...workspacePackages(root).map((entry) => entry.dir)];
}

function readSelection(root: string): Selection {
	const file = statePath(root);
	if (!existsSync(file)) return { mode: "release" };
	const state = readJson<Selection>(file);
	if (!state || !["release", "local", "switching"].includes(state.mode))
		throw new Error("Invalid development selection; run core:use-local or core:use-release");
	return state;
}

function writeSelection(root: string, state: Selection) {
	const file = statePath(root);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(`${file}.tmp`, file);
}

export function assertSelection(options: DevelopmentOptions): Selection {
	const root = workspaceRoot(options);
	const selection = readSelection(root);
	if (selection.mode === "switching")
		throw new Error("Dependency switch did not finish. Rerun core:use-local or core:use-release.");
	if (selection.mode === "local") {
		const checkout = realpathSync(selection.checkout ?? path.join(root, ".leitwerk-base"));
		if (
			selection.privateLock !== hash(path.join(root, "package-lock.json")) ||
			selection.publicLock !== hash(path.join(checkout, "package-lock.json"))
		)
			throw new Error("Dependencies changed. Run core:use-local again.");
		for (const source of workspacePackages(checkout)) {
			for (const consumer of consumers(root)) {
				if (packageDirectory(source.name, consumer) !== source.dir)
					throw new Error(
						`${source.name} does not resolve to local source. Run core:use-local again.`,
					);
			}
		}
		return { ...selection, checkout };
	}
	for (const consumer of consumers(root)) {
		const manifest = readJson(path.join(consumer, "package.json"));
		for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
			if (!name.startsWith("@leitwerk-dev/")) continue;
			const installed = packageDirectory(name, consumer);
			if (
				!isInside(path.join(root, "node_modules"), installed) &&
				!isInside(path.join(consumer, "node_modules"), installed)
			)
				throw new Error(`${name} is linked to source in release mode. Run core:use-release.`);
		}
	}
	return selection;
}

export function localComposition(options: DevelopmentOptions, checkout: string): string {
	const input = loadWorkspaceComposition(compositionPath(options));
	const file = path.join(workspaceRoot(options), ".leitwerk", "development.composition.yaml");
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(
		file,
		stringify({
			version: 1,
			leitwerk: { root: checkout },
			workspace_root: input.workspaceRoot,
			runtime_config: input.runtimeConfigPath,
			extensions: input.extensionDirs,
			test_roots: input.testRoots,
			...(Object.keys(input.sandboxes).length ? { sandboxes: input.sandboxes } : {}),
		}),
	);
	return file;
}

function linkPackages(root: string, checkout: string) {
	for (const consumer of consumers(root)) {
		for (const source of workspacePackages(checkout)) {
			const target = path.join(consumer, "node_modules", source.name);
			mkdirSync(path.dirname(target), { recursive: true });
			// Unlink only the installed package, never its target or the source checkout.
			if (lstatSync(target, { throwIfNoEntry: false }))
				rmSync(target, { recursive: true, force: true });
			symlinkSync(path.relative(path.dirname(target), source.dir), target, "dir");
		}
	}
}

export async function useLocal(options: DevelopmentOptions): Promise<void> {
	const root = workspaceRoot(options);
	const retained = readSelection(root).checkout;
	const checkout = path.resolve(root, options.checkout ?? retained ?? ".leitwerk-base");
	if (realpathSync(root) === checkout || isInside(path.join(root, "node_modules"), checkout))
		throw new Error("Core checkout must be separate from the workspace and installed packages");
	if (!existsSync(checkout)) {
		const lockFile = path.join(root, "leitwerk-base.lock.yaml");
		const lock = existsSync(lockFile) ? parse(readFileSync(lockFile, "utf8")) : undefined;
		const revision: unknown = options.revision ?? lock?.public_git_sha;
		if (typeof revision !== "string" || !revision.trim() || revision.startsWith("-"))
			throw new Error(
				"A new checkout requires --revision or a release lock containing public_git_sha",
			);
		await run(
			"git",
			[
				"clone",
				"--filter=blob:none",
				"--",
				options.repository ?? "https://github.com/leitwerk-dev/leitwerk.git",
				checkout,
			],
			{ cwd: root },
		);
		await run("git", ["fetch", "origin", revision], { cwd: checkout });
		await run("git", ["switch", "-c", "development", "FETCH_HEAD"], { cwd: checkout });
	}
	const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: checkout,
		encoding: "utf8",
	}).trim();
	if (realpathSync(topLevel) !== realpathSync(checkout) || realpathSync(checkout) === root)
		throw new Error("Core path must be a separate Git checkout");
	writeSelection(root, { mode: "switching", checkout });
	await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], { cwd: checkout });
	await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], { cwd: root });
	linkPackages(root, realpathSync(checkout));
	const env = { ...process.env };
	delete env.LEITWERK_COMPOSITION_PATH;
	await run("npm", ["run", "build"], { cwd: checkout, env });
	await run("npm", ["run", "--if-present", "build:ext-ui"], { cwd: checkout, env });
	localComposition(options, checkout);
	writeSelection(root, {
		mode: "local",
		checkout: realpathSync(checkout),
		privateLock: hash(path.join(root, "package-lock.json")),
		publicLock: hash(path.join(checkout, "package-lock.json")),
	});
	console.info(`Using local core at ${checkout}. Its branch and edits are preserved.`);
}

export async function useRelease(options: DevelopmentOptions): Promise<void> {
	const root = workspaceRoot(options);
	const checkout = readSelection(root).checkout;
	writeSelection(root, { mode: "switching", checkout });
	await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], { cwd: root });
	writeSelection(root, { mode: "release", checkout });
	console.info("Using released npm packages. The core checkout and branches are retained.");
}
