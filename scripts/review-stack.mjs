import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const validationCommand = "npm run test:full";
const requiredChecks = ["Full validation", "Conventional PR title and DCO"];
const help = `Usage:
  npm run review:stack -- <top-PR-number-or-URL> [--repo owner/repo] [--checkout path] [--json]
  npm run review:stack -- validate [--checkout path]

Status reads GitHub and the current checkout. Repeat --checkout to include other clones.
The stack follows base/head branch relationships, including merged PRs.
Decision threads use <!-- stack-review:decision --> in their first comment; all open threads are shown.
validate runs npm run test:full in one clean checkout and records the result for its exact HEAD.
Records stay under the checkout's Git directory. No GitHub writes, commits, or branch changes.
`;

async function command(program, args, cwd = process.cwd()) {
	const result = await exec(program, args, {
		cwd,
		encoding: "utf8",
		timeout: 30_000,
		killSignal: "SIGKILL",
		maxBuffer: 16 * 1024 * 1024,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GH_PROMPT_DISABLED: "1" },
	});
	return result.stdout;
}

async function graphql(query, variables) {
	const args = ["api", "graphql", "-f", `query=${query}`];
	for (const [name, value] of Object.entries(variables)) {
		if (value !== null) args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
	}
	const response = JSON.parse(await command("gh", args));
	if (response.errors?.length) {
		throw new Error(response.errors.map((error) => error.message).join("\n"));
	}
	if (!response.data?.repository)
		throw new Error("GitHub repository was not found or is inaccessible");
	return response.data.repository;
}

export async function collectPages(fetchPage) {
	const nodes = [];
	let cursor = null;
	const seen = new Set();
	do {
		const page = await fetchPage(cursor);
		nodes.push(...page.nodes);
		if (!page.pageInfo.hasNextPage) return nodes;
		cursor = page.pageInfo.endCursor;
		if (!cursor || seen.has(cursor)) throw new Error("GitHub pagination did not advance");
		seen.add(cursor);
	} while (cursor);
	return nodes;
}

export function orderStack(pulls, topNumber, repository, defaultBranch) {
	const top = pulls.find((pull) => pull.number === topNumber);
	if (!top) throw new Error(`PR #${topNumber} was not found in ${repository}`);
	const stack = [top];
	const seen = new Set([top.number]);
	while (stack[0].baseRefName !== defaultBranch) {
		const child = stack[0];
		const candidates = pulls.filter(
			(pull) =>
				pull.headRefName === child.baseRefName &&
				pull.headRepository?.nameWithOwner.toLowerCase() === repository.toLowerCase(),
		);
		const exact = candidates.filter((pull) => pull.headRefOid === child.baseRefOid);
		const open = candidates.filter((pull) => pull.state === "OPEN");
		const matches = exact.length ? exact : open.length ? open : candidates;
		if (!matches.length) break;
		if (matches.length > 1) {
			throw new Error(
				`Ambiguous parent of #${child.number}: ${matches.map((pull) => pull.url).join(", ")}`,
			);
		}
		const parent = matches[0];
		if (seen.has(parent.number)) throw new Error(`Stack has a cycle at #${parent.number}`);
		seen.add(parent.number);
		stack.unshift(parent);
	}
	return stack;
}

async function readStack(repository, number) {
	const [owner, name] = repository.split("/");
	let defaultBranch;
	const pulls = await collectPages(async (cursor) => {
		const result = await graphql(
			`query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequests(first: 100, after: $cursor, states: [OPEN, CLOSED, MERGED],
                 orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number title url state isDraft baseRefName baseRefOid headRefName headRefOid
        headRepository { nameWithOwner }
        mergeable mergeStateStatus reviewDecision
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`,
			{ owner, name, cursor },
		);
		defaultBranch = result.defaultBranchRef?.name;
		return result.pullRequests;
	});
	return { defaultBranch, pulls: orderStack(pulls, number, repository, defaultBranch) };
}

async function readThreads(repository, number) {
	const [owner, name] = repository.split("/");
	const threads = await collectPages(async (cursor) => {
		const result = await graphql(
			`query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id isResolved isOutdated path line
          first: comments(first: 1) { nodes { body url author { login } } }
          latest: comments(last: 1) { nodes { body url author { login } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`,
			{ owner, name, number, cursor },
		);
		return result.pullRequest.reviewThreads;
	});
	return unresolvedReviewThreads(threads);
}

export function unresolvedReviewThreads(threads) {
	return threads
		.filter((thread) => !thread.isResolved)
		.map((thread) => ({
			...thread,
			isDecision: thread.first.nodes[0]?.body.includes("<!-- stack-review:decision -->") ?? false,
		}));
}

async function readChecks(repository, sha) {
	const [owner, name] = repository.split("/");
	const checks = await collectPages(async (cursor) => {
		const result = await graphql(
			`query($owner: String!, $name: String!, $sha: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    object(expression: $sha) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100, after: $cursor) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
}`,
			{ owner, name, sha, cursor },
		);
		if (!result.object) throw new Error(`GitHub could not read commit ${sha}`);
		return (
			result.object.statusCheckRollup?.contexts ?? {
				nodes: [],
				pageInfo: { hasNextPage: false },
			}
		);
	});
	return checks.map((check) =>
		check.__typename === "CheckRun"
			? {
					name: check.name,
					state: check.status === "COMPLETED" ? (check.conclusion ?? "UNKNOWN") : check.status,
					url: check.detailsUrl,
				}
			: { name: check.context, state: check.state, url: check.targetUrl },
	);
}

export function parseDirtyFiles(porcelain) {
	const entries = porcelain.split("\0");
	const files = [];
	for (let i = 0; i < entries.length; i++) {
		if (!entries[i]) continue;
		const status = entries[i].slice(0, 2);
		files.push({
			status,
			path: entries[i].slice(3),
			...(status.includes("R") || status.includes("C") ? { from: entries[++i] } : {}),
		});
	}
	return files;
}

export async function readCheckout(cwd) {
	const root = (await command("git", ["rev-parse", "--show-toplevel"], cwd)).trim();
	const [head, branch, gitDirectory, status] = await Promise.all([
		command("git", ["rev-parse", "HEAD"], root),
		command("git", ["rev-parse", "--abbrev-ref", "HEAD"], root),
		command("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], root),
		command("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root),
	]);
	return {
		root,
		head: head.trim(),
		branch: branch.trim(),
		gitDirectory: gitDirectory.trim(),
		dirtyFiles: parseDirtyFiles(status),
	};
}

function recordPath(checkout, sha) {
	return path.join(checkout.gitDirectory, "stack-review", "validations", `${sha}.json`);
}

export async function readValidation(checkout, sha) {
	const file = recordPath(checkout, sha);
	try {
		const record = JSON.parse(await readFile(file, "utf8"));
		if (
			record.version !== 1 ||
			record.sha !== sha ||
			record.command !== validationCommand ||
			!["running", "passed", "failed", "invalidated"].includes(record.status) ||
			!Number.isFinite(Date.parse(record.startedAt))
		) {
			throw new Error(`Invalid validation record: ${file}`);
		}
		return { ...record, file };
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

async function writeValidation(checkout, record) {
	const file = recordPath(checkout, record.sha);
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
	await rename(temporary, file);
}

function runFullValidation(cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn("npm", ["run", "test:full"], { cwd, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

export async function validateCheckout(cwd, run = runFullValidation) {
	const before = await readCheckout(cwd);
	if (before.dirtyFiles.length) {
		throw new Error("Validation recording requires a clean checkout, including untracked files");
	}
	const record = {
		version: 1,
		sha: before.head,
		command: validationCommand,
		status: "running",
		startedAt: new Date().toISOString(),
		nodeVersion: process.version,
		platform: `${process.platform}/${process.arch}`,
	};
	await writeValidation(before, record);
	let exitCode;
	try {
		exitCode = await run(before.root);
		const after = await readCheckout(before.root);
		record.status =
			after.head !== before.head || after.dirtyFiles.length
				? "invalidated"
				: exitCode === 0
					? "passed"
					: "failed";
	} catch (error) {
		record.status = "failed";
		record.error = error.message;
		exitCode = 1;
	}
	await writeValidation(before, {
		...record,
		finishedAt: new Date().toISOString(),
		exitCode,
	});
	return { status: record.status, sha: record.sha, exitCode: record.status === "passed" ? 0 : 1 };
}

export async function collectReport(repository, number, checkoutPaths) {
	const checkouts = await Promise.all([...new Set(checkoutPaths)].map(readCheckout));
	const stack = await readStack(repository, number);
	const pulls = await Promise.all(
		stack.pulls.map(async (pull) => {
			const [checks, unresolvedThreads, comparison, records] = await Promise.all([
				readChecks(repository, pull.headRefOid),
				readThreads(repository, pull.number),
				command("gh", [
					"api",
					`repos/${repository}/compare/${pull.baseRefOid}...${pull.headRefOid}?per_page=1`,
				]).then(JSON.parse),
				Promise.all(checkouts.map((checkout) => readValidation(checkout, pull.headRefOid))),
			]);
			const localValidation =
				records
					.filter(Boolean)
					.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null;
			return {
				...pull,
				baseCommitsMissing: comparison.behind_by,
				checks,
				missingRequiredChecks: requiredChecks.filter(
					(name) => !checks.some((check) => check.name === name),
				),
				unresolvedThreads,
				localValidation,
			};
		}),
	);
	return {
		generatedAt: new Date().toISOString(),
		repository,
		top: number,
		...stack,
		pulls,
		checkouts,
	};
}

function oneLine(text) {
	return String(text)
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

export function formatReport(report) {
	const lines = [
		`${report.repository}: stack ending at #${report.top} (${report.generatedAt})`,
		"",
	];
	for (const checkout of report.checkouts) {
		lines.push(
			`Checkout ${oneLine(checkout.root)}: ${oneLine(checkout.branch)} @ ${checkout.head.slice(0, 12)}`,
			checkout.dirtyFiles.length ? `  DIRTY: ${checkout.dirtyFiles.length} files` : "  Clean",
			...checkout.dirtyFiles.map(
				(file) =>
					`  ${file.status} ${JSON.stringify(file.path)}${file.from ? ` (from ${JSON.stringify(file.from)})` : ""}`,
			),
		);
	}
	if (report.pulls[0].baseRefName !== report.defaultBranch) {
		lines.push(`Stack stops at ${oneLine(report.pulls[0].baseRefName)}; no parent PR was found.`);
	}
	for (const [index, pull] of report.pulls.entries()) {
		lines.push(
			"",
			`${index + 1}/${report.pulls.length} #${pull.number} [${pull.state}${pull.isDraft ? ", DRAFT" : ""}] ${oneLine(pull.title)}`,
			`  ${pull.url}`,
			`  ${oneLine(pull.baseRefName)} @ ${pull.baseRefOid.slice(0, 12)} -> ${oneLine(pull.headRefName)} @ ${pull.headRefOid.slice(0, 12)}`,
			`  Base inheritance: ${pull.baseCommitsMissing === 0 ? "includes base" : `${pull.baseCommitsMissing} base commits missing`}`,
			`  GitHub: content mergeability=${pull.mergeable}; merge state=${pull.mergeStateStatus}; review=${pull.reviewDecision || "not reported"}`,
			`  Local full validation: ${pull.localValidation ? `${pull.localValidation.status} (${pull.localValidation.startedAt}, ${pull.localValidation.file})` : "not recorded for this SHA"}`,
			...pull.checks.map(
				(check) => `  Check ${oneLine(check.name)}: ${check.state} ${check.url ?? ""}`,
			),
			...pull.missingRequiredChecks.map((name) => `  Required check missing: ${name}`),
			`  Unresolved review threads: ${pull.unresolvedThreads.length}; marked decisions: ${pull.unresolvedThreads.filter((thread) => thread.isDecision).length}`,
		);
		for (const thread of pull.unresolvedThreads) {
			const first = thread.first.nodes[0];
			const latest = thread.latest.nodes[0];
			lines.push(
				`    ${thread.isDecision ? "DECISION " : ""}${oneLine(thread.path)}${thread.line ? `:${thread.line}` : ""}${thread.isOutdated ? " (outdated)" : ""} ${first?.url ?? ""}`,
				`    ${oneLine(first?.body ?? "Comment unavailable").slice(0, 240)}`,
			);
			if (latest && latest.url !== first?.url) {
				lines.push(
					`    Latest @${latest.author?.login ?? "deleted"}: ${oneLine(latest.body).slice(0, 240)} ${latest.url}`,
				);
			}
		}
	}
	return lines.join("\n");
}

async function main(args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			repo: { type: "string" },
			checkout: { type: "string", multiple: true },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help || !positionals.length) {
		console.info(help);
		return;
	}
	if (positionals.length !== 1) throw new Error("Supply one top PR number or URL");
	if (positionals[0] === "validate") {
		if (values.repo || values.json || (values.checkout?.length ?? 0) > 1) {
			throw new Error("validate accepts only one optional --checkout");
		}
		const result = await validateCheckout(values.checkout?.[0] ?? process.cwd());
		console.info(`Local full validation: ${result.status} for ${result.sha}`);
		process.exitCode = result.exitCode;
		return;
	}
	let target = positionals[0];
	let repository = values.repo;
	if (target.startsWith("https://")) {
		const url = new URL(target);
		const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/u);
		if (url.hostname !== "github.com" || !match) throw new Error("Expected a github.com PR URL");
		const urlRepository = `${match[1]}/${match[2]}`;
		if (repository && repository.toLowerCase() !== urlRepository.toLowerCase()) {
			throw new Error("--repo does not match the PR URL");
		}
		repository = urlRepository;
		target = match[3];
	}
	if (!/^[1-9]\d*$/u.test(target) || !Number.isSafeInteger(Number(target))) {
		throw new Error("Expected a PR number or URL");
	}
	repository ??= (
		await command("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
	).trim();
	if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("Expected --repo owner/repo");
	const report = await collectReport(repository, Number(target), [
		process.cwd(),
		...(values.checkout ?? []),
	]);
	console.info(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(`[review:stack] ${error.message}`);
		process.exitCode = 1;
	});
}
