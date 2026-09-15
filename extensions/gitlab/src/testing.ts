import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
	GitLabClientLike,
	GitLabDiff,
	GitLabMergeRequest,
	GitLabNote,
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

interface LocalState {
	projects: GitLabProject[];
	mrs: GitLabMergeRequest[];
	pipelines: GitLabPipeline[];
	notes: Record<string, GitLabNote[]>;
	diffs: Record<string, GitLabDiff[]>;
}
/** Persistent GitLab test boundary. Repository URLs use local Git's file transport. */
export class LocalGitLabAdapter {
	state: LocalState;
	loseNextCommentResponse = false;
	constructor(
		readonly root: string,
		readonly baseUrl = "https://gitlab.test",
	) {
		mkdirSync(root, { recursive: true });
		const file = path.join(root, "gitlab.json");
		this.state = existsSync(file)
			? JSON.parse(readFileSync(file, "utf8"))
			: { projects: [], mrs: [], pipelines: [], notes: {}, diffs: {} };
	}
	save() {
		writeFileSync(path.join(this.root, "gitlab.json"), JSON.stringify(this.state), { mode: 0o600 });
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
			getProject: async (id) => structuredClone(this.project(id)),
			listProjects: async () => structuredClone(this.state.projects),
			getGroup: async (id) => ({ id: 1, full_path: String(id) }),
			listGroupProjects: async (group) =>
				structuredClone(
					this.state.projects.filter((p) => p.path_with_namespace.startsWith(`${group}/`)),
				),
			getMergeRequest: async (id, iid) => ({
				...structuredClone(mr(id, iid)),
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
			addNote: async (id, iid, body) => {
				const key = `${id}:${iid}`;
				this.state.notes[key] ??= [];
				const list = this.state.notes[key];
				const note = { id: list.length + 1, body };
				list.push(note);
				this.save();
				if (this.loseNextCommentResponse) {
					this.loseNextCommentResponse = false;
					throw new Error("Response lost after comment write");
				}
				return note;
			},
		};
	}
}
