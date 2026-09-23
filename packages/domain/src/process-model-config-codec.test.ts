import { assert, describe, expect, it } from "vitest";
import {
	normalizeLaunchModelConfigInput,
	parseStrictInstanceTurnConfigsJson,
	serializeInstanceTurnConfigs,
} from "./process-model-config.js";

describe("process model configuration codecs", () => {
	it.each([
		"turn.with.dot",
		"",
	])("reports turn id %j when its config is not an object", (turnId) => {
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
		const serialized = serializeInstanceTurnConfigs(normalized.turnConfigs ?? {});
		assert(typeof serialized === "string", "Non-empty turn configuration must serialize to JSON");
		expect(JSON.parse(serialized)).toEqual({ run: { modelProfileId: "second" } });
	});
});
