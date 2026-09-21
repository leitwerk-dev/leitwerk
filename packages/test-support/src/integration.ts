export {
	type AcceptedTurnFixture,
	type AcceptedTurnReference,
	createExtensionIntegrationHarness,
	type ExtensionIntegrationHarness,
	type ExtensionIntegrationHarnessOptions,
	type ExtensionIntegrationProcess,
	type ExtensionIntegrationSnapshot,
	type ExtensionTestRequest,
	type ExtensionTestResponse,
	type IntegrationAnnotationObservation,
	type IntegrationApprovalObservation,
	type IntegrationEventObservation,
	type IntegrationInputObservation,
	type IntegrationLeafObservation,
	type IntegrationProcessInput,
	type IntegrationPromptObservation,
	type IntegrationToolCall,
	type IntegrationTurnResult,
	type IntegrationTurnScript,
} from "./extension-integration-harness.js";
export {
	createIntegrationHarness,
	createPersistentIntegrationFixture,
	type IntegrationHarness,
} from "./integration-harness.js";
export { waitForValue } from "./polling.js";
export { createProcessDriver } from "./process-driver.js";
export { createTestServerSetupCapability } from "./server-extension-test-harness.js";
