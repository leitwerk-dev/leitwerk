import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/index.js";
import { backupProductionDatabase, deploymentPreflightConfig } from "./deployment-preflight.js";

describe("deployment preflight", () => {
	it("takes a consistent online backup of a WAL database without changing the source", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "leitwerk-preflight-"));
		const sourcePath = path.join(root, "production.sqlite");
		const copyPath = path.join(root, "scratch", "copy.sqlite");
		const source = new Database(sourcePath);
		source.pragma("journal_mode = WAL");
		source.exec(
			"CREATE TABLE durable (value TEXT NOT NULL); INSERT INTO durable VALUES ('preserved')",
		);
		await backupProductionDatabase({ sourcePath, destinationPath: copyPath });

		const copy = new Database(copyPath, { readonly: true });
		expect(copy.prepare("SELECT value FROM durable").pluck().get()).toBe("preserved");
		expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
		copy.close();
		expect(source.prepare("SELECT value FROM durable").pluck().all()).toEqual(["preserved"]);
		expect(source.pragma("integrity_check", { simple: true })).toBe("ok");
		source.close();
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
