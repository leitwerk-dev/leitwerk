import { mkdirSync, writeFileSync } from "node:fs";
import {
	bindExternalWrites,
	type ExternalWriteLogRecordInput,
} from "@leitwerk-dev/external-writes/internal";
import type { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import type { AppContext } from "@leitwerk-dev/server";
import { localPath, readLocalJson, writeLocalJson } from "@leitwerk-dev/test-support/local-git";
import type { LocalWoodpeckerAdapter } from "@leitwerk-dev/woodpecker/testing";

export interface ProviderControlInput {
	operation: string;
	requestId: string;
	repository?: string;
	number?: number;
	body?: string;
	title?: string;
	kind?: "conversation" | "review" | "inline";
	branch?: string;
	sha?: string;
	status?: string;
	enabled?: boolean;
}

/** Durable local provider operations; process transitions belong to provider polling. */
export function providerControls(
	forgejo: LocalForgejoAdapter,
	woodpecker: LocalWoodpeckerAdapter,
	poll: () => Promise<unknown>,
) {
	const file = "provider-controls.json";
	const state = readLocalJson(forgejo.options.root, file, {
		version: 1,
		writes: {} as Record<string, ExternalWriteLogRecordInput>,
		requests: {} as Record<string, string>,
	});
	state.requests ??= {};
	const save = () => writeLocalJson(forgejo.options.root, file, state);
	let pending: Promise<unknown> = Promise.resolve();
	const execute = async (body: ProviderControlInput) => {
		const allowed = [
			"create-issue",
			"cancel-issue",
			"remove-trigger",
			"feedback",
			"pipeline",
			"advance-base",
			"conflict",
			"merge",
			"close",
			"lost-ticket-response",
			"lost-pr-response",
		];
		if (!body || !allowed.includes(body.operation)) throw new Error("Unknown provider operation");
		if (!/^[a-zA-Z0-9-]{8,80}$/.test(body.requestId ?? ""))
			throw new Error("A requestId of 8–80 letters, digits or hyphens is required");
		const fingerprint = JSON.stringify(
			Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))),
		);
		const key = `provider-control:${body.requestId}`;
		const old = state.writes[key];
		if (
			(old && old.metadata?.request !== fingerprint) ||
			(state.requests[key] && state.requests[key] !== fingerprint)
		)
			throw new Error("Request id already used for a different operation");
		state.requests[key] = fingerprint;
		save();
		await bindExternalWrites(
			{
				hasDedupKey: (key) => Boolean(state.writes[key]),
				record: (record) => {
					state.writes[record.dedupKey] = record;
					save();
				},
			},
			"local-provider-controls",
		).logOnly({ writeType: `sandbox.${body.operation}`, dedupKey: key }, async () => {
			const perform = async () => {
				if (body.operation === "lost-ticket-response" || body.operation === "lost-pr-response") {
					if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");
					if (body.operation === "lost-ticket-response")
						forgejo.state.failAfterIssueWrite = body.enabled;
					else forgejo.state.failAfterPullWrite = body.enabled;
					forgejo.save();
					return { enabled: body.enabled };
				}
				const r = forgejo.state.repositories.find(
					(r) => r.repository.full_name === body.repository,
				);
				if (!r) throw new Error("Select a seeded Forgejo repository");
				const owner = r.repository.owner.login,
					name = r.repository.name;
				const client = forgejo.client();
				if (body.operation === "create-issue") {
					const marker = `<!-- ${key} -->`;
					const existing = r.issues.find((i) => i.body?.includes(marker));
					if (existing) return existing;
					return client.createIssue(owner, name, {
						title: body.title?.slice(0, 200) || "Review watering",
						body: `${body.body?.slice(0, 16000) || "Document the weekly review."}\n\n${marker}`,
						labels: r.labels.filter((l) => l.name === "use-leitwerk").map((l) => l.id),
					});
				}
				if (body.operation === "cancel-issue" || body.operation === "remove-trigger") {
					const issue = r.issues.find((i) => i.number === body.number);
					if (!issue) throw new Error("Select a source issue");
					return client.updateIssue(
						owner,
						name,
						issue.number,
						body.operation === "cancel-issue"
							? { state: "closed" }
							: {
									labels: issue.labels.filter((l) => l.name !== "use-leitwerk").map((l) => l.id),
								},
					);
				}
				const pr = r.pulls.find((p) => p.number === body.number);
				if (!pr) throw new Error("Select a pull request in this repository");
				forgejo.refresh(r, pr);
				switch (body.operation) {
					case "merge":
						return pr.merged ? structuredClone(pr) : forgejo.merge(r, pr.number);
					case "close":
						return client.updatePullRequest(owner, name, pr.number, { state: "closed" });
					case "feedback": {
						const kind = body.kind ?? "conversation";
						if (!["conversation", "review", "inline"].includes(kind))
							throw new Error("Invalid feedback kind");
						const marker = `<!-- ${key} -->`;
						const existing = r.feedback[pr.number]?.find((item) => item.body.includes(marker));
						if (existing) return existing;
						return forgejo.addFeedback(r, pr.number, {
							kind,
							body: `${body.body?.slice(0, 16000) || "Add the watering schedule."}\n\n${marker}`,
							author: "reviewer",
							...(kind === "inline" ? { path: "notes.txt", line: 1, reviewId: 1 } : {}),
						});
					}
					case "pipeline": {
						const branch = body.branch ?? pr.head.ref;
						const current = forgejo.head(r, branch);
						const sha = body.sha ?? current;
						if (
							!/^[a-f0-9]{40}$/.test(sha) ||
							!forgejo.git.isAncestor(r.repository.ssh_url, sha, current)
						)
							throw new Error("Pipeline SHA must belong to the selected branch");
						const ci = woodpecker.state.repositories.find(
							(r) => r.repository.full_name === body.repository,
						);
						if (!ci) throw new Error("Unknown local CI repository");
						const existing = ci.pipelines.find((pipeline) => pipeline.controlKey === key);
						if (existing) return existing;
						const valid =
							forgejo.git.run(r.repository.ssh_url, ["show", `${sha}:check.txt`]) === "pass";
						return woodpecker.publish(ci, {
							controlKey: key,
							branch,
							commit: sha,
							status: body.status ?? (valid ? "success" : "failure"),
							logs:
								body.body?.slice(0, 64000) ??
								(valid
									? "Notebook check passed"
									: "Notebook check failed: check.txt must contain pass"),
							event: "push",
						});
					}
					case "advance-base":
					case "conflict": {
						const bare = r.repository.ssh_url;
						const base = forgejo.head(r, pr.base.ref);
						const subject = `docs: advance local base (${body.requestId})`;
						const existing = forgejo.git
							.run(bare, ["log", "--format=%H %s", base])
							.split("\n")
							.find((line) => line.slice(41) === subject)
							?.slice(0, 40);
						if (existing) return { baseSha: existing, headSha: pr.head.sha };
						const directory = localPath(
							forgejo.options.root,
							`control-workspaces/${body.requestId}`,
						);
						mkdirSync(directory, { recursive: true });
						const git = (...args: string[]) => forgejo.git.run(directory, args);
						git("init");
						git("fetch", bare, base);
						git("checkout", "--detach", "FETCH_HEAD");
						const file = body.operation === "conflict" ? "notes.txt" : "season.txt";
						writeFileSync(localPath(directory, file), "Base update: preserve seasonal notes.\n");
						git("add", "--", file);
						git("commit", "--allow-empty", "-m", subject);
						git(
							"push",
							`--force-with-lease=refs/heads/${pr.base.ref}:${base}`,
							bare,
							`HEAD:refs/heads/${pr.base.ref}`,
						);
						return { baseSha: forgejo.head(r, pr.base.ref), headSha: pr.head.sha };
					}
				}
			};
			return { request: fingerprint, result: await perform() };
		});
		return { result: state.writes[key]?.metadata?.result, polling: await poll() };
	};
	return {
		state,
		run(body: ProviderControlInput) {
			const result = pending.then(() => execute(body));
			pending = result.catch(() => {});
			return result;
		},
		register(context: AppContext) {
			context.app.post<{ Body: ProviderControlInput }>(
				"/__local/providers/control",
				async (request, reply) => {
					try {
						return await this.run(request.body);
					} catch (error) {
						return reply.code(400).send({ error: (error as Error).message });
					}
				},
			);
			context.app.get<{ Params: { repository: string; number: string } }>(
				"/__local/providers/diff/:repository/:number",
				async (request, reply) => {
					const r = forgejo.state.repositories.find(
						(r) => r.repository.id === Number(request.params.repository),
					);
					const pr = r?.pulls.find((p) => p.number === Number(request.params.number));
					if (!r || !pr) return reply.code(404).send({ error: "Unknown local pull request" });
					forgejo.refresh(r, pr);
					return {
						pullRequest: pr,
						diff: forgejo.git.run(r.repository.ssh_url, [
							"diff",
							`${pr.base.sha}...${pr.head.sha}`,
							"--",
						]),
					};
				},
			);
		},
	};
}
