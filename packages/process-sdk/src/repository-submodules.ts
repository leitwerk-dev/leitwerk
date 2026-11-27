import { spawn } from "node:child_process";
import { resolveGitBinary } from "./git-binary.js";
import { repositoryGitArgs, repositoryGitSubprocessEnv } from "./repository-git-env.js";

const preserveLocalWork = [
	'status=$(git status --porcelain --ignored=matching --untracked-files=normal --ignore-submodules=dirty) && test -z "$status" || exit 1',
	"head=$(git rev-parse HEAD) || exit 1",
	// Do not move an unpushed detached commit. A named branch retains its HEAD.
	'test "$head" = "$sha1" || git symbolic-ref -q HEAD >/dev/null || test -n "$(git for-each-ref --contains "$head" refs/remotes --format="%(refname)")"',
].join("; ");

/**
 * Best-effort initialization at the checked-out revision. Returns a safe warning
 * when preparation is incomplete, without exposing Git output or credentials.
 * Call after selecting the revision and before using the checkout.
 * @public
 */
export async function prepareRepositorySubmodules(
	projectKey: string,
	repoPath: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const deadline = AbortSignal.timeout(30_000);
	const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const env = repositoryGitSubprocessEnv(projectKey, { GIT_TERMINAL_PROMPT: "0" });
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	// No ambient helpers, transports or redirects. A managed SSH wrapper enforces pinned host keys.
	const config = [
		"-c",
		"protocol.allow=never",
		"-c",
		"protocol.https.allow=always",
		"-c",
		`protocol.ssh.allow=${env.GIT_SSH ? "always" : "never"}`,
		"-c",
		"http.followRedirects=false",
		"-c",
		"http.extraHeader=",
		...(env.GIT_CONFIG_COUNT ? [] : ["-c", "credential.helper="]),
	];

	const run = (args: string[]) =>
		new Promise<{ ok: boolean; output: string }>((resolve) => {
			if (stop.aborted) return resolve({ ok: false, output: "" });
			const child = spawn(resolveGitBinary(), repositoryGitArgs([...config, ...args]), {
				cwd: repoPath,
				env,
				detached: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
			let output = Buffer.alloc(0);
			let stopped = false;
			const terminate = () => {
				stopped = true;
				try {
					if (child.pid) process.kill(-child.pid, "SIGKILL");
				} catch {
					/* The process group already exited. */
				}
			};
			stop.addEventListener("abort", terminate, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				if (output.length + chunk.length > 1024 * 1024) terminate();
				else output = Buffer.concat([output, chunk]);
			});
			child.on("error", () => {
				stopped = true;
			});
			child.on("close", (code) => {
				stop.removeEventListener("abort", terminate);
				resolve({ ok: !stopped && code === 0, output: output.toString("utf8") });
			});
		});

	const manifest = await run(["ls-files", "--stage", "--", ".gitmodules"]);
	if (manifest.ok && !manifest.output) return undefined;
	const safeWarning = (reason: string) => `Submodules in ${projectKey} are incomplete: ${reason}`;
	const unavailable = (status = "") => {
		const paths = status.split("\n").flatMap((line) => {
			// Only include ordinary relative paths, never raw Git output.
			const match = /^[-+U][0-9a-f]{40,64} ([\w./ -]+?)(?: \(.+\))?$/.exec(line);
			return match && match[1].length <= 128 ? [match[1]] : [];
		});
		const affected = paths.length
			? `(${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", …" : ""}) `
			: "";
		return safeWarning(
			deadline.aborted
				? `${affected}preparation timed out.`
				: `${affected}check repository access or transport and run git submodule status --recursive.`,
		);
	};
	if (!manifest.ok) return unavailable();
	const unmerged = await run(["ls-files", "--unmerged", "-z"]);
	if (!unmerged.ok) return unavailable();
	if (unmerged.output) return safeWarning("the checkout has unresolved conflicts.");

	const staged = await run([
		"diff",
		"--cached",
		"--raw",
		"--ignore-submodules=none",
		"--no-renames",
		"-z",
	]);
	if (!staged.ok) return unavailable();
	if (
		/(?:^|\0):(?:160000 \d{6}|\d{6} 160000) /.test(staged.output) ||
		!(await run(["diff", "--cached", "--quiet", "--", ".gitmodules"])).ok ||
		!(await run(["diff", "--quiet", "--", ".gitmodules"])).ok
	)
		return stop.aborted
			? unavailable()
			: safeWarning("existing submodule configuration was left untouched.");
	const before = await run(["submodule", "status", "--recursive"]);
	const incomplete = /^(?:[-+U])/m;
	if (!before.ok) return unavailable();
	if (!incomplete.test(before.output)) return undefined;
	if (!(await run(["submodule", "foreach", "--quiet", "--recursive", preserveLocalWork])).ok)
		return stop.aborted
			? unavailable(before.output)
			: safeWarning("existing submodule work was left untouched.");
	const update = await run([
		"submodule",
		"update",
		"--init",
		"--recursive",
		"--checkout",
		"--jobs=4",
	]);
	const status = await run(["submodule", "status", "--recursive"]);
	if (!update.ok || !status.ok || incomplete.test(status.output))
		return unavailable(status.ok ? status.output : before.output);
	return undefined;
}
