import { describe, expect, it } from "vitest";
import {
	buildFailedTurnRecoveryMetadata,
	createGenericFailedTurnRecoveryContext,
	readFailedTurnRecoveryContext,
} from "./turn-recovery.js";

describe("turn recovery metadata", () => {
	it("builds generic continue recovery metadata scoped to a turn record", () => {
		const metadata = buildFailedTurnRecoveryMetadata("trn_1");

		expect(readFailedTurnRecoveryContext(metadata, "trn_1")).toEqual(
			createGenericFailedTurnRecoveryContext(),
		);
		expect(readFailedTurnRecoveryContext(metadata, "trn_other")).toBeNull();
	});

	it("keeps explicit recovery details while defaulting strategy", () => {
		const metadata = buildFailedTurnRecoveryMetadata("trn_2", {
			suggestedContinuePrompt: "Call markdown_result with the final summary.",
			failureCode: "missing_markdown_result",
			missingToolNames: ["markdown_result"],
		});

		expect(readFailedTurnRecoveryContext(metadata, "trn_2")).toEqual({
			strategy: "continue",
			suggestedContinuePrompt: "Call markdown_result with the final summary.",
			failureCode: "missing_markdown_result",
			missingToolNames: ["markdown_result"],
		});
	});
});
