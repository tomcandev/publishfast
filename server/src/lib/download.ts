import { extname } from 'node:path'
import type { FastifyReply } from 'fastify'

/**
 * Safe serving of user-uploaded bytes. Uploads are attacker-controlled (an
 * ingest token, a pipeline), and they are served from the app's own origin,
 * where an admin may be signed in. So:
 * - only a short list of media types is ever served inline with its type;
 * - everything else is `application/octet-stream` as an attachment;
 * - every response says `nosniff` and carries a sandbox CSP, so even a page
 *   opened directly cannot run script against the app.
 */
export const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
])

export const SANDBOX_CSP = "sandbox; default-src 'none'"

export const IMAGE_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

export const VIDEO_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}

/** Types and names a scoped token may never upload: they can carry script. */
export function isActiveContent(mime: string, filename: string) {
  const m = mime.toLowerCase()
  if (/(svg|html|xml|javascript|ecmascript)/.test(m)) return true
  return /\.(svgz?|html?|xht(ml)?|xml|xsl|js|mjs)$/i.test(filename)
}

function baseMime(mime: string) {
  return mime.split(';')[0]!.trim().toLowerCase()
}

/** The type to serve: the stored one if it is safe, a safe one implied by the name, or octet-stream. */
export function servingType(mime: string, filename: string) {
  const m = baseMime(mime)
  if (INLINE_TYPES.has(m)) return m
  // Old rows uploaded without a type: a known media name still previews.
  if (m === '' || m === 'application/octet-stream' || m === 'binary/octet-stream') {
    const ext = extname(filename).toLowerCase()
    const byName = IMAGE_EXT[ext] ?? VIDEO_EXT[ext]
    if (byName && INLINE_TYPES.has(byName)) return byName
  }
  return 'application/octet-stream'
}

/**
 * A Content-Disposition header that is always plain ASCII: an ASCII fallback
 * name plus the real name as RFC 5987 `filename*`. Control and non-Latin-1
 * characters in a name can then never make Node refuse the header.
 */
export function contentDisposition(kind: 'inline' | 'attachment', name: string) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_').trim() || 'download'
  const encoded = encodeURIComponent(name.replace(/[\x00-\x1f\x7f]/g, '')).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/** Headers for one stored file. Inline only when asked for and the type is on the safe list. */
export function sendFileHeaders(
  reply: FastifyReply,
  opts: { mime: string; filename: string; size?: number; inline?: boolean },
) {
  const type = servingType(opts.mime, opts.filename)
  const inline = !!opts.inline && type !== 'application/octet-stream'
  reply
    .header('Content-Type', type)
    .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', opts.filename))
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', SANDBOX_CSP)
  if (opts.size !== undefined) reply.header('Content-Length', String(opts.size))
  return reply
}
