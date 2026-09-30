/** @internal */
export interface WikiTopic {
	/** @internal */ id: string;
	/** @internal */ key: string;
	/** @internal */ title: string;
	/** @internal */ url: string;
	/** @internal */ sourceRevision: string;
}

/** @internal */
export interface WikiEvidence {
	/** @internal */ repository: string;
	/** @internal */ revision: string;
	/** @internal */ path: string;
	/** @internal */ observation: string;
}

/** @internal */
export interface WikiPage {
	/** @internal */ id: string;
	/** @internal */ topicId: string;
	/** @internal */ revision: number;
	/** @internal */ title: string;
	/** @internal */ markdown: string;
	/** @internal */ applicability: string;
	/** @internal */ status: "proposed" | "observed" | "validated" | "needs_revalidation";
	/** @internal */ evidence: WikiEvidence[];
	/** @internal */ links: string[];
	/** @internal */ sourceRevision: string;
	/** @internal */ instanceId: string;
	/** @internal */ turnRecordId: string;
	/** @internal */ updatedAt: string;
	/** @internal */ deleted: boolean;
}

/** @internal */
export interface TopicPublication {
	/** @internal */ triggered?: boolean;
	/** @internal */ key: string;
	/** @internal */ topicId: string;
	/** @internal */ binding: Record<string, unknown>;
	/** @internal */ externalId: string | null;
	/** @internal */ url: string | null;
}
