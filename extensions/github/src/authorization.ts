import type { GitHubClient, GitHubFeedbackItem, GitHubIssue } from "./client.js";

type MembershipClient = Pick<GitHubClient, "profile" | "isOrganizationMember">;

export async function authorizedTrigger(
	client: MembershipClient & Pick<GitHubClient, "getIssue" | "listIssueEvents">,
	owner: string,
	repo: string,
	number: number,
	trigger: string,
	done: string,
) {
	if (
		client.profile.allowedOrganization &&
		owner.toLowerCase() !== client.profile.allowedOrganization.toLowerCase()
	)
		return null;
	const issue = (await client.getIssue(owner, repo, number)) as GitHubIssue & {
		/** @internal */
		pull_request?: unknown;
	};
	if (
		issue.pull_request ||
		issue.state !== "open" ||
		!issue.labels.some((label) => label.name === trigger) ||
		issue.labels.some((label) => label.name === done)
	)
		return null;
	const last = (await client.listIssueEvents(owner, repo, number))
		.filter(
			(event) =>
				(event.event === "labeled" || event.event === "unlabeled") && event.label?.name === trigger,
		)
		.sort((a, b) => b.id - a.id)[0];
	if (
		last?.event !== "labeled" ||
		!last.actor?.login ||
		!(await client.isOrganizationMember(last.actor.login))
	)
		return null;
	return {
		/** @internal */
		issue,
		/** @internal */
		actor: last.actor.login,
		/** @internal */
		eventId: last.id,
	};
}

export async function actionableFeedback(client: MembershipClient, feedback: GitHubFeedbackItem[]) {
	const authorized: GitHubFeedbackItem[] = [];
	for (const item of feedback) {
		if (
			item.author.toLowerCase() === client.profile.botLogin.toLowerCase() ||
			item.body.includes("<!-- leitwerk-write:")
		)
			continue;
		if (await client.isOrganizationMember(item.author)) authorized.push(item);
	}
	return authorized;
}
