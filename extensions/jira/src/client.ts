import { asUnknownRecord } from "@leitwerk-dev/domain";

/** @public */
export interface JiraProject {
	/** @internal */
	id: string;

	/** @internal */
	key: string;

	/** @internal */
	name: string;
}

/** @public */
export interface JiraComponent {
	/** @internal */
	id: string;

	/** @internal */
	name: string;
}

/** @public */
export interface JiraIssue {
	/** @internal */
	id: string;

	/** @internal */
	key: string;

	/** @internal */
	fields: {
		/** @internal */
		issuetype?: {
			/** @internal */
			id: string;
			/** @internal */
			name: string;
			/** @internal */
			subtask?: boolean;
		};
		/** @internal */
		parent?: JiraIssueReceipt;
		/** @internal */
		updated?: string;
		/** @internal */
		summary: string;

		/** @internal */
		description: string | null;

		/** @internal */
		labels: string[];

		/** @internal */
		project: JiraProject;

		/** @internal */
		components: JiraComponent[];

		/** @internal */
		status: {
			/** @internal */
			statusCategory: {
				/** @internal */
				key: string;
			};
		};
	};
}

/** @public */
export interface JiraComment {
	/** @internal */
	id: string;

	/** @internal */
	body: string;
}

/** @public */
export interface JiraClientLike extends Pick<JiraClient, keyof JiraClient> {}

/** @internal */
export interface JiraCreateMetadata {
	/** @internal */ epicLinkField: string | null;
	/** @internal */
	issueTypes: {
		/** @internal */
		id: string;
		/** @internal */
		name: string;
		/** @internal */
		subtask?: boolean;
		/** @internal */
		fields: Record<
			string,
			{
				/** @internal */
				required?: boolean;
				/** @internal */
				hasDefaultValue?: boolean;
			}
		>;
	}[];
}

/** @internal */
export class JiraRequestError extends Error {
	/** @internal */
	readonly status: number;
	/** @internal */
	constructor(status: number) {
		super(`Jira request failed (${status})`);
		this.status = status;
	}
}

/** @internal */
export interface JiraIssueReceipt {
	/** @internal */ id: string;
	/** @internal */ key: string;
}

/** @internal */
export function jiraBaseUrl(raw: string): string {
	const url = new URL(raw);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
		throw new Error("Jira base_url must be HTTPS, without credentials, query, or fragment");
	return url.href.replace(/\/+$/, "");
}

/** @internal */
export function parseJiraProfiles(raw: unknown): Map<
	string,
	{
		/** @internal */
		baseUrl: string;
		/** @internal */
		token: string;
		/** @internal */
		epicLinkField?: string;
	}
> {
	const profiles = asUnknownRecord(asUnknownRecord(raw)?.profiles) ?? {};
	return new Map(
		Object.entries(profiles).map(([id, value]) => {
			const profile = asUnknownRecord(value);
			if (
				typeof profile?.base_url !== "string" ||
				typeof profile.token !== "string" ||
				!profile.token.trim()
			)
				throw new Error(`Jira profile '${id}' requires base_url and a PAT`);
			const token = profile.token.startsWith("env:")
				? (process.env[profile.token.slice(4)] ?? "")
				: profile.token;
			if (!token || /[\r\n\0]/.test(token))
				throw new Error(`Jira profile '${id}' requires a valid PAT`);
			if (
				profile.epic_link_field !== undefined &&
				(typeof profile.epic_link_field !== "string" ||
					!/^customfield_\d+$/.test(profile.epic_link_field))
			)
				throw new Error("epic_link_field must identify a Jira custom field");
			return [
				id,
				{
					baseUrl: jiraBaseUrl(profile.base_url),
					token,
					...(typeof profile.epic_link_field === "string"
						? { epicLinkField: profile.epic_link_field }
						: {}),
				},
			];
		}),
	);
}
/** Jira Data Center REST v2. Credentials never appear in errors or public fields. @public */
export class JiraClient {
	/** @internal */
	readonly baseUrl: string;
	#token: string;
	#fetch: typeof fetch;
	#epicLinkField: string | undefined;

	/** @internal */
	constructor(
		profile: {
			/** @internal */
			baseUrl: string;
			/** @internal */
			token: string;
			/** @internal */
			epicLinkField?: string;
		},
		fetcher: typeof fetch = fetch,
	) {
		this.#fetch = fetcher;
		this.baseUrl = jiraBaseUrl(profile.baseUrl);
		this.#token = profile.token;
		this.#epicLinkField = profile.epicLinkField;
	}
	async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
		let response: Response;
		try {
			response = await this.#fetch(`${this.baseUrl}/rest/api/2/${path}`, {
				...init,
				redirect: "error",
				signal: AbortSignal.timeout(30_000),
				headers: {
					Authorization: `Bearer ${this.#token}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
			});
		} catch {
			throw new Error("Jira request unavailable");
		}
		if (!response.ok) throw new JiraRequestError(response.status);
		if (response.status === 204) return undefined as T;
		try {
			return (await response.json()) as T;
		} catch {
			throw new Error("Jira returned invalid JSON");
		}
	}
	async #pages<T>(path: string, field: string): Promise<T[]> {
		const items: T[] = [];
		let startAt = 0;
		for (;;) {
			const page = await this.#request<Record<string, unknown> | T[]>(
				`${path}${path.includes("?") ? "&" : "?"}startAt=${startAt}&maxResults=100`,
			);
			// Data Center's project and component endpoints may return the complete array.
			if (Array.isArray(page)) return page;
			const batch = page[field];
			if (!Array.isArray(batch)) throw new Error("Jira returned an invalid page");
			if (typeof page.startAt === "number" && page.startAt !== startAt)
				throw new Error("Jira pagination did not advance");
			items.push(...(batch as T[]));
			startAt += batch.length;
			if (page.isLast === true || (typeof page.total === "number" && startAt >= page.total))
				return items;
			if (!batch.length) {
				if (typeof page.total === "number" && startAt < page.total)
					throw new Error("Jira returned an incomplete page");
				return items;
			}
		}
	}

	/** @internal */
	listProjects() {
		return this.#pages<JiraProject>("project", "values");
	}

	/** @internal */
	listComponents(projectId: string) {
		return this.#pages<JiraComponent>(
			`project/${encodeURIComponent(projectId)}/components`,
			"values",
		);
	}

	/** @internal */
	searchIssues(projectIds: readonly string[]) {
		if (!projectIds.length || projectIds.some((id) => !/^\d+$/.test(id)))
			throw new Error("Select explicit Jira project IDs");
		const jql = `project in (${projectIds.join(",")}) AND labels = "use-leitwerk" AND (labels not in ("leitwerk-done")) AND statusCategory != Done ORDER BY id ASC`;
		return this.#pages<JiraIssue>(
			`search?jql=${encodeURIComponent(jql)}&fields=summary,description,labels,project,components,status`,
			"issues",
		);
	}

	/** @internal */
	getIssue(id: string) {
		return this.#request<JiraIssue>(`issue/${encodeURIComponent(id)}?fields=*all`);
	}

	async #resolveEpicLinkField(): Promise<string | null> {
		if (this.#epicLinkField) return this.#epicLinkField;
		const fields = await this.#request<{ id: string; schema?: { custom?: string } }[]>("field");
		const matches = fields.filter(
			(field) => field.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-link",
		);
		if (!matches.length) return null;
		if (matches.length !== 1)
			throw new Error(
				"Configure this Jira profile's epic_link_field; Epic Link discovery is ambiguous",
			);
		this.#epicLinkField = matches[0].id;
		return this.#epicLinkField;
	}

	/** @internal */
	async getEpic(issue: JiraIssue): Promise<JiraIssue | null> {
		if (issue.fields.issuetype?.name.toLowerCase() === "epic") return issue;
		const field = await this.#resolveEpicLinkField();
		if (!field) return null;
		const key = (issue.fields as unknown as Record<string, unknown>)[field];
		return typeof key === "string" && key ? this.getIssue(key) : null;
	}

	/** @internal */
	searchSplitIssues(projectIds: readonly string[]): Promise<JiraIssue[]> {
		if (!projectIds.length || projectIds.some((id) => !/^\d+$/.test(id)))
			throw new Error("Select explicit Jira project IDs");
		const jql = `project in (${projectIds.join(",")}) AND labels in ("leitwerk-issue-split", "leitwerk-epic-split") AND issuetype not in subTaskIssueTypes() AND statusCategory != Done ORDER BY id ASC`;
		return this.#pages(`search?jql=${encodeURIComponent(jql)}&fields=*all`, "issues");
	}

	/** @internal */
	async createMetadata(projectId: string, includeEpicLink = true): Promise<JiraCreateMetadata> {
		const metadata = await this.#request<{
			projects: { id: string; issuetypes: JiraCreateMetadata["issueTypes"] }[];
		}>(
			`issue/createmeta?projectIds=${encodeURIComponent(projectId)}&expand=projects.issuetypes.fields`,
		);
		const project = metadata.projects.find((candidate) => candidate.id === projectId);
		if (!project) throw new Error("Jira issue creation is unavailable for this project");
		const epicLinkField = includeEpicLink ? await this.#resolveEpicLinkField() : null;
		if (includeEpicLink && !epicLinkField)
			throw new Error("Splitting a Jira epic requires an Epic Link field");
		return { epicLinkField, issueTypes: project.issuetypes };
	}

	/** @internal */
	createIssue(fields: Record<string, unknown>): Promise<JiraIssueReceipt> {
		return this.#request("issue", { method: "POST", body: JSON.stringify({ fields }) });
	}

	/** @internal */
	async findSplitIssue(projectId: string, marker: string): Promise<JiraIssue | null> {
		if (!/^\d+$/.test(projectId) || !/^leitwerk-split-[a-f0-9]{64}$/.test(marker))
			throw new Error("Invalid split ticket identity");
		const jql = `project = ${projectId} AND labels = "${marker}" ORDER BY id ASC`;
		const matches = await this.#pages<JiraIssue>(
			`search?jql=${encodeURIComponent(jql)}&fields=*all`,
			"issues",
		);
		if (matches.length > 1)
			throw new Error(
				"Multiple Jira tickets share the split identity; operator reconciliation required",
			);
		return matches[0] ?? null;
	}

	/** @internal */
	listComments(id: string) {
		return this.#pages<JiraComment>(`issue/${encodeURIComponent(id)}/comment`, "comments");
	}

	/** @internal */
	addComment(id: string, body: string) {
		return this.#request<JiraComment>(`issue/${encodeURIComponent(id)}/comment`, {
			method: "POST",
			body: JSON.stringify({ body }),
		});
	}

	/** @internal */
	updateLabels(id: string, remove: string[], add: string[]) {
		return this.#request<void>(`issue/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: JSON.stringify({
				update: {
					labels: [
						...remove.map((value) => ({ remove: value })),
						...add.map((value) => ({ add: value })),
					],
				},
			}),
		});
	}
}

/** @public */
export const jiraEligible = (issue: JiraIssue) =>
	issue.fields.labels.includes("use-leitwerk") &&
	!issue.fields.labels.includes("leitwerk-done") &&
	issue.fields.status.statusCategory.key !== "done";
/** Installation context paths and immutable issue IDs define launch identity. @public */
export const jiraIssueExternalId = (baseUrl: string, id: string) =>
	`jira:${JSON.stringify([jiraBaseUrl(baseUrl), id])}`;

/** @internal */
export const jiraIsEpic = (issue: JiraIssue) =>
	issue.fields.issuetype?.name.toLowerCase() === "epic";

/** @internal */
export const jiraSplitEligible = (issue: JiraIssue) =>
	Boolean(issue.fields.issuetype?.id) &&
	issue.fields.issuetype?.subtask !== true &&
	issue.fields.status.statusCategory.key !== "done" &&
	issue.fields.labels.some((label) =>
		["leitwerk-issue-split", "leitwerk-epic-split"].includes(label),
	);

/** @internal */
export async function jiraSplitChildMatches(
	client: JiraClientLike,
	issue: JiraIssue,
	sourceIssueId: string,
	relationship: "epic" | "subtask",
): Promise<boolean> {
	if (relationship === "subtask")
		return issue.fields.issuetype?.subtask === true && issue.fields.parent?.id === sourceIssueId;
	return (
		issue.fields.issuetype?.subtask !== true &&
		(await client.getEpic?.(issue))?.id === sourceIssueId
	);
}
