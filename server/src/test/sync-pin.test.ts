/**
 * Pins what the automatic public-count sync (lib/metrics.ts) does for each
 * kind of link, so routing its TikTok page fetches through the URL guard
 * cannot change the counts it records, nor what it fetches for YouTube and
 * other platforms. The network is stubbed: no request leaves the process.
 */
import './env.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { publications } from '../db/schema.js'
import { syncAllPublicationMetrics } from '../lib/metrics.js'
import { makeContent, makeUser } from './helpers.js'

type Call = { url: string; redirect: string | undefined }

const YT = 'https://www.youtube.com/watch?v=pin-yt'
const OTHER = 'https://example.test/v/pin-other'
const TT_API = 'https://www.tiktok.com/@pin.creator/video/7000000000000000001'
const TT_PAGE = 'https://www.tiktok.com/@pin.creator/video/7000000000000000002'

const ids: Record<string, string> = {}
let calls: Call[] = []
let realFetch: typeof fetch

before(async () => {
  migrate()
  const owner = makeUser('pin')
  for (const [key, platform, url] of [
    ['yt', 'youtube', YT],
    ['other', 'facebook', OTHER],
    ['ttApi', 'tiktok', TT_API],
    ['ttPage', 'instagram', TT_PAGE], // a TikTok link saved under another platform still goes to the TikTok reader
  ] as const) {
    const id = randomUUID()
    ids[key] = id
    db.insert(publications)
      .values({ id, contentId: makeContent({ status: 'PUBLISHED' }), userId: owner.id, platform, publishedUrl: url, views: 5 })
      .run()
  }

  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, redirect: init?.redirect })
    if (url.startsWith('https://www.tikwm.com/')) {
      const target = new URL(url).searchParams.get('url')
      if (target === TT_API) {
        return new Response(JSON.stringify({ code: 0, data: { play_count: 900, digg_count: 90, comment_count: 9, share_count: 3 } }))
      }
      return new Response(JSON.stringify({ code: -1, msg: 'no' }))
    }
    if (url === YT) return new Response('<html>"viewCount":"4321"</html>')
    if (url === OTHER) return new Response('<html>nothing to read</html>')
    if (url === TT_API) return new Response('<html></html>')
    if (url === TT_PAGE) {
      return new Response('<html>"playCount":55,"diggCount":6,"commentCount":2,"shareCount":1</html>')
    }
    return new Response('', { status: 404 })
  }) as typeof fetch

  const result = await syncAllPublicationMetrics()
  assert.equal(result.totalChecked, 4)
  assert.equal(result.errors, 0)
})

after(() => {
  globalThis.fetch = realFetch
  sqlite.close()
})

const pub = (key: string) => db.select().from(publications).where(eq(publications.id, ids[key]!)).get()!

describe('metrics sync: what it fetches and records per kind of link', () => {
  it('YouTube: the link is resolved with redirects followed, then read; the views are recorded', () => {
    assert.deepEqual(
      calls.filter((c) => c.url === YT),
      [
        { url: YT, redirect: 'follow' },
        { url: YT, redirect: undefined },
      ],
    )
    const p = pub('yt')
    assert.equal(p.views, 4321)
    assert.equal(p.metricError, null)
  })

  it('another platform: the link is resolved (redirects followed) and nothing else; counts are kept', () => {
    assert.deepEqual(calls.filter((c) => c.url === OTHER), [{ url: OTHER, redirect: 'follow' }])
    const p = pub('other')
    assert.equal(p.views, 5, 'a reading of zero keeps the old count')
    assert.equal(p.metricError, null)
    assert.ok(p.lastCheckedAt)
  })

  it('TikTok: counts come from the tikwm reader when it answers', () => {
    const p = pub('ttApi')
    assert.deepEqual([p.views, p.likes, p.comments, p.shares], [900, 90, 9, 3])
    assert.equal(p.metricError, null)
    assert.ok(calls.some((c) => c.url === `https://www.tikwm.com/api/?url=${encodeURIComponent(TT_API)}`))
  })

  it('TikTok: when tikwm has nothing, the counts are read from the video page', () => {
    const p = pub('ttPage')
    assert.deepEqual([p.views, p.likes, p.comments, p.shares], [55, 6, 2, 1])
    assert.equal(p.metricError, null)
  })
})
