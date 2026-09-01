import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isPathInside, prepareTransferArchive } from "@leitwerk-dev/session-transfer";
import type { ProcessStateExporter } from "./types.js";

export interface FilesystemExportSource {
	workspaceRoot: string;
	sessionFile: string;
}

export function createFilesystemProcessStateExporter(input: {
	resolveSource(instanceId: string): FilesystemExportSource | Promise<FilesystemExportSource>;
	allowedRoots: readonly string[];
}): ProcessStateExporter {
	const allowedRoots = input.allowedRoots.map((root) => path.resolve(root));
	return {
		async prepare(request) {
			const source = await input.resolveSource(request.instanceId);
			const workspaceRoot = await realpath(path.resolve(source.workspaceRoot));
			const sessionFile = await realpath(path.resolve(source.sessionFile));
			for (const candidate of [workspaceRoot, sessionFile]) {
				if (!allowedRoots.some((root) => isPathInside(root, candidate))) {
					throw new Error("Transfer source escapes configured process storage roots");
				}
			}
			if (!(await lstat(workspaceRoot)).isDirectory())
				throw new Error("Process workspace is unavailable");
			if (!(await lstat(sessionFile)).isFile())
				throw new Error("Primary Pi session is unavailable");
			return prepareTransferArchive({
				workspaceRoot,
				sessionFile,
				manifest: request.manifest,
				limits: request.limits,
				signal: request.signal,
			});
		},
		async reconcile() {},
	};
}
