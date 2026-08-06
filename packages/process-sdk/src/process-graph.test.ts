import { describe, expect, it } from "vitest";
import { emptyParamsCodec } from "./codecs.js";
import { automaticTurn, defineProcess, llmTurn } from "./define-process.js";
import { toProcessGraphView, validateProcessGraphProducts } from "./process-graph.js";

const stateCodec = {
	parse(value: unknown): Record<string, unknown> {
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	},
	serialize(value: Record<string, unknown>): unknown {
		return value;
	},
};

describe("process graph product validation", () => {
	it("validates optional consumed products against declared publishers", () => {
		const process = defineProcess({
			id: "optional_product_process",
			displayName: "Optional Product Process",
			entry: "consumer",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({}),
			turns: {
				consumer: llmTurn({
					availableTools: [],
					description: "Consumer",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "Consume optional product",
					optionalConsumedProducts: ["message"],
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});

		expect(validateProcessGraphProducts(toProcessGraphView(process))).toContain(
			"Turn 'consumer' consumes product 'message' that is never published by this process",
		);
	});

	it("treats automatic outcome-level product publication as a graph publisher", () => {
		const process = defineProcess({
			id: "automatic_product_process",
			displayName: "Automatic Product Process",
			entry: "producer",
			paramsCodec: emptyParamsCodec,
			stateCodec,
			initialState: () => ({}),
			turns: {
				producer: automaticTurn({
					description: "Produce",
					run: async () => ({ outcome: "published", params: { message: "Published" } }),
					outcomes: {
						published: {
							description: "Published",
							parameters: {
								message: { type: "string", description: "Message", required: true },
							},
							publishedProduct: "message",
							turnResultMarkdownParameter: "message",
							to: "consumer",
						},
					},
				}),
				consumer: llmTurn({
					availableTools: [],
					description: "Consumer",
					branchType: "primary",
					context: "fresh",
					prompt: async () => "Consume message",
					consumedProducts: ["message"],
					turnEnd: { outcome: "done", params: {}, complete: true },
				}),
			},
		});

		expect(validateProcessGraphProducts(toProcessGraphView(process))).toEqual([]);
	});
});
