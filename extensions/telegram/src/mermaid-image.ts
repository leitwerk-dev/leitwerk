import { Worker } from "node:worker_threads";

const MAX_MERMAID_SOURCE_CHARS = 20_000;
const MAX_MERMAID_SOURCE_LINES = 500;
const MERMAID_RENDER_TIMEOUT_MS = 8_000;

const RENDER_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_SVG_ELEMENTS = 2_000;
const TARGET_WIDTH = 1_600;
const MAX_TARGET_HEIGHT = 5_000;
const MAX_TARGET_PIXELS = 8_000_000;
const MAX_PNG_BYTES = 10 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function svgDimensions(svg) {
  const match = /<svg[^>]*\bviewBox=["']\s*[-+\d.e]+\s+[-+\d.e]+\s+([-+\d.e]+)\s+([-+\d.e]+)\s*["']/i.exec(svg);
  if (!match) fail("Rendered Mermaid SVG has no bounded viewBox");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    fail("Rendered Mermaid SVG dimensions are invalid");
  }
  return { width, height };
}

(async () => {
  const [{ renderMermaidSVG, THEMES }, { default: sharp }] = await Promise.all([
    import("beautiful-mermaid"),
    import("sharp"),
  ]);
  const svg = renderMermaidSVG(workerData.source, THEMES["zinc-light"]);
  if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) fail("Rendered Mermaid SVG is too large");
  const elementCount = (svg.match(/<[a-zA-Z][^>]*>/g) || []).length;
  if (elementCount > MAX_SVG_ELEMENTS) fail("Rendered Mermaid diagram is too complex");
  const dimensions = svgDimensions(svg);
  const targetHeight = Math.ceil((dimensions.height / dimensions.width) * TARGET_WIDTH);
  if (targetHeight > MAX_TARGET_HEIGHT || TARGET_WIDTH * targetHeight > MAX_TARGET_PIXELS) {
    fail("Rendered Mermaid diagram dimensions are too large");
  }
  const png = await sharp(Buffer.from(svg), { limitInputPixels: MAX_TARGET_PIXELS })
    .resize({ width: TARGET_WIDTH, height: targetHeight, fit: "fill" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
  if (png.byteLength > MAX_PNG_BYTES) fail("Rendered Mermaid PNG is too large");
  const bytes = Uint8Array.from(png);
  parentPort.postMessage({ ok: true, bytes }, [bytes.buffer]);
})().catch((error) => {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
});
`;

export async function renderMermaidPng(source: string): Promise<Uint8Array> {
	const normalized = source.trim();
	if (!normalized) throw new Error("Mermaid source is empty");
	if (normalized.length > MAX_MERMAID_SOURCE_CHARS) {
		throw new Error(`Mermaid source exceeds ${MAX_MERMAID_SOURCE_CHARS} characters`);
	}
	if (normalized.split("\n").length > MAX_MERMAID_SOURCE_LINES) {
		throw new Error(`Mermaid source exceeds ${MAX_MERMAID_SOURCE_LINES} lines`);
	}

	return new Promise<Uint8Array>((resolve, reject) => {
		const worker = new Worker(RENDER_WORKER_SOURCE, {
			eval: true,
			workerData: { source: normalized },
			resourceLimits: {
				maxOldGenerationSizeMb: 96,
				maxYoungGenerationSizeMb: 24,
				stackSizeMb: 4,
			},
		});
		let settled = false;
		const finish = (work: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			work();
		};
		const timer = setTimeout(() => {
			finish(() => reject(new Error("Mermaid rendering timed out")));
		}, MERMAID_RENDER_TIMEOUT_MS);
		worker.once("message", (message: unknown) => {
			const result = message as { ok?: boolean; bytes?: Uint8Array; error?: string };
			if (result.ok && result.bytes instanceof Uint8Array) {
				finish(() => resolve(result.bytes as Uint8Array));
				return;
			}
			finish(() => reject(new Error(result.error || "Mermaid rendering failed")));
		});
		worker.once("error", (error) => finish(() => reject(error)));
		worker.once("exit", (code) => {
			if (code !== 0) finish(() => reject(new Error(`Mermaid renderer exited with code ${code}`)));
		});
	});
}
