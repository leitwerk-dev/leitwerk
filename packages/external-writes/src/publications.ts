/** Durable cross-process publication identity and retained binding. @internal */
export interface PublicationReceipt {
	/** @internal */ triggered?: boolean;
	/** @internal */ key: string;
	/** @internal */ topicId: string;
	/** @internal */ binding: Record<string, unknown>;
	/** @internal */ externalId: string | null;
	/** @internal */ url: string | null;
}

/** @internal */
export interface PublicationStore {
	/** @internal */ publication(key: string): PublicationReceipt | null;
	/** @internal */ publicationByExternalId(externalId: string): PublicationReceipt | null;
	/** @internal */ reservePublication(input: PublicationReceipt): boolean;
	/** @internal */ finishPublication(key: string, externalId: string, url: string): void;
	/** @internal */ releaseRejectedPublication(key: string): void;
	/** @internal */ markPublicationTriggered(key: string): void;
}
