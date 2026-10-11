import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const CGROUP = "/sys/fs/cgroup";
const PROC_SYS = "/proc/sys";
const PROC_NET = "/proc/sys/net";

interface Mount {
	id: string;
	parent: string;
	root: string;
	target: string;
	options: string[];
	optional: string[];
	type: string;
	source: string;
	superOptions: string[];
}

interface MountPreparationDeps {
	platform: string;
	uid: number | undefined;
	read: (path: string) => Promise<string>;
	mount: (args: string[], signal: AbortSignal) => Promise<void>;
}

function requireValue(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function mounts(value: string): Mount[] {
	return value
		.trim()
		.split("\n")
		.map((line) => {
			const fields = line.split(" ");
			const separator = fields.indexOf("-");
			requireValue(separator >= 6 && fields.length >= separator + 4, "Invalid mount information");
			const decode = (field: string) =>
				field.replace(/\\([0-7]{3})/gu, (_, octal: string) =>
					String.fromCharCode(Number.parseInt(octal, 8)),
				);
			return {
				id: fields[0],
				parent: fields[1],
				root: decode(fields[3]),
				target: decode(fields[4]),
				options: fields[5].split(",").sort(),
				optional: fields.slice(6, separator),
				type: fields[separator + 1],
				source: fields[separator + 2],
				superOptions: fields[separator + 3].split(",").sort(),
			};
		});
}

function atMount(entries: Mount[], target: string): Mount {
	const matches = entries.filter((entry) => entry.target === target);
	requireValue(matches.length === 1, `Expected one mount at ${target}`);
	return matches[0];
}

function writableSuperblock(mount: Mount): boolean {
	return mount.superOptions.includes("rw") && !mount.superOptions.includes("ro");
}

async function snapshot(deps: MountPreparationDeps) {
	const [mountinfo, membership, cpu, memory] = await Promise.all([
		deps.read("/proc/self/mountinfo"),
		deps.read("/proc/self/cgroup"),
		deps.read(`${CGROUP}/cpu.max`),
		deps.read(`${CGROUP}/memory.max`),
	]);
	const entries = mounts(mountinfo);
	const cgroup = atMount(entries, CGROUP);
	const proc = atMount(entries, "/proc");
	const sys = atMount(entries, PROC_SYS);
	requireValue(
		membership.trim() === "0::/" && cgroup.type === "cgroup2" && cgroup.root === "/",
		"A namespace-root cgroup2 mount is required",
	);
	requireValue(
		writableSuperblock(cgroup) && cgroup.superOptions.includes("nsdelegate"),
		"A writable, namespace-delegating cgroup2 superblock is required",
	);
	requireValue(
		["nosuid", "nodev", "noexec"].every((flag) => cgroup.options.includes(flag)),
		"The cgroup2 mount must retain nosuid, nodev and noexec",
	);
	const cpuValues = cpu.trim().split(/\s+/u);
	requireValue(
		cpuValues.length === 2 && cpuValues.every((value) => /^\d+$/u.test(value) && BigInt(value) > 0),
		"A finite worker CPU quota is required",
	);
	requireValue(
		/^\d+$/u.test(memory.trim()) && BigInt(memory.trim()) > 0,
		"A finite worker memory limit is required",
	);
	requireValue(
		proc.type === "proc" &&
			proc.root === "/" &&
			sys.type === "proc" &&
			sys.root === "/sys" &&
			sys.options.includes("ro") &&
			!sys.options.includes("rw") &&
			writableSuperblock(sys),
		"A read-only /proc/sys mount on a writable proc superblock is required",
	);
	return { entries, cgroup, proc, sys, cpu, memory };
}

/** @internal */
export async function prepareVirtualMachineDockerMounts(
	signal: AbortSignal,
	deps: MountPreparationDeps = {
		platform: process.platform,
		uid: process.getuid?.(),
		read: (path) => readFile(path, "utf8"),
		mount: (args, signal) =>
			promisify(execFile)("mount", args, { signal, timeout: 5_000, maxBuffer: 4_096 }).then(
				() => undefined,
			),
	},
): Promise<void> {
	try {
		requireValue(
			deps.platform === "linux" && deps.uid === 0,
			"VM Docker mount preparation requires Linux container root",
		);
		signal.throwIfAborted();
		const before = await snapshot(deps);
		const net = before.entries.filter((entry) => entry.target === PROC_NET);
		requireValue(
			net.length <= 1 &&
				(!net.length ||
					(net[0].type === "proc" &&
						net[0].root === "/sys/net" &&
						JSON.stringify(net[0].superOptions) === JSON.stringify(before.sys.superOptions))),
			"Unexpected /proc/sys/net mount",
		);

		// Bind remounts change only this mount. Plain remounts would affect the
		// shared guest superblock and can make later Kata exec calls fail.
		const remount = async (target: string) => {
			signal.throwIfAborted();
			await deps.mount(["-o", "remount,bind,rw,nosuid,nodev,noexec", target], signal);
		};
		await remount(CGROUP);
		if (!net.length) {
			signal.throwIfAborted();
			await deps.mount(["--bind", PROC_NET, PROC_NET], signal);
		}
		await remount(PROC_NET);
		signal.throwIfAborted();
		const after = await snapshot(deps);
		requireValue(
			before.cpu === after.cpu && before.memory === after.memory,
			"Mount preparation changed the worker resource limits",
		);
		requireValue(
			JSON.stringify(before.proc) === JSON.stringify(after.proc) &&
				JSON.stringify(before.sys) === JSON.stringify(after.sys),
			"Mount preparation changed the parent proc mounts",
		);
		const expectedCgroup = {
			...before.cgroup,
			options: [
				...before.cgroup.options.filter((flag) => flag !== "ro" && flag !== "rw"),
				"rw",
			].sort(),
		};
		requireValue(
			JSON.stringify(expectedCgroup) === JSON.stringify(after.cgroup),
			"Mount preparation changed the cgroup2 superblock or mount flags",
		);
		const preparedNet = atMount(after.entries, PROC_NET);
		requireValue(
			preparedNet.type === "proc" &&
				preparedNet.root === "/sys/net" &&
				preparedNet.parent === before.sys.id &&
				["rw", "nosuid", "nodev", "noexec"].every((flag) => preparedNet.options.includes(flag)) &&
				!preparedNet.options.includes("ro") &&
				JSON.stringify(preparedNet.superOptions) === JSON.stringify(before.sys.superOptions),
			"The network sysctl mount was not prepared without changing its superblock",
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown mount preparation error";
		throw new Error(`VM Docker mount preparation failed: ${message.slice(0, 2_048)}`);
	}
}
