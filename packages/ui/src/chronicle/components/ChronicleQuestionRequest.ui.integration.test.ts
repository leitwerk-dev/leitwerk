/// <reference types="svelte" />
import type { ProcessQuestionRequest } from "@leitwerk-dev/domain";
import { createTestQuestionRequest } from "@leitwerk-dev/test-support/fixtures";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountTest } from "../../test-support/mount.js";

const mockSubmitQuestionAnswers = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api", () => ({ submitQuestionAnswers: mockSubmitQuestionAnswers }));

import ChronicleQuestionRequest from "./ChronicleQuestionRequest.svelte";

function questionRequest(overrides: Partial<ProcessQuestionRequest> = {}): ProcessQuestionRequest {
	return createTestQuestionRequest({
		id: "request-1",
		instanceId: "process-1",
		turnRecordId: "turn-1",
		...overrides,
	});
}

function mountSubject(request = questionRequest()) {
	return mountTest(ChronicleQuestionRequest, { request }).target;
}

beforeEach(() => {
	mockSubmitQuestionAnswers.mockReset();
	mockSubmitQuestionAnswers.mockImplementation(async () =>
		questionRequest({
			status: "answered",
			answers: ["Safe\nContext: Keep the change focused"],
			answeredAt: "2026-07-26T00:01:00.000Z",
		}),
	);
});

describe("ChronicleQuestionRequest", () => {
	it("keeps edits local until submission", async () => {
		const target = mountSubject();
		const option = target.querySelector("input") as HTMLInputElement;
		option.click();
		await tick();

		expect(option.checked).toBe(true);
		expect(mockSubmitQuestionAnswers).not.toHaveBeenCalled();
	});

	it("submits the complete local draft and renders the durable answer", async () => {
		const target = mountSubject();
		(target.querySelector("input") as HTMLInputElement).click();
		const context = target.querySelectorAll("textarea")[1] as HTMLTextAreaElement;
		context.value = "Keep the change focused";
		context.dispatchEvent(new Event("input", { bubbles: true }));
		(target.querySelector("form") as HTMLFormElement).requestSubmit();
		await tick();
		await tick();

		expect(mockSubmitQuestionAnswers).toHaveBeenCalledWith({
			instanceId: "process-1",
			requestId: "request-1",
			draft: [
				{
					selectedOptionIds: ["question_1_option_1"],
					freeText: "",
					comment: "Keep the change focused",
				},
			],
		});
		expect(target.textContent).toContain("Safe");
		expect(target.textContent).toContain("Keep the change focused");
		expect(target.querySelector("form")).toBeNull();
	});
});
