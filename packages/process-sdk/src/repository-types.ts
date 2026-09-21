/** Common issue and pull-request response fields used by repository integrations. @public */
export interface RepositoryIssue {
	/** @public */
	number: number;
	/** @public */
	title: string;
	/** @public */
	body: string | null;
	/** @public */
	state: string;
	/** @public */
	html_url: string;
	/** @public */
	updated_at: string;
	/** @public */
	user: {
		/** @public */
		login: string;
	};
	/** @public */
	labels: Array<{
		/** @public */
		id: number;
		/** @public */
		name: string;
	}>;
}

/** @public */
export interface RepositoryPullRequest {
	/** @public */
	number: number;
	/** @internal */
	title: string;
	/** @internal */
	body: string | null;
	/** @internal */
	state: string;
	/** @public */
	merged: boolean;
	/** @internal */
	mergeable?: boolean | null;
	/** @internal */
	mergeable_state?: string | null;
	/** @public */
	merge_commit_sha: string | null;
	/** @public */
	html_url: string;
	/** @public */
	head: {
		/** @internal */
		ref: string;
		/** @public */
		sha: string;
	};
	/** @internal */
	base: {
		/** @internal */
		ref: string;
		/** @internal */
		sha: string;
	};
}
