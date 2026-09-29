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
export interface JiraClientLike {
	/** @internal */
	readonly baseUrl: string;

	/** @internal */
	listProjects(): Promise<JiraProject[]>;

	/** @internal */
	listComponents(projectId: string): Promise<JiraComponent[]>;

	/** @internal */
	searchIssues(projectIds: readonly string[]): Promise<JiraIssue[]>;

	/** @internal */
	getIssue(id: string): Promise<JiraIssue>;

	/** @internal */
	listComments(id: string): Promise<JiraComment[]>;

	/** @internal */
	addComment(id: string, body: string): Promise<JiraComment>;

	/** @internal */
	updateLabels(id: string, remove: string[], add: string[]): Promise<void>;
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
			return [id, { baseUrl: jiraBaseUrl(profile.base_url), token }];
		}),
	);
}
/** Jira Data Center REST v2. Credentials never appear in errors or public fields. @public */
export class JiraClient implements JiraClientLike {
	/** @internal */
	readonly baseUrl: string;
	#token: string;
	#fetch: typeof fetch;

	/** @internal */
	constructor(
		profile: {
			/** @internal */
			baseUrl: string;
			/** @internal */
			token: string;
		},
		fetcher: typeof fetch = fetch,
	) {
		this.#fetch = fetcher;
		this.baseUrl = jiraBaseUrl(profile.baseUrl);
		this.#token = profile.token;
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
		if (!response.ok) throw new Error(`Jira request failed (${response.status})`);
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
		return this.#request<JiraIssue>(
			`issue/${encodeURIComponent(id)}?fields=summary,description,labels,project,components,status`,
		);
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
