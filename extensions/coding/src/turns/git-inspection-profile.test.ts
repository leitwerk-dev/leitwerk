import { describe, expect, it } from "vitest";
import { GitTrace2Collector } from "./git-inspection-profile.js";

function event(value: Record<string, unknown>): Buffer {
	return Buffer.from(`${JSON.stringify(value)}\n`);
}

describe("Git inspection Trace2 reduction", () => {
	it("aggregates only allowlisted counters and region durations across stream chunks", () => {
		const collector = new GitTrace2Collector();
		const trace = Buffer.concat([
			event({ event: "start", argv: ["git", "private filename"] }),
			event({ event: "def_repo", worktree: "private repository" }),
			event({ event: "data", category: "index", key: "refresh/sum_scan", value: "42" }),
			event({ event: "data", category: "index", key: "refresh/sum_scan", value: 1 }),
			event({ event: "data", category: "index", key: "private filename", value: 99 }),
			event({ event: "region_leave", category: "index", label: "refresh", t_rel: 0.25 }),
			event({ event: "region_leave", category: "index", label: "refresh", t_rel: 0.5 }),
			event({ event: "region_leave", category: "index", label: "private filename", t_rel: 7 }),
		]);
		for (let offset = 0; offset < trace.length; offset += 7)
			collector.write(trace.subarray(offset, offset + 7));
		expect(collector.finish()).toEqual({
			counters: { "index/refresh/sum_scan": 43 },
			regionsMs: { "index/refresh": 750 },
			incomplete: false,
		});
	});

	it("survives malformed and oversized lines and marks missing or invalid traces", () => {
		const collector = new GitTrace2Collector();
		collector.write(Buffer.from("invalid JSON\nnull\n{}\n"));
		collector.write(
			event({ event: "data", category: { toString: null }, key: "refresh/sum_scan" }),
		);
		collector.write(
			event({ event: "data", category: "index", key: "refresh/sum_scan", value: "" }),
		);
		collector.write(
			event({ event: "data", category: "index", key: "refresh/sum_scan", value: -1 }),
		);
		collector.write(
			event({ event: "region_leave", category: "index", label: "refresh", t_rel: -1 }),
		);
		collector.write(Buffer.alloc(20 * 1024, "x"));
		collector.write(Buffer.from("\n"));
		collector.write(
			event({ event: "data", category: "index", key: "refresh/sum_scan", value: "2" }),
		);
		collector.write(Buffer.from("unfinished"));
		expect(collector.finish()).toEqual({
			counters: { "index/refresh/sum_scan": 2 },
			regionsMs: {},
			incomplete: true,
		});
		expect(new GitTrace2Collector().finish().incomplete).toBe(true);
	});

	it("stops parsing after a bounded byte budget while continuing to accept the stream", () => {
		const collector = new GitTrace2Collector();
		collector.write(
			event({ event: "data", category: "index", key: "refresh/sum_scan", value: "1" }),
		);
		for (let index = 0; index < 20; index++) collector.write(Buffer.alloc(64 * 1024, "x"));
		collector.write(Buffer.from("\n"));
		collector.write(
			event({ event: "data", category: "index", key: "refresh/sum_scan", value: "99" }),
		);
		expect(collector.finish()).toEqual({
			counters: { "index/refresh/sum_scan": 1 },
			regionsMs: {},
			incomplete: true,
		});
	});
});
