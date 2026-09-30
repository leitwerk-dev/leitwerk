import { readLocalJson, writeLocalJson } from "@leitwerk-dev/test-support/local-git";
import type { JiraClientLike, JiraComment, JiraCreateProject, JiraIssue } from "./client.js";

/** @internal */
export class LocalJiraAdapter {
	/** @internal */
	readonly state: {
		/** @internal */
		version: number;
		/** @internal */
		projects: JiraCreateProject[];
		/** @internal */
		issues: JiraIssue[];
		/** @internal */
		comments: Record<string, JiraComment[]>;
	};
	/** @internal */
	loseNextIssueResponse = false;
	/** @internal */
	constructor(
		/** @internal */ readonly root: string,
		/** @internal */ readonly baseUrl = "https://jira.test",
	) {
		this.state = readLocalJson(root, "jira.json", {
			version: 1,
			projects: [],
			issues: [],
			comments: {},
		});
	}
	/** @internal */
	save(): void {
		writeLocalJson(this.root, "jira.json", this.state);
	}
	/** @internal */
	seed(project: JiraCreateProject): void {
		if (this.state.projects.some((candidate) => candidate.id === project.id)) return;
		this.state.projects.push(structuredClone(project));
		this.save();
	}
	/** @internal */
	client(): JiraClientLike {
		const issue = (id: string) => {
			const found = this.state.issues.find((issue) => issue.id === id || issue.key === id);
			if (!found) throw new Error("Unknown local Jira issue");
			return found;
		};
		return {
			baseUrl: this.baseUrl,
			listProjects: async () => structuredClone(this.state.projects),
			listCreateProjects: async (id) =>
				structuredClone(this.state.projects.filter((project) => !id || project.id === id)),
			listComponents: async () => [],
			searchIssues: async (ids) =>
				structuredClone(this.state.issues.filter((issue) => ids.includes(issue.fields.project.id))),
			listProjectIssues: async (id) =>
				structuredClone(this.state.issues.filter((issue) => issue.fields.project.id === id)),
			getIssue: async (id) => structuredClone(issue(id)),
			createIssue: async (fields) => {
				const project = this.state.projects.find(
					(project) => project.id === (fields.project as { id: string }).id,
				);
				if (!project) throw new Error("Unknown local Jira project");
				const issueType = project.issuetypes.find(
					(type) => type.id === (fields.issuetype as { id: string }).id,
				);
				if (!issueType) throw new Error("Unknown local Jira issue type");
				for (const key of Object.keys(fields)) {
					if (!["project", "issuetype"].includes(key) && !Object.hasOwn(issueType.fields, key))
						throw new Error(`Jira field '${key}' is not on the create screen`);
				}
				const created: JiraIssue = {
					id: String(this.state.issues.length + 1),
					key: `${project.key}-${this.state.issues.filter((issue) => issue.fields.project.id === project.id).length + 1}`,
					fields: {
						...fields,
						summary: String(fields.summary),
						description: String(fields.description),
						labels: (fields.labels as string[] | undefined) ?? [],
						project,
						components: [],
						status: { statusCategory: { key: "new" } },
					},
				};
				this.state.issues.push(created);
				this.save();
				if (this.loseNextIssueResponse) {
					this.loseNextIssueResponse = false;
					throw new Error("Response lost after issue write");
				}
				return structuredClone(created);
			},
			listComments: async (id) => structuredClone(this.state.comments[issue(id).id] ?? []),
			addComment: async (id, body) => {
				this.state.comments[issue(id).id] ??= [];
				const comments = this.state.comments[issue(id).id];
				const comment = { id: String(comments.length + 1), body };
				comments.push(comment);
				this.save();
				return structuredClone(comment);
			},
			updateLabels: async (id, remove, add) => {
				const current = issue(id);
				current.fields.labels = [
					...new Set([...current.fields.labels.filter((label) => !remove.includes(label)), ...add]),
				];
				this.save();
			},
		};
	}
}
