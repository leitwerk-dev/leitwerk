import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
	GitLabClientLike,
	GitLabDiff,
	GitLabFeedback,
	GitLabIssue,
	GitLabMergeRequest,
	GitLabNote,
	GitLabNoteReaction,
	GitLabPipeline,
	GitLabProject,
} from "./client.js";

export type {
	GitLabClientLike,
	GitLabMergeRequest,
	GitLabPipeline,
	GitLabProject,
} from "./client.js";
export { setupGitLabIntegration } from "./index.js";

/** @public */
interface LocalState {
	/** @public */
	issues?: GitLabIssue[];
	/** @public */
	issueNotes?: Record<string, GitLabNote[]>;
	/** @public */
	labels?: Record<string, string[]>;
	/** @internal */
	projects: GitLabProject[];
	/** @internal */
	mrs: GitLabMergeRequest[];
	/** @internal */
	pipelines: GitLabPipeline[];
	/** @public */
	notes: Record<string, GitLabNote[]>;
	/** @internal */
	diffs: Record<string, GitLabDiff[]>;
	/** @public */
	feedback?: Record<string, GitLabFeedback[]>;
	/** @public */
	discussionNotes?: Record<string, GitLabNote[]>;
	/** @public */
	reactions?: Record<string, GitLabNoteReaction[]>;
}
/** Persistent GitLab test boundary. Repository URLs use local Git's file transport. */
/** @public */
export class LocalGitLabAdapter {
	/** @public */
	state: LocalState;
	/** @public */
	loseNextCommentResponse = false;
	/** @public */
	loseNextMergeRequestResponse = false;
	/** @public */
	loseNextReplyResponse = false;
	/** @public */
	loseNextReactionResponse = false;
	/** @public */
	constructor(
		/** @internal */
		readonly root: string,
		/** @internal */
		readonly baseUrl = "https://gitlab.test",
	) {
		mkdirSync(root, { recursive: true });
		const file = path.join(root, "gitlab.json");
		this.state = existsSync(file)
			? JSON.parse(readFileSync(file, "utf8"))
			: { projects: [], mrs: [], pipelines: [], notes: {}, diffs: {} };
	}
	/** @public */
	save() {
		writeFileSync(path.join(this.root, "gitlab.json"), JSON.stringify(this.state), { mode: 0o600 });
	}
	private append<T>(items: T[], item: T, kind: "Comment" | "Reply" | "Reaction"): T {
		items.push(item);
		this.save();
		const flag = `loseNext${kind}Response` as const;
		if (this[flag]) {
			this[flag] = false;
			const action = {
				Comment: "comment write",
				Reply: "discussion reply",
				Reaction: "reaction write",
			};
			throw new Error(`Response lost after ${action[kind]}`);
		}
		return item;
	}
	private project(id: number | string) {
		const p = this.state.projects.find((p) => p.id === id || p.path_with_namespace === id);
		if (!p) throw new Error("Unknown test project");
		return p;
	}
	private git(id: number, args: string[]) {
		return execFileSync(
			"git",
			["-c", "core.hooksPath=/dev/null", "--git-dir", this.project(id).http_url_to_repo, ...args],
			{ encoding: "utf8" },
		).trim();
	}
	/** @public */
	addProject(name: string, bare: string): GitLabProject {
		const project: GitLabProject = {
			id: this.state.projects.length + 1,
			path_with_namespace: name,
			http_url_to_repo: bare,
			web_url: `${this.baseUrl}/${name}`,
			default_branch: "main",
		};
		this.state.projects.push(project);
		this.save();
		return project;
	}
	/** @public */
	openMr(project: GitLabProject, branch: string): GitLabMergeRequest {
		const mr: GitLabMergeRequest = {
			iid: this.state.mrs.length + 1,
			project_id: project.id,
			target_project_id: project.id,
			source_project_id: project.id,
			title: "Update dependency",
			description: "Renovate upgrade",
			state: "opened",
			labels: ["renovate"],
			sha: this.git(project.id, ["rev-parse", branch]),
			source_branch: branch,
			target_branch: "main",
			web_url: `${project.web_url}/-/merge_requests/${this.state.mrs.length + 1}`,
		};
		this.state.mrs.push(mr);
		this.save();
		return mr;
	}
	/** @public */
	pipeline(mr: GitLabMergeRequest, status: string): GitLabPipeline {
		const value: GitLabPipeline = {
			id: this.state.pipelines.length + 1,
			project_id: mr.source_project_id,
			sha: this.git(mr.source_project_id, ["rev-parse", mr.source_branch]),
			ref: mr.source_branch,
			status,
			source: "merge_request_event",
			web_url: `${this.project(mr.source_project_id).web_url}/-/pipelines/${this.state.pipelines.length + 1}`,
		};
		this.state.pipelines.push(value);
		this.save();
		return value;
	}
	/** @public */
	createIssue(projectId: number, title: string, labels: string[] = ["use-leitwerk"]): GitLabIssue {
		this.state.issues ??= [];
		const project = this.project(projectId);
		const iid = this.state.issues.filter((i) => i.project_id === projectId).length + 1;
		const issue: GitLabIssue = {
			id: this.state.issues.length + 1,
			iid,
			project_id: projectId,
			title,
			description: "",
			web_url: `${project.web_url}/-/issues/${iid}`,
			state: "opened",
			labels,
		};
		this.state.issues.push(issue);
		this.save();
		return issue;
	}
	/** @public */
	merge(request: GitLabMergeRequest) {
		const base = this.git(request.project_id, ["rev-parse", request.target_branch]);
		const head = this.git(request.project_id, ["rev-parse", request.source_branch]);
		const tree = this.git(request.project_id, ["merge-tree", "--write-tree", base, head]);
		const commit = this.git(request.project_id, [
			"-c",
			"user.name=Leitwerk Bot",
			"-c",
			"user.email=bot@gitlab.test",
			"commit-tree",
			tree,
			"-p",
			base,
			"-p",
			head,
			"-m",
			request.title,
		]);
		this.git(request.project_id, [
			"update-ref",
			`refs/heads/${request.target_branch}`,
			commit,
			base,
		]);
		request.state = "merged";
		request.merge_commit_sha = commit;
		this.save();
	}
	private conflicts(request: GitLabMergeRequest): boolean {
		try {
			this.git(request.project_id, [
				"merge-tree",
				"--write-tree",
				request.target_branch,
				request.source_branch,
			]);
			return false;
		} catch {
			return true;
		}
	}
	/** @public */
	client(): GitLabClientLike {
		const mr = (id: number, iid: number) => {
			const m = this.state.mrs.find((m) => m.project_id === id && m.iid === iid);
			if (!m) throw new Error("Unknown test MR");
			return m;
		};
		const commit = (id: number, ref: string) => ({
			id: this.git(id, ["rev-parse", ref]),
			parent_ids: this.git(id, ["show", "-s", "--format=%P", ref]).split(" ").filter(Boolean),
			message: this.git(id, ["show", "-s", "--format=%B", ref]),
		});
		return {
			baseUrl: this.baseUrl,
			listIssues: async (id) =>
				structuredClone(
					(this.state.issues ?? []).filter((i) => i.project_id === id && i.state === "opened"),
				),
			getIssue: async (id, iid) => {
				const issue = (this.state.issues ?? []).find((i) => i.project_id === id && i.iid === iid);
				if (!issue) throw new Error("Unknown local GitLab issue");
				return structuredClone(issue);
			},
			updateIssue: async (id, iid, patch) => {
				const issue = (this.state.issues ?? []).find((i) => i.project_id === id && i.iid === iid);
				if (!issue) throw new Error("Unknown local GitLab issue");
				if (patch.labels !== undefined) issue.labels = patch.labels ? patch.labels.split(",") : [];
				if (patch.state_event === "close") issue.state = "closed";
				this.save();
				return structuredClone(issue);
			},
			listIssueNotes: async (id, iid) =>
				structuredClone(this.state.issueNotes?.[`${id}:${iid}`] ?? []),
			addIssueNote: async (id, iid, body) => {
				this.state.issueNotes ??= {};
				this.state.issueNotes[`${id}:${iid}`] ??= [];
				const notes = this.state.issueNotes[`${id}:${iid}`];
				return this.append(notes, { id: notes.length + 1, body }, "Comment");
			},
			listLabels: async (id) => (this.state.labels?.[id] ?? []).map((name) => ({ name })),
			createLabel: async (id, name) => {
				this.state.labels ??= {};
				this.state.labels[id] ??= [];
				const labels = this.state.labels[id];
				if (!labels.includes(name)) labels.push(name);
				this.save();
				return { name };
			},
			listBranchMergeRequests: async (id, source, target) =>
				structuredClone(
					this.state.mrs.filter(
						(m) => m.project_id === id && m.source_branch === source && m.target_branch === target,
					),
				),
			createMergeRequest: async (id, input) => {
				const request = this.openMr(this.project(id), input.source_branch);
				Object.assign(request, {
					title: input.title,
					description: input.description,
					target_branch: input.target_branch,
					labels: [],
				});
				this.save();
				if (this.loseNextMergeRequestResponse) {
					this.loseNextMergeRequestResponse = false;
					throw new Error("Response lost after merge request creation");
				}
				return structuredClone(request);
			},
			preflightRepository: async (id, baseBranch, workBranch) => {
				this.git(id, ["rev-parse", `refs/heads/${baseBranch}`]);
				this.git(id, ["check-ref-format", `refs/heads/${workBranch}`]);
				this.git(id, [
					"push",
					"--dry-run",
					this.project(id).http_url_to_repo,
					`${baseBranch}:refs/heads/${workBranch}`,
				]);
			},

			getProject: async (id) => structuredClone(this.project(id)),
			listProjects: async () => structuredClone(this.state.projects),
			getGroup: async (id) => ({ id: 1, full_path: String(id) }),
			listGroupProjects: async (group) =>
				structuredClone(
					this.state.projects.filter((p) => p.path_with_namespace.startsWith(`${group}/`)),
				),
			getMergeRequest: async (id, iid) => ({
				...structuredClone(mr(id, iid)),
				has_conflicts: this.conflicts(mr(id, iid)),
				sha: commit(mr(id, iid).source_project_id, mr(id, iid).source_branch).id,
			}),
			listMergeRequests: async (id, label) =>
				structuredClone(
					this.state.mrs.filter(
						(m) => m.project_id === id && m.state === "opened" && m.labels.includes(label),
					),
				),
			getBranch: async (id, branch) => ({
				name: branch,
				can_push: true,
				protected: false,
				commit: commit(id, branch),
			}),
			getCommit: async (id, ref) => commit(id, ref),
			getChanges: async (id, iid) => structuredClone(this.state.diffs[`${id}:${iid}`] ?? []),
			listMergeRequestPipelines: async (id, iid) =>
				structuredClone(
					this.state.pipelines.filter(
						(p) =>
							p.project_id === mr(id, iid).source_project_id && p.ref === mr(id, iid).source_branch,
					),
				),
			listBranchPipelines: async (id, branch, sha) =>
				structuredClone(
					this.state.pipelines.filter(
						(p) => p.project_id === id && p.ref === branch && p.sha === sha && p.source === "push",
					),
				),
			getPipeline: async (id, pipeline) => {
				const p = this.state.pipelines.find((p) => p.project_id === id && p.id === pipeline);
				if (!p) throw new Error("Unknown test pipeline");
				return structuredClone(p);
			},
			listFailedJobs: async (id, pipeline) => [
				{
					id: pipeline * 100,
					name: "test",
					status: "failed",
					web_url: `${this.project(id).web_url}/-/jobs/${pipeline * 100}`,
					failure_reason: "script_failure",
				},
			],
			getJobTrace: async () => ({
				text: "Expected new dependency API; test failed",
				truncated: false,
			}),
			resolveGitIdentity: async () => ({
				name: "Leitwerk Bot",
				email: "bot@gitlab.test",
				username: "bot",
			}),
			listNotes: async (id, iid) => structuredClone(this.state.notes[`${id}:${iid}`] ?? []),
			listMergeRequestFeedback: async (id, iid) =>
				structuredClone(this.state.feedback?.[`${id}:${iid}`] ?? []),
			getDiscussion: async (id, iid, discussionId) => ({
				id: discussionId,
				notes: (this.state.discussionNotes?.[`${id}:${iid}:${discussionId}`] ?? []).map((note) => ({
					...structuredClone(note),
					system: false,
					created_at: new Date().toISOString(),
					author: { username: "bot" },
				})),
			}),
			replyToDiscussion: async (id, iid, discussionId, body) => {
				const key = `${id}:${iid}:${discussionId}`;
				this.state.discussionNotes ??= {};
				this.state.discussionNotes[key] ??= [];
				const notes = this.state.discussionNotes[key];
				return this.append(notes, { id: notes.length + 1, body }, "Reply");
			},
			listNoteReactions: async (id, iid, noteId) =>
				structuredClone(this.state.reactions?.[`${id}:${iid}:${noteId}`] ?? []),
			addNoteReaction: async (id, iid, noteId, name) => {
				const key = `${id}:${iid}:${noteId}`;
				this.state.reactions ??= {};
				this.state.reactions[key] ??= [];
				const reactions = this.state.reactions[key];
				if (
					reactions.some((reaction) => reaction.name === name && reaction.user.username === "bot")
				)
					throw new Error("Reaction already exists");
				const reaction = { id: reactions.length + 1, name, user: { username: "bot" } };
				return this.append(reactions, reaction, "Reaction");
			},
			addNote: async (id, iid, body) => {
				const key = `${id}:${iid}`;
				this.state.notes[key] ??= [];
				const notes = this.state.notes[key];
				return this.append(notes, { id: notes.length + 1, body }, "Comment");
			},
		};
	}
}
