<script lang="ts">
import type { AuthMeResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import { onMount } from "svelte";
import ToastContainer from "./components/ToastContainer.svelte";
import { fetchAuthMeWithRetry } from "./lib/api.js";
import { dispatchLaunchUpdated } from "./lib/launch-updates.js";
import {
	handleWsEvent,
	setCurrentDetailInstanceId,
	setProcessBrowseActive,
} from "./lib/processes.svelte";
import { routeStore } from "./lib/router.svelte";
import { handleToastFrame } from "./lib/toasts.svelte";
import {
	dispatchBrowserUiExtensionWsFrame,
	loadBrowserUiExtensions,
} from "./lib/ui-extensions.svelte.js";
import { connect, onWsEvent } from "./lib/ws.svelte";
import AppShell from "./shell/AppShell.svelte";

let authState = $state<"loading" | "reconnecting" | "authenticated" | "unauthenticated" | "error">(
	"loading",
);
let authError = $state<string | null>(null);
let authMe = $state<AuthMeResponseBody | null>(null);
let realtimeStarted = false;

onMount(() => {
	const controller = new AbortController();
	void fetchAuthMeWithRetry({
		maxAttempts: 120,
		signal: controller.signal,
		onRetry: () => {
			authState = "reconnecting";
			authError = null;
		},
	})
		.then((me) => {
			authMe = me;
			authState = me.actor ? "authenticated" : "unauthenticated";
		})
		.catch((error: unknown) => {
			if (controller.signal.aborted) return;
			authError = error instanceof Error ? error.message : String(error);
			authState = "error";
		});
	return () => controller.abort();
});

$effect(() => {
	const route = $routeStore;
	setCurrentDetailInstanceId(route.page === "process-detail" ? route.params.instanceId : null);
	setProcessBrowseActive(route.page === "processes");
});

$effect(() => {
	if (authState !== "authenticated" || realtimeStarted) {
		return;
	}
	realtimeStarted = true;
	void loadBrowserUiExtensions();
	onWsEvent((frame) => {
		if (dispatchLaunchUpdated(frame)) {
			return;
		}
		if (dispatchBrowserUiExtensionWsFrame(frame)) {
			return;
		}
		if (handleToastFrame(frame)) {
			return;
		}
		handleWsEvent(frame);
	});
	connect();
});
</script>

<ToastContainer />
{#if authState === "loading"}
	<div class="auth-gate" role="status">Loading…</div>
{:else if authState === "reconnecting"}
	<div class="auth-gate" role="status">Backend restarting…</div>
{:else if authState === "unauthenticated"}
	<div class="auth-gate">
		<h1>Sign in required</h1>
		<a class="auth-button" href="/auth/login">Sign in</a>
	</div>
{:else if authState === "error"}
	<div class="auth-gate" role="alert">{authError ?? "Could not load authentication status."}</div>
{:else if authMe?.actor}
	<AppShell route={$routeStore} authEnabled={authMe.authEnabled} actor={authMe.actor} />
{/if}

<style>
	:global(:root) {
		--font-sans: "Public Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont,
			"Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
		--font-display: "Public Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont,
			"Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
		--font-mono: "SF Mono", "Fira Code", ui-monospace, monospace;
		--chronicle-bg: #ffffff;
		--chronicle-sidebar-surface: #f7f8fa;
		--chronicle-panel-surface: #ffffff;
		--chronicle-panel-muted: #f2f4f7;
		--chronicle-card-surface: #ffffff;
		--chronicle-card-surface-strong: #f8fafc;
		--chronicle-border: #d9dee5;
		--chronicle-border-strong: #aeb7c2;
		--chronicle-text: #18212b;
		--chronicle-text-muted: #4c5968;
		--chronicle-text-faint: #687483;
		--chronicle-text-on-accent: #ffffff;
		--chronicle-accent: #2f61b7;
		--chronicle-accent-soft: rgba(47, 97, 183, 0.12);
		--chronicle-link: color-mix(in srgb, var(--chronicle-text) 66%, var(--chronicle-accent) 34%);
		--chronicle-success: #157a52;
		--chronicle-success-surface: color-mix(in srgb, white 90%, var(--chronicle-success) 10%);
		--chronicle-attention: #a76313;
		--chronicle-danger: #a83a32;
		--chronicle-danger-surface: color-mix(in srgb, white 88%, var(--chronicle-danger) 12%);
		--chronicle-danger-surface-soft: color-mix(in srgb, white 92%, var(--chronicle-danger) 8%);
		--chronicle-danger-border: color-mix(in srgb, var(--chronicle-danger) 38%, var(--chronicle-border) 62%);
		--chronicle-danger-text: #7d2d27;
		--chronicle-danger-text-strong: #5f231f;
		--chronicle-code-surface: color-mix(in srgb, var(--chronicle-panel-muted) 76%, white 24%);
		--chronicle-code-inline: color-mix(in srgb, var(--chronicle-panel-muted) 70%, var(--chronicle-border) 30%);
		--chronicle-shadow: 0 18px 40px rgba(24, 33, 43, 0.08);
		--chronicle-shadow-soft: 0 10px 24px rgba(24, 33, 43, 0.055);
		--chronicle-secondary-indent: clamp(24px, 4vw, 48px);
		--type-label: 11px;
		--type-caption: 12px;
		--type-body-sm: 13px;
		--type-body: 14px;
		--type-body-lg: 15px;
		--type-title-sm: 18px;
		--type-title-md: 20px;
		--type-title-lg: 24px;
		--tracking-label: 0.08em;
		--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
		--ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);
		--duration-fast: 160ms;
		--duration-base: 220ms;
		--duration-slow: 320ms;
		--space-2xs: 4px;
		--space-xs: 8px;
		--space-sm: 12px;
		--space-md: 16px;
		--space-lg: 24px;
		--space-xl: 32px;
		--space-2xl: 48px;
		--space-3xl: 64px;
		--space-4xl: 96px;
		--space-1: var(--space-2xs);
		--space-2: var(--space-xs);
		--space-3: var(--space-sm);
		--space-4: var(--space-md);
		--space-5: var(--space-lg);
		--space-6: var(--space-xl);
		--space-7: var(--space-2xl);
		--radius-sm: 10px;
		--radius-md: 14px;
		--radius-lg: 18px;
		--radius-xl: 22px;
	}

	:global(html),
	:global(body) {
		min-height: 100%;
	}

	.auth-gate {
		min-height: 100vh;
		display: grid;
		place-content: center;
		gap: var(--space-md, 16px);
		text-align: center;
		color: var(--chronicle-text, #1f2933);
		background: var(--chronicle-bg, #f4efe7);
	}

	.auth-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 10px 16px;
		border-radius: 999px;
		background: var(--chronicle-accent, #3564d7);
		color: var(--chronicle-text-on-accent, white);
		text-decoration: none;
		font-weight: 700;
	}

	:global(body) {
		margin: 0;
		font-family: var(--font-sans);
		font-size: 16px;
		line-height: 1.5;
		font-kerning: normal;
		text-rendering: optimizeLegibility;
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
		background: var(--chronicle-bg);
		color: var(--chronicle-text);
		color-scheme: light;
	}

	:global(*),
	:global(*::before),
	:global(*::after) {
		box-sizing: border-box;
	}

	:global(button),
	:global(input),
	:global(textarea),
	:global(select) {
		font: inherit;
	}

	:global(:where(a, button, input, textarea, select, summary, [tabindex]):focus-visible) {
		outline: 2px solid var(--chronicle-accent);
		outline-offset: 3px;
	}

	:global(:where(button, input, textarea, select):focus-visible) {
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--chronicle-accent) 16%, transparent 84%);
	}

	:global(::selection) {
		background: color-mix(in srgb, var(--chronicle-accent) 18%, white 82%);
	}

	:global(.sr-only) {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	:global([data-pressable="true"]) {
		transition:
			transform var(--duration-fast) var(--ease-out-quart),
			background var(--duration-fast) var(--ease-out-quart),
			border-color var(--duration-fast) var(--ease-out-quart),
			box-shadow var(--duration-fast) var(--ease-out-quart),
			color var(--duration-fast) var(--ease-out-quart);
	}

	@media (prefers-reduced-motion: reduce) {
		:global(*),
		:global(*::before),
		:global(*::after) {
			animation-duration: 0.01ms !important;
			animation-iteration-count: 1 !important;
			transition-duration: 0.01ms !important;
			scroll-behavior: auto !important;
		}
	}
</style>
