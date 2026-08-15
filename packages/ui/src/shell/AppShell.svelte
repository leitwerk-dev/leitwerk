<script lang="ts">
import type { Actor } from "@leitwerk-dev/domain";
import { tick } from "svelte";
import BrowserUiExtensionIndicatorHost from "../components/BrowserUiExtensionIndicatorHost.svelte";
import KeyboardShortcutsModal from "../components/KeyboardShortcutsModal.svelte";
import { isPlainShortcut, isTextEntryTarget } from "../lib/keyboard.js";
import {
	closeKeyboardShortcutHelp,
	type KeyboardShortcutItem,
	keyboardShortcutHelpOpen,
	toggleKeyboardShortcutHelp,
} from "../lib/keyboard-shortcuts-help.js";
import type { Route } from "../lib/router.svelte";
import { buildHomePath, followLink } from "../lib/router.svelte.js";
import {
	browserUiExtensionShellIndicators,
	browserUiExtensionShortcutHelpItems,
	dispatchBrowserUiExtensionShortcut,
} from "../lib/ui-extensions.svelte.js";
import RouteLoadBoundary from "./RouteLoadBoundary.svelte";
import Sidebar from "./Sidebar.svelte";

interface Props {
	route: Route;
	authEnabled: boolean;
	actor: Actor;
}

const homeShortcutItems: readonly KeyboardShortcutItem[] = [
	{ keys: ["←", "↑", "↓", "→"], label: "Navigate process types" },
	{ keys: ["Enter", "Space"], label: "Open setup / jump into the setup form" },
	{ keys: ["Esc"], label: "Back to process types" },
	{ keys: ["?"], label: "Toggle shortcuts" },
];

const browseShortcutItems: readonly KeyboardShortcutItem[] = [
	{ keys: ["/"], label: "Focus process search" },
	{ keys: ["?"], label: "Toggle shortcuts" },
];

const watcherShortcutItems: readonly KeyboardShortcutItem[] = [
	{ keys: ["?"], label: "Toggle shortcuts" },
];

const processShortcutItems: readonly KeyboardShortcutItem[] = [
	{ keys: ["↑", "↓"], label: "Move between steps" },
	{ keys: ["."], label: "Jump to latest" },
	{ keys: ["i"], label: "Toggle process info" },
	{ keys: ["r"], label: "Open reasoning details" },
	{ keys: ["?"], label: "Toggle shortcuts" },
];

let { route, authEnabled, actor }: Props = $props();

const mobileSidebarQuery = "(max-width: 960px)";
const homePath = buildHomePath();
let mobileLayout = $state(false);
let mobileSidebarOpen = $state(false);
let mobileMenuButton = $state<HTMLButtonElement | null>(null);
let mobileDrawer = $state<HTMLDivElement | null>(null);
let observedRouteKey = $state<string | null>(null);

function closeMobileSidebar(options: { restoreFocus?: boolean } = {}) {
	if (!mobileSidebarOpen) return;
	mobileSidebarOpen = false;
	if (options.restoreFocus !== false) {
		void tick().then(() => mobileMenuButton?.focus());
	}
}

async function openMobileSidebar() {
	mobileSidebarOpen = true;
	await tick();
	mobileDrawer?.querySelector<HTMLButtonElement>('[data-action="close-mobile-sidebar"]')?.focus();
}

$effect(() => {
	const media =
		typeof window.matchMedia === "function" ? window.matchMedia(mobileSidebarQuery) : null;
	const updateMobileLayout = () => {
		mobileLayout = media?.matches ?? window.innerWidth <= 960;
		if (!mobileLayout) closeMobileSidebar({ restoreFocus: false });
	};
	updateMobileLayout();
	if (media) {
		media.addEventListener("change", updateMobileLayout);
		return () => media.removeEventListener("change", updateMobileLayout);
	}
	window.addEventListener("resize", updateMobileLayout);
	return () => window.removeEventListener("resize", updateMobileLayout);
});

$effect(() => {
	const routeKey = JSON.stringify(route);
	if (observedRouteKey !== null && observedRouteKey !== routeKey) {
		closeMobileSidebar({ restoreFocus: false });
	}
	observedRouteKey = routeKey;
});

$effect(() => {
	if (!mobileLayout || !mobileSidebarOpen) return;

	const previousOverflow = document.body.style.overflow;
	document.body.style.overflow = "hidden";
	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			closeMobileSidebar();
			return;
		}
		if (event.key !== "Tab" || !mobileDrawer) return;

		const focusable = Array.from(
			mobileDrawer.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
			),
		).filter((element) => element.offsetParent !== null);
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};
	document.addEventListener("keydown", handleKeydown);
	return () => {
		document.body.style.overflow = previousOverflow;
		document.removeEventListener("keydown", handleKeydown);
	};
});

const shortcutHelpTitle = $derived.by(() => {
	if (route.page === "home") {
		return "Start a process";
	}
	if (route.page === "processes") {
		return "All processes";
	}
	if (route.page === "watchers") {
		return "Watchers";
	}
	if (route.page === "skills") {
		return "Skills";
	}
	if (route.page === "future-launch-detail") {
		return "Scheduled launch";
	}
	return "Process detail";
});
const shortcutHelpDescription = $derived.by(() => {
	if (route.page === "home") {
		return "Quick reference for choosing a process type, opening setup, and returning to the process gallery.";
	}
	if (route.page === "processes") {
		return "Quick reference for searching and filtering process records.";
	}
	if (route.page === "watchers") {
		return "Quick reference for reviewing configured watcher registrations.";
	}
	if (route.page === "skills") {
		return "Quick reference for browsing, registering, and maintaining skills.";
	}
	if (route.page === "future-launch-detail") {
		return "Quick reference for reviewing or editing a scheduled launch.";
	}
	return "Quick reference for moving through the turn rail and returning to the latest activity.";
});
const shortcutHelpItems = $derived.by(() => {
	const extensionItems = $browserUiExtensionShortcutHelpItems;
	if (route.page === "home") {
		return [...homeShortcutItems, ...extensionItems];
	}
	if (route.page === "processes") {
		return [...browseShortcutItems, ...extensionItems];
	}
	if (route.page === "watchers" || route.page === "skills") {
		return [...watcherShortcutItems, ...extensionItems];
	}
	if (route.page === "future-launch-detail") {
		return [...watcherShortcutItems, ...extensionItems];
	}
	return [...processShortcutItems, ...extensionItems];
});

$effect(() => {
	const helpOpen = $keyboardShortcutHelpOpen;

	const handleWindowKeydown = (event: KeyboardEvent) => {
		if (event.defaultPrevented || !isPlainShortcut(event)) {
			return;
		}

		if (event.key === "Escape") {
			if (!helpOpen) {
				return;
			}
			event.preventDefault();
			closeKeyboardShortcutHelp();
			return;
		}

		if (isTextEntryTarget(event.target)) {
			return;
		}

		if (event.key === "?") {
			event.preventDefault();
			toggleKeyboardShortcutHelp();
			return;
		}

		if (dispatchBrowserUiExtensionShortcut(event)) {
			event.preventDefault();
		}
	};

	window.addEventListener("keydown", handleWindowKeydown);
	return () => {
		window.removeEventListener("keydown", handleWindowKeydown);
	};
});
</script>

<div class="app-shell" data-shell="app">
	<header class="mobile-shell-bar">
		<a href={homePath} class="mobile-brand" onclick={(event) => followLink(event, homePath)}>
			Leitwerk
		</a>
		<button
			bind:this={mobileMenuButton}
			type="button"
			class="mobile-menu-button"
			data-action="open-mobile-sidebar"
			aria-label="Open navigation"
			aria-controls="mobile-sidebar-drawer"
			aria-expanded={mobileSidebarOpen}
			onclick={openMobileSidebar}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path d="M4 7h16M4 12h16M4 17h16" />
			</svg>
		</button>
	</header>
	<button
		type="button"
		class="mobile-drawer-backdrop"
		class:is-open={mobileSidebarOpen}
		aria-label="Close navigation"
		aria-hidden={!mobileSidebarOpen}
		tabindex="-1"
		onclick={() => closeMobileSidebar()}
	></button>
	<div
		bind:this={mobileDrawer}
		id="mobile-sidebar-drawer"
		class="mobile-sidebar-drawer"
		class:is-open={mobileSidebarOpen}
		data-mobile-sidebar="drawer"
		data-mobile-sidebar-state={mobileSidebarOpen ? "open" : "closed"}
		role={mobileLayout ? "dialog" : undefined}
		aria-modal={mobileLayout ? "true" : undefined}
		aria-label={mobileLayout ? "Navigation" : undefined}
		inert={mobileLayout && !mobileSidebarOpen}
	>
		<button
			type="button"
			class="mobile-drawer-close"
			data-action="close-mobile-sidebar"
			aria-label="Close navigation"
			onclick={() => closeMobileSidebar()}
		>
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path d="m6 6 12 12M18 6 6 18" />
			</svg>
		</button>
		<Sidebar currentRoute={route} {authEnabled} {actor} />
	</div>
	{#if $browserUiExtensionShellIndicators.length > 0}
		<div class="browser-ui-extension-indicators" data-section="browser-ui-extension-indicators">
			{#each $browserUiExtensionShellIndicators as indicator (`${indicator.extensionManifestId}:${indicator.id}`)}
				<BrowserUiExtensionIndicatorHost {indicator} />
			{/each}
		</div>
	{/if}
	<main class="content-region">
		{#if route.page === "home"}
			<RouteLoadBoundary
				load={import("../pages/HomePage.svelte")}
				props={{ launcherId: route.params.launcher ?? null }}
			/>
		{:else if route.page === "processes"}
			<RouteLoadBoundary load={import("../pages/ProcessesPage.svelte")} props={{}} />
		{:else if route.page === "watchers"}
			<RouteLoadBoundary load={import("../pages/WatchersPage.svelte")} props={{}} />
		{:else if route.page === "skills"}
			<RouteLoadBoundary
				load={import("../pages/SkillsPage.svelte")}
				props={{
					detailKind: route.params.detailKind ?? null,
					repositoryId: route.params.repositoryId ?? null,
					skillId: route.params.skillId ?? null,
				}}
			/>
		{:else if route.page === "future-launch-detail"}
			<RouteLoadBoundary
				load={import("../pages/FutureLaunchDetailPage.svelte")}
				props={{ futureExecutionId: route.params.futureExecutionId }}
			/>
		{:else if route.page === "process-detail"}
			<RouteLoadBoundary
				load={import("../pages/ProcessDetailPage.svelte")}
				props={{ instanceId: route.params.instanceId }}
				viewportMode="workspace"
			/>
		{/if}
	</main>
</div>

<KeyboardShortcutsModal
	open={$keyboardShortcutHelpOpen}
	title={shortcutHelpTitle}
	description={shortcutHelpDescription}
	items={shortcutHelpItems}
	onClose={closeKeyboardShortcutHelp}
/>

<style>
	.mobile-shell-bar,
	.mobile-drawer-backdrop,
	.mobile-drawer-close {
		display: none;
	}

	.mobile-sidebar-drawer {
		display: contents;
	}

	.app-shell {
		display: flex;
		align-items: stretch;
		width: 100%;
		min-height: 100dvh;
		height: 100dvh;
		background: var(--chronicle-bg);
		overflow: visible;
	}

	.browser-ui-extension-indicators {
		position: fixed;
		right: 18px;
		bottom: 18px;
		z-index: 30;
		display: grid;
		gap: 8px;
		pointer-events: none;
	}

	.browser-ui-extension-indicators :global(*) {
		pointer-events: auto;
	}

	.content-region {
		flex: 1 1 auto;
		display: flex;
		min-width: 0;
		min-height: 0;
		padding: clamp(var(--space-sm), 1.8vw, var(--space-lg)) clamp(var(--space-md), 2vw, var(--space-xl)) clamp(var(--space-lg), 2.6vw, var(--space-xl));
		overflow: visible;
	}

	.content-region > :global(*) {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
	}

	@media (max-width: 960px) {
		.app-shell {
			flex-direction: column;
			height: auto;
			overflow: visible;
		}

		.mobile-shell-bar {
			position: sticky;
			top: 0;
			z-index: 40;
			display: flex;
			align-items: center;
			justify-content: space-between;
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) max(14px, env(safe-area-inset-right)) 0 max(14px, env(safe-area-inset-left));
			border-bottom: 1px solid color-mix(in srgb, var(--chronicle-border) 88%, white 12%);
			background: color-mix(in srgb, var(--chronicle-sidebar-surface) 96%, white 4%);
		}

		.mobile-brand {
			color: var(--chronicle-text);
			font-size: var(--type-title-sm);
			font-weight: 750;
			letter-spacing: -0.015em;
			text-decoration: none;
		}

		.mobile-menu-button,
		.mobile-drawer-close {
			display: inline-grid;
			place-items: center;
			width: 44px;
			height: 44px;
			padding: 0;
			border: 1px solid var(--chronicle-border);
			border-radius: var(--radius-sm);
			background: var(--chronicle-card-surface);
			color: var(--chronicle-text);
			cursor: pointer;
		}

		.mobile-menu-button svg,
		.mobile-drawer-close svg {
			width: 21px;
			height: 21px;
			fill: none;
			stroke: currentColor;
			stroke-linecap: round;
			stroke-width: 1.8;
		}

		.mobile-menu-button:focus-visible,
		.mobile-drawer-close:focus-visible,
		.mobile-brand:focus-visible {
			outline: 2px solid var(--chronicle-accent);
			outline-offset: 2px;
		}

		.mobile-drawer-backdrop {
			position: fixed;
			inset: 0;
			z-index: 50;
			display: block;
			padding: 0;
			border: 0;
			background: rgba(24, 33, 43, 0.38);
			opacity: 0;
			pointer-events: none;
			transition: opacity 180ms ease-out;
		}

		.mobile-drawer-backdrop.is-open {
			opacity: 1;
			pointer-events: auto;
		}

		.mobile-sidebar-drawer {
			position: fixed;
			inset: 0 auto 0 0;
			z-index: 60;
			display: block;
			width: min(88vw, 360px);
			max-width: 100%;
			background: var(--chronicle-sidebar-surface);
			box-shadow: 18px 0 40px rgba(24, 33, 43, 0.14);
			transform: translateX(-102%);
			visibility: hidden;
			transition:
				transform 220ms cubic-bezier(0.22, 1, 0.36, 1),
				visibility 0s linear 220ms;
		}

		.mobile-sidebar-drawer.is-open {
			transform: translateX(0);
			visibility: visible;
			transition-delay: 0s;
		}

		.mobile-drawer-close {
			position: absolute;
			top: max(10px, env(safe-area-inset-top));
			right: max(10px, env(safe-area-inset-right));
			z-index: 2;
		}

		.content-region {
			padding: 14px;
			overflow: visible;
		}
	}

	@media (max-width: 960px) and (prefers-reduced-motion: reduce) {
		.mobile-drawer-backdrop,
		.mobile-sidebar-drawer {
			transition: none;
		}
	}
</style>
