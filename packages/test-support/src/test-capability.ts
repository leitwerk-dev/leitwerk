import type { CapabilityToken } from "@leitwerk-dev/process-sdk";

/** Extension-owned adapter supplied to a harness capability token. @public */
export interface ExtensionTestCapability<T = unknown> {
	/** @public */
	token: CapabilityToken<T>;
	/** @public */
	value: T;
}
