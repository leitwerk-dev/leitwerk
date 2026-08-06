export { createCompactProcessDetailFixtureFactory } from "./compact-process-detail-fixture.js";
export { FakeGitOps, type RepoTemplate } from "./fakes/fake-git-ops.js";
export { FakeLlmProvider, type LlmResponse } from "./fakes/fake-llm.js";
export {
	createInProcessWorkerSpawn,
	type InProcessWorkerSpawnOptions,
} from "./in-process-worker.js";
export {
	createIntegrationHarness,
	type IntegrationHarness,
	type IntegrationHarnessOptions,
} from "./integration-harness.js";
export { waitForValue } from "./polling.js";
export {
	createInMemoryExternalWriteLog,
	createTestServerSetupCapability,
	type InMemoryExternalWriteLog,
	type ServerExtensionTestHarness,
	setupServerExtensionTest,
} from "./server-extension-test-harness.js";
export { createTestApp, type TestApp, type TestAppOptions } from "./test-app.js";
export {
	baseEnvelope,
	flushAsyncWork,
	testConfigSnapshot,
} from "./worker-testing/ipc-harness.js";
export {
	createSchemaDrivenStubPiFactory,
	createSchemaDrivenToolCallScriptResolver,
	synthesizeStubArgValue,
	synthesizeStubToolArgs,
} from "./worker-testing/schema-driven-stub-pi.js";
export {
	createStubToolScriptController,
	type StubToolScriptController,
} from "./worker-testing/stub-pi-controls.js";
export {
	StubPiTreeHandle,
	StubPiTreeHandleFactory,
	type StubPiTreeHandleFactoryOptions,
	type StubToolCallScriptCall,
	type StubToolCallScriptItem,
	type StubToolCallScriptResolver,
	type StubToolCallScriptResolverContext,
} from "./worker-testing/stub-pi-tree-handle.js";
