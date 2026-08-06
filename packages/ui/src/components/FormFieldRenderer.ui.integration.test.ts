// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormFieldDefinition } from "../lib/api.js";
import FormFieldRenderer from "./FormFieldRenderer.svelte";

let mounted: ReturnType<typeof mount> | null = null;

afterEach(() => {
	if (mounted) {
		unmount(mounted);
		mounted = null;
	}
	document.body.innerHTML = "";
});

function renderBooleanField(marker: "launcher" | "action") {
	const field: FormFieldDefinition = {
		id: "confirmed",
		label: "Confirmed",
		kind: "boolean",
		required: true,
		description: "Confirm before continuing.",
	};
	const onValueChange = vi.fn();
	mounted = mount(FormFieldRenderer, {
		target: document.body,
		props: {
			field,
			id: `${marker}-confirmed`,
			value: false,
			descriptionId: `${marker}-confirmed-description`,
			describedBy: `${marker}-confirmed-description`,
			marker,
			onValueChange,
		},
	});
	return { field, onValueChange };
}

describe("FormFieldRenderer", () => {
	it("renders boolean launcher fields as compact checkbox controls", () => {
		const { field, onValueChange } = renderBooleanField("launcher");

		const input = document.querySelector<HTMLInputElement>("input[data-launcher-form-field]");
		expect(input).not.toBeNull();
		expect(input?.type).toBe("checkbox");
		expect(input?.closest(".checkbox-row")).not.toBeNull();
		expect(document.querySelector("label.checkbox-label")?.textContent).toContain("Confirmed");

		input?.click();
		expect(onValueChange).toHaveBeenCalledWith(field, true);
	});

	it("renders boolean action fields with action field markers", () => {
		renderBooleanField("action");

		const input = document.querySelector<HTMLInputElement>("input[data-action-form-field]");
		expect(input).not.toBeNull();
		expect(input?.type).toBe("checkbox");
		expect(input?.hasAttribute("data-launcher-form-field")).toBe(false);
	});
});
