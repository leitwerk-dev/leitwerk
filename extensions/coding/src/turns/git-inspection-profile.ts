import { StringDecoder } from "node:string_decoder";

const MAX_TRACE_BYTES = 512 * 1024;
const MAX_LINE_LENGTH = 16 * 1024;
const COUNTERS = new Set([
	"index/read/cache_nr",
	"index/preload/sum_lstat",
	"index/refresh/sum_lstat",
	"index/refresh/sum_scan",
	"read_directory/directories-visited",
	"read_directory/paths-visited",
	"status/count/changed",
	"status/count/untracked",
]);
const REGIONS = new Set([
	"index/do_read_index",
	"index/preload",
	"index/refresh",
	"index/do_write_index",
	"status/worktrees",
	"status/index",
	"status/untracked",
	"dir/read_directory",
	"diff/setup",
	"diff/write back to queue",
]);

/** @internal */
export interface GitTrace2Summary {
	/** @internal */
	counters: Record<string, number>;
	/** @internal */
	regionsMs: Record<string, number>;
	/** Trace was absent, malformed, or exceeded the parsing budget. @internal */
	incomplete: boolean;
}

/** Reduces a bounded Trace2 stream to allowlisted numbers; never retains raw events. @internal */
export class GitTrace2Collector {
	private readonly decoder = new StringDecoder("utf8");
	private readonly summary: GitTrace2Summary = { counters: {}, regionsMs: {}, incomplete: false };
	private bytes = 0;
	private pending = "";
	private droppingLine = false;
	private sawEvent = false;

	/** @internal */
	write(chunk: Buffer): void {
		const remaining = MAX_TRACE_BYTES - this.bytes;
		if (chunk.length > remaining) this.summary.incomplete = true;
		if (remaining <= 0) return;
		const retained = chunk.subarray(0, remaining);
		this.bytes += retained.length;
		this.consume(this.decoder.write(retained));
	}

	/** @internal */
	finish(): GitTrace2Summary {
		this.consume(this.decoder.end());
		if (this.pending || this.droppingLine || !this.sawEvent) this.summary.incomplete = true;
		this.pending = "";
		return this.summary;
	}

	private consume(text: string): void {
		let start = 0;
		while (start < text.length) {
			const end = text.indexOf("\n", start);
			const part = text.slice(start, end < 0 ? text.length : end);
			if (!this.droppingLine) {
				if (this.pending.length + part.length > MAX_LINE_LENGTH) {
					this.summary.incomplete = true;
					this.pending = "";
					this.droppingLine = true;
				} else this.pending += part;
			}
			if (end < 0) break;
			if (!this.droppingLine) this.readEvent(this.pending);
			this.pending = "";
			this.droppingLine = false;
			start = end + 1;
		}
	}

	private readEvent(line: string): void {
		let event: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
			event = parsed as Record<string, unknown>;
		} catch {
			this.summary.incomplete = true;
			return;
		}
		if (typeof event.event !== "string") {
			this.summary.incomplete = true;
			return;
		}
		this.sawEvent = true;
		if (event.event === "data") {
			if (typeof event.category !== "string" || typeof event.key !== "string") {
				this.summary.incomplete = true;
				return;
			}
			const key = `${event.category}/${event.key}`;
			if (!COUNTERS.has(key)) return;
			const value =
				typeof event.value === "string" && /^\d+$/.test(event.value)
					? Number(event.value)
					: event.value;
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
				this.summary.incomplete = true;
				return;
			}
			const total = (this.summary.counters[key] ?? 0) + value;
			if (Number.isSafeInteger(total)) this.summary.counters[key] = total;
			else this.summary.incomplete = true;
		} else if (event.event === "region_leave") {
			if (typeof event.category !== "string" || typeof event.label !== "string") {
				this.summary.incomplete = true;
				return;
			}
			const key = `${event.category}/${event.label}`;
			if (!REGIONS.has(key)) return;
			if (typeof event.t_rel !== "number" || !Number.isFinite(event.t_rel) || event.t_rel < 0) {
				this.summary.incomplete = true;
				return;
			}
			const total = (this.summary.regionsMs[key] ?? 0) + event.t_rel * 1_000;
			if (Number.isFinite(total)) this.summary.regionsMs[key] = total;
			else this.summary.incomplete = true;
		}
	}
}
