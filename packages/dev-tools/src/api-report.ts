import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createSnapshot } from "./api-report-indexer.mjs";
import { run } from "./command.js";
import { loadWorkspaceComposition } from "./composition.js";
import { runDevelopment } from "./development.js";
import { listWorkspacePackageDirs, packageDirectory, readJson } from "./workspace.js";

/** Generate portable evidence without changing dependency selection. @internal */
export async function runApiReportCli(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			workspace: { type: "string" },
			composition: { type: "string" },
			"usage-only": { type: "boolean" },
			"output-dir": { type: "string" },
			built: { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	if (values.help) {
		console.info(
			"leitwerk-dev api:report [--workspace PATH] [--composition PATH] [--usage-only] [--output-dir PATH] [--built]",
		);
		return;
	}
	const root = path.resolve(values.workspace ?? process.cwd());
	const output = path.resolve(
		values["output-dir"] ?? path.join(root, ".leitwerk/api-explorer/reports"),
	);
	const compositionPath = values.composition && path.resolve(root, values.composition);
	const composition = compositionPath ? loadWorkspaceComposition(compositionPath) : undefined;
	const manifest = readJson(path.join(root, "package.json"));
	if (!values.built && !values["usage-only"]) {
		if (manifest.name === "leitwerk")
			await run("npm", ["run", "build"], {
				cwd: root,
				env: {
					...process.env,
					...(compositionPath ? { LEITWERK_COMPOSITION_PATH: compositionPath } : {}),
				},
			});
		else await runDevelopment("build", { workspaceRoot: root, compositionPath });
	}
	const localDirs = [
		...new Set([
			root,
			...listWorkspacePackageDirs(root),
			...(composition?.packages.map((p) => p.dir) ?? []),
		]),
	];
	const packageDirs = new Set(localDirs);
	// Resolve the installed graph using the same package resolver as development commands.
	for (const dir of packageDirs) {
		const pkg = readJson(path.join(dir, "package.json"));
		for (const name of Object.keys({
			...pkg.dependencies,
			...pkg.devDependencies,
			...pkg.optionalDependencies,
		})) {
			if (!name.startsWith("@leitwerk-dev/")) continue;
			if (localDirs.some((local) => readJson(path.join(local, "package.json")).name === name))
				continue;
			try {
				packageDirs.add(packageDirectory(name, dir));
			} catch {
				/* Unresolved imports become index diagnostics. */
			}
		}
	}
	const snapshot = await createSnapshot(root, path.join(output, "../models"), {
		extract: !values["usage-only"],
		packageDirs: [...packageDirs],
		sourceRoots: [
			...new Set([
				root,
				...(composition?.packages.map((p) => p.dir) ?? []),
				...(composition?.testRoots ?? []),
			]),
		],
	});
	const report = {
		schemaVersion: 1,
		producerVersion:
			readJson(fileURLToPath(new URL("../package.json", import.meta.url))).version ?? "unknown",
		kind: values["usage-only"] ? "usage" : "catalog",
		source: {
			...snapshot.repository,
			fingerprint: createHash("sha256")
				.update(JSON.stringify([snapshot.contentFingerprint, snapshot.nodes, snapshot.occurrences]))
				.digest("hex"),
		},
		analyzedPackages: Object.fromEntries(
			[...packageDirs].map((dir) => {
				const pkg = readJson(path.join(dir, "package.json"));
				return [pkg.name, pkg.version ?? "unknown"];
			}),
		),
		snapshot,
	};
	fs.mkdirSync(output, { recursive: true });
	const target = path.join(
		output,
		values["usage-only"] ? `usage-${report.source.id}.json` : "catalog.json",
	);
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(report));
		fs.renameSync(temporary, target);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
	console.info(
		`Wrote ${target}: ${snapshot.nodes.length} nodes, ${snapshot.occurrences.length} occurrences`,
	);
}
