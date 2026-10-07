import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	createCapabilityToken,
	type IntegrationToolExecutionContext,
} from "@leitwerk-dev/process-sdk";
import type { WikiTopic } from "./model.js";
import type { TopicWikiStore } from "./store.js";

/** Provider-owned refresh result; source text is untrusted requirement context. @internal */
export interface WikiTopicContext {
	/** @internal */ topic: WikiTopic;
	/** Current shared source requirement, when available. @internal */ sourceDescription?: string;
}

/** Refresh and validate a process's retained source binding before a wiki operation. @internal */
export type WikiSourceResolver = (
	ctx: IntegrationToolExecutionContext,
	binding: Readonly<Record<string, unknown>>,
) => Promise<WikiTopicContext>;

/** Server-owned wiki interface; workers use authorized tools only. @internal */
export interface WikiIntegration extends TopicWikiStore {
	/** One resolver per process definition; duplicate registrations fail. @internal */
	registerProcessSource(processId: string, resolver: WikiSourceResolver): void;
	/** Resolve only the topic retained on the accepted process. @internal */
	resolveTopic(ctx: IntegrationToolExecutionContext): Promise<WikiTopicContext>;
}

/** @internal */
export const topicWikiCapability = createCapabilityToken<WikiIntegration>("core:topic-wiki");

/** Resolver registrations are scoped to this server instance. @internal */
export function createWikiIntegration(store: TopicWikiStore): WikiIntegration {
	const resolvers = new Map<string, WikiSourceResolver>();
	return {
		...store,
		registerProcessSource(processId, resolver) {
			if (!processId || resolvers.has(processId))
				throw new Error(`Wiki source resolver already registered or invalid: ${processId}`);
			resolvers.set(processId, resolver);
		},
		async resolveTopic(ctx) {
			const binding = asUnknownRecord(ctx.process.metadata?.wiki);
			if (!binding || typeof binding.topicId !== "string" || !binding.topicId)
				throw new Error("This process has no wiki topic binding");
			const retained = store.getTopic(binding.topicId);
			if (!retained) throw new Error("Wiki topic binding unavailable");
			if (retained.deleted) throw new Error("This wiki group was deleted and cannot be restored");
			const resolver = resolvers.get(ctx.process.processId);
			// A topic-only binding needs no provider. Provider data must never silently
			// lose its freshness and identity checks when its resolver is unavailable.
			if (!resolver && Object.keys(binding).some((key) => key !== "topicId"))
				throw new Error("Wiki source resolver unavailable for this process");
			const result = resolver ? await resolver(ctx, binding) : { topic: retained };
			if (result.topic.id !== binding.topicId || result.topic.key !== retained.key)
				throw new Error("Wiki source binding mismatch");
			if (result.topic.deleted)
				throw new Error("This wiki group was deleted and cannot be restored");
			return result;
		},
	};
}
