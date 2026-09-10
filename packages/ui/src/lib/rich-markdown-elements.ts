import { parseManagedResultImagePath } from "@leitwerk-dev/worker-protocol/worker-result-image";
import createDOMPurify from "dompurify";
import { secureAnchorNewTab } from "./external-links.js";
import type { MermaidRenderRequest, MermaidRenderResponse } from "./mermaid-render.worker.js";

const CSS_IMPORT = /@import[^;]+;/gi;

export interface MermaidRenderWorker {
	onmessage: ((event: MessageEvent<MermaidRenderResponse>) => void) | null;
	onerror: ((event: Event) => void) | null;
	postMessage(message: MermaidRenderRequest): void;
	terminate(): void;
}

export interface RichMarkdownEnhancerOptions {
	createMermaidWorker?: () => MermaidRenderWorker;
}

function createMermaidWorker(): MermaidRenderWorker {
	return new Worker(new URL("./mermaid-render.worker.ts", import.meta.url), {
		type: "module",
	}) as MermaidRenderWorker;
}

/** Sanitizes executable SVG content but does not enforce a network resource policy; see docs/security.md. */
export function sanitizeMermaidSvg(svg: string): string {
	const purifier = createDOMPurify(globalThis.window);
	return purifier.sanitize(svg.replace(CSS_IMPORT, ""), {
		USE_PROFILES: { svg: true, svgFilters: true },
		FORBID_TAGS: ["script", "foreignObject", "iframe", "image", "use"],
		FORBID_ATTR: ["href", "xlink:href", "style", "onload", "onclick", "onerror"],
	});
}

function renderResultImage(host: HTMLElement): void {
	if (host.firstElementChild) return;
	const src = host.dataset.resultImage ?? "";
	if (!parseManagedResultImagePath(src)) return;
	const link = document.createElement("a");
	link.href = src;
	secureAnchorNewTab(link);
	link.setAttribute("aria-label", `Open image: ${host.dataset.alt ?? ""}`);
	const image = document.createElement("img");
	image.src = src;
	image.alt = host.dataset.alt ?? "";
	link.append(image);
	host.append(link);
}

function showMermaidFallback(root: ShadowRoot, source: string): void {
	root.replaceChildren();
	const warning = document.createElement("p");
	warning.setAttribute("role", "status");
	warning.textContent = "Diagram could not be rendered. Mermaid source is shown below.";
	const pre = document.createElement("pre");
	pre.textContent = source;
	root.append(warning, pre);
}

function renderMermaidDiagrams(
	node: HTMLElement,
	workerFactory: () => MermaidRenderWorker,
): (() => void) | null {
	const diagrams = [...node.querySelectorAll<HTMLElement>("[data-mermaid-source]")].filter(
		(host) => !host.shadowRoot && host.dataset.rendering !== "true",
	);
	if (diagrams.length === 0) return null;

	let worker: MermaidRenderWorker;
	try {
		worker = workerFactory();
	} catch {
		for (const host of diagrams) {
			const source = host.textContent ?? "";
			host.dataset.rendering = "true";
			host.replaceChildren();
			showMermaidFallback(host.attachShadow({ mode: "open" }), source);
		}
		return null;
	}

	const pending = new Map<number, { root: ShadowRoot; source: string }>();
	let nextId = 1;
	let terminated = false;
	const terminate = (): void => {
		if (terminated) return;
		terminated = true;
		pending.clear();
		worker.terminate();
	};
	const finishIfIdle = (): void => {
		if (pending.size === 0) terminate();
	};
	worker.onmessage = (event) => {
		const target = pending.get(event.data.id);
		if (!target) return;
		pending.delete(event.data.id);
		if (event.data.ok) {
			try {
				const svg = sanitizeMermaidSvg(event.data.svg);
				target.root.innerHTML = `<style>:host{display:block;margin:0 0 14px;overflow:auto;--bg:#fff;--fg:#27272a}svg{display:block;max-width:100%;height:auto}</style>${svg}`;
			} catch {
				showMermaidFallback(target.root, target.source);
			}
		} else {
			showMermaidFallback(target.root, target.source);
		}
		finishIfIdle();
	};
	worker.onerror = () => {
		for (const { root, source } of pending.values()) showMermaidFallback(root, source);
		terminate();
	};

	for (const host of diagrams) {
		const source = host.textContent ?? "";
		host.dataset.rendering = "true";
		host.replaceChildren();
		const root = host.attachShadow({ mode: "open" });
		const id = nextId++;
		pending.set(id, { root, source });
		try {
			worker.postMessage({ id, source });
		} catch {
			pending.delete(id);
			showMermaidFallback(root, source);
		}
	}
	finishIfIdle();
	return terminate;
}

function renderRichMarkdown(
	node: HTMLElement,
	workerFactory: () => MermaidRenderWorker,
): (() => void) | null {
	for (const image of node.querySelectorAll<HTMLElement>("[data-result-image]")) {
		renderResultImage(image);
	}
	return renderMermaidDiagrams(node, workerFactory);
}

export function createRichMarkdownEnhancer(options: RichMarkdownEnhancerOptions = {}) {
	const workerFactory = options.createMermaidWorker ?? createMermaidWorker;
	return function enhanceRichMarkdown(
		node: HTMLElement,
		_markdown?: unknown,
	): { update: () => void; destroy: () => void } {
		let generation = 0;
		let cancelRender: (() => void) | null = null;
		const schedule = (): void => {
			generation += 1;
			const scheduledGeneration = generation;
			cancelRender?.();
			cancelRender = null;
			queueMicrotask(() => {
				if (generation !== scheduledGeneration) return;
				cancelRender = renderRichMarkdown(node, workerFactory);
			});
		};
		schedule();
		return {
			update: schedule,
			destroy: () => {
				generation += 1;
				cancelRender?.();
				cancelRender = null;
			},
		};
	};
}

export const enhanceRichMarkdown = createRichMarkdownEnhancer();
