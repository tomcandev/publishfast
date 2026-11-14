/**
 * Pins what the automatic public-count sync (lib/metrics.ts) fetches and
 * records for each kind of link. Updated on purpose (review 2): every
 * request now goes through the guarded fetch, YouTube included, and a link
 * on any other host is not fetched at all. The network is stubbed: no
 * request leaves the process.
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
const YT_SHORT = 'https://youtu.be/pin-short'
const YT_HTTP = 'http://youtube.com/watch?v=pin-http'
const OTHER = 'https://example.test/v/pin-other'
const SHORTENER = 'https://bit.ly/to-tiktok'
const TT_API = 'https://www.tiktok.com/@pin.creator/video/7000000000000000001'
const TT_PAGE = 'https://www.tiktok.com/@pin.creator/video/7000000000000000002'
const TT_BARE = 'https://tiktok.com/@pin.creator/video/7000000000000000003'
const TT_HTTP = 'http://www.tiktok.com/@pin.creator/video/7000000000000000004'
const TT_QUERY = 'https://www.tiktok.com/@pin.creator/video/7000000000000000005?_t=PRIVATE-SHARE-TOKEN&_r=1'
const TT_PORT = 'https://www.tiktok.com:8443/@pin.creator/video/7000000000000000006'
const TT_BIG_TIKWM = 'https://www.tiktok.com/@pin.creator/video/7000000000000000007'
const SSRF_YT = 'http://127.0.0.1:19100/internal/secret?x=youtube.com'
const SSRF_TT = 'http://127.0.0.1:19100/internal/secret?x=tiktok.com'
const YT_PORT = 'https://www.youtube.com:8443/watch?v=x'

const PAGE_COUNTS = '<html>"playCount":55,"diggCount":6,"commentCount":2,"shareCount":1</html>'

const ids: Record<string, string> = {}
let calls: Call[] = []
let realFetch: typeof fetch

before(async () => {
  migrate()
  const owner = makeUser('pin')
  const links: [string, (typeof publications.platform.enumValues)[number], string][] = [
    ['yt', 'youtube', YT],
    ['ytShort', 'youtube_shorts', YT_SHORT],
    ['ytHttp', 'youtube', YT_HTTP],
    ['other', 'facebook', OTHER],
    ['shortener', 'other', SHORTENER],
    ['ttApi', 'tiktok', TT_API],
    ['ttPage', 'instagram', TT_PAGE], // a TikTok link saved under another platform still goes to the TikTok reader
    ['ttBare', 'tiktok', TT_BARE],
    ['ttHttp', 'tiktok', TT_HTTP],
    ['ttQuery', 'tiktok', TT_QUERY],
    ['ttPort', 'tiktok', TT_PORT],
    ['ttBigTikwm', 'tiktok', TT_BIG_TIKWM],
    ['ssrfYt', 'youtube', SSRF_YT],
    ['ssrfTt', 'tiktok', SSRF_TT],
    ['ytPort', 'youtube', YT_PORT],
  ]
  for (const [key, platform, url] of links) {
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
    const host = new URL(url).hostname
    if (host === 'www.tikwm.com') {
      const target = new URL(url).searchParams.get('url')
      if (target === TT_API) {
        return new Response(JSON.stringify({ code: 0, data: { play_count: 900, digg_count: 90, comment_count: 9, share_count: 3 } }))
      }
      if (target === TT_BIG_TIKWM) return new Response('{"code":0,"data":{"play_count":1},"pad":"' + 'x'.repeat(3 * 1024 * 1024) + '"}')
      throw new TypeError('tikwm is down')
    }
    if (url === YT) return new Response('<html>"viewCount":"4321"</html>')
    if (url === 'https://youtu.be/pin-short') return new Response(null, { status: 301, headers: { location: 'https://www.youtube.com/watch?v=pin-short' } })
    if (url === 'https://www.youtube.com/watch?v=pin-short') return new Response('<html>"viewCount":"77"</html>')
    if (url === 'https://youtube.com/watch?v=pin-http') return new Response('<html>"viewCount":"88"</html>')
    if (url.startsWith('https://www.tiktok.com/@pin.creator/') || url.startsWith('https://tiktok.com/@pin.creator/')) {
      return url.startsWith(TT_API) ? new Response('<html></html>') : new Response(PAGE_COUNTS)
    }
    return new Response('TOP-SECRET 999999 views', { status: 200 })
  }) as typeof fetch

  const result = await syncAllPublicationMetrics()
  assert.equal(result.totalChecked, links.length)
})

after(() => {
  globalThis.fetch = realFetch
  sqlite.close()
})

const pub = (key: string) => db.select().from(publications).where(eq(publications.id, ids[key]!)).get()!
const hosts = () => calls.map((c) => new URL(c.url).hostname)

describe('metrics sync: what it fetches and records per kind of link', () => {
  it('every request is guarded: redirect manual, and only TikTok, YouTube and tikwm hosts', () => {
    assert.ok(calls.length > 0)
    assert.ok(calls.every((c) => c.redirect === 'manual'), 'no request follows redirects by itself')
    const allowed = new Set(['www.tiktok.com', 'tiktok.com', 'www.youtube.com', 'youtube.com', 'youtu.be', 'www.tikwm.com'])
    assert.deepEqual(hosts().filter((h) => !allowed.has(h)), [])
  })

  it('YouTube: read once through the guard; youtu.be follows its redirect to www.youtube.com; http is read as https', () => {
    assert.deepEqual(calls.filter((c) => c.url === YT), [{ url: YT, redirect: 'manual' }])
    assert.equal(pub('yt').views, 4321)
    assert.equal(pub('yt').metricError, null)
    assert.equal(pub('ytShort').views, 77)
    assert.equal(pub('ytHttp').views, 88)
    assert.ok(!calls.some((c) => c.url.startsWith('http://')))
  })

  it('another host, a shortener, a loopback address dressed as youtube.com or tiktok.com: no request at all; counts kept', () => {
    for (const key of ['other', 'shortener', 'ssrfYt', 'ssrfTt']) {
      assert.equal(pub(key).views, 5, key)
      assert.equal(pub(key).metricError, null, key)
    }
    assert.ok(!calls.some((c) => c.url.includes('127.0.0.1') || c.url.includes('example.test') || c.url.includes('bit.ly')))
  })

  it('a port on a known host is refused before any request (and never sent to tikwm)', () => {
    assert.ok(pub('ttPort').metricError)
    assert.ok(pub('ytPort').metricError)
    assert.ok(!calls.some((c) => c.url.includes('8443') || decodeURIComponent(c.url).includes(':8443')))
  })

  it('TikTok: counts come from the tikwm reader when it answers', () => {
    const p = pub('ttApi')
    assert.deepEqual([p.views, p.likes, p.comments, p.shares], [900, 90, 9, 3])
    assert.equal(p.metricError, null)
    assert.ok(calls.some((c) => c.url === `https://www.tikwm.com/api/?url=${encodeURIComponent(TT_API)}`))
  })

  it('TikTok: when tikwm is down, the counts are read from the video page, also for tiktok.com and http:// links', () => {
    for (const key of ['ttPage', 'ttBare', 'ttHttp', 'ttQuery']) {
      const p = pub(key)
      assert.deepEqual([p.views, p.likes, p.comments, p.shares], [55, 6, 2, 1], key)
      assert.equal(p.metricError, null, key)
    }
  })

  it('tikwm gets the link without its query string, and its answer is capped', () => {
    const sent = calls.filter((c) => c.url.startsWith('https://www.tikwm.com/')).map((c) => new URL(c.url).searchParams.get('url')!)
    assert.ok(sent.some((u) => u.startsWith('https://www.tiktok.com/@pin.creator/video/7000000000000000005')))
    assert.ok(!sent.some((u) => u.includes('PRIVATE-SHARE-TOKEN') || u.includes('?')))
    // An answer over 3 MB is dropped; the page's counts are used.
    assert.equal(pub('ttBigTikwm').views, 55)
  })
})
