import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getDefaultConfig, type LeitwerkConfig } from "@leitwerk-dev/server";
import { parse } from "yaml";
import type { SandboxInput } from "./index.js";
import { assertSandboxPath } from "./storage.js";

export const SANDBOX_MODEL_PROVIDER = "sandbox-model";
export const SANDBOX_MODEL_ID = "scripted";

function readPrivateFile(root: string, file: string): string | undefined {
	assertSandboxPath(root, file);
	if (!existsSync(file)) return undefined;
	if ((lstatSync(file).mode & 0o777) !== 0o600)
		throw new Error(`${path.relative(root, file)} must have mode 0600`);
	return readFileSync(file, "utf8");
}

/**
 * Read `<workspace>/.leitwerk/sandbox/<name>.yaml`, the composition's private local
 * settings. Returns `undefined` when absent. Reset and preflight retain the file.
 * @public
 */
export function readSandboxSettings(input: SandboxInput, name: string): unknown {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
		throw new Error("Sandbox settings names must be lowercase kebab-case");
	const root = path.join(input.paths.workspaceRoot, ".leitwerk", "sandbox");
	const contents = readPrivateFile(input.paths.workspaceRoot, path.join(root, `${name}.yaml`));
	return contents === undefined ? undefined : parse(contents);
}

export function configureSandboxStorage(
	config: LeitwerkConfig,
	paths: SandboxInput["paths"],
): void {
	config.storage = {
		sqlite_path: path.join(paths.directory, "application.sqlite"),
		tree_files_dir: path.join(paths.directory, "trees"),
		process_workspaces_dir: path.join(paths.directory, "workspaces"),
	};
	config.pi.agent_dir = path.join(paths.directory, "pi-agent");
	for (const candidate of [...Object.values(config.storage), config.pi.agent_dir])
		assertSandboxPath(paths.root, candidate);
}
/** @public */
export function sandboxConfig(input: SandboxInput): LeitwerkConfig {
	const config = getDefaultConfig();
	config.server = {
		...config.server,
		host: "127.0.0.1",
		port: Number(new URL(input.urls.backend).port),
		base_url: input.urls.backend,
	};
	configureSandboxStorage(config, input.paths);
	config.workers.runner = "local";
	if (config.local_worker) config.local_worker.allow_host_docker = true;
	config.pi.model_profiles = [
		{
			id: "sandbox",
			provider: SANDBOX_MODEL_PROVIDER,
			model_id: SANDBOX_MODEL_ID,
			thinking_level: "off",
		},
	];
	config.pi.process_title_generation.model_profile = null;
	config.pi.retry.enabled = false;
	config.extension_loading.sources = [];
	if (input.mode === "real") {
		const contents = readPrivateFile(input.paths.root, path.join(input.paths.root, "model.json"));
		if (contents === undefined)
			throw new Error(
				"Real mode requires dedicated .leitwerk/sandbox/model.json. See the sandbox README.",
			);
		const model = JSON.parse(contents);
		if (!Array.isArray(model.model_profiles) || !model.model_profiles.length || !model.providers)
			throw new Error("model.json requires model_profiles and providers");
		config.pi.model_profiles = model.model_profiles;
		config.extensions.models = model.providers;
	}
	return config;
}
export function prepareSandboxDirectory(input: SandboxInput): void {
	assertSandboxPath(input.paths.root, input.paths.directory);
	mkdirSync(input.paths.directory, { recursive: true, mode: 0o700 });
	chmodSync(input.paths.directory, 0o700);
}
