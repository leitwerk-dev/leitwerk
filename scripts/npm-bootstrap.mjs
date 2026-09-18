import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	globSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

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
		"The bootstrap command also configures stable publishing with `npm trust`: `leitwerk-dev/leitwerk`, `publish.yml`, `npm-publish`. Requires npm 11.16+ and an npm login with 2FA enabled.",
		"Existing matching publishers are retained; conflicting publishers are never overwritten. Rerun the command to resume interrupted setup.",
		"Package existence does not verify trusted-publisher settings. The local bootstrap command checks them for every package; the unauthenticated CI check cannot.",
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

function trustCommand(args, run, capture = false) {
	const result = run("npm", [...args, "--registry", registry], {
		encoding: "utf8",
		stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`npm ${args.join(" ")} failed; rerun bootstrap to resume`);
	return result.stdout?.trim() ?? "";
}

export function needsPublisher(output, name) {
	if (!output) return true; // npm trust list --json prints nothing when no trust exists.
	const config = JSON.parse(output);
	if (
		config.type !== "github" ||
		config.repository !== "leitwerk-dev/leitwerk" ||
		config.file !== "publish.yml" ||
		config.environment !== "npm-publish" ||
		!config.permissions?.includes("createPackage")
	)
		throw new Error(`Conflicting trusted publisher for ${name}; refusing to overwrite it`);
	return false;
}

export function trustTranscript(transcript) {
	const text = stripVTControlCharacters(transcript);
	const configurations = [];
	// npm emits a JSON object per publisher, plus optional browser-auth metadata.
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start)) {
		let depth = 0;
		let quoted = false;
		let escaped = false;
		let end = start;
		for (; end < text.length; end++) {
			const char = text[end];
			if (quoted) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') quoted = false;
			} else if (char === '"') quoted = true;
			else if (char === "{") depth++;
			else if (char === "}" && --depth === 0) break;
		}
		if (end === text.length) throw new Error("Incomplete npm trust response");
		const value = JSON.parse(text.slice(start, end + 1));
		if (!(typeof value.title === "string" && typeof value.url === "string" && !value.type)) {
			configurations.push(value);
		}
		start = end + 1;
	}
	if (configurations.length > 1) throw new Error("Unexpected multiple npm trust configurations");
	return configurations.length ? JSON.stringify(configurations[0]) : "";
}

export function terminalCommand(
	command,
	args,
	options,
	run = spawnSync,
	platform = process.platform,
) {
	if (!Array.isArray(options.stdio)) return run(command, args, options);
	if (!["darwin", "linux"].includes(platform))
		throw new Error("Bootstrap supports macOS and Linux only");
	const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-npm-trust-"));
	const transcript = path.join(directory, "output");
	try {
		// Keep npm's stdin AND stdout attached to a terminal: otplease refuses 2FA otherwise.
		// The private temporary directory protects browser-auth URLs in the transcript.
		const quote = (arg) => `'${arg.replaceAll("'", "'\\''")}'`;
		const scriptArgs =
			platform === "darwin"
				? ["-q", transcript, command, ...args]
				: ["-q", "-e", "-c", [command, ...args].map(quote).join(" "), transcript];
		const result = run("script", scriptArgs, {
			stdio: "inherit",
			env: { ...process.env, NO_COLOR: "1" },
		});
		return {
			...result,
			stdout: result.status === 0 ? trustTranscript(readFileSync(transcript, "utf8")) : "",
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export function bootstrapPackages(catalog, missing, run = terminalCommand) {
	const result = run("npm", ["--version"], { encoding: "utf8" });
	const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(result.stdout?.trim() ?? "");
	if (
		result.status !== 0 ||
		!match ||
		Number(match[1]) < 11 ||
		(Number(match[1]) === 11 && Number(match[2]) < 16)
	) {
		throw new Error("Bootstrap requires npm 11.16+ (npm install -g npm@11.16.0)");
	}
	const pending = [];
	// Check all existing publishers before creating packages or trust relationships.
	for (const { name } of catalog) {
		bootstrapManifest(name);
		if (
			missing.includes(name) ||
			needsPublisher(trustCommand(["trust", "list", name, "--json"], run, true), name)
		) {
			pending.push(name);
		}
	}
	publishBootstrap(missing, run);
	for (const name of pending) {
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
				"--yes",
			],
			run,
		);
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
