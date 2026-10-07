import { type Codec, parseJsonData } from "@leitwerk-dev/process-sdk";
import * as v from "valibot";

const nonEmptyString = v.pipe(
	v.string(),
	v.check((value) => !!value.trim(), "Expected a nonempty string"),
);
const trimmedString = v.pipe(nonEmptyString, v.trim());
/** @internal */
const contextSchema = v.object({
	/** @internal */
	focusedResult: v.string(),
	/** @internal */
	parentPrompt: v.string(),
	/** @internal */
	durableResults: v.pipe(v.array(v.string()), v.readonly()),
	/** @internal */
	additionalInstructions: v.string(),
	/** @internal */
	capturedAt: v.string(),
});
const destinationSummarySchema = v.object({
	/** @internal */
	id: nonEmptyString,
	/** @internal */
	displayName: nonEmptyString,
	/** @internal */
	group: v.optional(v.string()),
	/** @internal */
	description: v.optional(v.string()),
});
const destinationSchema = v.object({
	/** @internal */
	summary: destinationSummarySchema,
	/** @internal */
	data: v.pipe(
		v.unknown(),
		v.transform((value) => parseJsonData(value, "destination.data must be JSON-serializable")),
	),
	/** @internal */
	agentContext: v.optional(v.string()),
});
/** @public */
const paramsSchema = v.object({
	/** @internal */
	parentInstanceId: trimmedString,
	/** @internal */
	artifact: v.variant("kind", [
		v.object({
			/** @internal */
			kind: v.literal("turn_result"),
			/** @internal */
			turnRecordId: nonEmptyString,
			/** @internal */
			leafEntryId: v.optional(v.string()),
		}),
		v.object({
			/** @internal */
			kind: v.literal("leaf_outcome"),
			/** @internal */
			turnRecordId: v.optional(v.string()),
			/** @internal */
			leafEntryId: nonEmptyString,
		}),
	]),
	/** @internal */
	focus: v.variant("kind", [
		v.object({
			/** @internal */
			kind: v.literal("whole_result"),
			/** @internal */
			excerpt: v.optional(v.string()),
		}),
		v.object({
			/** @internal */
			kind: v.literal("excerpt"),
			/** @internal */
			excerpt: nonEmptyString,
		}),
	]),
	/** @internal */
	context: contextSchema,
	/** @internal */
	additionalInstructions: v.optional(v.string(), ""),
	/** @internal */
	toolName: trimmedString,
	/** @internal */
	initiatingActor: v.object({
		/** @internal */
		id: nonEmptyString,
		/** @internal */
		kind: nonEmptyString,
		/** @internal */
		provider: v.nullable(nonEmptyString),
		/** @internal */
		displayName: v.optional(v.string()),
	}),
	/** @internal */
	ticketDestination: v.optional(destinationSchema),
	/** @internal */
	ticketDestinations: v.optional(v.pipe(v.array(destinationSummarySchema), v.readonly())),
	/** @internal */
	ticketDestinationWarnings: v.optional(v.pipe(v.array(v.string()), v.readonly())),
	/** @internal */
	launchModelProfileId: v.optional(nonEmptyString),
});

/** @internal */
export type TicketParentContextSnapshot = v.InferOutput<typeof contextSchema>;
/** @public */
export type TicketCreationParams = v.InferOutput<typeof paramsSchema>;
/** @internal */
export const ticketCreationParamsCodec: Codec<TicketCreationParams> = {
	parse: (value) => v.parse(paramsSchema, value),
	serialize: (value) => value,
};
