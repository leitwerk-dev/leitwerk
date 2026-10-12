<script>
let { name = "agent", size = 20 } = $props();
const paths = {
	agent: "M8 4h8v4H8z M4 10h16v10H4z M8 14h.01 M16 14h.01 M9 17h6 M12 2v2 M2 13h2 M20 13h2",
	map: "m16 3 4 4-4 4M4 11V9a2 2 0 0 1 2-2h14M8 21l-4-4 4-4m12 0v2a2 2 0 0 1-2 2H4",
	automatic: "m10 3-1 3-3 1-3 3v4l3 1 1 3 3 3h4l1-3 3-1 3-3v-4l-3-1-1-3-3-3h-4Z",
	human: "M5 21v-3a7 7 0 0 1 14 0v3M9 17l2 2 4-4",
	complete: "M5 12l4 4L19 6",
	abort: "M7 7l10 10 M17 7L7 17",
	arrow: "M4 12h16 M14 6l6 6-6 6",
	left: "M15 6l-6 6 6 6",
	right: "M9 6l6 6-6 6",
	close: "M6 6l12 12 M18 6L6 18",
	fit: "M9 3H3v6 M15 3h6v6 M3 15v6h6 M21 15v6h-6",
	plus: "M5 12h14 M12 5v14",
	minus: "M5 12h14",
	loop: "M5 8a8 8 0 1 1-1 8 M5 3v5h5",
	branch: "M6 3v14a4 4 0 0 0 4 4h8 M6 7h8a4 4 0 0 0 4-4 M14 17l4 4-4 3 M14 3l4-3",
	info: "M12 11v6 M12 7h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
	layers: "M12 3L3 8l9 5 9-5-9-5 M3 12l9 5 9-5 M3 16l9 5 9-5",
	play: "M8 4l12 8-12 8z",
	edit: "M4 20h4L20 8l-4-4L4 16z M13 7l4 4",
	wrench: "M14 6a5 5 0 0 0-6 6L3 17a2.8 2.8 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z",
};
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{#if name === 'llm'}<path d="m10 3 2.2 6.8L19 12l-6.8 2.2L10 21l-2.2-6.8L1 12l6.8-2.2L10 3Z" fill="currentColor" stroke="none" /><path d="m19 1 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Zm1 14 .8 2.2L23 18l-2.2.8L20 21l-.8-2.2L17 18l2.2-.8L20 15Z" fill="currentColor" stroke="none" />{:else if name === 'collect'}<path d="M12 3L21 12L12 21L3 12Z" fill="var(--collection-fill, none)" /><path d="M7 9L12 12L7 15 M12 12H17" />{:else if name === 'automatic'}<path d={paths.automatic} transform="translate(0 -1) scale(1 .95)" /><circle cx="12" cy="11" r="3" />{:else if name === 'human'}<circle cx="12" cy="7" r="3" /><path d={paths.human} />{:else}<path d={paths[name] || paths.agent} />{/if}</svg>
