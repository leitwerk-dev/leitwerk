import type { JiraClientLike, JiraComment, JiraIssue, JiraRemoteLink } from "@leitwerk-dev/jira";
import { localJiraIssueClient } from "@leitwerk-dev/jira/testing";
import { readLocalJson, writeLocalJson } from "@leitwerk-dev/test-support/local-git";

export const jiraProject = { id: "100", key: "ATLAS", name: "Atlas delivery experience" };
export const jiraComponents = [
	{ id: "200", name: "Delivery API" },
	{ id: "201", name: "Web checkout" },
	{ id: "202", name: "Customer experience" },
];
export type JiraScene = "plan" | "delivery" | "bypasses";
interface SceneState {
	version: number;
	now: number;
	issues: JiraIssue[];
	comments: Record<string, JiraComment[]>;
	remoteLinks: Record<string, JiraRemoteLink[]>;
	requests: Record<string, { scene: JiraScene; issueId: string }>;
	mappingsSeeded: boolean;
}

/** Persistent, local-only Jira boundary for review scenes. */
export class JiraSceneStore {
	readonly state: SceneState;
	constructor(
		readonly root: string,
		readonly baseUrl: string,
	) {
		this.state = readLocalJson<SceneState>(root, "jira-scenes.json", {
			version: 1,
			now: Date.now(),
			issues: [],
			comments: {},
			remoteLinks: {},
			requests: {},
			mappingsSeeded: false,
		});
		this.state.remoteLinks ??= {};
	}
	save() {
		writeLocalJson(this.root, "jira-scenes.json", this.state);
	}
	issue(id: string): JiraIssue {
		const issue = this.state.issues.find((issue) => issue.id === id || issue.key === id);
		if (!issue) throw new Error("Unknown local Jira issue");
		return issue;
	}
	create(scene: JiraScene, requestId: string): JiraIssue {
		const prior = this.state.requests[requestId];
		if (prior) {
			if (prior.scene !== scene) throw new Error("Request ID already belongs to another scene");
			return this.issue(prior.issueId);
		}
		const issue: JiraIssue = {
			id: String(501 + this.state.issues.length),
			key: `ATLAS-${this.state.issues.length + 1}`,
			fields: {
				summary: `${scene === "plan" ? "Review plan" : scene === "delivery" ? "Simplify and publish" : "Bypass both gates"}: clarify delivery windows`,
				description:
					"Show the same delivery window in the API contract and web checkout. Document the customer-facing wording, preserve date semantics, and check both repositories.",
				project: jiraProject,
				components: [...jiraComponents],
				labels: [
					"use-leitwerk",
					...(scene === "bypasses"
						? ["leitwerk-skip-plan-decision", "leitwerk-skip-simplification"]
						: []),
				],
				status: { statusCategory: { key: "new" } },
			},
		};
		this.state.issues.push(issue);
		this.state.requests[requestId] = { scene, issueId: issue.id };
		this.save();
		return issue;
	}
	client(): JiraClientLike {
		return {
			...localJiraIssueClient(this.state, () => this.save()),
			baseUrl: this.baseUrl,
			listProjects: async () => [jiraProject],
			listCreateProjects: async () => [],
			searchSplitIssues: async () => [],
			getEpic: async () => null,
			findSplitIssue: async () => null,
			createMetadata: async () => {
				throw new Error("Issue splitting is unavailable in this review composition");
			},
			listProjectIssues: async (id) =>
				structuredClone(this.state.issues.filter((issue) => issue.fields.project.id === id)),
			createIssueReceipt: async () => {
				throw new Error("Ticket creation is unavailable in this review composition");
			},
			createIssue: async () => {
				throw new Error("Ticket creation is unavailable in this review composition");
			},
			listComponents: async () => structuredClone(jiraComponents),
			searchIssues: async () => structuredClone(this.state.issues),
		};
	}
}
