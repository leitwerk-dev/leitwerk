import { asUnknownRecord } from "@leitwerk-dev/domain";
import { repositoryHttpsUrl } from "@leitwerk-dev/process-sdk";
import { preflightGitLabRepository } from "./preflight.js";

export interface GitLabProfile {
	baseUrl: string;
	token: string;
	gitIdentity?: { name: string; email: string };
}
export interface GitLabProject {
	id: number;
	path_with_namespace: string;
	http_url_to_repo: string;
	web_url: string;
	default_branch: string;
	archived?: boolean;
	permissions?: {
		project_access?: { access_level: number } | null;
		group_access?: { access_level: number } | null;
	};
}
export interface GitLabGroup {
	id: number;
	full_path: string;
}
export interface GitLabIssue {
	id: number;
	iid: number;
	project_id: number;
	title: string;
	description: string | null;
	web_url: string;
	state: string;
	labels: string[];
}
export interface GitLabMergeRequest {
	detailed_merge_status?: string;
	has_conflicts?: boolean;
	iid: number;
	project_id: number;
	source_project_id: number;
	target_project_id: number;
	title: string;
	description: string | null;
	state: string;
	labels: string[];
	sha: string;
	source_branch: string;
	target_branch: string;
	web_url: string;
	merge_commit_sha?: string | null;
	diff_refs?: { base_sha: string; head_sha: string; start_sha: string };
}
export interface GitLabCommit {
	id: string;
	parent_ids: string[];
	message: string;
	web_url?: string;
}
export interface GitLabBranch {
	name: string;
	can_push: boolean;
	protected: boolean;
	commit: GitLabCommit;
}
export interface GitLabPipeline {
	id: number;
	project_id: number;
	sha: string;
	ref: string;
	status: string;
	source?: string;
	web_url: string;
}
export interface GitLabJob {
	id: number;
	name: string;
	status: string;
	web_url: string;
	failure_reason?: string;
}
export interface GitLabDiff {
	old_path: string;
	new_path: string;
	diff: string;
	new_file: boolean;
	deleted_file: boolean;
	renamed_file: boolean;
}
export interface GitLabNote {
	id: number;
	body: string;
}
export interface GitLabNoteReaction {
	id: number;
	name: string;
	user: { username: string };
}
export interface GitLabFeedback {
	id: number;
	discussionId: string;
	body: string;
	author: string;
	createdAt: string;
	path?: string;
	line?: number;
}
export interface GitLabDiscussion {
	id: string;
	notes: (GitLabNote & {
		system: boolean;
		created_at: string;
		author: { username: string; bot?: boolean };
		resolved?: boolean;
		position?: { new_path?: string; old_path?: string; new_line?: number; old_line?: number };
	})[];
}
export interface GitLabIdentity {
	name: string;
	email: string;
	username: string;
}
export interface GitLabObservation {
	mr: GitLabMergeRequest;
	pipeline: GitLabPipeline | null;
}

export class GitLabError extends Error {
	constructor(
		readonly status: number,
		readonly retryable: boolean,
	) {
		super(
			`GitLab request failed (${status || "network unavailable"})${retryable ? "; retryable" : "; check profile and project access"}`,
		);
	}
}
export function parseGitLabProfiles(raw: unknown): Map<string, GitLabProfile> {
	const profiles = new Map<string, GitLabProfile>();
	for (const [name, value] of Object.entries(
		asUnknownRecord(asUnknownRecord(raw)?.profiles) ?? {},
	)) {
		const item = asUnknownRecord(value) ?? {};
		const baseUrl = typeof item.base_url === "string" ? item.base_url.replace(/\/+$/, "") : "";
		const url = repositoryHttpsUrl(`${baseUrl}/` === "/" ? "" : `${baseUrl}/repository`);
		if (url.origin !== baseUrl)
			throw new Error(`GitLab profile '${name}' requires an HTTPS origin base_url`);
		const configuredToken = typeof item.token === "string" ? item.token : "";
		const token = configuredToken.startsWith("env:")
			? (process.env[configuredToken.slice(4)] ?? "")
			: configuredToken;
		if (!token || /[\r\n\0]/.test(token))
			throw new Error(`GitLab profile '${name}' requires a token`);
		const identity = asUnknownRecord(item.git_identity);
		if (
			identity &&
			[identity.name, identity.email].some(
				(v) => typeof v !== "string" || !v.trim() || /[\r\n<>]/.test(v),
			)
		)
			throw new Error(`GitLab profile '${name}' requires a valid git_identity name and email`);
		profiles.set(name, {
			baseUrl,
			token,
			...(identity
				? { gitIdentity: { name: String(identity.name), email: String(identity.email) } }
				: {}),
		});
	}
	return profiles;
}
const projectPath = (id: number | string) => `/projects/${encodeURIComponent(id)}`;
const mrPath = (id: number, iid: number) => `${projectPath(id)}/merge_requests/${iid}`;

/** GitLab v4 API. Errors deliberately omit response bodies, headers and tokens. */
export class GitLabClient {
	readonly baseUrl: string;
	readonly #profile: GitLabProfile;
	readonly #fetch: typeof fetch;
	readonly #sleep: (ms: number) => Promise<unknown>;
	constructor(
		profile: GitLabProfile,
		options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<unknown> } = {},
	) {
		if (repositoryHttpsUrl(`${profile.baseUrl}/repository`).origin !== profile.baseUrl)
			throw new Error("GitLab requires an HTTPS origin baseUrl");
		if (!profile.token || /[\r\n\0]/.test(profile.token))
			throw new Error("GitLab requires a valid token");
		this.#profile = profile;
		this.baseUrl = profile.baseUrl;
		this.#fetch = options.fetch ?? fetch;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}
	private async response(
		path: string,
		signal?: AbortSignal,
		body?: unknown,
		method?: string,
	): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await this.#fetch(`${this.baseUrl}/api/v4${path}`, {
					method: method ?? (body === undefined ? "GET" : "POST"),
					redirect: "error",
					headers: {
						"PRIVATE-TOKEN": this.#profile.token,
						Accept: "application/json",
						...(body === undefined ? {} : { "Content-Type": "application/json" }),
					},
					signal: signal
						? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
						: AbortSignal.timeout(30_000),
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
			} catch {
				if (signal?.aborted) throw new GitLabError(0, true);
				if (body !== undefined || attempt >= 2) throw new GitLabError(0, true);
				await this.#sleep(1_000 * 2 ** attempt);
				continue;
			}
			if (response.ok) return response;
			const retryable =
				response.status === 429 || response.status >= 500 || response.status === 408;
			await response.body?.cancel();
			if (!retryable || body !== undefined || attempt >= 2)
				throw new GitLabError(response.status, retryable);
			const seconds = Number(response.headers.get("retry-after"));
			await this.#sleep(Math.min(30_000, seconds > 0 ? seconds * 1_000 : 1_000 * 2 ** attempt));
		}
	}
	private async request<T>(
		path: string,
		signal?: AbortSignal,
		body?: unknown,
		method?: string,
	): Promise<T> {
		return this.json<T>(await this.response(path, signal, body, method));
	}
	private async json<T>(response: Response): Promise<T> {
		try {
			return (await response.json()) as T;
		} catch {
			throw new GitLabError(502, true);
		}
	}
	private async pages<T>(path: string, signal?: AbortSignal): Promise<T[]> {
		const rows: T[] = [];
		let page = 1;
		for (let n = 0; n < 10_000; n++) {
			const response = await this.response(
				`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
				signal,
			);
			const batch = await this.json<T[]>(response);
			if (!Array.isArray(batch)) throw new Error("Invalid GitLab list response");
			rows.push(...batch);
			const next = response.headers.get("x-next-page");
			if (next === "" || (next === null && batch.length < 100)) return rows;
			const nextPage = next === null ? page + 1 : Number(next);
			if (!Number.isInteger(nextPage) || nextPage <= page)
				throw new Error("Invalid GitLab pagination");
			page = nextPage;
		}
		throw new Error("GitLab pagination limit exceeded; discovery incomplete");
	}
	listIssues(id: number, signal?: AbortSignal): Promise<GitLabIssue[]> {
		return this.pages(`${projectPath(id)}/issues?state=opened&scope=all`, signal);
	}
	getIssue(id: number, iid: number, signal?: AbortSignal): Promise<GitLabIssue> {
		return this.request(`${projectPath(id)}/issues/${iid}`, signal);
	}
	updateIssue(
		id: number,
		iid: number,
		patch: { labels?: string; state_event?: "close" },
		signal?: AbortSignal,
	): Promise<GitLabIssue> {
		return this.request(`${projectPath(id)}/issues/${iid}`, signal, patch, "PUT");
	}
	listIssueNotes(id: number, iid: number, signal?: AbortSignal): Promise<GitLabNote[]> {
		return this.pages(`${projectPath(id)}/issues/${iid}/notes`, signal);
	}
	addIssueNote(id: number, iid: number, body: string, signal?: AbortSignal): Promise<GitLabNote> {
		return this.request(`${projectPath(id)}/issues/${iid}/notes`, signal, { body });
	}
	listLabels(id: number, signal?: AbortSignal): Promise<Array<{ name: string }>> {
		return this.pages(`${projectPath(id)}/labels`, signal);
	}
	createLabel(id: number, name: string, signal?: AbortSignal): Promise<{ name: string }> {
		return this.request(`${projectPath(id)}/labels`, signal, { name, color: "#2da44e" });
	}
	listBranchMergeRequests(
		id: number,
		source: string,
		target: string,
		signal?: AbortSignal,
	): Promise<GitLabMergeRequest[]> {
		return this.pages(
			`${projectPath(id)}/merge_requests?state=all&source_branch=${encodeURIComponent(source)}&target_branch=${encodeURIComponent(target)}`,
			signal,
		);
	}
	createMergeRequest(
		id: number,
		input: { title: string; description: string; source_branch: string; target_branch: string },
		signal?: AbortSignal,
	): Promise<GitLabMergeRequest> {
		return this.request(`${projectPath(id)}/merge_requests`, signal, {
			...input,
			remove_source_branch: false,
		});
	}
	async preflightRepository(
		projectId: number,
		baseBranch: string,
		workBranch: string,
		signal?: AbortSignal,
	): Promise<void> {
		const project = await this.getProject(projectId, signal);
		await preflightGitLabRepository({
			url: project.http_url_to_repo,
			origin: this.baseUrl,
			token: this.#profile.token,
			baseBranch,
			workBranch,
			signal,
		});
	}

	getProject(id: number | string, signal?: AbortSignal): Promise<GitLabProject> {
		return this.request(projectPath(id), signal);
	}
	listProjects(signal?: AbortSignal): Promise<GitLabProject[]> {
		return this.pages("/projects?archived=false", signal);
	}
	getGroup(id: number | string, signal?: AbortSignal): Promise<GitLabGroup> {
		return this.request(`/groups/${encodeURIComponent(id)}`, signal);
	}
	listGroupProjects(id: number | string, signal?: AbortSignal): Promise<GitLabProject[]> {
		return this.pages(
			`/groups/${encodeURIComponent(id)}/projects?include_subgroups=true&with_shared=false&archived=false`,
			signal,
		);
	}
	listMergeRequests(
		id: number,
		label: string,
		signal?: AbortSignal,
	): Promise<GitLabMergeRequest[]> {
		return this.pages(
			`${projectPath(id)}/merge_requests?state=opened&labels=${encodeURIComponent(label)}`,
			signal,
		);
	}
	getMergeRequest(id: number, iid: number, signal?: AbortSignal): Promise<GitLabMergeRequest> {
		return this.request(mrPath(id, iid), signal);
	}
	getChanges(id: number, iid: number, signal?: AbortSignal): Promise<GitLabDiff[]> {
		return this.pages(`${mrPath(id, iid)}/diffs`, signal);
	}
	getBranch(id: number, branch: string, signal?: AbortSignal): Promise<GitLabBranch> {
		return this.request(
			`${projectPath(id)}/repository/branches/${encodeURIComponent(branch)}`,
			signal,
		);
	}
	getCommit(id: number, sha: string, signal?: AbortSignal): Promise<GitLabCommit> {
		return this.request(`${projectPath(id)}/repository/commits/${encodeURIComponent(sha)}`, signal);
	}
	listMergeRequestPipelines(
		id: number,
		iid: number,
		signal?: AbortSignal,
	): Promise<GitLabPipeline[]> {
		return this.pages(`${mrPath(id, iid)}/pipelines`, signal);
	}
	listBranchPipelines(
		id: number,
		branch: string,
		sha: string,
		signal?: AbortSignal,
	): Promise<GitLabPipeline[]> {
		return this.pages(
			`${projectPath(id)}/pipelines?ref=${encodeURIComponent(branch)}&sha=${encodeURIComponent(sha)}&source=push`,
			signal,
		);
	}
	getPipeline(id: number, pipeline: number, signal?: AbortSignal): Promise<GitLabPipeline> {
		return this.request(`${projectPath(id)}/pipelines/${pipeline}`, signal);
	}
	listFailedJobs(id: number, pipeline: number, signal?: AbortSignal): Promise<GitLabJob[]> {
		return this.pages(
			`${projectPath(id)}/pipelines/${pipeline}/jobs?scope[]=failed&include_retried=false`,
			signal,
		);
	}
	listNotes(id: number, iid: number, signal?: AbortSignal): Promise<GitLabNote[]> {
		return this.pages(`${mrPath(id, iid)}/notes`, signal);
	}
	getDiscussion(
		id: number,
		iid: number,
		discussionId: string,
		signal?: AbortSignal,
	): Promise<GitLabDiscussion> {
		return this.request(
			`${mrPath(id, iid)}/discussions/${encodeURIComponent(discussionId)}`,
			signal,
		);
	}
	replyToDiscussion(
		id: number,
		iid: number,
		discussionId: string,
		body: string,
		signal?: AbortSignal,
	): Promise<GitLabNote> {
		return this.request(
			`${mrPath(id, iid)}/discussions/${encodeURIComponent(discussionId)}/notes`,
			signal,
			{ body },
		);
	}
	listNoteReactions(
		id: number,
		iid: number,
		noteId: number,
		signal?: AbortSignal,
	): Promise<GitLabNoteReaction[]> {
		return this.pages(`${mrPath(id, iid)}/notes/${noteId}/award_emoji`, signal);
	}
	addNoteReaction(
		id: number,
		iid: number,
		noteId: number,
		name: string,
		signal?: AbortSignal,
	): Promise<GitLabNoteReaction> {
		return this.request(`${mrPath(id, iid)}/notes/${noteId}/award_emoji`, signal, { name });
	}
	async listMergeRequestFeedback(
		id: number,
		iid: number,
		signal?: AbortSignal,
	): Promise<GitLabFeedback[]> {
		const [discussions, identity] = await Promise.all([
			this.pages<GitLabDiscussion>(`${mrPath(id, iid)}/discussions`, signal),
			this.resolveGitIdentity(signal),
		]);
		const feedback: GitLabFeedback[] = [];
		for (const discussion of discussions) {
			for (const note of discussion.notes) {
				if (
					note.system ||
					note.resolved ||
					note.author.bot ||
					note.author.username === identity.username ||
					!note.body.trim() ||
					!Number.isFinite(Date.parse(note.created_at))
				)
					continue;
				const position = note.position ?? discussion.notes[0]?.position;
				feedback.push({
					id: note.id,
					discussionId: discussion.id,
					body: note.body,
					author: note.author.username,
					createdAt: note.created_at,
					...(position
						? {
								path: position.new_path ?? position.old_path,
								line: position.new_line ?? position.old_line,
							}
						: {}),
				});
			}
		}
		return feedback.sort((a, b) => a.id - b.id);
	}
	addNote(id: number, iid: number, body: string, signal?: AbortSignal): Promise<GitLabNote> {
		return this.request(`${mrPath(id, iid)}/notes`, signal, { body });
	}
	async resolveGitIdentity(signal?: AbortSignal): Promise<GitLabIdentity> {
		const user = await this.request<{
			name?: string;
			username?: string;
			email?: string;
			commit_email?: string;
		}>("/user", signal);
		const name = this.#profile.gitIdentity?.name ?? user.name;
		const email = this.#profile.gitIdentity?.email ?? user.commit_email ?? user.email;
		if (!user.username || !name?.trim() || !email?.includes("@") || /[\r\n<>]/.test(name + email))
			throw new Error(
				"GitLab bot Git identity is unavailable; configure git_identity on the profile",
			);
		return { name, email, username: user.username };
	}
	async getJobTrace(
		id: number,
		job: number,
		maxBytes = 65_536,
		signal?: AbortSignal,
	): Promise<{ text: string; truncated: boolean }> {
		const limit = Math.min(262_144, Math.max(1, Math.floor(maxBytes) || 65_536));
		const response = await this.response(`${projectPath(id)}/jobs/${job}/trace`, signal);
		const reader = response.body?.getReader();
		if (!reader) return { text: "", truncated: false };
		const chunks: Uint8Array[] = [];
		let size = 0;
		let truncated = false;
		try {
			while (true) {
				const item = await reader.read();
				if (item.done) break;
				const take = Math.min(item.value.length, limit - size);
				chunks.push(item.value.slice(0, take));
				size += take;
				if (size >= limit) {
					truncated = true;
					break;
				}
			}
		} finally {
			await reader.cancel();
		}
		return { text: Buffer.concat(chunks).toString("utf8"), truncated };
	}
}
export type GitLabClientLike = Pick<GitLabClient, keyof GitLabClient>;

/** A pending current pipeline supersedes every older result. Synthetic merges must contain this source head. */
export async function observeMergeRequest(
	client: GitLabClientLike,
	projectId: number,
	iid: number,
	signal?: AbortSignal,
): Promise<GitLabObservation> {
	const mr = await client.getMergeRequest(projectId, iid, signal);
	if (mr.state !== "opened") return { mr, pipeline: null };
	const associated = (await client.listMergeRequestPipelines(projectId, iid, signal)).sort(
		(a, b) => b.id - a.id,
	);
	for (const candidate of associated) {
		const id = candidate.project_id ?? projectId;
		let matches = candidate.sha === mr.sha;
		if (
			!matches &&
			(candidate.ref === `refs/merge-requests/${iid}/merge` ||
				candidate.sha === mr.merge_commit_sha)
		) {
			const commit = await client.getCommit(id, candidate.sha, signal);
			matches = commit.parent_ids.includes(mr.sha);
		}
		if (matches) return { mr, pipeline: await client.getPipeline(id, candidate.id, signal) };
	}
	const candidates = await client.listBranchPipelines(
		mr.source_project_id,
		mr.source_branch,
		mr.sha,
		signal,
	);
	const latest = candidates
		.filter((p) => p.sha === mr.sha && p.ref === mr.source_branch && p.source === "push")
		.sort((a, b) => b.id - a.id)[0];
	return {
		mr,
		pipeline: latest ? await client.getPipeline(mr.source_project_id, latest.id, signal) : null,
	};
}
