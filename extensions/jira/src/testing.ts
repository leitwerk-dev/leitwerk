import { readLocalJson, writeLocalJson } from "@leitwerk-dev/test-support/local-git";
import {
	type JiraClientLike,
	type JiraComment,
	type JiraComponent,
	type JiraCreateMetadata,
	type JiraCreateProject,
	type JiraIssue,
	type JiraIssueReceipt,
	type JiraProject,
	jiraEligible,
	jiraSplitEligible,
} from "./client.js";

export { registerJiraWikiTools } from "./wiki.js";

/** @internal */
export class LocalJiraSplitAdapter implements JiraClientLike {
	/** @internal */ readonly baseUrl = "https://jira.test/context";
	/** @internal */ readonly issues = new Map<string, JiraIssue>();
	/** @internal */ readonly comments = new Map<string, JiraComment[]>();
	/** @internal */ readonly creations: Record<string, unknown>[] = [];
	/** @internal */ loseNextCreateResponse = false;
	/** @internal */ searchVisible = true;
	/** @internal */ components: JiraComponent[] = [{ id: "200", name: "Service" }];
	/** @internal */ epicLinkField: string | null = "customfield_100";
	/** @internal */ issueTypes: JiraCreateMetadata["issueTypes"] = [
		{ id: "Story", name: "Story", subtask: false, fields: {} },
		{ id: "Task", name: "Task", subtask: false, fields: {} },
		{ id: "10003", name: "Sub-task", subtask: true, fields: {} },
	];

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
	/** @internal */ async listCreateProjects(projectId?: string): Promise<JiraCreateProject[]> {
		return (await this.listProjects())
			.filter((project) => !projectId || project.id === projectId)
			.map((project) => ({
				...project,
				issuetypes: this.issueTypes
					.filter((type) => !type.subtask)
					.map((type) => ({
						...type,
						subtask: false,
						fields: Object.fromEntries(
							Object.entries(type.fields).map(([key, field]) => [
								key,
								{
									...field,
									name: key,
									required: field.required ?? false,
								},
							]),
						),
					})),
			}));
	}
	/** @internal */ async listProjectIssues(projectId: string): Promise<JiraIssue[]> {
		return structuredClone(
			[...this.issues.values()].filter((issue) => issue.fields.project.id === projectId),
		);
	}
	/** @internal */ async listComponents(): Promise<JiraComponent[]> {
		return structuredClone(this.components);
	}
	/** @internal */ async searchIssues(projectIds: readonly string[], triggerLabel?: string) {
		return [...this.issues.values()]
			.filter(
				(issue) =>
					projectIds.includes(issue.fields.project.id) && jiraEligible(issue, triggerLabel),
			)
			.map((issue) => structuredClone(issue));
	}
	/** @internal */ async searchSplitIssues(projectIds: readonly string[]) {
		return [...this.issues.values()]
			.filter((issue) => projectIds.includes(issue.fields.project.id) && jiraSplitEligible(issue))
			.map((issue) => structuredClone(issue));
	}
	/** @internal */ async getEpic(issue: JiraIssue): Promise<JiraIssue | null> {
		if (issue.fields.issuetype?.name === "Epic") return issue;
		if (!this.epicLinkField) return null;
		const key = (issue.fields as unknown as Record<string, unknown>)[this.epicLinkField];
		return typeof key === "string" ? this.getIssue(key) : null;
	}
	/** @internal */ async createMetadata(
		_projectId: string,
		includeEpicLink = true,
	): Promise<JiraCreateMetadata> {
		if (includeEpicLink && !this.epicLinkField)
			throw new Error("Splitting a Jira epic requires an Epic Link field");
		return {
			epicLinkField: includeEpicLink ? this.epicLinkField : null,
			issueTypes: structuredClone(this.issueTypes),
		};
	}
	/** @internal */ async createIssueReceipt(
		fields: Record<string, unknown>,
	): Promise<JiraIssueReceipt> {
		const { id, key } = await this.createIssue(fields);
		return { id, key };
	}
	/** @internal */ async createIssue(fields: Record<string, unknown>): Promise<JiraIssue> {
		const type = this.issueTypes.find(
			(candidate) => candidate.id === (fields.issuetype as { id: string }).id,
		);
		if (!type) throw new Error("Unknown Jira issue type");
		if (Boolean(type.subtask) !== Boolean(fields.parent))
			throw new Error("Jira subtask creation requires its parent");
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
						name: type.name,
						subtask: type.subtask,
					},
					...(fields.parent
						? { parent: await this.getIssue((fields.parent as { id: string }).id) }
						: {}),
					status: { statusCategory: { key: "new" } },
				},
			},
			typeof fields.customfield_100 === "string" ? fields.customfield_100 : undefined,
		);
		if (this.loseNextCreateResponse) {
			this.loseNextCreateResponse = false;
			throw new Error("Response lost after Jira creation");
		}
		return this.getIssue(id);
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
		return {
			...localJiraIssueClient(this.state, () => this.save()),
			baseUrl: this.baseUrl,
			listProjects: async () => structuredClone(this.state.projects),
			listCreateProjects: async (id) =>
				structuredClone(this.state.projects.filter((project) => !id || project.id === id)),
			listComponents: async () => [],
			searchIssues: async (ids) =>
				structuredClone(this.state.issues.filter((issue) => ids.includes(issue.fields.project.id))),
			listProjectIssues: async (id) =>
				structuredClone(this.state.issues.filter((issue) => issue.fields.project.id === id)),
			searchSplitIssues: async (ids) =>
				structuredClone(
					this.state.issues.filter(
						(issue) => ids.includes(issue.fields.project.id) && jiraSplitEligible(issue),
					),
				),
			getEpic: async (issue) =>
				issue.fields.issuetype?.name === "Epic" ? structuredClone(issue) : null,
			createMetadata: async (id, includeEpicLink = true) => {
				if (includeEpicLink)
					throw new Error("Local ticket creation does not configure an Epic Link field");
				const project = this.state.projects.find((project) => project.id === id);
				if (!project) throw new Error("Unknown local Jira project");
				return { epicLinkField: null, issueTypes: structuredClone(project.issuetypes) };
			},
			findSplitIssue: async (id, marker) => {
				const matches = this.state.issues.filter(
					(issue) => issue.fields.project.id === id && issue.fields.labels.includes(marker),
				);
				if (matches.length > 1) throw new Error("Multiple Jira tickets share the split identity");
				return structuredClone(matches[0] ?? null);
			},
			createIssueReceipt: async (fields, signal) => {
				const { id, key } = await this.client().createIssue(fields, signal);
				return { id, key };
			},
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
		};
	}
}

/** @internal */
export function localJiraIssueClient(
	state: Pick<LocalJiraAdapter["state"], "issues" | "comments">,
	save: () => void,
): Pick<JiraClientLike, "getIssue" | "listComments" | "addComment" | "updateLabels"> {
	const issue = (id: string) => {
		const found = state.issues.find((issue) => issue.id === id || issue.key === id);
		if (!found) throw new Error("Unknown local Jira issue");
		return found;
	};
	return {
		getIssue: async (id) => structuredClone(issue(id)),
		listComments: async (id) => structuredClone(state.comments[issue(id).id] ?? []),
		addComment: async (id, body) => {
			state.comments[issue(id).id] ??= [];
			const comments = state.comments[issue(id).id];
			const comment = { id: String(comments.length + 1), body };
			comments.push(comment);
			save();
			return structuredClone(comment);
		},
		updateLabels: async (id, remove, add) => {
			const current = issue(id);
			current.fields.labels = [
				...new Set([...current.fields.labels.filter((label) => !remove.includes(label)), ...add]),
			];
			save();
		},
	};
}
