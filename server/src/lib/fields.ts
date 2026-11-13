import { z } from 'zod'

/**
 * An ISO 8601 time with a `Z` or an offset, stored as UTC `toISOString()` so
 * stored times compare correctly as text (the release scheduler relies on it).
 */
export const isoTime = z
  .string()
  .datetime({ offset: true, message: 'Must be an ISO 8601 time, e.g. 2026-11-28T13:00:00Z' })
  .transform((s) => new Date(s).toISOString())

/** A plain JSON object (not an array or null) of at most `maxBytes` once serialised. */
export function jsonObject(maxBytes: number, field: string) {
  return z
    .record(z.unknown(), { invalid_type_error: `${field} must be a JSON object` })
    .refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= maxBytes, {
      message: `${field} must be at most ${Math.round(maxBytes / 1024)} KB`,
    })
}

export const META_MAX_BYTES = 64 * 1024
export const EXTRA_MAX_BYTES = 16 * 1024
