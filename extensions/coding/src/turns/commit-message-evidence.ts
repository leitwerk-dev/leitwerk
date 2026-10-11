import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ScopedSettingsSnapshot } from "@leitwerk-dev/domain";
import {
	repositoryGitArgs,
	sanitizeWorkerSubprocessEnv,
	type TurnDiagnosticReport,
} from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import { commitMessageGitTimeout } from "../settings.js";
import { GitTrace2Collector } from "./git-inspection-profile.js";

interface GitOutput {
	text: string;
	truncated: boolean;
}

interface RepositoryChanges {
	key: string;
	path: string;
	head: string;
	status: GitOutput;
	stagedDiff: GitOutput;
	unstagedDiff: GitOutput;
	untrackedFiles: GitOutput;
}

/** @internal */
export interface RepositoryCommitMessagePreparation {
	/** @internal */
	repositories: RepositoryChanges[];
}

// Preparation checkpoints have a 64 KiB limit. Leave room for checkpoint metadata.
const MAX_SNAPSHOT_BYTES = 60 * 1024;

interface GitInspectionContext {
	key: string;
	cwd: string;
	timeoutMs: number;
	indexFile?: string;
	reportDiagnostic?: (report: TurnDiagnosticReport) => void;
}

function inspectionEnv(indexFile: string | undefined): NodeJS.ProcessEnv {
	const env = sanitizeWorkerSubprocessEnv(process.env);
	// Ambient index selection and trace destinations must not change this inspection
	// or persist raw Trace2 events. Only fd 3 receives our temporary trace stream.
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_TRACE") || key === "GIT_INDEX_FILE") delete env[key];
	}
	return {
		...env,
		...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
		GIT_OPTIONAL_LOCKS: indexFile ? "1" : "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_TRACE2: "0",
		GIT_TRACE2_PERF: "0",
		GIT_TRACE2_EVENT: "3",
	};
}

async function readGit(
	ctx: GitInspectionContext,
	command: string,
	args: string[],
): Promise<GitOutput> {
	const started = performance.now();
	const trace = new GitTrace2Collector();
	let exitCode: number | null = null;
	let exitSignal: NodeJS.Signals | null = null;
	let timedOut = false;
	let succeeded = false;
	let outputBytes = 0;
	try {
		const output = await new Promise<GitOutput>((resolve, reject) => {
			const child = spawn(
				resolveGitBinary(),
				repositoryGitArgs([
					...(ctx.indexFile
						? ["-c", "core.splitIndex=false", "-c", "splitIndex.sharedIndexExpire=never"]
						: ["--no-optional-locks"]),
					"-c",
					"core.fsmonitor=false",
					...args,
				]),
				{
					cwd: ctx.cwd,
					env: inspectionEnv(ctx.indexFile),
					stdio: ["ignore", "pipe", "ignore", "pipe"],
					timeout: ctx.timeoutMs,
				},
			);
			child.stdio[3]?.on("data", (chunk: Buffer) => trace.write(chunk));
			const chunks: Buffer[] = [];
			let bytes = 0;
			let truncated = false;
			child.stdout?.on("data", (chunk: Buffer) => {
				outputBytes += chunk.length;
				const remaining = MAX_SNAPSHOT_BYTES - bytes;
				if (chunk.length > remaining) truncated = true;
				const retained = chunk.subarray(0, remaining);
				if (retained.length) chunks.push(retained);
				bytes += retained.length;
			});
			child.once("error", reject);
			child.once("close", (code, signal) => {
				exitCode = code;
				exitSignal = signal;
				timedOut = child.killed;
				if (code !== 0) {
					if (timedOut) {
						reject(
							new Error(
								`Cannot inspect '${ctx.key}': git ${args[0]} timed out after ${ctx.timeoutMs}ms`,
							),
						);
						return;
					}
					reject(
						new Error(`Cannot inspect '${ctx.key}': git ${args[0]} failed (${signal ?? code})`),
					);
					return;
				}
				resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated });
			});
		});
		succeeded = true;
		return output;
	} finally {
		const report: TurnDiagnosticReport = {
			level: succeeded ? "info" : "warn",
			code: "coding.git_inspection",
			message: "Commit-message Git inspection command completed",
			details: {
				repository: ctx.key,
				command,
				durationMs: Math.round((performance.now() - started) * 1_000) / 1_000,
				timeoutMs: ctx.timeoutMs,
				outcome: succeeded ? "succeeded" : timedOut ? "timed_out" : "failed",
				exitCode,
				signal: exitSignal,
				outputBytes,
				trace2: trace.finish(),
			},
		};
		// Diagnostics are best-effort and must not replace a Git result or failure.
		try {
			ctx.reportDiagnostic?.(report);
		} catch {}
	}
}

/** @internal */
export async function prepareRepositoryCommitMessageEvidence(ctx: {
	projects: readonly { key: string }[];
	repo: { get(key: string): { fsPath: string } };
	scopedSettings?: ScopedSettingsSnapshot;
	reportDiagnostic?: (report: TurnDiagnosticReport) => void;
}): Promise<RepositoryCommitMessagePreparation> {
	const capturedTimeout = ctx.scopedSettings?.values.find(
		({ key }) => key === commitMessageGitTimeout.key,
	);
	const timeoutMs = commitMessageGitTimeout.schema.parse(
		capturedTimeout ? capturedTimeout.value : commitMessageGitTimeout.defaultValue,
	);
	const repositories: RepositoryChanges[] = [];
	for (const project of ctx.projects) {
		const cwd = ctx.repo.get(project.key).fsPath;
		const inspection = { key: project.key, cwd, timeoutMs, reportDiagnostic: ctx.reportDiagnostic };
		const head = await readGit(inspection, "rev-parse.head", ["rev-parse", "HEAD"]);
		const indexPath = await readGit(inspection, "rev-parse.index", [
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"index",
		]);
		if (indexPath.truncated)
			throw new Error(`Cannot inspect '${project.key}': Git index path too long`);
		const scratch = await mkdtemp(path.join(tmpdir(), "leitwerk-git-inspection-"));
		try {
			const indexFile = path.join(scratch, "index");
			try {
				const originalIndex = indexPath.text.replace(/\n$/, "");
				const metadata = await stat(originalIndex);
				await copyFile(originalIndex, indexFile);
				await chmod(indexFile, 0o600);
				// A newer copy timestamp could hide racy-clean entries. Millisecond
				// rounding moves this timestamp earlier, conservatively retaining scans.
				await utimes(indexFile, metadata.atime, metadata.mtime);
			} catch (error) {
				// An absent index is a valid checkout state. Git may create only the scratch copy.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			// Status can persist refreshed stat data here. Later diffs reuse it without
			// rehashing clean files or updating the checkout's staging state.
			const git = (command: string, args: string[]) =>
				readGit({ ...inspection, indexFile }, command, args);
			const status = await git("status", ["status", "--porcelain=v1", "--untracked-files=all"]);
			const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color"];
			const stagedDiff = await git("diff.staged", ["diff", "--cached", ...diffOptions]);
			const unstagedDiff = await git("diff.unstaged", ["diff", ...diffOptions]);
			const untrackedFiles = await git("ls-files.untracked", [
				"ls-files",
				"--others",
				"--exclude-standard",
			]);
			repositories.push({
				key: project.key,
				path: cwd,
				head: head.text.trim(),
				status,
				stagedDiff,
				unstagedDiff,
				untrackedFiles,
			});
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}
	const prepared = { repositories };
	const outputs = repositories.flatMap((repo) => [
		repo.status,
		repo.stagedDiff,
		repo.unstagedDiff,
		repo.untrackedFiles,
	]);
	while (Buffer.byteLength(JSON.stringify(prepared), "utf8") > MAX_SNAPSHOT_BYTES) {
		const largest = outputs.reduce<GitOutput | undefined>(
			(current, output) =>
				!current || output.text.length > current.text.length ? output : current,
			undefined,
		);
		if (!largest?.text.length) throw new Error("Repository identities exceed the evidence limit");
		largest.text = largest.text.slice(0, Math.floor(largest.text.length / 2));
		largest.truncated = true;
	}
	return prepared;
}
