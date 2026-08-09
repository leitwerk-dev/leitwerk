import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const titlePattern =
	/^(?:feat|fix|docs|test|ci|build|chore|refactor|perf|revert)(?:\([a-z0-9][a-z0-9._/-]*\))?!?: \S(?:.*\S)?$/u;

export function isConventionalTitle(title) {
	return titlePattern.test(title);
}

export function hasMatchingSignoff(message, authorName, authorEmail) {
	const expected = `Signed-off-by: ${authorName} <${authorEmail}>`;
	return message
		.split(/\r?\n/u)
		.some((line) => line.trim().toLocaleLowerCase() === expected.toLocaleLowerCase());
}

export function readCommitPolicyErrors(baseSha, headSha) {
	const result = spawnSync(
		"git",
		["log", "--format=%H%x00%an%x00%ae%x00%B%x00%x1e", `${baseSha}..${headSha}`],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) {
		throw new Error(result.stderr || `git log exited with ${String(result.status)}`);
	}
	return result.stdout
		.split("\x1e")
		.map((record) => record.replace(/^\s+|\s+$/gu, ""))
		.filter(Boolean)
		.flatMap((record) => {
			const [sha, authorName, authorEmail, ...messageParts] = record.split("\x00");
			const message = messageParts.join("\x00");
			return hasMatchingSignoff(message, authorName, authorEmail)
				? []
				: [`${sha}: missing Signed-off-by: ${authorName} <${authorEmail}>`];
		});
}

function run() {
	const title = process.env.PR_TITLE ?? "";
	const baseSha = process.env.PR_BASE_SHA ?? "";
	const headSha = process.env.PR_HEAD_SHA ?? "";
	const errors = [
		...(isConventionalTitle(title)
			? []
			: [
					`PR title is not Conventional Commits syntax: '${title}'. Use type(scope)!: description.`,
				]),
		...(baseSha && headSha
			? readCommitPolicyErrors(baseSha, headSha)
			: ["PR_BASE_SHA and PR_HEAD_SHA are required"]),
	];
	if (errors.length > 0) {
		console.error(`[policy] Validation failed:\n- ${errors.join("\n- ")}`);
		process.exit(1);
	}
	console.info("[policy] Conventional title and DCO sign-offs are valid");
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) run();
