import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { parseSkillPackManifest, type SkillPackManifest } from "@leitwerk-dev/protocol";
import { parse as parseYaml } from "yaml";

const exec = promisify(execFile);
const gitEnv = {
	...process.env,
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "/bin/false",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
};
const RECIPE = "skill-pack.json";
const VENDOR = "upstream";
const WORK = ".skill-pack/work";
const PATCH = "patches/leitwerk.patch";

interface Recipe {
	upstream: SkillPackManifest["upstream"];
	licenses: string[];
	skills: { id: string; sourcePath: string; dependencies: string[] }[];
}

function contained(root: string, relative: string): string {
	if (
		!relative ||
		relative.includes("\\") ||
		relative.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
	) {
		throw new Error(`Invalid skill-pack path '${relative}'`);
	}
	return path.join(root, relative);
}

async function recipeAt(root: string): Promise<Recipe> {
	const value = JSON.parse(await readFile(path.join(root, RECIPE), "utf8")) as Recipe;
	if (
		!Array.isArray(value.licenses) ||
		!value.licenses.length ||
		value.licenses.some((item) => typeof item !== "string")
	) {
		throw new Error("Skill-pack recipe must list upstream license files");
	}
	for (const license of value.licenses) contained(root, license);
	parseSkillPackManifest({
		formatVersion: 1,
		upstream: value.upstream,
		patchDigest: "0".repeat(64),
		skills: value.skills?.map((entry) => ({
			...entry,
			directory: entry.id,
			label: entry.id,
			description: entry.id,
		})),
	});
	return value;
}

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		return (await exec("git", ["-C", cwd, ...args], { env: gitEnv, maxBuffer: 16 * 1024 * 1024 }))
			.stdout;
	} catch (error) {
		const failure = error as Error & { stderr?: string; stdout: string; code?: number };
		// A no-index diff exits with 1 when the trees differ.
		if (args[0] === "diff" && failure.code === 1) return failure.stdout;
		throw new Error(`Skill-pack git ${args[0]} failed: ${failure.stderr || failure.message}`, {
			cause: error,
		});
	}
}

async function regularFiles(root: string): Promise<string[]> {
	const result: string[] = [];
	async function visit(relative: string): Promise<void> {
		const target = relative ? contained(root, relative) : root;
		const stat = await lstat(target);
		if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
			throw new Error(`Skill pack requires regular files: ${target}`);
		if (stat.isFile()) {
			result.push(relative);
			return;
		}
		for (const name of (await readdir(target)).sort()) {
			await visit(relative ? `${relative}/${name}` : name);
		}
	}
	await visit("");
	return result;
}

async function copyTree(source: string, destination: string): Promise<void> {
	await regularFiles(source);
	await cp(source, destination, { recursive: true });
}

async function withTemp<T>(run: (root: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-skill-pack-"));
	try {
		return await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function patchBytes(root: string): Promise<Buffer> {
	return readFile(path.join(root, PATCH));
}

async function patchedCopy(root: string, destination: string): Promise<Buffer> {
	await copyTree(path.join(root, VENDOR), destination);
	const patch = await patchBytes(root);
	if (!patch.length) return patch;
	const patchPath = path.join(path.dirname(destination), "adaptation.patch");
	await writeFile(patchPath, patch);
	await git(destination, ["apply", "--no-index", "--check", patchPath]);
	await git(destination, ["apply", "--no-index", patchPath]);
	await regularFiles(destination);
	return patch;
}

async function replaceDirectory(source: string, destination: string): Promise<void> {
	await mkdir(path.dirname(destination), { recursive: true });
	// Rename on the destination filesystem, restoring the previous output on failure.
	const staged = await mkdtemp(path.join(path.dirname(destination), ".skill-pack-output-"));
	const backup = `${staged}-previous`;
	let previous = false;
	let published = false;
	try {
		await cp(source, staged, { recursive: true });
		try {
			await rename(destination, backup);
			previous = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await rename(staged, destination);
			published = true;
		} catch (error) {
			if (previous) await rename(backup, destination);
			throw error;
		}
	} finally {
		await rm(staged, { recursive: true, force: true });
		if (published) await rm(backup, { recursive: true, force: true });
	}
}

async function validateSkill(
	root: string,
	id: string,
	dependencies: string[],
	knownIds: Set<string>,
): Promise<{ label: string; description: string }> {
	const files = await regularFiles(root);
	const markdown = await readFile(path.join(root, "SKILL.md"), "utf8");
	const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	const metadata = header ? parseYaml(header[1]) : null;
	if (
		metadata?.name !== id ||
		typeof metadata.description !== "string" ||
		!metadata.description.trim()
	) {
		throw new Error(`Skill '${id}' needs matching frontmatter name and a description`);
	}
	for (const file of files) {
		if (Buffer.byteLength(`skills/${id}/${file}`) > 100)
			throw new Error(`Skill resource path exceeds bundle limit: ${id}/${file}`);
		if (!file.endsWith(".md")) continue;
		const text = (await readFile(path.join(root, file), "utf8")).replace(
			/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gm,
			"",
		);
		for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
			const link = match[1].split("#")[0];
			if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
			const target = path.resolve(root, path.dirname(file), decodeURIComponent(link));
			const rel = path.relative(root, target);
			if (rel.startsWith(`..${path.sep}`)) {
				const parts = rel.split(path.sep);
				if (
					parts[0] === ".." &&
					parts.length === 3 &&
					parts[2] === "SKILL.md" &&
					knownIds.has(parts[1]) &&
					dependencies.includes(parts[1])
				)
					continue;
				throw new Error(`Skill '${id}' has an undeclared dependency link: ${link}`);
			}
			if (!files.includes(rel.split(path.sep).join("/")))
				throw new Error(`Skill '${id}' has a broken resource link: ${link}`);
		}
	}
	return { label: metadata.name, description: metadata.description };
}

/** Apply reviewed patches and atomically materialize a package's dist/skills. @public */
export async function buildSkillPack(packageDirectory: string): Promise<void> {
	const root = path.resolve(packageDirectory);
	const recipe = await recipeAt(root);
	await withTemp(async (temp) => {
		const patched = path.join(temp, "patched");
		const patch = await patchedCopy(root, patched);
		const output = path.join(temp, "output");
		await mkdir(output);
		const entries: SkillPackManifest["skills"] = [];
		const ids = new Set(recipe.skills.map((skill) => skill.id));
		for (const skill of recipe.skills) {
			const source = contained(patched, skill.sourcePath);
			const metadata = await validateSkill(source, skill.id, skill.dependencies, ids);
			await copyTree(source, path.join(output, skill.id));
			entries.push({ ...skill, ...metadata, directory: skill.id });
		}
		for (const skill of recipe.skills) {
			for (const license of recipe.licenses) {
				const target = contained(output, `${skill.id}/licenses/${license}`);
				await mkdir(path.dirname(target), { recursive: true });
				// Retain attribution in every independently attached skill bundle.
				await copyTree(contained(path.join(root, VENDOR), license), target);
			}
		}
		for (const file of await regularFiles(output)) {
			if (Buffer.byteLength(`skills/${file}`) > 100)
				throw new Error(`Skill resource path exceeds bundle limit: ${file}`);
		}
		const manifest = parseSkillPackManifest({
			formatVersion: 1,
			upstream: recipe.upstream,
			patchDigest: createHash("sha256").update(patch).digest("hex"),
			skills: entries,
		});
		await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		await replaceDirectory(output, path.join(root, "dist/skills"));
	});
}

async function prepare(root: string, ref?: string): Promise<void> {
	const recipe = await recipeAt(root);
	// Never overwrite a maintainer's edited working copy.
	try {
		await lstat(path.join(root, WORK));
		throw new Error(`Remove or move '${WORK}' before preparing another copy`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await withTemp(async (temp) => {
		if (ref) {
			const checkout = path.join(temp, "checkout");
			await git(temp, ["clone", "--quiet", "--no-checkout", "--", recipe.upstream.url, checkout]);
			const commit = (
				await git(checkout, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
			).trim();
			await git(checkout, ["checkout", "--quiet", "--detach", commit]);
			const vendor = path.join(temp, VENDOR);
			await mkdir(vendor);
			for (const relative of [
				...recipe.skills.map((skill) => skill.sourcePath),
				...recipe.licenses,
			]) {
				await copyTree(contained(checkout, relative), contained(vendor, relative));
			}
			await replaceDirectory(vendor, path.join(root, VENDOR));
			recipe.upstream.commit = commit;
			await writeFile(path.join(root, RECIPE), `${JSON.stringify(recipe, null, 2)}\n`);
		}
		const work = path.join(temp, "work");
		try {
			await patchedCopy(root, work);
		} catch (error) {
			if (!ref) throw error;
			// Keep the new pristine tree available for resolving an upstream conflict.
			await rm(work, { recursive: true, force: true });
			await copyTree(path.join(root, VENDOR), work);
			await replaceDirectory(work, path.join(root, WORK));
			throw new Error(
				`Upstream updated, but the adaptation patch needs review. Resolve it in ${WORK}, then run skills:diff. ${String(error)}`,
			);
		}
		await replaceDirectory(work, path.join(root, WORK));
	});
}

async function diff(root: string): Promise<void> {
	await recipeAt(root);
	await withTemp(async (temp) => {
		await copyTree(path.join(root, VENDOR), path.join(temp, "a"));
		await copyTree(path.join(root, WORK), path.join(temp, "b"));
		const patch = await git(temp, [
			"diff",
			"--no-index",
			"--binary",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--no-prefix",
			"--",
			"a",
			"b",
		]);
		await mkdir(path.join(root, "patches"), { recursive: true });
		await writeFile(path.join(root, PATCH), patch);
	});
}

/** @internal */
export async function runSkillPackCli(command: string, args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: { package: { type: "string" }, ref: { type: "string" } },
	});
	const root = path.resolve(values.package ?? process.cwd());
	if (values.ref && command !== "skills:prepare") throw new Error("--ref requires skills:prepare");
	if (command === "skills:prepare") await prepare(root, values.ref);
	else if (command === "skills:diff") await diff(root);
	else if (command === "skills:build") await buildSkillPack(root);
	else throw new Error(`Unknown skill-pack command '${command}'`);
}
