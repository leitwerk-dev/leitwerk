import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "../config/config-loader.js";
import {
	createLocalWorkerStorageLayout,
	createProcessVolumeWorkerStorageLayout,
	createWorkerStorageLayout,
	resolveWorkerPiAgentDir,
} from "./worker-storage-layout.js";

describe("local worker storage layout", () => {
	it("uses server-owned workspace and tree directories and creates the workspace", () => {
		const root = mkdtempSync(path.join(tmpdir(), "leitwerk-storage-layout-"));
		const layout = createLocalWorkerStorageLayout({
			processWorkspacesDir: path.join(root, "workspaces"),
			treeFilesDir: path.join(root, "trees"),
		});

		const paths = layout("agt_1");

		expect(paths).toEqual({
			workspaceRoot: path.join(root, "workspaces", "agt_1"),
			primaryTreeFile: path.join(root, "trees", "agt_1.jsonl"),
			resume: false,
		});
		expect(existsSync(paths.workspaceRoot)).toBe(true);
	});

	it("marks local starts as resumable when a server snapshot already exists", () => {
		const root = mkdtempSync(path.join(tmpdir(), "leitwerk-storage-layout-"));
		const treeFile = path.join(root, "trees", "agt_1.jsonl");
		mkdirSync(path.dirname(treeFile), { recursive: true });
		writeFileSync(treeFile, "{}\n", "utf8");
		const layout = createLocalWorkerStorageLayout({
			processWorkspacesDir: path.join(root, "workspaces"),
			treeFilesDir: path.join(root, "trees"),
		});

		expect(layout("agt_1").resume).toBe(true);
	});
});

describe("process-volume worker storage layout", () => {
	it("uses stable in-volume worker paths independent of instance id", () => {
		const layout = createProcessVolumeWorkerStorageLayout({ mountPath: "/state/" });

		expect(layout("agt_1")).toEqual({
			workspaceRoot: "/state/workspace",
			primaryTreeFile: "/state/tree/primary.jsonl",
			resume: true,
		});
		expect(layout("agt_2")).toEqual(layout("agt_1"));
	});

	it("normalizes configured container mount paths", () => {
		const layout = createProcessVolumeWorkerStorageLayout({ mountPath: "state//process" });

		expect(layout("agt_1").workspaceRoot).toBe("/state/process/workspace");
	});
});

describe("resolveWorkerPiAgentDir", () => {
	it("uses the configured managed agent directory for local workers", () => {
		const config = getDefaultConfig();
		config.workers.runner = "local";
		config.pi.agent_dir = "/managed/pi-agent";

		expect(resolveWorkerPiAgentDir(config)).toBe("/managed/pi-agent");
	});

	it("uses the actual process volume mount when provided", () => {
		const config = getDefaultConfig();
		config.pi.agent_dir = "/configured/pi-agent";

		expect(resolveWorkerPiAgentDir(config, "/custom-volume")).toBe("/custom-volume/pi-agent");
	});
});

describe("createWorkerStorageLayout", () => {
	it("selects the Kubernetes process-volume layout for Kubernetes runner mode", () => {
		const config = getDefaultConfig();
		config.workers.runner = "kubernetes";
		config.kubernetes = {
			...config.kubernetes,
			process_volume: { ...config.kubernetes.process_volume, mount_path: "/pv" },
		};

		const paths = createWorkerStorageLayout(config)("agt_1");

		expect(paths.primaryTreeFile).toBe("/pv/tree/primary.jsonl");
		expect(paths.workspaceRoot).toBe("/pv/workspace");
		expect(paths.resume).toBe(true);
	});
});
