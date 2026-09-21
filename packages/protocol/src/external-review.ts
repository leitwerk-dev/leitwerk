/** Repository review created by a worker-side handoff and persisted by the server. @internal */
export interface CreatedExternalReview {
	/** @internal */
	projectKey: string;
	/** @internal */
	externalId: string;
	/** @internal */
	externalUrl: string;
	/** @internal */
	baseBranch: string;
}
