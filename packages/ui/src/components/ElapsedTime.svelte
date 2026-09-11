<script lang="ts">
import { elapsedMilliseconds, formatElapsedTime } from "../lib/elapsed-time.js";

let {
	startedAt,
	endedAt = null,
	running = false,
}: {
	startedAt: string | null;
	endedAt?: string | null;
	running?: boolean;
} = $props();
let now = $state(Date.now());
$effect(() => {
	if (!running || !startedAt || endedAt) return;
	now = Date.now();
	const timer = setInterval(() => {
		now = Date.now();
	}, 1000);
	return () => clearInterval(timer);
});
const elapsed = $derived(elapsedMilliseconds(startedAt, endedAt, running ? now : null));
</script>

<span class="elapsed-time" aria-live="off" title={elapsed === null ? "Timing unavailable" : undefined}>
    {elapsed === null ? "—" : formatElapsedTime(elapsed)}{running && elapsed !== null ? " elapsed" : ""}
</span>

<style>
.elapsed-time { font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
