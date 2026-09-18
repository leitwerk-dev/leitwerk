import escapeHtml from "escape-html";

/** @internal */
export interface LeafOutcomeRendererMeta {
	/** @internal */
	instanceId: string;
	/** @internal */
	snapshotId: string;
	/** @internal */
	leafEntryId: string;
	/** @internal */
	turnRecordId: string | null;
	/** @internal */
	createdAt: string;
	/** @internal */
	schemaVersion: number | null;
	/** @internal */
	lifecycleStatus?: string | null;
	/** @internal */
	selectedTurnId?: string | null;
	/** @internal */
	processUpdatedAt?: string | null;
}

/** @internal */
export interface LeafOutcomeRendererRuntime {
	/** @internal */
	apiVersion: 1;
	/** @internal */
	markdown: {
		/** @internal */
		render(markdown: string): string;
	};
	/** @internal */
	server: {
		/** @internal */
		resolveUrl(path: string): string;
		/** @internal */
		fetch(path: string, init?: RequestInit): Promise<Response>;
	};
	/** @internal */
	formatRelativeTime(iso: string): string;
}

/** @internal */
export function escapeLeafOutcomeHtml(value: string): string {
	return escapeHtml(value);
}

/** @internal */
export function normalizeLeafOutcomeOptionalText(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/** @internal */
const LeafOutcomeElementBase = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

/** @internal */
export abstract class LeafOutcomeCustomElement<TPayload> extends LeafOutcomeElementBase {
	/** @internal */
	protected readonly shadowRootRef: ShadowRoot;
	private payloadValue: TPayload | null = null;
	private runtimeValue: LeafOutcomeRendererRuntime | null = null;
	private metaValue: LeafOutcomeRendererMeta | null = null;
	private signaledReady = false;

	/** @internal */
	constructor() {
		super();
		this.shadowRootRef = this.attachShadow({ mode: "open" });
	}

	/** @internal */
	set payload(value: TPayload | null) {
		this.payloadValue = value;
		this.renderContent();
	}

	/** @internal */
	get payload(): TPayload | null {
		return this.payloadValue;
	}

	/** @internal */
	set runtime(value: LeafOutcomeRendererRuntime | null) {
		this.runtimeValue = value;
		this.renderContent();
	}

	/** @internal */
	get runtime(): LeafOutcomeRendererRuntime | null {
		return this.runtimeValue;
	}

	/** @internal */
	set meta(value: LeafOutcomeRendererMeta | null) {
		this.metaValue = value;
		this.renderContent();
	}

	/** @internal */
	get meta(): LeafOutcomeRendererMeta | null {
		return this.metaValue;
	}

	/** @internal */
	connectedCallback(): void {
		this.renderContent();
	}

	/** @internal */
	protected canRender(): this is this & { runtime: LeafOutcomeRendererRuntime } {
		return this.isConnected && this.runtimeValue !== null;
	}

	/** @internal */
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

	/** @internal */
	protected emitError(code: string, message: string): void {
		this.dispatchEvent(
			new CustomEvent("o2-leaf-outcome-error", {
				bubbles: true,
				composed: true,
				detail: { code, message },
			}),
		);
	}

	/** @internal */
	protected abstract renderContent(): void;
}
