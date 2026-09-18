import { isIP } from "node:net";
import * as v from "valibot";

/** @internal */
export const dockerRegistryCredentialSchema = v.object({
	/** @internal */
	registry: v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/)),
	/** @internal */
	username: v.pipe(v.string(), v.nonEmpty(), v.regex(/^[^:\r\n\0]+$/)),
	/** @internal */
	password: v.pipe(v.string(), v.nonEmpty()),
});

/** @internal */
export const ipAddressSchema = v.pipe(
	v.string(),
	v.nonEmpty(),
	v.check((value) => isIP(value) !== 0, "Expected an IPv4 or IPv6 address"),
);
const ipv4CidrSchema = v.pipe(
	v.string(),
	v.check(
		(value) => /^.+\/(?:[1-9]|[12][0-9]|30)$/.test(value) && isIP(value.split("/")[0] ?? "") === 4,
	),
);
/** @internal */
export type DockerNetworkConfig = v.InferOutput<typeof dockerNetworkSchema>;

/** @internal */
export const dockerNetworkSchema = v.strictObject({
	/** @internal */
	bridge_cidr: ipv4CidrSchema,
	/** @internal */
	address_pools: v.pipe(
		v.array(
			v.pipe(
				v.strictObject({
					/** @internal */
					base: ipv4CidrSchema,
					/** @internal */
					size: v.pipe(v.number(), v.integer(), v.maxValue(30)),
				}),
				v.check((pool) => pool.size >= Number(pool.base.split("/")[1])),
			),
		),
		v.nonEmpty(),
	),
	/** @internal */
	dns: v.pipe(v.array(ipAddressSchema), v.nonEmpty()),
});
