import { createAcceptedLlmTurn as createTurn } from "@leitwerk-dev/server/testing";

export function createAcceptedLlmTurn(
	ctx: Parameters<typeof createTurn>[0],
	input: Parameters<typeof createTurn>[1],
	piResourceSnapshotDigest = "system-fixture-digest",
) {
	return createTurn(ctx, input, {
		id: `tsr_fixture_${input.id}`,
		workerId: `wkr_fixture_${input.id}`,
		model: {
			profileId: input.modelProfileId ?? "test",
			providerId: "test",
			modelId: "test",
			thinkingLevel: "off",
		},
		piResourceSnapshotDigest,
		workerRuntimeProfileId: "test",
	});
}
