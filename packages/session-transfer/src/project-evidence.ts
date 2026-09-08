import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LeitwerkTransferManifestV1 } from "./format.js";
import { isPathInside } from "./format.js";

const execFileAsync = promisify(execFile);

type TransferProject = LeitwerkTransferManifestV1["projects"][number];

export async function readProjectEvidence(
	workspaceRoot: string,
	projects: readonly TransferProject[],
	signal?: AbortSignal,
): Promise<TransferProject[]> {
	return Promise.all(
		projects.map(async (project) => {
			const projectRoot = path.resolve(workspaceRoot, ...project.relativePath.split("/"));
			if (!isPathInside(workspaceRoot, projectRoot)) {
				throw new Error(`Project '${project.key}' escapes the workspace`);
			}
			try {
				await lstat(path.join(projectRoot, ".git"));
			} catch {
				throw new Error(`Project '${project.key}' is not a Git worktree`);
			}
			const [head = "", branch = ""] = (
				await execFileAsync(
					"git",
					["-C", projectRoot, "rev-parse", "HEAD", "--abbrev-ref", "HEAD"],
					{
						signal,
					},
				)
			).stdout
				.trim()
				.split("\n");
			return {
				...project,
				head: head || null,
				branch: branch && branch !== "HEAD" ? branch : null,
			};
		}),
	);
}
