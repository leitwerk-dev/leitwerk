// Keep inline LikeC4 views in sync with the Zensical light/dark palette toggle.
(() => {
	const scheme = () =>
		document.body.getAttribute("data-md-color-scheme") === "slate" ? "dark" : "light";
	const sync = () => {
		const value = scheme();
		for (const view of document.querySelectorAll("likec4-view")) {
			if (view.getAttribute("color-scheme") !== value) view.setAttribute("color-scheme", value);
		}
	};
	new MutationObserver(sync).observe(document.body, {
		attributes: true,
		attributeFilter: ["data-md-color-scheme"],
		childList: true,
		subtree: true,
	});
	sync();
})();
