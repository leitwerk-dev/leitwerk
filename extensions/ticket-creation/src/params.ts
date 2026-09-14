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
	artifact: v.variant("kind", [
		v.object({
			kind: v.literal("turn_result"),
			turnRecordId: nonEmptyString,
			leafEntryId: v.optional(v.string()),
		}),
		v.object({
			kind: v.literal("leaf_outcome"),
			turnRecordId: v.optional(v.string()),
			leafEntryId: nonEmptyString,
		}),
	]),
	focus: v.variant("kind", [
		v.object({ kind: v.literal("whole_result"), excerpt: v.optional(v.string()) }),
		v.object({ kind: v.literal("excerpt"), excerpt: nonEmptyString }),
	]),
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
