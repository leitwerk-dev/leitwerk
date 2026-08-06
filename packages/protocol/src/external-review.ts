/** Repository review created by a worker-side handoff and persisted by the server. */
export interface CreatedExternalReview {
	projectKey: string;
	externalId: string;
	externalUrl: string;
	baseBranch: string;
}
