import { describe, expect, it } from "vitest";
import {
	buildFailedTurnRecoveryMetadata,
	createGenericFailedTurnRecoveryContext,
	inferTerminalRecordingFailedTurnRecoveryContext,
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

	it("infers continuation for legacy terminal outcome recording failures", () => {
		expect(
			inferTerminalRecordingFailedTurnRecoveryContext({
				errorSummary: "Server could not durably record worker turn outcome: invalid transition",
				errorClass: "infrastructure",
			}),
		).toEqual(createGenericFailedTurnRecoveryContext());
		expect(
			inferTerminalRecordingFailedTurnRecoveryContext({
				errorSummary: "Worker exited unexpectedly",
				errorClass: "infrastructure",
			}),
		).toBeNull();
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
