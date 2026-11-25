// Sync LikeC4 with the docs palette and open walkthroughs from the homepage cards.
(() => {
	const scheme = () =>
		document.body.getAttribute("data-md-color-scheme") === "slate" ? "dark" : "light";
	const sync = () => {
		const value = scheme();
		for (const diagram of document.querySelectorAll("likec4-view")) {
			if (diagram.getAttribute("color-scheme") !== value)
				diagram.setAttribute("color-scheme", value);
		}
	};
	new MutationObserver(sync).observe(document.body, {
		attributes: true,
		attributeFilter: ["data-md-color-scheme"],
		childList: true,
		subtree: true,
	});
	sync();

	document.addEventListener("click", (event) => {
		const card = event.target.closest?.("[data-flow-card]");
		if (!card) return;
		const player = document.getElementById(card.getAttribute("aria-controls"));
		const flow = player?.querySelector("leitwerk-flow");
		if (!flow) return;
		for (const other of document.querySelectorAll("[data-flow-card]")) {
			other.setAttribute("aria-pressed", String(other === card));
		}
		player.hidden = false;
		flow.start(card.dataset.flowCard);
		flow.focus({ preventScroll: true });
		player.scrollIntoView({
			behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
			block: "start",
		});
	});
})();
