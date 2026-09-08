import type { FastifyRequest } from "fastify";

export function parseBearerToken(value: string | string[] | undefined): string | null {
	const authorization = Array.isArray(value) ? value[0] : value;
	return authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
}

export function bearerToken(request: FastifyRequest): string | null {
	return parseBearerToken(request.headers.authorization);
}
