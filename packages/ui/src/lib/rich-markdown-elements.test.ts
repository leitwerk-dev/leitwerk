// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { MermaidRenderRequest, MermaidRenderResponse } from "./mermaid-render.worker.js";
import {
	createRichMarkdownEnhancer,
	enhanceRichMarkdown,
	type MermaidRenderWorker,
	sanitizeMermaidSvg,
} from "./rich-markdown-elements.js";

const MANAGED_IMAGE = "/api/processes/prc_1/turn-records/trn_1/result-images/img_1.png";

class FakeMermaidWorker implements MermaidRenderWorker {
	onmessage: ((event: MessageEvent<MermaidRenderResponse>) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	readonly requests: MermaidRenderRequest[] = [];
	readonly terminate = vi.fn();

	postMessage(message: MermaidRenderRequest): void {
		this.requests.push(message);
	}

	respond(response: MermaidRenderResponse): void {
		this.onmessage?.({ data: response } as MessageEvent<MermaidRenderResponse>);
	}
}

function mermaidHost(source: string): HTMLElement {
	const host = document.createElement("div");
	host.dataset.mermaidSource = "";
	const pre = document.createElement("pre");
	pre.textContent = source;
	host.append(pre);
	return host;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("rich Markdown elements", () => {
	it("preserves Mermaid styles and local markers while removing hrefs and CSS imports", () => {
		const sanitized = sanitizeMermaidSvg(`
			<svg xmlns="http://www.w3.org/2000/svg">
				<style>.node { fill: red; stroke: black; }</style>
				<style>@import url("https://example.com/theme.css");</style>
				<a href="https://example.com/"><rect class="node" /></a>
				<path marker-end="url(#arrow)" />
			</svg>
		`);

		expect(sanitized).toContain(".node { fill: red; stroke: black; }");
		expect(sanitized).toContain('marker-end="url(#arrow)"');
		expect(sanitized).not.toContain("example.com");
		expect(sanitized).not.toContain("@import");
	});

	it("keeps presentation URL references as a documented accepted risk", () => {
		const sanitized = sanitizeMermaidSvg(
			'<svg xmlns="http://www.w3.org/2000/svg"><path stroke="url(https://example.com/paint.svg)" /></svg>',
		);

		expect(sanitized).toContain('stroke="url(https://example.com/paint.svg)"');
	});

	it("links the managed image to its original", async () => {
		const container = document.createElement("div");
		container.innerHTML = `<span data-result-image="${MANAGED_IMAGE}" data-alt="Evidence"></span>`;
		document.body.append(container);
		enhanceRichMarkdown(container);
		await Promise.resolve();

		const link = container.querySelector<HTMLAnchorElement>("[data-result-image] a");
		const image = link?.querySelector<HTMLImageElement>("img");
		expect(link?.getAttribute("href")).toBe(MANAGED_IMAGE);
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
		expect(link?.classList.contains("external-link")).toBe(false);
		expect(image?.getAttribute("src")).toBe(MANAGED_IMAGE);
		expect(image?.alt).toBe("Evidence");
	});

	it("sends an excessive diagram to a terminable worker without imposing a source limit", async () => {
		const source = `flowchart LR\n${"A --> B\n".repeat(20_000)}`;
		const container = document.createElement("div");
		container.append(mermaidHost(source));
		document.body.append(container);
		const worker = new FakeMermaidWorker();
		const enhance = createRichMarkdownEnhancer({ createMermaidWorker: () => worker });

		const action = enhance(container);
		await Promise.resolve();

		expect(worker.requests).toEqual([{ id: 1, source }]);
		action.destroy();
		expect(worker.terminate).toHaveBeenCalledOnce();
	});

	it("renders repeated diagrams through one worker and terminates it after the batch", async () => {
		const sources = [
			"flowchart LR\nA --> B",
			"flowchart TD\nC --> D",
			"stateDiagram-v2\nOpen --> Closed",
		];
		const container = document.createElement("div");
		container.append(...sources.map(mermaidHost));
		document.body.append(container);
		const worker = new FakeMermaidWorker();
		const createWorker = vi.fn(() => worker);
		const action = createRichMarkdownEnhancer({ createMermaidWorker: createWorker })(container);
		await Promise.resolve();

		expect(createWorker).toHaveBeenCalledOnce();
		expect(worker.requests.map(({ source }) => source)).toEqual(sources);
		for (const request of worker.requests) {
			worker.respond({
				id: request.id,
				ok: true,
				svg: `<svg viewBox="0 0 10 10"><text>${request.id}</text></svg>`,
			});
		}

		const hosts = [...container.querySelectorAll<HTMLElement>("[data-mermaid-source]")];
		expect(hosts.every((host) => Boolean(host.shadowRoot?.querySelector("svg")))).toBe(true);
		expect(worker.terminate).toHaveBeenCalledOnce();
		action.destroy();
		expect(worker.terminate).toHaveBeenCalledOnce();
	});
});
