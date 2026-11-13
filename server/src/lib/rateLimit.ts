/**
 * Per-IP limit on failed bearer-token attempts: after MAX_FAILURES unknown,
 * expired or revoked tokens within WINDOW_MS, every bearer request from that
 * IP gets 429 for BLOCK_MS. In memory, per process: tokens are 192 random bits,
 * so this is a brake on noisy guessing, not the thing that makes guessing hard.
 */
export const MAX_FAILURES = 20
export const WINDOW_MS = 5 * 60_000
export const BLOCK_MS = 5 * 60_000
const MAX_TRACKED = 10_000

type Entry = { count: number; windowStart: number; blockedUntil: number }
const entries = new Map<string, Entry>()

export function isBearerBlocked(ip: string, now = Date.now()) {
  const e = entries.get(ip)
  return !!e && e.blockedUntil > now
}

/** Count one failure. Returns true when this failure starts a block. */
export function recordBearerFailure(ip: string, now = Date.now()) {
  let e = entries.get(ip)
  if (!e || now - e.windowStart > WINDOW_MS) {
    e = { count: 0, windowStart: now, blockedUntil: 0 }
    entries.set(ip, e)
  }
  e.count++
  if (e.count >= MAX_FAILURES && e.blockedUntil <= now) {
    e.blockedUntil = now + BLOCK_MS
    e.count = 0
    e.windowStart = now
    prune(now)
    return true
  }
  prune(now)
  return false
}

function prune(now: number) {
  if (entries.size <= MAX_TRACKED) return
  for (const [ip, e] of entries) {
    if (e.blockedUntil <= now && now - e.windowStart > WINDOW_MS) entries.delete(ip)
  }
  // Still too many (a flood of distinct addresses): drop the oldest entries.
  for (const ip of entries.keys()) {
    if (entries.size <= MAX_TRACKED) break
    entries.delete(ip)
  }
}

/** For tests only. */
export function _resetBearerFailures() {
  entries.clear()
}
