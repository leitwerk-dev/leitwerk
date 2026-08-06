import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";

const execFile = promisify(execFileCb);

import type { ProcessLaunchExecutorLike } from "@leitwerk-dev/process-sdk";

export interface ProcessAnalysisRuntime {
	analysisCwd: string;
	serverBaseUrl: string;
	processWorkspacesDir: string | null;
	processLaunches: ProcessLaunchExecutorLike | null;
}

const runtime: ProcessAnalysisRuntime = {
	analysisCwd: path.resolve(process.cwd()),
	serverBaseUrl: "http://localhost",
	processWorkspacesDir: null,
	processLaunches: null,
};

export function configureProcessAnalysisRuntime(overrides: Partial<ProcessAnalysisRuntime>): void {
	runtime.analysisCwd = overrides.analysisCwd
		? path.resolve(overrides.analysisCwd)
		: runtime.analysisCwd;
	runtime.serverBaseUrl = overrides.serverBaseUrl ?? runtime.serverBaseUrl;
	runtime.processWorkspacesDir = overrides.processWorkspacesDir ?? null;
	runtime.processLaunches = overrides.processLaunches ?? null;
}

export function getProcessAnalysisRuntime(): ProcessAnalysisRuntime {
	return runtime;
}

export interface ProcessAnalysisRuntimeRepoConfig {
	repoLocator: string;
	baseBranch: string;
}

async function runGit(args: readonly string[]): Promise<string | null> {
	try {
		const { stdout } = await execFile(resolveGitBinary(), ["-C", runtime.analysisCwd, ...args], {
			encoding: "utf8",
		});
		return stdout.trim();
	} catch {
		return null;
	}
}

export async function isProcessAnalysisRuntimeGitRepo(): Promise<boolean> {
	return (await runGit(["rev-parse", "--is-inside-work-tree"])) === "true";
}

export async function resolveProcessAnalysisRuntimeRepoConfig(): Promise<ProcessAnalysisRuntimeRepoConfig> {
	const originHead = await runGit([
		"symbolic-ref",
		"--quiet",
		"--short",
		"refs/remotes/origin/HEAD",
	]);
	const baseBranch = originHead?.startsWith("origin/")
		? originHead.slice("origin/".length)
		: "main";
	return {
		repoLocator: runtime.analysisCwd,
		baseBranch,
	};
}
