import { describe, expect, it, vi } from "vitest";
import { prepareVirtualMachineDockerMounts } from "./virtual-machine-docker.js";

// OCI read-only mount layout observed in a Linux VM guest, with synthetic
// mount identifiers and worker budgets. The proc superblock remains writable.
const beforeMounts = `42 41 0:18 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
47 46 0:26 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot
49 42 0:18 /sys /proc/sys ro,relatime - proc proc rw
`;
const afterMounts = `42 41 0:18 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
47 46 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot
49 42 0:18 /sys /proc/sys ro,relatime - proc proc rw
51 49 0:18 /sys/net /proc/sys/net rw,nosuid,nodev,noexec,relatime - proc proc rw
`;

function fixture(
	overrides: {
		before?: string;
		after?: string;
		membership?: string;
		cpu?: string;
		memory?: string;
		afterCpu?: string;
		afterMemory?: string;
		platform?: string;
		uid?: number;
	} = {},
) {
	let prepared = false;
	const runtime = {
		platform: overrides.platform ?? "linux",
		uid: overrides.uid ?? 0,
		read: vi.fn(async (path: string) => {
			switch (path) {
				case "/proc/self/mountinfo":
					return prepared ? (overrides.after ?? afterMounts) : (overrides.before ?? beforeMounts);
				case "/proc/self/cgroup":
					return overrides.membership ?? "0::/\n";
				case "/sys/fs/cgroup/cpu.max":
					return (prepared ? overrides.afterCpu : undefined) ?? overrides.cpu ?? "200000 100000\n";
				case "/sys/fs/cgroup/memory.max":
					return (
						(prepared ? overrides.afterMemory : undefined) ?? overrides.memory ?? "536870912\n"
					);
				default:
					throw new Error(`Unexpected read: ${path}`);
			}
		}),
		mount: vi.fn(async (args: string[], _signal: AbortSignal) => {
			if (args[0] === "-o" && args.at(-1) === "/proc/sys/net") prepared = true;
		}),
	};
	return runtime;
}

describe("VM private Docker mount preparation", () => {
	it("changes only mount-local flags and binds only the network sysctl subtree", async () => {
		const runtime = fixture();
		const signal = new AbortController().signal;
		await prepareVirtualMachineDockerMounts(signal, runtime);
		expect(runtime.mount.mock.calls).toEqual([
			[["-o", "remount,bind,rw,nosuid,nodev,noexec", "/sys/fs/cgroup"], signal],
			[["--bind", "/proc/sys/net", "/proc/sys/net"], signal],
			[["-o", "remount,bind,rw,nosuid,nodev,noexec", "/proc/sys/net"], signal],
		]);
		expect(runtime.read.mock.calls.map(([path]) => path)).toEqual([
			"/proc/self/mountinfo",
			"/proc/self/cgroup",
			"/sys/fs/cgroup/cpu.max",
			"/sys/fs/cgroup/memory.max",
			"/proc/self/mountinfo",
			"/proc/self/cgroup",
			"/sys/fs/cgroup/cpu.max",
			"/sys/fs/cgroup/memory.max",
		]);
	});

	it("accepts an already prepared mount without stacking another proc bind", async () => {
		const runtime = fixture({ before: afterMounts });
		await prepareVirtualMachineDockerMounts(new AbortController().signal, runtime);
		expect(runtime.mount.mock.calls.map(([args]) => args.at(-1))).toEqual([
			"/sys/fs/cgroup",
			"/proc/sys/net",
		]);
	});

	it.each([
		{ platform: "darwin" },
		{ uid: 1000 },
		{ membership: "0::/worker\n" },
		{ before: beforeMounts.replace("- cgroup2", "- tmpfs") },
		{ before: beforeMounts.replace(" / /sys/fs/cgroup ", " /worker /sys/fs/cgroup ") },
		{ before: beforeMounts.replace("rw,nsdelegate", "ro,nsdelegate") },
		{ before: beforeMounts.replace(",nsdelegate", "") },
		{ before: beforeMounts.replace("ro,nosuid,nodev,noexec", "ro,nodev,noexec") },
		{ before: beforeMounts.replace("/proc/sys ro,relatime", "/proc/sys rw,relatime") },
		{ cpu: "max 100000\n" },
		{ cpu: "200000 0\n" },
		{ memory: "max\n" },
		{ memory: "0\n" },
	])("rejects an unsafe guest boundary before changing any mounts: %j", async (overrides) => {
		const runtime = fixture(overrides);
		await expect(
			prepareVirtualMachineDockerMounts(new AbortController().signal, runtime),
		).rejects.toThrow("VM Docker mount preparation failed");
		expect(runtime.mount).not.toHaveBeenCalled();
	});

	it.each([
		{ afterCpu: "300000 100000\n" },
		{ afterMemory: "1073741824\n" },
	])("rejects changed resource ceilings after remount: %j", async (overrides) => {
		await expect(
			prepareVirtualMachineDockerMounts(new AbortController().signal, fixture(overrides)),
		).rejects.toThrow("changed the worker resource limits");
	});

	it("detects superblock changes even when the target mount becomes writable", async () => {
		const runtime = fixture({ after: afterMounts.replace(",memory_recursiveprot", "") });
		await expect(
			prepareVirtualMachineDockerMounts(new AbortController().signal, runtime),
		).rejects.toThrow("changed the cgroup2 superblock or mount flags");
	});

	it("rejects making all proc sysctls writable", async () => {
		const runtime = fixture({
			after: afterMounts.replace("/proc/sys ro,relatime", "/proc/sys rw,relatime"),
		});
		await expect(
			prepareVirtualMachineDockerMounts(new AbortController().signal, runtime),
		).rejects.toThrow("read-only /proc/sys mount");
	});

	it("stops on the first mount failure and bounds its diagnostic", async () => {
		const runtime = fixture();
		runtime.mount.mockRejectedValue(new Error("x".repeat(20_000)));
		const error = await prepareVirtualMachineDockerMounts(
			new AbortController().signal,
			runtime,
		).catch((error: Error) => error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message.length).toBeLessThan(2_100);
		expect(runtime.mount).toHaveBeenCalledOnce();
	});

	it("honors shutdown before reading or changing the mounts", async () => {
		const controller = new AbortController();
		controller.abort();
		const runtime = fixture();
		await expect(prepareVirtualMachineDockerMounts(controller.signal, runtime)).rejects.toThrow();
		expect(runtime.read).not.toHaveBeenCalled();
		expect(runtime.mount).not.toHaveBeenCalled();
	});
});
