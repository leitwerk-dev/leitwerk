import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	globSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const registry = "https://registry.npmjs.org/";
const version = "0.0.0-bootstrap.0";

export function bootstrapCatalog(root = fileURLToPath(new URL("../", import.meta.url))) {
	const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	const files = globSync(
		manifest.workspaces.map((pattern) => `${pattern}/package.json`),
		{ cwd: root },
	);
	return files
		.flatMap((file) => {
			const workspace = JSON.parse(readFileSync(path.join(root, file), "utf8"));
			if (workspace.private === true) return [];
			bootstrapManifest(workspace.name);
			return [{ name: workspace.name }];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export async function missingPackages(catalog, request = fetch) {
	const missing = [];
	for (const { name } of catalog) {
		const response = await request(`${registry}${encodeURIComponent(name)}`, {
			signal: AbortSignal.timeout(30_000),
		});
		if (response.status === 404) {
			missing.push(name);
			continue;
		}
		if (!response.ok) throw new Error(`npm lookup for ${name}: HTTP ${response.status}`);
		const metadata = await response.json();
		if (metadata.name !== name || !Object.keys(metadata.versions ?? {}).length) {
			throw new Error(`npm returned invalid or unpublished metadata for ${name}`);
		}
	}
	return missing;
}

export function bootstrapManifest(name) {
	if (!/^@leitwerk-dev\/[a-z0-9-]+$/u.test(name)) throw new Error("Invalid package name");
	return {
		name,
		version,
		description: "Registration placeholder only. Not a usable Leitwerk release.",
		license: "Apache-2.0",
		repository: { type: "git", url: "git+https://github.com/leitwerk-dev/leitwerk.git" },
		publishConfig: { access: "public", registry, tag: "bootstrap", provenance: false },
	};
}

export function bootstrapInstructions(missing) {
	return [
		"## npm package registration",
		"",
		...(missing.length
			? [
					"Manual bootstrap required before merging this release PR:",
					...missing.map((name) => `- \`${name}\``),
					"",
					"From a checkout of this release PR, run:",
					"```sh",
					"npm run publish:bootstrap",
					"```",
					"If not authenticated, run `npm login` first. Complete npm's browser/2FA prompts.",
					"This publishes only missing names as metadata-only `0.0.0-bootstrap.0` placeholders under `bootstrap`, not application code. It does not change `latest` or `next`.",
				]
			: ["All workspace package names are registered on npm."]),
		"",
		"The bootstrap command also configures stable publishing with `npm trust`: `leitwerk-dev/leitwerk`, `publish.yml`, `npm-publish`. Requires npm 11.16+ within npm 11 and an npm login with 2FA enabled.",
		"Matching publishers are skipped; conflicting publishers stop setup without being changed. Rerun to resume interrupted setup.",
		"Authentication and writes run directly in the terminal. Publisher checks use a separate structured JSON channel. CI checks registration only.",
		"",
	].join("\n");
}

export function publishBootstrap(names, run = spawnSync) {
	// Validate every name before the first external write.
	const manifests = names.map(bootstrapManifest);
	for (const manifest of manifests) {
		const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-npm-bootstrap-"));
		try {
			writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
			writeFileSync(path.join(directory, "README.md"), `${manifest.description}\n`);
			console.info(`Registering ${manifest.name}@${version} (bootstrap)`);
			const result = run(
				"npm",
				[
					"publish",
					directory,
					"--tag",
					"bootstrap",
					"--access",
					"public",
					"--registry",
					registry,
					"--ignore-scripts",
					"--provenance=false",
				],
				{ cwd: directory, stdio: "inherit" },
			);
			if (result.error) throw result.error;
			if (result.status !== 0)
				throw new Error(`Bootstrap failed for ${manifest.name}; rerun to resume`);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
}

function trustCommand(args, run) {
	const result = run("npm", [...args, "--registry", registry], { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`npm ${args.join(" ")} failed; rerun bootstrap to resume`);
}

export function readPublishers(name, run = spawnSync, npmCli = process.env.npm_execpath) {
	if (!npmCli) throw new Error("Run bootstrap through npm run publish:bootstrap");
	const result = run(
		process.execPath,
		[
			"--require",
			fileURLToPath(new URL("./npm-trust-json.cjs", import.meta.url)),
			realpathSync(npmCli),
			"trust",
			"list",
			name,
			"--registry",
			registry,
		],
		{ stdio: ["inherit", "inherit", "inherit", "pipe"], encoding: "utf8" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`npm trust list failed for ${name}; rerun to resume`);
	const response = JSON.parse(result.output[3]);
	if (response?.packageName !== name || !Array.isArray(response.publishers))
		throw new Error(`Invalid structured npm trust response for ${name}`);
	return response.publishers;
}

export function needsPublisher(publishers, name) {
	if (!Array.isArray(publishers)) throw new Error(`Invalid npm trust response for ${name}`);
	if (publishers.length === 0) return true;
	const config = publishers[0];
	if (
		publishers.length !== 1 ||
		config?.type !== "github" ||
		config.claims?.repository !== "leitwerk-dev/leitwerk" ||
		config.claims?.workflow_ref?.file !== "publish.yml" ||
		config.claims?.environment !== "npm-publish" ||
		!Array.isArray(config.permissions) ||
		!config.permissions.includes("createPackage")
	)
		throw new Error(`Conflicting trusted publisher for ${name}; refusing to overwrite it`);
	return false;
}

export function bootstrapPackages(
	catalog,
	missing,
	run = spawnSync,
	lookup = readPublishers,
	report = console.info,
) {
	// Validate every name and check existing publishers before the first external write.
	for (const { name } of catalog) bootstrapManifest(name);
	for (const name of missing) bootstrapManifest(name);
	const pending = [];
	for (const [index, { name }] of catalog.entries()) {
		const progress = `[${index + 1}/${catalog.length}] ${name}`;
		report(`${progress}: checking trusted publisher...`);
		if (missing.includes(name)) {
			pending.push(name);
			report(`${progress}: registration and publisher setup required`);
		} else if (needsPublisher(lookup(name), name)) {
			pending.push(name);
			report(`${progress}: publisher setup required`);
		} else {
			report(`${progress}: matching publisher; skipped`);
		}
	}
	publishBootstrap(missing, run);
	for (const [index, name] of pending.entries()) {
		report(`[${index + 1}/${pending.length}] ${name}: configuring trusted publisher...`);
		trustCommand(
			[
				"trust",
				"github",
				name,
				"--repo",
				"leitwerk-dev/leitwerk",
				"--file",
				"publish.yml",
				"--env",
				"npm-publish",
				"--allow-publish",
			],
			run,
		);
		report(`[${index + 1}/${pending.length}] ${name}: publisher configured`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const command = process.argv[2];
		if (!["check", "publish"].includes(command)) throw new Error("Expected check or publish");
		if (command === "publish" && process.env.CI)
			throw new Error("Bootstrap is a local, interactive operation");
		const catalog = bootstrapCatalog();
		const missing = await missingPackages(catalog);
		const instructions = bootstrapInstructions(missing);
		console.info(instructions);
		if (process.env.GITHUB_STEP_SUMMARY)
			appendFileSync(process.env.GITHUB_STEP_SUMMARY, instructions);
		if (command === "check") {
			if (missing.length) process.exitCode = 1;
		} else {
			bootstrapPackages(catalog, missing);
			console.info("Bootstrap complete. Stable trusted publishing is configured.");
		}
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
