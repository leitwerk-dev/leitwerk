import type { WsFrame } from "@leitwerk-dev/protocol";

/** @internal */
export interface BrowserUiExtensionContext {
	/** @internal */
	readonly extensionManifestId: string;
	/** @internal */
	readonly moduleUrl: string;
	/** @internal */
	resolveAssetUrl(relativePath: string): string;
}

/** @internal */
export interface BrowserUiShortcutRegistration {
	/** @internal */
	readonly id: string;
	/** @internal */
	readonly keys: readonly string[];
	/** @internal */
	readonly label: string;
	/** @internal */
	handle(event: KeyboardEvent): boolean | undefined;
}

/** @internal */
export interface BrowserUiShellIndicatorRegistration {
	/** @internal */
	readonly id: string;
	/** @internal */
	readonly label: string;
	/** @internal */
	mount(host: HTMLElement): undefined | (() => void);
}

/** @internal */
export type BrowserUiWsFrameHandler = (frame: WsFrame) => boolean | undefined;

/** @internal */
export interface BrowserUiExtensionAPI {
	/** @internal */
	registerShortcut(registration: BrowserUiShortcutRegistration): () => void;
	/** @internal */
	registerShellIndicator(registration: BrowserUiShellIndicatorRegistration): () => void;
	/** @internal */
	onWsFrame(handler: BrowserUiWsFrameHandler): () => void;
}

/** @internal */
export interface BrowserUiExtensionModule {
	/** @internal */
	setup(api: BrowserUiExtensionAPI, context: BrowserUiExtensionContext): void | Promise<void>;
}
