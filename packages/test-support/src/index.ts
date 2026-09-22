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
export function createInMemoryExternalWriteLog(): ReturnType<
	typeof createInMemoryExternalWriteLogImpl
> {
	return createInMemoryExternalWriteLogImpl();
}
