import { describe, expect, it } from "vitest";
import {
	normalizeLaunchModelConfigInput,
	parseStrictInstanceTurnConfigsJson,
	serializeInstanceTurnConfigs,
} from "./process-model-config.js";

describe("process model configuration codecs", () => {
	it("reports dotted and empty turn ids in malformed JSON entries", () => {
		for (const turnId of ["turn.with.dot", ""]) {
			expect(
				parseStrictInstanceTurnConfigsJson("test_process", JSON.stringify({ [turnId]: [] })),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_turn_configs_json",
					processId: "test_process",
					reason: "turn_config_not_object",
					turnId,
				},
			});
		}
	});

	it("normalizes and serializes model configuration input", () => {
		const normalized = normalizeLaunchModelConfigInput({
			defaultModelProfileId: " first ",
			turnConfigs: { run: { modelProfileId: " second " }, empty: { modelProfileId: " " } },
		});
		expect(normalized).toEqual({
			defaultModelProfileId: "first",
			turnConfigs: { run: { modelProfileId: "second" } },
		});
		expect(serializeInstanceTurnConfigs(normalized.turnConfigs ?? {})).toBe(
			JSON.stringify({ run: { modelProfileId: "second" } }),
		);
	});
});
