// Connect <leitwerk-flow> elements to the docs: follow the palette toggle, and let the landing page
// pitch cards open the player with their flow and start it.
(() => {
	const scheme = () =>
		document.body.getAttribute("data-md-color-scheme") === "slate" ? "dark" : "light";
	const sync = () => {
		const value = scheme();
		for (const flow of document.querySelectorAll("leitwerk-flow")) {
			if (flow.getAttribute("color-scheme") !== value) flow.setAttribute("color-scheme", value);
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
		flow.flow = card.dataset.flowCard;
		flow.reset();
		flow.focus({ preventScroll: true });
		player.scrollIntoView({
			behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
			block: "start",
		});
		flow.play();
	});
})();
