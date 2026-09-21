import { createInMemoryExternalWriteLog as createInMemoryExternalWriteLogImpl } from "./server-extension-test-harness.js";

export { FakeLlmProvider } from "./fakes/fake-llm.js";
export { postImmediateLaunch, postImmediateLaunchRequest } from "./http-launch.js";
export {
	type FixtureModelProviderSet,
	fixtureModelProviders,
} from "./model-provider-fixtures.js";
export {
	createPollingTestExtension,
	createTestServerSetupCapability,
	createToolCollector,
} from "./server-extension-test-harness.js";
/** @internal */
export function createInMemoryExternalWriteLog(): {
	/** @internal */
	records: Array<{
		/** @internal */
		dedupKey: string;
	}>;
	/** @internal */
	hasDedupKey(key: string): boolean;
	/** @internal */
	record(input: {
		/** @internal */
		dedupKey: string;
	}): {
		/** @internal */
		dedupKey: string;
	};
	/** @internal */
	getDedupKeys(): ReadonlySet<string>;
} {
	return createInMemoryExternalWriteLogImpl();
}
