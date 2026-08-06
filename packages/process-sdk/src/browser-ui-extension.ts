import type { WsFrame } from "@leitwerk-dev/protocol";

export interface BrowserUiExtensionContext {
	readonly extensionManifestId: string;
	readonly moduleUrl: string;
	resolveAssetUrl(relativePath: string): string;
}

export interface BrowserUiShortcutRegistration {
	readonly id: string;
	readonly keys: readonly string[];
	readonly label: string;
	handle(event: KeyboardEvent): boolean | undefined;
}

export interface BrowserUiShellIndicatorRegistration {
	readonly id: string;
	readonly label: string;
	mount(host: HTMLElement): undefined | (() => void);
}

export type BrowserUiWsFrameHandler = (frame: WsFrame) => boolean | undefined;

export interface BrowserUiExtensionAPI {
	registerShortcut(registration: BrowserUiShortcutRegistration): () => void;
	registerShellIndicator(registration: BrowserUiShellIndicatorRegistration): () => void;
	onWsFrame(handler: BrowserUiWsFrameHandler): () => void;
}

export interface BrowserUiExtensionModule {
	setup(api: BrowserUiExtensionAPI, context: BrowserUiExtensionContext): void | Promise<void>;
}
