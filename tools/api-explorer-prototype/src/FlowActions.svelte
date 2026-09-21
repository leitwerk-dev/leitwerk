<script lang="ts">
import { useSvelteFlow } from "@xyflow/svelte";
import { onMount } from "svelte";

let { onready }: { onready: (fit: () => void) => void } = $props();
const { fitView } = useSvelteFlow();
onMount(() => {
	const fit = () => {
		void fitView({
			padding: 0.15,
			maxZoom: 1,
			duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180,
		});
	};
	let timer: ReturnType<typeof setTimeout>;
	const resize = () => {
		clearTimeout(timer);
		timer = setTimeout(fit, 120);
	};
	onready(fit);
	window.addEventListener("resize", resize);
	return () => {
		window.removeEventListener("resize", resize);
		clearTimeout(timer);
	};
});
</script>
