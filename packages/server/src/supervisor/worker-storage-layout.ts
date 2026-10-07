import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expandPiAgentDir } from "@leitwerk-dev/process-sdk/pi-config";
import type { LeitwerkConfig } from "../config/config-types.js";

/** @internal */
export interface WorkerTreePaths {
	/** @internal */
	primaryTreeFile: string;
	/** @internal */
	workspaceRoot: string;
	/** @internal */
	piResourceBundlesDir: string;
	/** @internal */
	resume: boolean;
}

/** @internal */
export type WorkerStorageLayout = (instanceId: string) => WorkerTreePaths;

function normalizeContainerMountPath(mountPath: string): string {
	const trimmed = mountPath.trim();
	if (trimmed === "") {
		return "/state";
	}
	const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	return path.posix.normalize(withLeadingSlash);
}

function joinContainerPath(mountPath: string, ...segments: string[]): string {
	const normalized = normalizeContainerMountPath(mountPath);
	return path.posix.join(normalized, ...segments);
}

/** @internal */
export function createLocalWorkerStorageLayout(input: {
	/** @internal */
	processWorkspacesDir: string;
	/** @internal */
	treeFilesDir: string;
}): WorkerStorageLayout {
	return (instanceId) => {
		const processWorkspacesDir = path.resolve(input.processWorkspacesDir);
		const treeFilesDir = path.resolve(input.treeFilesDir);
		const workspaceRoot = path.join(processWorkspacesDir, instanceId);
		const primaryTreeFile = path.join(treeFilesDir, `${instanceId}.jsonl`);
		const resume = existsSync(workspaceRoot) || existsSync(primaryTreeFile);
		mkdirSync(processWorkspacesDir, { recursive: true });
		mkdirSync(treeFilesDir, { recursive: true });
		mkdirSync(workspaceRoot, { recursive: true });
		return {
			primaryTreeFile,
			workspaceRoot,
			piResourceBundlesDir: path.join(workspaceRoot, ".leitwerk", "pi-resource-bundles"),
			resume,
		};
	};
}

/** @internal */
export function createProcessVolumeWorkerStorageLayout(input: {
	/** @internal */
	mountPath: string;
}): WorkerStorageLayout {
	return () => ({
		workspaceRoot: joinContainerPath(input.mountPath, "workspace"),
		primaryTreeFile: joinContainerPath(input.mountPath, "tree", "primary.jsonl"),
		piResourceBundlesDir: joinContainerPath(input.mountPath, "pi-resource-bundles"),
		// Server-opaque volumes may already contain the authoritative worker tree even
		// when the server has no fresh snapshot. Never tell the worker to initialize a
		// known-empty local session just because the server cannot inspect the volume.
		resume: true,
	});
}

function configuredProcessVolumeMountPath(config: LeitwerkConfig): string {
	return config.workers.runner === "kubernetes"
		? (config.kubernetes?.process_volume.mount_path ?? "/state")
		: (config.docker?.process_volume.mount_path ?? "/state");
}

export function resolveWorkerPiAgentDir(config: LeitwerkConfig, mountPath?: string): string {
	return mountPath
		? joinContainerPath(mountPath, "pi-agent")
		: expandPiAgentDir(config.pi.agent_dir);
}

/** @internal */
export function createWorkerStorageLayout(config: LeitwerkConfig): WorkerStorageLayout {
	if (config.workers.runner === "docker" || config.workers.runner === "kubernetes") {
		return createProcessVolumeWorkerStorageLayout({
			mountPath: configuredProcessVolumeMountPath(config),
		});
	}
	return createLocalWorkerStorageLayout({
		processWorkspacesDir: config.storage.process_workspaces_dir,
		treeFilesDir: config.storage.tree_files_dir,
	});
}
