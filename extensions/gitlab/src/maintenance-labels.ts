import type { ExternalWrites } from "@leitwerk-dev/external-writes";
import type { GitLabClientLike, GitLabLabelEvent, GitLabMergeRequest } from "./client.js";

/** @public */
export const GITLAB_ACTIVE_LABEL = "leitwerk-active";
/** @public */
export const GITLAB_DONE_LABEL = "leitwerk-done";
/** @public */
export interface GitLabLabelState {
	/** @public */ mr: GitLabMergeRequest;
	/** @public */ events: GitLabLabelEvent[];
}
/** Read transitions before the current labels so remove/re-add cannot hide cancellation. @public */
export async function readGitLabLabels(
	client: GitLabClientLike,
	projectId: number,
	iid: number,
	signal?: AbortSignal,
): Promise<GitLabLabelState> {
	const events = await client.listMergeRequestLabelEvents(projectId, iid, signal);
	const mr = await client.getMergeRequest(projectId, iid, signal);
	return { mr, events: events.sort((a, b) => a.id - b.id) };
}
/** @public */
export function gitLabActivationStatus(
	after: number,
	labels: GitLabLabelState,
): "pending" | "active" | "removed" {
	const events = labels.events.filter(
		(event) => event.label?.name === GITLAB_ACTIVE_LABEL && event.id > after,
	);
	if (events.some((event) => event.action === "remove")) return "removed";
	if (!events.length) return "pending";
	return labels.mr.labels.includes(GITLAB_ACTIVE_LABEL) ? "active" : "removed";
}
/** All label updates preserve unrelated labels and reconcile uncertain writes. @internal */
export async function ensureGitLabMaintenanceLabels(input: {
	client: GitLabClientLike;
	writes: ExternalWrites;
	projectId: number;
	iid: number;
	writeKey: string;
	after: number;
	status: "active" | "merged" | "closed" | "stopped";
	guard(): Promise<boolean>;
	signal?: AbortSignal;
}): Promise<void> {
	const { client, writes, projectId, iid, status, after, signal } = input;
	const settled = async () => {
		const labels = await readGitLabLabels(client, projectId, iid, signal);
		if (!(await input.guard())) throw new Error("GitLab label write superseded");
		if (status === "active")
			return (
				labels.mr.state !== "opened" ||
				gitLabActivationStatus(after, labels) === "removed" ||
				(labels.mr.labels.includes(GITLAB_ACTIVE_LABEL) &&
					!labels.mr.labels.includes(GITLAB_DONE_LABEL))
			);
		// An operator's newer activation belongs to a future process.
		const active = labels.events.filter(
			(event) => event.label?.name === GITLAB_ACTIVE_LABEL && event.id > after,
		);
		if (
			active.some(
				(event, index) =>
					event.action === "add" &&
					active.slice(0, index).some((before) => before.action === "remove"),
			)
		)
			return true;
		return (
			!labels.mr.labels.includes(GITLAB_ACTIVE_LABEL) &&
			(status !== "merged" ||
				labels.mr.labels.includes(GITLAB_DONE_LABEL) ||
				labels.events.some(
					(event) =>
						event.id > after && event.label?.name === GITLAB_DONE_LABEL && event.action === "add",
				))
		);
	};
	await writes.ensure(
		{ writeType: "gitlab.mr_labels", dedupKey: input.writeKey },
		{
			reconcile: async (phase) => (phase === "already_recorded" || (await settled()) ? true : null),
			execute: async () => {
				if (await settled()) return true;
				await client.updateMergeRequestLabels(
					projectId,
					iid,
					status === "active"
						? { add_labels: GITLAB_ACTIVE_LABEL, remove_labels: GITLAB_DONE_LABEL }
						: {
								...(status === "merged" ? { add_labels: GITLAB_DONE_LABEL } : {}),
								remove_labels: GITLAB_ACTIVE_LABEL,
							},
					signal,
				);
				return true;
			},
			toMetadata: () => ({ projectId, iid, status }),
		},
	);
}
