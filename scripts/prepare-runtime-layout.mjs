import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const output = path.resolve(process.argv[2] ?? "/runtime-layout");
const stableRoot = path.join(output, "stable");
const appRoot = path.join(output, "app");

async function copy(relativePath, layerRoot, options = {}) {
	await mkdir(path.dirname(path.join(layerRoot, relativePath)), { recursive: true });
	await cp(path.join(root, relativePath), path.join(layerRoot, relativePath), options);
}

async function workspacePaths(group) {
	const entries = await readdir(path.join(root, group), { withFileTypes: true });
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => `${group}/${entry.name}`)
		.sort();
}

await rm(output, { recursive: true, force: true });
await Promise.all([mkdir(stableRoot, { recursive: true }), mkdir(appRoot, { recursive: true })]);
await copy("package.json", stableRoot);
await copy("LICENSE", stableRoot);

for (const workspace of [
	...(await workspacePaths("packages")),
	...(await workspacePaths("extensions")),
]) {
	await copy(`${workspace}/package.json`, stableRoot);
	await cp(
		path.join(root, workspace, "README.md"),
		path.join(stableRoot, workspace, "README.md"),
	).catch((error) => {
		if (error?.code !== "ENOENT") throw error;
	});
	await copy(`${workspace}/dist`, appRoot, { recursive: true });
}

await copy("packages/server/migrations", appRoot, { recursive: true });
