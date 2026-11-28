import { prepareRepositorySubmodules, type TurnDiagnosticReport } from "@leitwerk-dev/process-sdk";

/** @internal */
export async function prepareSubmodules(
	repo: { key: string; fsPath: string },
	ctx: { reportDiagnostic(report: TurnDiagnosticReport): void },
) {
	const message = await prepareRepositorySubmodules(repo.key, repo.fsPath);
	if (message) ctx.reportDiagnostic({ level: "warn", code: "repository.submodules", message });
	return message;
}

// A failed refresh can leave a retained submodule at its previous commit. Do
// not let a parent-wide git add turn that checkout into a pointer change.
/** @internal */
export function assertSafeSubmoduleStaging(git: (args: string[]) => string): void {
	const unstaged = git(["diff", "--raw", "--no-renames", "--ignore-submodules=dirty", "-z"]);
	const changesGitlink = /(?:^|\0):(?:160000 \d{6}|\d{6} 160000) /.test(unstaged);
	const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
	// git ls-files reports an embedded worktree as a path ending in slash,
	// unlike ordinary untracked files.
	const embeddedCheckout = untracked.split("\0").some((entry) => entry.endsWith("/"));
	if (changesGitlink || embeddedCheckout)
		throw new Error(
			"Cannot automatically stage an out-of-sync or untracked submodule. Restore the checkout or explicitly stage the intended Git link change.",
		);
}
