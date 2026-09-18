import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { getDefaultConfig } from "./config/index.js";
import { deploymentPreflightConfig } from "./deployment-preflight.js";

const execFileAsync = promisify(execFile);

function backupInQuietProcess(sourcePath: string, destinationPath: string) {
	// Runner timers can conceal native backup completion stalls. Use a quiet child.
	const moduleUrl = new URL("./deployment-preflight.ts", import.meta.url).href;
	return execFileAsync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`import { backupProductionDatabase } from ${JSON.stringify(moduleUrl)};
			await backupProductionDatabase({ sourcePath: process.argv[1], destinationPath: process.argv[2] });`,
			sourcePath,
			destinationPath,
		],
		{ timeout: 10_000, env: { ...process.env, NODE_OPTIONS: undefined } },
	);
}

async function databaseFixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "leitwerk-preflight-"));
	const sourcePath = path.join(root, "production.sqlite");
	const source = new DatabaseSync(sourcePath);
	onTestFinished(async () => {
		source.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, sourcePath, source };
}

describe("deployment preflight", () => {
	it("takes a consistent online backup of a WAL database without changing the source", async () => {
		const { root, sourcePath, source } = await databaseFixture();
		const copyPath = path.join(root, "scratch", "copy.sqlite");
		source.prepare("PRAGMA journal_mode = WAL").get();
		source.exec(
			"CREATE TABLE durable (value TEXT NOT NULL); INSERT INTO durable VALUES ('preserved')",
		);
		await backupInQuietProcess(sourcePath, copyPath);

		const copy = new DatabaseSync(copyPath, { readOnly: true });
		try {
			expect(copy.prepare("SELECT value FROM durable").get()).toEqual({ value: "preserved" });
			expect(copy.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		} finally {
			copy.close();
		}
		expect(source.prepare("SELECT value FROM durable").all()).toEqual([{ value: "preserved" }]);
		expect(source.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
	});

	it("rejects an invalid destination without keeping the backup process alive", async () => {
		const { root, sourcePath, source } = await databaseFixture();
		source.exec("CREATE TABLE durable (value TEXT NOT NULL)");
		await expect(backupInQuietProcess(sourcePath, root)).rejects.toMatchObject({
			code: 1,
			killed: false,
		});
		expect(source.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
	});

	it("redirects every server-owned write path to scratch storage", async () => {
		const config = getDefaultConfig();
		config.storage.sqlite_path = "/production/leitwerk.sqlite";
		config.storage.process_workspaces_dir = "/production/workspaces";
		config.storage.tree_files_dir = "/production/trees";
		(config.storage as typeof config.storage & { artifacts_dir: string }).artifacts_dir =
			"/production/artifacts";
		config.pi.agent_dir = "/production/pi";

		const isolated = deploymentPreflightConfig(config, "/scratch", "/scratch/db.sqlite");

		expect(isolated.storage).toEqual({
			sqlite_path: "/scratch/db.sqlite",
			process_workspaces_dir: "/scratch/workspaces",
			tree_files_dir: "/scratch/trees",
			artifacts_dir: "/scratch/artifacts",
		});
		expect(isolated.pi.agent_dir).toBe("/scratch/pi");
		expect(config.storage.sqlite_path).toBe("/production/leitwerk.sqlite");
	});
});
