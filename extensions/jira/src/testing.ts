import {
	type JiraClientLike,
	type JiraComment,
	type JiraComponent,
	type JiraCreateMetadata,
	type JiraIssue,
	type JiraIssueReceipt,
	type JiraProject,
	jiraEligible,
} from "./client.js";

export { registerJiraWikiTools } from "./wiki.js";

/** @internal */
export class LocalJiraAdapter implements JiraClientLike {
	/** @internal */ readonly baseUrl = "https://jira.test/context";
	/** @internal */ readonly issues = new Map<string, JiraIssue>();
	/** @internal */ readonly comments = new Map<string, JiraComment[]>();
	/** @internal */ readonly creations: Record<string, unknown>[] = [];
	/** @internal */ loseNextCreateResponse = false;
	/** @internal */ searchVisible = true;
	/** @internal */ components: JiraComponent[] = [{ id: "200", name: "Service" }];

	/** @internal */ seedIssue(issue: JiraIssue, epicKey?: string): void {
		const stored = structuredClone(issue);
		if (epicKey) Object.assign(stored.fields, { customfield_100: epicKey });
		this.issues.set(issue.id, stored);
	}
	/** @internal */ async getIssue(id: string): Promise<JiraIssue> {
		const issue =
			this.issues.get(id) ?? [...this.issues.values()].find((candidate) => candidate.key === id);
		if (!issue) throw new Error("Jira issue unavailable");
		return structuredClone(issue);
	}
	/** @internal */ async listProjects(): Promise<JiraProject[]> {
		return [
			...new Map(
				[...this.issues.values()].map((issue) => [issue.fields.project.id, issue.fields.project]),
			).values(),
		];
	}
	/** @internal */ async listComponents(): Promise<JiraComponent[]> {
		return structuredClone(this.components);
	}
	/** @internal */ async searchIssues(projectIds: readonly string[]) {
		return [...this.issues.values()]
			.filter((issue) => projectIds.includes(issue.fields.project.id) && jiraEligible(issue))
			.map((issue) => structuredClone(issue));
	}
	/** @internal */ async searchEpics(projectIds: readonly string[]) {
		return [...this.issues.values()]
			.filter(
				(issue) =>
					projectIds.includes(issue.fields.project.id) &&
					issue.fields.issuetype?.name === "Epic" &&
					issue.fields.labels.includes("leitwerk-epic-split") &&
					issue.fields.status.statusCategory.key !== "done",
			)
			.map((issue) => structuredClone(issue));
	}
	/** @internal */ async getEpic(issue: JiraIssue): Promise<JiraIssue | null> {
		if (issue.fields.issuetype?.name === "Epic") return issue;
		const key = (issue.fields as unknown as Record<string, unknown>).customfield_100;
		return typeof key === "string" ? this.getIssue(key) : null;
	}
	/** @internal */ async createMetadata(): Promise<JiraCreateMetadata> {
		return {
			epicLinkField: "customfield_100",
			issueTypes: ["Story", "Task"].map((name) => ({ id: name, name, fields: {} })),
		};
	}
	/** @internal */ async createIssue(fields: Record<string, unknown>): Promise<JiraIssueReceipt> {
		this.creations.push(structuredClone(fields));
		const id = String(1000 + this.creations.length),
			key = `APP-${id}`;
		const project = (await this.listProjects()).find(
			(candidate) => candidate.id === (fields.project as { id: string }).id,
		);
		if (!project) throw new Error("Unknown Jira project");
		this.seedIssue(
			{
				id,
				key,
				fields: {
					summary: String(fields.summary),
					description: String(fields.description),
					components: (fields.components as { id: string }[]).map(
						({ id }) => this.components.find((component) => component.id === id)!,
					),
					labels: fields.labels as string[],
					project,
					issuetype: {
						id: (fields.issuetype as { id: string }).id,
						name: (fields.issuetype as { id: string }).id,
					},
					status: { statusCategory: { key: "new" } },
				},
			},
			String(fields.customfield_100),
		);
		if (this.loseNextCreateResponse) {
			this.loseNextCreateResponse = false;
			throw new Error("Response lost after Jira creation");
		}
		return { id, key };
	}
	/** @internal */ async findSplitIssue(projectId: string, marker: string) {
		return this.searchVisible
			? structuredClone(
					[...this.issues.values()].find(
						(issue) =>
							issue.fields.project.id === projectId && issue.fields.labels.includes(marker),
					) ?? null,
				)
			: null;
	}
	/** @internal */ async listComments(id: string) {
		return structuredClone(this.comments.get(id) ?? []);
	}
	/** @internal */ async addComment(id: string, body: string): Promise<JiraComment> {
		const comments = this.comments.get(id) ?? [];
		const comment = { id: String(comments.length + 1), body };
		comments.push(comment);
		this.comments.set(id, comments);
		return comment;
	}
	/** @internal */ async updateLabels(id: string, remove: string[], add: string[]) {
		const issue = this.issues.get(id);
		if (!issue) throw new Error("Unknown issue");
		issue.fields.labels = [
			...new Set([...issue.fields.labels.filter((label) => !remove.includes(label)), ...add]),
		];
	}
}
