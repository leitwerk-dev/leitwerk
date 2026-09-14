import { type Codec, parseJsonData } from "@leitwerk-dev/process-sdk";
import * as v from "valibot";

const nonEmptyString = v.pipe(
	v.string(),
	v.check((value) => !!value.trim(), "Expected a nonempty string"),
);
const trimmedString = v.pipe(nonEmptyString, v.trim());
const contextSchema = v.object({
	focusedResult: v.string(),
	parentPrompt: v.string(),
	durableResults: v.pipe(v.array(v.string()), v.readonly()),
	additionalInstructions: v.string(),
	capturedAt: v.string(),
});
const destinationSummarySchema = v.object({
	id: nonEmptyString,
	displayName: nonEmptyString,
	group: v.optional(v.string()),
	description: v.optional(v.string()),
});
const destinationSchema = v.object({
	summary: destinationSummarySchema,
	data: v.pipe(
		v.unknown(),
		v.transform((value) => parseJsonData(value, "destination.data must be JSON-serializable")),
	),
	agentContext: v.optional(v.string()),
});
const paramsSchema = v.object({
	parentInstanceId: trimmedString,
	artifact: v.pipe(
		v.object({
			kind: v.picklist(["turn_result", "leaf_outcome"]),
			turnRecordId: v.optional(v.string()),
			leafEntryId: v.optional(v.string()),
		}),
		v.check(
			(value) => !!(value.kind === "turn_result" ? value.turnRecordId : value.leafEntryId)?.trim(),
			"Invalid artifact identifier",
		),
	),
	focus: v.pipe(
		v.object({ kind: v.picklist(["whole_result", "excerpt"]), excerpt: v.optional(v.string()) }),
		v.check(
			(value) => value.kind !== "excerpt" || !!value.excerpt?.trim(),
			"Invalid focus.excerpt",
		),
	),
	context: contextSchema,
	additionalInstructions: v.optional(v.string(), ""),
	toolName: trimmedString,
	initiatingActor: v.object({
		id: nonEmptyString,
		kind: nonEmptyString,
		provider: v.nullable(nonEmptyString),
		displayName: v.optional(v.string()),
	}),
	ticketDestination: v.optional(destinationSchema),
	ticketDestinations: v.optional(v.pipe(v.array(destinationSummarySchema), v.readonly())),
	ticketDestinationWarnings: v.optional(v.pipe(v.array(v.string()), v.readonly())),
	launchModelProfileId: v.optional(nonEmptyString),
});

export type TicketParentContextSnapshot = v.InferOutput<typeof contextSchema>;
export type TicketCreationParams = v.InferOutput<typeof paramsSchema>;
export const ticketCreationParamsCodec: Codec<TicketCreationParams> = {
	parse: (value) => v.parse(paramsSchema, value),
	serialize: (value) => value,
};
