import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { trimToNull } from "@leitwerk-dev/domain";
import { sanitizeWorkerSubprocessEnv } from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";

const DEFAULT_BASE_SHA_SUFFIX_LENGTH = 12;
const DEFAULT_MAX_BRANCH_SLUG_LENGTH = 48;
const DEFAULT_PROMPT_WORD_COUNT = 5;
const AUTO_BRANCH_RANDOM_HEX_LENGTH = 3;
const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

export interface ResolveBaseBranchShaInput {
	repoLocator: string;
	baseBranch: string;
	timeoutMs?: number;
}

function truncateSlugAtSeparator(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	return value.slice(0, maxLength).replace(/-+$/g, "");
}

function normalizedBranchWords(value: string): string[] {
	return (
		value
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[’']/g, "")
			.match(/[a-z0-9]+/g) ?? []
	);
}

export function slugifyBranchSourceForBranch(sourceText: string): string {
	const words = normalizedBranchWords(sourceText).slice(0, DEFAULT_PROMPT_WORD_COUNT);
	const normalized = words.join("-");
	const slug = truncateSlugAtSeparator(normalized, DEFAULT_MAX_BRANCH_SLUG_LENGTH);
	return slug || "change";
}

/** @deprecated Use slugifyBranchSourceForBranch. */
export const slugifyPromptForBranch = slugifyBranchSourceForBranch;
/** @deprecated Use slugifyBranchSourceForBranch. */
export const slugifyTitleForBranch = slugifyBranchSourceForBranch;

function normalizeSha(value: string): string {
	const sha = value.trim().toLowerCase();
	if (!/^[0-9a-f]{7,64}$/.test(sha)) {
		throw new Error(`Expected a git object sha, got '${value}'`);
	}
	return sha;
}

export function generateAutoWorkBranchRandomHex(): string {
	return randomBytes(2).toString("hex").slice(0, AUTO_BRANCH_RANDOM_HEX_LENGTH);
}

function normalizeRandomHex(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (!new RegExp(`^[0-9a-f]{${AUTO_BRANCH_RANDOM_HEX_LENGTH}}$`).test(normalized)) {
		throw new Error(
			`Expected ${AUTO_BRANCH_RANDOM_HEX_LENGTH} random hex characters, got '${value}'`,
		);
	}
	return normalized;
}

export function buildAutoWorkBranch(
	sourceText: string,
	baseBranchSha: string,
	randomHex = generateAutoWorkBranchRandomHex(),
): string {
	const slug = slugifyBranchSourceForBranch(sourceText);
	const suffix = normalizeRandomHex(randomHex);
	const sha = normalizeSha(baseBranchSha);
	return `${slug}-${suffix}-${sha.slice(0, DEFAULT_BASE_SHA_SUFFIX_LENGTH)}`;
}

/** Builds the same safe branch shape when authenticated remote SHA lookup must wait for a worker. */
export function gitShaLikeDigestFromSeed(seed: string): string {
	return createHash("sha256").update(seed).digest("hex");
}

export function buildAutoWorkBranchFromSeed(
	sourceText: string,
	seed: string,
	randomHex = generateAutoWorkBranchRandomHex(),
): string {
	return buildAutoWorkBranch(sourceText, gitShaLikeDigestFromSeed(seed), randomHex);
}

function baseBranchRef(baseBranch: string): string {
	const trimmed = trimToNull(baseBranch);
	if (!trimmed) {
		throw new Error("baseBranch is required to resolve an automatic work branch");
	}
	return trimmed.startsWith("refs/heads/") ? trimmed : `refs/heads/${trimmed}`;
}

function outputToString(value: unknown): string {
	return typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

export async function resolveBaseBranchSha(input: ResolveBaseBranchShaInput): Promise<string> {
	const repoLocator = trimToNull(input.repoLocator);
	if (!repoLocator) {
		throw new Error("repoLocator is required to resolve an automatic work branch");
	}
	const ref = baseBranchRef(input.baseBranch);
	let stdout = "";
	try {
		const result = await execFileAsync(resolveGitBinary(), ["ls-remote", repoLocator, ref], {
			encoding: "utf8",
			env: sanitizeWorkerSubprocessEnv(process.env, { GIT_TERMINAL_PROMPT: "0" }),
			timeout: input.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
		});
		stdout = outputToString(result.stdout);
	} catch (error) {
		const errorOutput = error as { message?: string; stdout?: unknown; stderr?: unknown };
		const message =
			trimToNull(outputToString(errorOutput.stderr)) ??
			trimToNull(outputToString(errorOutput.stdout)) ??
			errorOutput.message ??
			"unknown git error";
		throw new Error(`Failed to resolve '${ref}' from '${repoLocator}': ${message}`);
	}
	const match = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.split(/\s+/))
		.find((parts) => parts[1] === ref);
	const sha = match?.[0];
	if (!sha) {
		throw new Error(
			`Repository '${repoLocator}' does not expose base branch '${input.baseBranch}'`,
		);
	}
	return normalizeSha(sha);
}
