import { afterEach, describe, expect, it } from "vitest";
import {
	LeafOutcomeCustomElement,
	type LeafOutcomeRendererRuntime,
} from "./leaf-outcome-renderer.js";

const TEST_TAG_NAME = "test-leaf-outcome-renderer";

class TestLeafOutcomeElement extends LeafOutcomeCustomElement<{ text?: string }> {
	renderCount = 0;

	protected renderContent(): void {
		if (!this.canRender()) {
			return;
		}
		this.renderCount += 1;
		const text = typeof this.payload?.text === "string" ? this.payload.text.trim() : "";
		if (!text) {
			this.emitError("missing_text", "text is required");
			return;
		}
		this.shadowRootRef.innerHTML = `<p>${text}</p>`;
		this.emitReady();
	}
}

if (!customElements.get(TEST_TAG_NAME)) {
	customElements.define(TEST_TAG_NAME, TestLeafOutcomeElement);
}

function createRuntime(): LeafOutcomeRendererRuntime {
	return {
		apiVersion: 1,
		markdown: {
			render(markdown) {
				return markdown;
			},
		},
		server: {
			resolveUrl(path) {
				return path;
			},
			async fetch() {
				return new Response(null, { status: 204 });
			},
		},
		formatRelativeTime(iso) {
			return iso;
		},
	};
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("LeafOutcomeCustomElement", () => {
	it("renders once connected and emits ready only once", () => {
		const element = document.createElement(TEST_TAG_NAME) as TestLeafOutcomeElement;
		const readyEvents: Event[] = [];
		element.addEventListener("o2-leaf-outcome-ready", (event) => {
			readyEvents.push(event);
		});

		element.payload = { text: "First render" };
		element.runtime = createRuntime();
		expect(element.renderCount).toBe(0);

		document.body.append(element);
		expect(element.renderCount).toBe(1);
		expect(element.shadowRoot?.textContent).toContain("First render");
		expect(readyEvents).toHaveLength(1);

		element.payload = { text: "Second render" };
		expect(element.renderCount).toBe(2);
		expect(element.shadowRoot?.textContent).toContain("Second render");
		expect(readyEvents).toHaveLength(1);
	});

	it("emits structured errors when rendering cannot complete", () => {
		const element = document.createElement(TEST_TAG_NAME) as TestLeafOutcomeElement;
		const errors: Array<{ code: string; message: string }> = [];
		element.addEventListener("o2-leaf-outcome-error", (event) => {
			errors.push((event as CustomEvent<{ code: string; message: string }>).detail);
		});

		element.runtime = createRuntime();
		document.body.append(element);

		expect(errors).toEqual([{ code: "missing_text", message: "text is required" }]);
		expect(element.shadowRoot?.innerHTML).toBe("");
	});
});
