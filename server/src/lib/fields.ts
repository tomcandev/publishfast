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

/** Control characters: become a space. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
/**
 * Invisible, direction, filler and tag characters: removed. Soft hyphen,
 * combining grapheme joiner, Arabic letter mark, Hangul fillers, Mongolian
 * vowel separator, zero width space, LRM/RLM, embeddings and overrides, word
 * joiner, invisible operators, isolates and deprecated format characters,
 * BOM, halfwidth filler, interlinear annotation, tag characters. The zero
 * width joiner and non-joiner stay (emoji and scripts need them).
 */
const INVISIBLE =
  /[\u00ad\u034f\u061c\u115f\u1160\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu

/**
 * Text made safe to store and show: control characters become spaces,
 * invisible ones go, whitespace is collapsed, then at most `max` characters
 * (code points: never cut inside a surrogate pair).
 */
export function cleanText(v: unknown, max = 200) {
  if (typeof v !== 'string') return ''
  const text = v.replace(CONTROL, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
  const points = Array.from(text)
  return points.length > max ? points.slice(0, max).join('').trimEnd() : text
}

/** The first non-empty line of a caption, cleaned, at most 200 characters; '' when there is none. */
export function captionFirstLine(caption: string | null | undefined) {
  for (const line of (caption ?? '').split(/\r\n|\r|\n/)) {
    const clean = cleanText(line, 200)
    if (clean) return clean
  }
  return ''
}
