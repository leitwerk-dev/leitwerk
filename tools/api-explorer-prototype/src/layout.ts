import ELK from "elkjs/lib/elk-api.js";
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";
import { type LayoutEdge, type LayoutNode, layoutGraph } from "./layout-graph";
/** @internal ELK's API posts work to its native worker; no graph work runs on the UI thread. */
export function createLayout() {
	const elk = new ELK({ workerFactory: () => new ElkWorker() });
	return {
		close: () => elk.terminateWorker(),
		async run(nodes: LayoutNode[], edges: LayoutEdge[], overview: boolean) {
			const graph = await elk.layout(layoutGraph(nodes, edges, overview));
			return new Map((graph.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
		},
	};
}
