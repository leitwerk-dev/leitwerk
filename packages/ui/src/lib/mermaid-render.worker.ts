export interface MermaidRenderRequest {
	id: number;
	source: string;
}

export type MermaidRenderResponse =
	| { id: number; ok: true; svg: string }
	| { id: number; ok: false; error: string };

const rendererPromise = import("beautiful-mermaid");
const workerScope = globalThis as unknown as {
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<MermaidRenderRequest>) => void,
	): void;
	postMessage(message: MermaidRenderResponse): void;
};

workerScope.addEventListener("message", (event) => {
	const { id, source } = event.data;
	void rendererPromise
		.then(({ renderMermaidSVG, THEMES }) => {
			workerScope.postMessage({
				id,
				ok: true,
				svg: renderMermaidSVG(source, THEMES["zinc-light"]),
			});
		})
		.catch((error) => {
			workerScope.postMessage({
				id,
				ok: false,
				error: error instanceof Error ? error.message : "Mermaid rendering failed",
			});
		});
});
