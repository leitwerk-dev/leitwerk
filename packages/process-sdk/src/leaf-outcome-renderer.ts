import escapeHtml from "escape-html";

export interface LeafOutcomeRendererMeta {
	instanceId: string;
	snapshotId: string;
	leafEntryId: string;
	turnRecordId: string | null;
	createdAt: string;
	schemaVersion: number | null;
	lifecycleStatus?: string | null;
	selectedTurnId?: string | null;
	processUpdatedAt?: string | null;
}

export interface LeafOutcomeRendererRuntime {
	apiVersion: 1;
	markdown: {
		render(markdown: string): string;
	};
	server: {
		resolveUrl(path: string): string;
		fetch(path: string, init?: RequestInit): Promise<Response>;
	};
	formatRelativeTime(iso: string): string;
}

export function escapeLeafOutcomeHtml(value: string): string {
	return escapeHtml(value);
}

export function normalizeLeafOutcomeOptionalText(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

const LeafOutcomeElementBase = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

export abstract class LeafOutcomeCustomElement<TPayload> extends LeafOutcomeElementBase {
	protected readonly shadowRootRef: ShadowRoot;
	private payloadValue: TPayload | null = null;
	private runtimeValue: LeafOutcomeRendererRuntime | null = null;
	private metaValue: LeafOutcomeRendererMeta | null = null;
	private signaledReady = false;

	constructor() {
		super();
		this.shadowRootRef = this.attachShadow({ mode: "open" });
	}

	set payload(value: TPayload | null) {
		this.payloadValue = value;
		this.renderContent();
	}

	get payload(): TPayload | null {
		return this.payloadValue;
	}

	set runtime(value: LeafOutcomeRendererRuntime | null) {
		this.runtimeValue = value;
		this.renderContent();
	}

	get runtime(): LeafOutcomeRendererRuntime | null {
		return this.runtimeValue;
	}

	set meta(value: LeafOutcomeRendererMeta | null) {
		this.metaValue = value;
		this.renderContent();
	}

	get meta(): LeafOutcomeRendererMeta | null {
		return this.metaValue;
	}

	connectedCallback(): void {
		this.renderContent();
	}

	protected canRender(): this is this & { runtime: LeafOutcomeRendererRuntime } {
		return this.isConnected && this.runtimeValue !== null;
	}

	protected emitReady(): void {
		if (this.signaledReady) {
			return;
		}
		this.signaledReady = true;
		this.dispatchEvent(
			new CustomEvent("o2-leaf-outcome-ready", {
				bubbles: true,
				composed: true,
			}),
		);
	}

	protected emitError(code: string, message: string): void {
		this.dispatchEvent(
			new CustomEvent("o2-leaf-outcome-error", {
				bubbles: true,
				composed: true,
				detail: { code, message },
			}),
		);
	}

	protected abstract renderContent(): void;
}
