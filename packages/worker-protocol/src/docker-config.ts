import { isIP } from "node:net";
import * as v from "valibot";

export const dockerRegistryCredentialSchema = v.object({
	registry: v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/)),
	username: v.pipe(v.string(), v.nonEmpty(), v.regex(/^[^:\r\n\0]+$/)),
	password: v.pipe(v.string(), v.nonEmpty()),
});

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
export type DockerNetworkConfig = v.InferOutput<typeof dockerNetworkSchema>;

export const dockerNetworkSchema = v.strictObject({
	bridge_cidr: ipv4CidrSchema,
	address_pools: v.pipe(
		v.array(
			v.pipe(
				v.strictObject({
					base: ipv4CidrSchema,
					size: v.pipe(v.number(), v.integer(), v.maxValue(30)),
				}),
				v.check((pool) => pool.size >= Number(pool.base.split("/")[1])),
			),
		),
		v.nonEmpty(),
	),
	dns: v.pipe(v.array(ipAddressSchema), v.nonEmpty()),
});
