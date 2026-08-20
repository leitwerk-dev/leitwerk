<script lang="ts">
import type { Actor } from "@leitwerk-dev/domain";
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
	<Sidebar currentRoute={route} {authEnabled} {actor} />
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

		.app-shell > :global(.sidebar) {
			order: 2;
		}

		.content-region {
			order: 1;
			padding: 14px;
			overflow: visible;
		}
	}
</style>
