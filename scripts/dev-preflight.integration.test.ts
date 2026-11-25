import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { testWorkspace } from "../packages/dev-tools/test-workspace.js";
import { closeDatabase, createDatabase } from "../packages/server/src/db/database.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

async function fixture() {
	const { root } = testWorkspace();
	const storage = path.join(root, "configured");
	const scratch = path.join(root, "scratch");
	await mkdir(storage);
	await mkdir(scratch);
	return { root, storage, scratch, database: path.join(storage, "leitwerk.sqlite") };
}

async function preflight(input: Awaited<ReturnType<typeof fixture>>, sqlitePath: string) {
	const configPath = path.join(input.root, "leitwerk.yaml");
	await writeFile(
		configPath,
		JSON.stringify({
			workers: { runner: "local" },
			extension_loading: { sources: [path.join(repoRoot, "extensions/models")] },
			storage: {
				sqlite_path: sqlitePath,
				process_workspaces_dir: path.join(input.storage, "workspaces"),
				tree_files_dir: path.join(input.storage, "trees"),
			},
			pi: {
				agent_dir: path.join(input.storage, "pi"),
				default_model_profile: "probe",
				model_profiles: [{ id: "probe", provider: "deepseek", model_id: "deepseek-v4-flash" }],
			},
		}),
	);
	return execFileAsync(process.execPath, ["--import", "tsx", "scripts/dev-preflight.ts"], {
		cwd: repoRoot,
		env: {
			...process.env,
			LEITWERK_COMPOSITION_PATH: undefined,
			LEITWERK_CONFIG_PATH: configPath,
			TMPDIR: input.scratch,
			JITI_FS_CACHE: "false",
			TSX_DISABLE_CACHE: "1",
		},
		timeout: 15_000,
	});
}

it("applies pending migrations to a copy of the live database, not the configured storage", async () => {
	const input = await fixture();
	const running = createDatabase({ sqlitePath: input.database });
	try {
		running.$client.exec(`
			DROP TABLE process_skills;
			DROP TABLE skill_revision_dependencies;
			DROP TABLE skill_revisions;
			DROP TABLE skills;
		`);
		const walPath = `${input.database}-wal`;
		const before = await readFile(input.database);
		const walBefore = await readFile(walPath);
		const entriesBefore = (await readdir(input.storage)).sort();

		const { stdout } = await preflight(input, input.database);

		expect(stdout).toContain("Applied SQLite migration(s):");
		expect((await readFile(input.database)).equals(before)).toBe(true);
		expect((await readFile(walPath)).equals(walBefore)).toBe(true);
		expect((await readdir(input.storage)).sort()).toEqual(entriesBefore);
		expect(await readdir(input.scratch)).toEqual([]);
	} finally {
		closeDatabase(running);
	}
}, 20_000);

it.each([
	["a missing SQLite file", "file"],
	["an in-memory database", ":memory:"],
])(
	"preflights %s without creating configured storage",
	async (_label, kind) => {
		const input = await fixture();
		await preflight(input, kind === ":memory:" ? kind : input.database);
		expect(await readdir(input.storage)).toEqual([]);
		expect(await readdir(input.scratch)).toEqual([]);
	},
	20_000,
);
