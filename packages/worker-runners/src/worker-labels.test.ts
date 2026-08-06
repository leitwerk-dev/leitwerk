import { describe, expect, it } from "vitest";
import {
	buildProcessResourceLabels,
	buildWorkerUnitLabels,
	isManagedWorkerUnitLabels,
	managedProcessNamespaceLabelSelector,
	managedWorkerLabelSelector,
	PROCESS_NAMESPACE_COMPONENT_VALUE,
	PROCESS_VOLUME_COMPONENT_VALUE,
	parseWorkerUnitIdentity,
	WORKER_LABEL_COMPONENT,
	WORKER_LABEL_INSTANCE_ID,
	WORKER_LABEL_MANAGED_BY,
	WORKER_LABEL_SERVER_EPOCH,
	WORKER_LABEL_WORKER_ID,
} from "./worker-labels.js";

const identity = {
	instanceId: "proc-1",
	workerId: "wkr-1",
	serverEpoch: "epoch-1",
};

describe("buildWorkerUnitLabels", () => {
	it("stamps the managed identity labels", () => {
		const labels = buildWorkerUnitLabels(identity);
		expect(labels[WORKER_LABEL_INSTANCE_ID]).toBe("proc-1");
		expect(labels[WORKER_LABEL_WORKER_ID]).toBe("wkr-1");
		expect(labels[WORKER_LABEL_SERVER_EPOCH]).toBe("epoch-1");
		expect(isManagedWorkerUnitLabels(labels)).toBe(true);
	});

	it("merges extra labels but never lets them override managed keys", () => {
		const labels = buildWorkerUnitLabels(identity, {
			"team.dev/owner": "squad-a",
			[WORKER_LABEL_INSTANCE_ID]: "spoofed",
			[WORKER_LABEL_MANAGED_BY]: "not-leitwerk",
		});
		expect(labels["team.dev/owner"]).toBe("squad-a");
		expect(labels[WORKER_LABEL_INSTANCE_ID]).toBe("proc-1");
		expect(isManagedWorkerUnitLabels(labels)).toBe(true);
	});
});

describe("parseWorkerUnitIdentity", () => {
	it("round-trips identity through the labels", () => {
		expect(parseWorkerUnitIdentity(buildWorkerUnitLabels(identity))).toEqual(identity);
	});

	it("returns null for unmanaged labels", () => {
		expect(parseWorkerUnitIdentity({ [WORKER_LABEL_COMPONENT]: "worker" })).toBeNull();
	});

	it("returns null when a managed label is missing", () => {
		const labels = buildWorkerUnitLabels(identity);
		delete labels[WORKER_LABEL_WORKER_ID];
		expect(parseWorkerUnitIdentity(labels)).toBeNull();
	});
});

describe("managedWorkerLabelSelector", () => {
	it("selects only managed worker units", () => {
		const selector = managedWorkerLabelSelector();
		const matching = buildWorkerUnitLabels(identity);
		expect(Object.entries(selector).every(([key, value]) => matching[key] === value)).toBe(true);
	});
});

describe("buildProcessResourceLabels", () => {
	it("stamps durable process labels without worker lease labels", () => {
		const labels = buildProcessResourceLabels({
			instanceId: "proc-1",
			component: PROCESS_VOLUME_COMPONENT_VALUE,
		});
		expect(labels).toMatchObject({
			[WORKER_LABEL_MANAGED_BY]: "leitwerk",
			[WORKER_LABEL_COMPONENT]: PROCESS_VOLUME_COMPONENT_VALUE,
			[WORKER_LABEL_INSTANCE_ID]: "proc-1",
		});
		expect(labels[WORKER_LABEL_WORKER_ID]).toBeUndefined();
		expect(labels[WORKER_LABEL_SERVER_EPOCH]).toBeUndefined();
	});

	it("selects process namespaces", () => {
		const selector = managedProcessNamespaceLabelSelector();
		const matching = buildProcessResourceLabels({
			instanceId: "proc-1",
			component: PROCESS_NAMESPACE_COMPONENT_VALUE,
		});
		expect(Object.entries(selector).every(([key, value]) => matching[key] === value)).toBe(true);
	});
});
