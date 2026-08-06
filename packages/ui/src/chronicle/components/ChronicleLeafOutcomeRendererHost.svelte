<script lang="ts">
import { onDestroy } from "svelte";
import * as v from "valibot";
import type { ChronicleLeafOutcomeItem } from "../lib/chronicle-projection.js";
import { loadLeafOutcomeRenderer } from "../lib/leaf-outcome-loader.js";
import {
	getLeafOutcomeRendererRuntime,
	type LeafOutcomeRendererMeta,
} from "../lib/leaf-outcome-runtime.js";
import ChronicleMarkdown from "./ChronicleMarkdown.svelte";

interface Props {
	instanceId: string;
	snapshotId: string;
	leafEntryId: string;
	turnRecordId: string | null;
	createdAt: string;
	schemaVersion: number | null;
	rendererId: string | null;
	props: ChronicleLeafOutcomeItem["props"];
	fallbackMarkdown: string | null;
	processLifecycleStatus?: string | null;
	processSelectedTurnId?: string | null;
	processUpdatedAt?: string | null;
}

type RendererState =
	| { kind: "loading" }
	| { kind: "ready"; tagName: string }
	| { kind: "error"; code: string; message: string };

interface LeafOutcomeRendererElement extends HTMLElement {
	payload?: Record<string, unknown>;
	runtime?: ReturnType<typeof getLeafOutcomeRendererRuntime>;
	meta?: LeafOutcomeRendererMeta;
}

let {
	instanceId,
	snapshotId,
	leafEntryId,
	turnRecordId,
	createdAt,
	schemaVersion,
	rendererId,
	props,
	fallbackMarkdown,
	processLifecycleStatus = null,
	processSelectedTurnId = null,
	processUpdatedAt = null,
}: Props = $props();
let mountTarget: HTMLDivElement | null = null;
let rendererState = $state<RendererState>({ kind: "loading" });
let loadingReservedHeightPx = $state<number | null>(null);
let mountedElement = $state<LeafOutcomeRendererElement | null>(null);

const readyTimeoutMs = 1_000;
const runtime = getLeafOutcomeRendererRuntime();
const unknownRecordSchema = v.pipe(
	v.unknown(),
	v.check(
		(value) => typeof value === "object" && value !== null && !Array.isArray(value),
		"Expected object",
	),
	v.record(v.string(), v.unknown()),
);
const hasValidRendererPayload = $derived(v.safeParse(unknownRecordSchema, props).success);

let readyTimeout: ReturnType<typeof setTimeout> | null = null;
let removeMountedListeners = () => {};
let activeMountedElement: LeafOutcomeRendererElement | null = null;
let activeMountedRendererId: string | null = null;
let activeMountedTarget: HTMLDivElement | null = null;

function readRendererErrorDetail(event: Event): { code: string; message: string } {
	const detail = event instanceof CustomEvent ? event.detail : null;
	const parsedDetail = v.safeParse(unknownRecordSchema, detail);
	if (!parsedDetail.success) {
		return {
			code: "renderer_error",
			message: "Renderer reported an unspecified error",
		};
	}
	return {
		code:
			typeof parsedDetail.output.code === "string" ? parsedDetail.output.code : "renderer_error",
		message:
			typeof parsedDetail.output.message === "string"
				? parsedDetail.output.message
				: "Renderer reported an unspecified error",
	};
}

function clearReadyTimeout() {
	if (!readyTimeout) {
		return;
	}
	clearTimeout(readyTimeout);
	readyTimeout = null;
}

function clearMountedRenderer(target: HTMLDivElement | null = activeMountedTarget) {
	clearReadyTimeout();
	removeMountedListeners();
	removeMountedListeners = () => {};
	if (target) {
		target.replaceChildren();
	}
	mountedElement = null;
	activeMountedElement = null;
	activeMountedRendererId = null;
	activeMountedTarget = null;
}

function buildRendererMeta(): LeafOutcomeRendererMeta {
	return {
		instanceId,
		snapshotId,
		leafEntryId,
		turnRecordId,
		createdAt,
		schemaVersion,
		lifecycleStatus: processLifecycleStatus,
		selectedTurnId: processSelectedTurnId,
		processUpdatedAt,
	};
}

$effect(() => {
	const target = mountTarget;
	const nextRendererId = rendererId;
	const payloadIsValid = hasValidRendererPayload;
	if (!target) {
		return;
	}

	if (!nextRendererId) {
		loadingReservedHeightPx = null;
		rendererState = {
			kind: "error",
			code: "missing_renderer_id",
			message: "Snapshot did not declare a rendererId for runtime loading",
		};
		clearMountedRenderer(target);
		return;
	}

	if (!payloadIsValid) {
		loadingReservedHeightPx = null;
		rendererState = {
			kind: "error",
			code: "invalid_renderer_payload",
			message: "Snapshot payload is missing or is not an object",
		};
		clearMountedRenderer(target);
		return;
	}

	if (
		activeMountedElement &&
		activeMountedRendererId === nextRendererId &&
		activeMountedTarget === target
	) {
		return;
	}

	let disposed = false;
	const currentHeight = target.offsetHeight;
	loadingReservedHeightPx = currentHeight > 0 ? currentHeight : null;
	rendererState = { kind: "loading" };
	clearMountedRenderer(target);

	void (async () => {
		const loaded = await loadLeafOutcomeRenderer(nextRendererId);
		if (disposed) {
			return;
		}
		if (!loaded.ok) {
			loadingReservedHeightPx = null;
			rendererState = {
				kind: "error",
				code: loaded.code,
				message: loaded.message,
			};
			clearMountedRenderer(target);
			return;
		}

		const element = document.createElement(loaded.descriptor.tagName) as LeafOutcomeRendererElement;
		element.style.display = "block";

		const handleReady = () => {
			if (disposed || activeMountedElement !== element) {
				return;
			}
			clearReadyTimeout();
			loadingReservedHeightPx = null;
			rendererState = { kind: "ready", tagName: loaded.descriptor.tagName };
		};
		const handleError = (event: Event) => {
			if (disposed || activeMountedElement !== element) {
				return;
			}
			const detail = readRendererErrorDetail(event);
			loadingReservedHeightPx = null;
			rendererState = {
				kind: "error",
				code: detail.code,
				message: detail.message,
			};
			clearMountedRenderer(target);
		};

		element.addEventListener("o2-leaf-outcome-ready", handleReady as EventListener);
		element.addEventListener("o2-leaf-outcome-error", handleError as EventListener);
		removeMountedListeners = () => {
			element.removeEventListener("o2-leaf-outcome-ready", handleReady as EventListener);
			element.removeEventListener("o2-leaf-outcome-error", handleError as EventListener);
		};

		element.payload = props;
		element.runtime = runtime;
		element.meta = buildRendererMeta();
		activeMountedElement = element;
		activeMountedRendererId = nextRendererId;
		activeMountedTarget = target;
		mountedElement = element;
		readyTimeout = setTimeout(() => {
			if (disposed || activeMountedElement !== element) {
				return;
			}
			loadingReservedHeightPx = null;
			rendererState = {
				kind: "error",
				code: "renderer_did_not_signal_readiness",
				message: "Renderer mounted but did not signal readiness in time",
			};
			clearMountedRenderer(target);
		}, readyTimeoutMs);
		target.replaceChildren(element);
	})();

	return () => {
		disposed = true;
	};
});

$effect(() => {
	const element = mountedElement;
	if (!element || !hasValidRendererPayload) {
		return;
	}
	const payload = props;
	element.payload = payload;
	element.runtime = runtime;
	element.meta = buildRendererMeta();
});

onDestroy(() => {
	clearMountedRenderer();
});
</script>

<div
	class="renderer-host"
	data-role="leaf-outcome-renderer-host"
	data-renderer-state={rendererState.kind}
	style:min-height={rendererState.kind === "loading" && loadingReservedHeightPx
		? `${loadingReservedHeightPx}px`
		: undefined}
>
	{#if rendererState.kind === "loading" && !loadingReservedHeightPx}
		<div class="renderer-loading" role="status">Loading result preview…</div>
	{/if}

	<div class="renderer-mount" bind:this={mountTarget}></div>

	{#if rendererState.kind === "error"}
		<div class="renderer-warning" data-warning-code={rendererState.code}>
			<div class="renderer-warning-header">
				<div>
					<p class="renderer-warning-title">Result preview unavailable</p>
					<p class="renderer-warning-copy">
						{fallbackMarkdown
							? "We couldn't load the result preview. The fallback details are shown below."
							: "We couldn't load the result preview."}
					</p>
				</div>
			</div>
			<details class="renderer-warning-technical">
				<summary>Technical details</summary>
				<dl class="renderer-warning-details">
					<dt>Renderer</dt>
					<dd>{rendererId ?? "Not available"}</dd>
					<dt>Snapshot</dt>
					<dd>{snapshotId}</dd>
					<dt>Message</dt>
					<dd>{rendererState.message}</dd>
					<dt>Code</dt>
					<dd>{rendererState.code}</dd>
				</dl>
			</details>
			{#if fallbackMarkdown}
				<ChronicleMarkdown markdown={fallbackMarkdown} className="renderer-fallback-markdown" />
			{/if}
		</div>
	{/if}
</div>

<style>
	.renderer-host {
		display: block;
		width: 100%;
		min-width: 0;
		--o2-surface: var(--chronicle-card-surface);
		--o2-surface-muted: var(--chronicle-panel-muted);
		--o2-border: var(--chronicle-border);
		--o2-text: var(--chronicle-text);
		--o2-text-muted: var(--chronicle-text-muted);
		--o2-accent: var(--chronicle-accent);
		--o2-radius-sm: 12px;
		--o2-radius-md: 18px;
		--o2-space-xs: 4px;
		--o2-space-sm: 8px;
		--o2-space-md: 12px;
		--o2-space-lg: 18px;
	}

	.renderer-mount {
		display: block;
		width: 100%;
		min-width: 0;
	}

	.renderer-loading {
		padding: 14px 16px;
		border-radius: 14px;
		background: color-mix(in srgb, var(--chronicle-panel-muted) 88%, white 12%);
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 78%, white 22%);
		font-size: var(--type-body-sm);
		color: var(--chronicle-text-muted);
	}

	.renderer-warning {
		padding: 16px 18px;
		border-radius: 18px;
		border: 1px solid var(--chronicle-danger-border);
		background: var(--chronicle-danger-surface-soft);
	}

	.renderer-warning-header {
		display: flex;
		justify-content: space-between;
		gap: 16px;
	}

	.renderer-warning-title {
		margin: 0 0 6px;
		font-size: var(--type-caption);
		font-weight: 700;
		letter-spacing: var(--tracking-label);
		text-transform: uppercase;
		color: var(--chronicle-danger-text);
	}

	.renderer-warning-copy {
		margin: 0;
		max-width: 72ch;
		font-size: var(--type-body);
		line-height: 1.6;
		color: var(--chronicle-danger-text-strong);
	}

	.renderer-warning-technical {
		margin-top: 12px;
	}

	.renderer-warning-technical summary {
		cursor: pointer;
		font-size: var(--type-caption);
		font-weight: 600;
		color: var(--chronicle-text-muted);
	}

	.renderer-warning-details {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 6px 12px;
		margin: 10px 0 0;
		font-size: var(--type-caption);
		color: var(--chronicle-text-muted);
	}

	.renderer-warning-details dt,
	.renderer-warning-details dd {
		margin: 0;
	}

	.renderer-warning-details dd {
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		color: var(--chronicle-text);
	}

	:global(.chronicle-markdown.renderer-fallback-markdown) {
		margin-top: 12px;
	}
</style>
