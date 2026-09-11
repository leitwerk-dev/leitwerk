<script lang="ts">
import GenericLauncher from "../components/GenericLauncher.svelte";
import PageHeader from "../components/PageHeader.svelte";
import {
	type FutureLaunchSummary,
	fetchLaunchers,
	type ProcessRetryConfig,
	type UiLauncherSummary,
} from "../lib/api.js";
import { isInteractiveTarget, isPlainShortcut, isTextEntryTarget } from "../lib/keyboard.js";
import { keyboardShortcutHelpOpen } from "../lib/keyboard-shortcuts-help.js";
import { queueProcessLaunchNotice } from "../lib/process-launch-notices.svelte";
import { upsertFutureExecution } from "../lib/processes.svelte.js";
import { consumePendingRetryConfig } from "../lib/retry-config.svelte.js";
import {
	buildFutureLaunchPath,
	buildHomePath,
	buildProcessPath,
	navigate,
} from "../lib/router.svelte";
import { wsStore } from "../lib/ws.svelte";
import ProcessFlowDiagram from "./ProcessFlowDiagram.svelte";
import ProcessGallery from "./ProcessGallery.svelte";

interface Props {
	launcherId?: string | null;
}

let { launcherId = undefined }: Props = $props();

let launchers = $state<UiLauncherSummary[]>([]);
let launchersLoading = $state(false);
let launchersError = $state<string | null>(null);
let retryLauncherId = $state<string | null>(null);
let unavailableLauncherId = $state<string | null>(null);
let retryInitialDraft = $state<ProcessRetryConfig | null>(null);
let loadToken = 0;
let observedReconnectCount = $state<number | null>(null);
let launcherShell = $state<HTMLElement | null>(null);
let lastFocusedSetupLauncherId: string | null = null;

const routeLauncherId = $derived(launcherId === undefined ? null : launcherId);
const activeLauncherId = $derived(routeLauncherId ?? retryLauncherId);
const selectedLauncher = $derived(
	activeLauncherId
		? (launchers.find((launcher) => launcher.id === activeLauncherId) ?? null)
		: null,
);

$effect(() => {
	if (launcherId === null) {
		retryLauncherId = null;
		retryInitialDraft = null;
	}
});

$effect(() => {
	if (!routeLauncherId) {
		unavailableLauncherId = null;
		return;
	}
	if (launchers.length === 0 && launchersLoading) {
		return;
	}
	unavailableLauncherId = launchers.some((launcher) => launcher.id === routeLauncherId)
		? null
		: routeLauncherId;
});

$effect(() => {
	const launcher = selectedLauncher;
	if (!launcher) {
		lastFocusedSetupLauncherId = null;
		return;
	}
	if (lastFocusedSetupLauncherId === launcher.id) {
		return;
	}
	lastFocusedSetupLauncherId = launcher.id;
	queueMicrotask(() => {
		if (launcherShell) {
			launcherShell.focus({ preventScroll: true });
		}
	});
});

$effect(() => {
	const reconnectCount = $wsStore.reconnectCount;
	if (observedReconnectCount === reconnectCount) {
		return;
	}
	observedReconnectCount = reconnectCount;
	void loadLaunchers();
});

$effect(() => {
	const shortcutHelpOpen = $keyboardShortcutHelpOpen;

	const handleWindowKeydown = (event: KeyboardEvent) => {
		if (
			event.defaultPrevented ||
			shortcutHelpOpen ||
			!isPlainShortcut(event) ||
			isTextEntryTarget(event.target) ||
			launchers.length === 0
		) {
			return;
		}

		if (selectedLauncher) {
			if (event.key === "Escape") {
				event.preventDefault();
				goBackToGallery();
				return;
			}

			if (event.key === "Enter" && !isInteractiveTarget(event.target)) {
				const firstField = document.querySelector<HTMLElement>(
					'[data-section="launcher-form"] [data-launcher-form-field]',
				);
				if (!firstField) {
					return;
				}
				event.preventDefault();
				firstField.focus();
				firstField.scrollIntoView({ behavior: "smooth", block: "center" });
			}
			return;
		}

		if (
			event.key === "ArrowDown" ||
			event.key === "ArrowRight" ||
			event.key === "ArrowUp" ||
			event.key === "ArrowLeft"
		) {
			const firstCard = document.querySelector<HTMLElement>(
				'[data-section="process-gallery"] [data-process-card-id][tabindex="0"]',
			);
			if (!firstCard) {
				return;
			}
			event.preventDefault();
			firstCard.focus();
		}
	};

	window.addEventListener("keydown", handleWindowKeydown);
	return () => {
		window.removeEventListener("keydown", handleWindowKeydown);
	};
});

async function loadLaunchers() {
	const token = ++loadToken;
	launchersLoading = true;
	launchersError = null;
	try {
		const result = await fetchLaunchers();
		if (token !== loadToken) {
			return;
		}
		launchers = result;

		const pendingRetry = consumePendingRetryConfig();
		if (pendingRetry && result.some((launcher) => launcher.id === pendingRetry.launcherId)) {
			retryLauncherId = pendingRetry.launcherId;
			retryInitialDraft = pendingRetry;
			unavailableLauncherId = null;
			if (!routeLauncherId) {
				navigate(buildHomePath(pendingRetry.launcherId), { replace: true });
			}
		} else {
			retryLauncherId = null;
			retryInitialDraft = null;
			if (pendingRetry) {
				unavailableLauncherId = pendingRetry.launcherId;
			}
		}
	} catch (error) {
		if (token !== loadToken) {
			return;
		}
		launchersError = error instanceof Error ? error.message : "Couldn't load available processes";
	} finally {
		if (token === loadToken) {
			launchersLoading = false;
		}
	}
}

function clearRetryPrefill() {
	retryLauncherId = null;
	retryInitialDraft = null;
}

function openLauncher(nextLauncherId: string) {
	clearRetryPrefill();
	if (launcherId === undefined) {
		retryLauncherId = nextLauncherId;
	}
	navigate(buildHomePath(nextLauncherId));
}

function goBackToGallery() {
	clearRetryPrefill();
	navigate(buildHomePath());
}

function handleLaunched(instanceId: string, launchWarning?: string | null) {
	if (launchWarning) {
		queueProcessLaunchNotice({
			instanceId,
			message: launchWarning,
		});
	}
	navigate(buildProcessPath(instanceId));
}

function handleScheduled(futureExecution: FutureLaunchSummary) {
	upsertFutureExecution(futureExecution);
	navigate(buildFutureLaunchPath(futureExecution.id));
}
</script>

<div class="home-experience" data-page="home">
	{#if selectedLauncher}
		<section
			class="configure-phase"
			data-section="process-configure"
			aria-labelledby="configure-title"
			bind:this={launcherShell}
			tabindex="-1"
		>
			<header class="setup-header">
				<PageHeader
					title={selectedLauncher.card.title ?? selectedLauncher.label}
					titleId="configure-title"
					subtitle={selectedLauncher.card.description ?? selectedLauncher.description}
				>
					{#snippet actions()}
						<button type="button" class="ui-button page-header-button" data-pressable="true" onclick={goBackToGallery}>
							<span aria-hidden="true">←</span>
							Process types
						</button>
					{/snippet}
				</PageHeader>
				<ProcessFlowDiagram launcher={selectedLauncher} mode="happy" expandable={true} />
			</header>

			<div class="home-launcher-shell" data-section="launcher-form">
				{#key selectedLauncher.id}
					<GenericLauncher
						launcher={selectedLauncher}
						initialRelaunchDraft={retryInitialDraft}
						onLaunched={handleLaunched}
						onScheduled={handleScheduled}
					/>
				{/key}
			</div>
		</section>
	{:else}
		<ProcessGallery
			{launchers}
			loading={launchersLoading}
			error={launchersError}
			{unavailableLauncherId}
			onRetry={() => void loadLaunchers()}
			onSelect={openLauncher}
		/>
	{/if}
</div>

<style>
	.home-experience {
		display: flex;
		flex-direction: column;
		width: 100%;
		min-height: 100%;
	}

	.configure-phase {
		display: flex;
		flex-direction: column;
		gap: var(--space-lg);
		min-height: 0;
		padding: var(--space-2xs) 2px var(--space-xl);
		outline: none;
	}

	.setup-header {
		display: grid;
		gap: var(--space-sm);
		max-width: 860px;
	}

	.home-launcher-shell {
		display: flex;
		flex-direction: column;
		min-width: 0;
		max-width: 980px;
	}
</style>
