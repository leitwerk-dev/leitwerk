import { asUnknownRecord } from "@leitwerk-dev/domain";
import { repositoryHttpsUrl } from "@leitwerk-dev/process-sdk";
import { preflightGitLabRepository } from "./preflight.js";

/** @internal */
export interface GitLabProfile {
	/** @internal */
	baseUrl: string;
	/** @internal */
	token: string;
	/** @internal */
	gitIdentity?: {
		/** @internal */
		name: string;
		/** @internal */
		email: string;
	};
}
/** @public */
export interface GitLabProject {
	/** @public */
	id: number;
	/** @public */
	path_with_namespace: string;
	/** @public */
	http_url_to_repo: string;
	/** @public */
	web_url: string;
	/** @internal */
	default_branch: string;
	/** @public */
	archived?: boolean;
	/** @internal */
	permissions?: {
		/** @internal */
		project_access?: {
			/** @internal */
			access_level: number;
		} | null;
		/** @internal */
		group_access?: {
			/** @internal */
			access_level: number;
		} | null;
	};
}
/** @internal */
export interface GitLabGroup {
	/** @internal */
	id: number;
	/** @internal */
	full_path: string;
}
/** @public */
export interface GitLabIssue {
	/** @public */
	id: number;
	/** @public */
	iid: number;
	/** @public */
	project_id: number;
	/** @public */
	title: string;
	/** @public */
	description: string | null;
	/** @public */
	web_url: string;
	/** @public */
	state: string;
	/** @public */
	labels: string[];
}
/** @public */
export interface GitLabMergeRequest {
	/** @public */
	detailed_merge_status?: string;
	/** @public */
	has_conflicts?: boolean;
	/** @public */
	merge_status?: string;
	/** @public */
	iid: number;
	/** @public */
	project_id: number;
	/** @public */
	source_project_id: number;
	/** @public */
	target_project_id: number;
	/** @public */
	title: string;
	/** @public */
	description: string | null;
	/** @public */
	state: string;
	/** @public */
	labels: string[];
	/** @public */
	sha: string;
	/** @public */
	source_branch: string;
	/** @public */
	target_branch: string;
	/** @public */
	web_url: string;
	/** @internal */
	merge_commit_sha?: string | null;
	/** @internal */
	diff_refs?: {
		/** @internal */
		base_sha: string;
		/** @internal */
		head_sha: string;
		/** @internal */
		start_sha: string;
	};
}
/** @public */
export interface GitLabCommit {
	/** @public */
	id: string;
	/** @internal */
	parent_ids: string[];
	/** @internal */
	message: string;
	/** @internal */
	web_url?: string;
}
/** @public */
export interface GitLabBranch {
	/** @internal */
	name: string;
	/** @public */
	can_push: boolean;
	/** @internal */
	protected: boolean;
	/** @public */
	commit: GitLabCommit;
}
/** @public */
export interface GitLabPipeline {
	/** @public */
	id: number;
	/** @public */
	project_id: number;
	/** @public */
	sha: string;
	/** @public */
	ref: string;
	/** @public */
	status: string;
	/** @internal */
	source?: string;
	/** @public */
	web_url: string;
}
/** @public */
export interface GitLabJob {
	/** @internal */
	id: number;
	/** @public */
	name: string;
	/** @internal */
	status: string;
	/** @public */
	web_url: string;
	/** @public */
	failure_reason?: string;
}
/** @public */
export interface GitLabDiff {
	/** @public */
	old_path: string;
	/** @public */
	new_path: string;
	/** @public */
	diff: string;
	/** @public */
	new_file: boolean;
	/** @public */
	deleted_file: boolean;
	/** @public */
	renamed_file: boolean;
}
/** @public */
export interface GitLabNote {
	/** @internal */
	id: number;
	/** @public */
	body: string;
}
/** @public */
export interface GitLabNoteReaction {
	/** @public */
	id: number;
	/** @internal */
	name: string;
	/** @internal */
	user: {
		/** @internal */
		username: string;
	};
}
/** @public */
export interface GitLabFeedback {
	/** @public */
	id: number;
	/** @public */
	discussionId: string;
	/** @public */
	body: string;
	/** @public */
	author: string;
	/** @public */
	createdAt: string;
	/** @public */
	path?: string;
	/** @public */
	line?: number;
}
/** @internal */
export interface GitLabDiscussion {
	/** @internal */
	id: string;
	/** @internal */
	notes: (GitLabNote & {
		/** @internal */
		system: boolean;
		/** @internal */
		created_at: string;
		/** @internal */
		author: {
			/** @internal */
			username: string;
			/** @internal */
			bot?: boolean;
		};
		/** @internal */
		resolved?: boolean;
		/** @internal */
		position?: {
			/** @internal */
			new_path?: string;
			/** @internal */
			old_path?: string;
			/** @internal */
			new_line?: number;
			/** @internal */
			old_line?: number;
		};
	})[];
}
/** @public */
export interface GitLabIdentity {
	/** @public */
	name: string;
	/** @public */
	email: string;
	/** @public */
	username: string;
}
/** @public */
export interface GitLabObservation {
	/** @public */
	mr: GitLabMergeRequest;
	/** @public */
	pipeline: GitLabPipeline | null;
	/** @public */
	targetHead?: string;
}

/** @public */
export function gitLabMergeabilityPending(mr: GitLabMergeRequest): boolean {
	return ["checking", "unchecked", "preparing"].includes(
		mr.detailed_merge_status ?? mr.merge_status ?? "",
	);
}

/** @public Only actionable Git conflicts/rebase requirements, not approvals or CI gates. */
export function gitLabMergeRepairReason(mr: GitLabMergeRequest): "conflict" | "rebase" | null {
	if (gitLabMergeabilityPending(mr)) return null;
	if (mr.has_conflicts || mr.detailed_merge_status === "conflict") return "conflict";
	return mr.detailed_merge_status === "need_rebase" ? "rebase" : null;
}

/** @internal */
export class GitLabError extends Error {
	/** @internal */
	constructor(
		/** @internal */
		readonly status: number,
		/** @internal */
		readonly retryable: boolean,
	) {
		super(
			`GitLab request failed (${status || "network unavailable"})${retryable ? "; retryable" : "; check profile and project access"}`,
		);
	}
}
/** @internal */
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
/** @public */
export class GitLabClient {
	/** @public */
	readonly baseUrl: string;
	readonly #profile: GitLabProfile;
	readonly #fetch: typeof fetch;
	readonly #sleep: (ms: number) => Promise<unknown>;
	/** @internal */
	constructor(
		profile: GitLabProfile,
		/** @public */
		options: {
			/** @internal */
			fetch?: typeof fetch;
			/** @internal */
			sleep?: (ms: number) => Promise<unknown>;
		} = {},
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
	/** @public */
	listIssues(id: number, signal?: AbortSignal): Promise<GitLabIssue[]> {
		return this.pages(`${projectPath(id)}/issues?state=opened&scope=all`, signal);
	}
	/** @public */
	getIssue(id: number, iid: number, signal?: AbortSignal): Promise<GitLabIssue> {
		return this.request(`${projectPath(id)}/issues/${iid}`, signal);
	}
	/** @public */
	updateIssue(
		id: number,
		iid: number,
		/** @public */
		patch: {
			/** @public */
			labels?: string;
			/** @public */
			state_event?: "close";
		},
		signal?: AbortSignal,
	): Promise<GitLabIssue> {
		return this.request(`${projectPath(id)}/issues/${iid}`, signal, patch, "PUT");
	}
	/** @public */
	listIssueNotes(id: number, iid: number, signal?: AbortSignal): Promise<GitLabNote[]> {
		return this.pages(`${projectPath(id)}/issues/${iid}/notes`, signal);
	}
	/** @public */
	addIssueNote(id: number, iid: number, body: string, signal?: AbortSignal): Promise<GitLabNote> {
		return this.request(`${projectPath(id)}/issues/${iid}/notes`, signal, { body });
	}
	/** @public */
	listLabels(
		id: number,
		signal?: AbortSignal,
	): Promise<
		Array<{
			/** @public */ name: string;
		}>
	> {
		return this.pages(`${projectPath(id)}/labels`, signal);
	}
	/** @public */
	createLabel(
		id: number,
		name: string,
		signal?: AbortSignal,
	): Promise<{
		/** @public */ name: string;
	}> {
		return this.request(`${projectPath(id)}/labels`, signal, { name, color: "#2da44e" });
	}
	/** @public */
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
	/** @public */
	createMergeRequest(
		id: number,
		/** @public */
		input: {
			/** @public */
			title: string;
			/** @public */
			description: string;
			/** @public */
			source_branch: string;
			/** @public */
			target_branch: string;
		},
		signal?: AbortSignal,
	): Promise<GitLabMergeRequest> {
		return this.request(`${projectPath(id)}/merge_requests`, signal, {
			...input,
			remove_source_branch: false,
		});
	}
	/** @public */
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

	/** @public */
	getProject(id: number | string, signal?: AbortSignal): Promise<GitLabProject> {
		return this.request(projectPath(id), signal);
	}
	/** @internal */
	listProjects(signal?: AbortSignal): Promise<GitLabProject[]> {
		return this.pages("/projects?archived=false", signal);
	}
	/** @internal */
	getGroup(id: number | string, signal?: AbortSignal): Promise<GitLabGroup> {
		return this.request(`/groups/${encodeURIComponent(id)}`, signal);
	}
	/** @internal */
	listGroupProjects(id: number | string, signal?: AbortSignal): Promise<GitLabProject[]> {
		return this.pages(
			`/groups/${encodeURIComponent(id)}/projects?include_subgroups=true&with_shared=false&archived=false`,
			signal,
		);
	}
	/** @public */
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
	/** @internal */
	getMergeRequest(id: number, iid: number, signal?: AbortSignal): Promise<GitLabMergeRequest> {
		return this.request(mrPath(id, iid), signal);
	}
	/** @public */
	getChanges(id: number, iid: number, signal?: AbortSignal): Promise<GitLabDiff[]> {
		return this.pages(`${mrPath(id, iid)}/diffs`, signal);
	}
	/** @public */
	getBranch(id: number, branch: string, signal?: AbortSignal): Promise<GitLabBranch> {
		return this.request(
			`${projectPath(id)}/repository/branches/${encodeURIComponent(branch)}`,
			signal,
		);
	}
	/** @internal */
	getCommit(id: number, sha: string, signal?: AbortSignal): Promise<GitLabCommit> {
		return this.request(`${projectPath(id)}/repository/commits/${encodeURIComponent(sha)}`, signal);
	}
	/** @internal */
	listMergeRequestPipelines(
		id: number,
		iid: number,
		signal?: AbortSignal,
	): Promise<GitLabPipeline[]> {
		return this.pages(`${mrPath(id, iid)}/pipelines`, signal);
	}
	/** @internal */
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
	/** @internal */
	getPipeline(id: number, pipeline: number, signal?: AbortSignal): Promise<GitLabPipeline> {
		return this.request(`${projectPath(id)}/pipelines/${pipeline}`, signal);
	}
	/** @public */
	listFailedJobs(id: number, pipeline: number, signal?: AbortSignal): Promise<GitLabJob[]> {
		return this.pages(
			`${projectPath(id)}/pipelines/${pipeline}/jobs?scope[]=failed&include_retried=false`,
			signal,
		);
	}
	/** @internal */
	listNotes(id: number, iid: number, signal?: AbortSignal): Promise<GitLabNote[]> {
		return this.pages(`${mrPath(id, iid)}/notes`, signal);
	}
	/** @internal */
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
	/** @internal */
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
	/** @internal */
	listNoteReactions(
		id: number,
		iid: number,
		noteId: number,
		signal?: AbortSignal,
	): Promise<GitLabNoteReaction[]> {
		return this.pages(`${mrPath(id, iid)}/notes/${noteId}/award_emoji`, signal);
	}
	/** @internal */
	addNoteReaction(
		id: number,
		iid: number,
		noteId: number,
		name: string,
		signal?: AbortSignal,
	): Promise<GitLabNoteReaction> {
		return this.request(`${mrPath(id, iid)}/notes/${noteId}/award_emoji`, signal, { name });
	}
	/** @public */
	async listMergeRequestFeedback(
		id: number,
		iid: number,
		signal?: AbortSignal,
	): Promise<GitLabFeedback[]> {
		const discussions = await this.pages<GitLabDiscussion>(
			`${mrPath(id, iid)}/discussions`,
			signal,
		);
		const feedback: GitLabFeedback[] = [];
		for (const discussion of discussions) {
			for (const note of discussion.notes) {
				if (
					note.system ||
					note.resolved ||
					note.author.bot ||
					/<!-- leitwerk:gitlab:[a-f0-9]{64} -->/.test(note.body) ||
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
	/** @internal */
	addNote(id: number, iid: number, body: string, signal?: AbortSignal): Promise<GitLabNote> {
		return this.request(`${mrPath(id, iid)}/notes`, signal, { body });
	}
	/** @public */
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
	/** @public */
	async getJobTrace(
		id: number,
		job: number,
		maxBytes = 65_536,
		signal?: AbortSignal,
		/** @public */
	): Promise<{
		/** @public */
		text: string;
		/** @public */
		truncated: boolean;
	}> {
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
/** @public */
export type GitLabClientLike = Pick<
	GitLabClient,
	| "listIssues"
	| "getIssue"
	| "updateIssue"
	| "listIssueNotes"
	| "addIssueNote"
	| "listLabels"
	| "createLabel"
	| "listBranchMergeRequests"
	| "createMergeRequest"
	| "preflightRepository"
	| "addNote"
	| "addNoteReaction"
	| "baseUrl"
	| "getBranch"
	| "getChanges"
	| "getCommit"
	| "getDiscussion"
	| "getGroup"
	| "getJobTrace"
	| "getMergeRequest"
	| "getPipeline"
	| "getProject"
	| "listBranchPipelines"
	| "listFailedJobs"
	| "listGroupProjects"
	| "listMergeRequestFeedback"
	| "listMergeRequestPipelines"
	| "listMergeRequests"
	| "listNoteReactions"
	| "listNotes"
	| "listProjects"
	| "replyToDiscussion"
	| "resolveGitIdentity"
>;

/** A pending current pipeline supersedes every older result. Synthetic merges must contain this source head. */
/** @public */
export async function observeMergeRequest(
	client: GitLabClientLike,
	projectId: number,
	iid: number,
	signal?: AbortSignal,
): Promise<GitLabObservation> {
	const mr = await client.getMergeRequest(projectId, iid, signal);
	if (mr.state !== "opened") return { mr, pipeline: null };
	const targetHead = (await client.getBranch(mr.target_project_id, mr.target_branch, signal)).commit
		.id;
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
		if (matches)
			return { mr, targetHead, pipeline: await client.getPipeline(id, candidate.id, signal) };
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
		targetHead,
		pipeline: latest ? await client.getPipeline(mr.source_project_id, latest.id, signal) : null,
	};
}
