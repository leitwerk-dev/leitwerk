/** Keeps `skills/<id>/SKILL.md` within the canonical bundle's 100-byte path limit. */
export const SAFE_SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,83}$/;
