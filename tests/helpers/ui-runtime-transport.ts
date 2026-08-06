import type { UiRuntimeTransportConfig } from "../../packages/ui/src/lib/runtime-config.ts";

const UI_RUNTIME_TRANSPORT_CONFIG_KEY = Symbol.for("leitwerk.uiRuntimeTransportConfig");

type GlobalWithUiRuntimeTransportConfig = typeof globalThis & {
	[UI_RUNTIME_TRANSPORT_CONFIG_KEY]?: UiRuntimeTransportConfig;
};

export function configureUiRuntimeTransport(config: UiRuntimeTransportConfig): void {
	const globalConfig = globalThis as GlobalWithUiRuntimeTransportConfig;
	globalConfig[UI_RUNTIME_TRANSPORT_CONFIG_KEY] = {
		...(globalConfig[UI_RUNTIME_TRANSPORT_CONFIG_KEY] ?? {}),
		...config,
	};
}

export function resetUiRuntimeTransport(): void {
	delete (globalThis as GlobalWithUiRuntimeTransportConfig)[UI_RUNTIME_TRANSPORT_CONFIG_KEY];
}
