/**
 * lib/tiktok.ts: the URL guard, the guarded fetch (network stubbed: no
 * request leaves the process), the video page parser on saved fixtures,
 * copyText and the sound URL; lib/sounds.ts: the ranking score on fixed numbers.
 */
import './env.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { median, soundScore } from '../lib/sounds.js'
import {
  FETCH_MAX_BYTES,
  TikTokFetchError,
  allowedTikTokUrl,
  copyText,
  fetchTikTokPage,
  parseTikTokVideoPage,
  soundUrl,
} from '../lib/tiktok.js'

const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')

describe('the TikTok page parser', () => {
  it('a named track (current page format)', () => {
    const v = parseTikTokVideoPage(fixture('tiktok-track.html'))!
    assert.deepEqual(v.sound, { id: '7300000000000000201', title: 'Lofi Study Loop', author: 'Example Band', original: false })
    assert.equal(v.videoId, '7400000000000000101')
    assert.equal(v.author, 'example.creator')
    assert.deepEqual([v.plays, v.likes, v.comments, v.shares], [98765, 4321, 34, 12])
    assert.equal(v.postedAt, '2024-11-13T00:00:00.000Z')
  })

  it('an original sound (older SIGI_STATE format); direction characters are removed', () => {
    const v = parseTikTokVideoPage(fixture('tiktok-original.html'))!
    assert.deepEqual(v.sound, { id: '7300000000000000202', title: 'original sound - Sample Teacher', author: 'Sample Teacher', original: true })
    assert.equal(v.author, 'sample.teacher')
    assert.equal(v.plays, 1500)
  })

  it('a page without the JSON, or with broken JSON, gives nothing', () => {
    assert.equal(parseTikTokVideoPage(fixture('tiktok-nojson.html')), null)
    assert.equal(parseTikTokVideoPage('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{not json</script>'), null)
    assert.equal(parseTikTokVideoPage(''), null)
  })

  it('a sound id that is not digits, or an inexact number, is no sound', () => {
    const page = (music: unknown) =>
      `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
        __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct: { id: '1', music } } } },
      })}</script>`
    assert.equal(parseTikTokVideoPage(page({ id: '../../etc', title: 'x' }))!.sound, null)
    assert.equal(parseTikTokVideoPage(page({ id: 7300000000000000201, title: 'x' }))!.sound, null)
    assert.equal(parseTikTokVideoPage(page({ id: '12', title: 'x'.repeat(500) }))!.sound!.title.length, 200)
  })
})

describe('copyText and the sound URL', () => {
  it('copyText: "<title> <author>" for a track, "original sound <author>" for an original sound', () => {
    assert.equal(copyText({ title: 'Lofi Study Loop', author: 'Example Band', original: false }), 'Lofi Study Loop Example Band')
    assert.equal(copyText({ title: 'original sound - Sample Teacher', author: 'Sample Teacher', original: true }), 'original sound Sample Teacher')
    assert.equal(copyText({ title: 'x', author: null, original: true }), 'original sound')
    assert.equal(copyText({ title: '  Two   spaces ', author: '', original: false }), 'Two spaces')
  })

  it('the sound URL is formed from the id', () => {
    assert.equal(soundUrl({ id: '7300000000000000201', title: 'Lofi Study Loop' }), 'https://www.tiktok.com/music/Lofi-Study-Loop-7300000000000000201')
    assert.equal(soundUrl({ id: '42', title: 'Nhạc nền – ' }), 'https://www.tiktok.com/music/Nhac-nen-42')
    assert.equal(soundUrl({ id: '42', title: '' }), 'https://www.tiktok.com/music/sound-42')
    assert.equal(soundUrl({ id: '4a', title: 'x' }), null)
  })
})

describe('the URL guard', () => {
  it('allows https links on the four TikTok hosts', () => {
    for (const ok of [
      'https://www.tiktok.com/@example.creator/video/7400000000000000101',
      'https://vt.tiktok.com/ZSabc123/',
      'https://vm.tiktok.com/ZMabc123/',
      'https://m.tiktok.com/v/7400000000000000101.html',
      'https://WWW.TIKTOK.COM/@x/video/1', // the parser lower-cases the host
      'https://www.tiktok.com:443/@x/video/1', // the default port; the parser drops it
      'https://www.tiktok.com/@x/video/1#comments',
    ]) {
      const url = allowedTikTokUrl(ok)
      assert.ok(url, ok)
      assert.equal(url!.hash, '')
    }
  })

  it('refuses other hosts, lookalikes, IP literals, ports, userinfo, other schemes and junk', () => {
    for (const bad of [
      'http://www.tiktok.com/@x/video/1',
      'https://tiktok.com/@x/video/1',
      'https://www.tiktok.com.evil.example/@x/video/1',
      'https://evil.example/www.tiktok.com/@x',
      'https://evil.tiktok.com/@x/video/1',
      'https://www.tiktok.com./@x/video/1',
      'https://www.tiktok.com@evil.example/',
      'https://user:pass@www.tiktok.com/@x/video/1',
      'https://user@www.tiktok.com/@x/video/1',
      'https://www.tiktok.com:8443/@x/video/1',
      'https://www.tiktok.com:80/@x/video/1',
      'https://127.0.0.1/@x/video/1',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/',
      'https://2130706433/',
      'https://0x7f.0.0.1/',
      'https://www.tiktok.com\n.evil.example/',
      'https://www.tiktök.com/@x',
      'ftp://www.tiktok.com/x',
      'javascript:alert(1)//www.tiktok.com',
      'data:text/html,www.tiktok.com',
      '//www.tiktok.com/@x',
      'www.tiktok.com/@x',
      '',
      `https://www.tiktok.com/${'a'.repeat(2048)}`,
    ]) {
      assert.equal(allowedTikTokUrl(bad), null, JSON.stringify(bad))
    }
    for (const notString of [null, undefined, 42, {}, ['https://www.tiktok.com/']]) assert.equal(allowedTikTokUrl(notString), null)
  })
})

describe('the guarded fetch (network stubbed)', () => {
  const realFetch = globalThis.fetch
  let calls: { url: string; redirect?: string }[] = []

  function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    calls = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, redirect: init?.redirect })
      return handler(url, init)
    }) as typeof fetch
  }
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  async function failure(p: Promise<unknown>) {
    try {
      await p
    } catch (err) {
      assert.ok(err instanceof TikTokFetchError, String(err))
      return err as TikTokFetchError
    }
    assert.fail('expected a TikTokFetchError')
  }

  it('follows a short link to the video page by hand, absolute and relative locations', async () => {
    stub((url) => {
      if (url === 'https://vt.tiktok.com/ZSabc/') return redirect('https://m.tiktok.com/v/7400000000000000101.html', 301)
      if (url === 'https://m.tiktok.com/v/7400000000000000101.html') return redirect('https://www.tiktok.com/@example.creator/video/7400000000000000101?_r=1')
      if (url === 'https://www.tiktok.com/@example.creator/video/7400000000000000101?_r=1') return redirect('/@example.creator/video/7400000000000000101', 308)
      if (url === 'https://www.tiktok.com/@example.creator/video/7400000000000000101') return new Response(fixture('tiktok-track.html'))
      return new Response('unexpected', { status: 500 })
    })
    const page = await fetchTikTokPage('https://vt.tiktok.com/ZSabc/')
    assert.equal(page.url, 'https://www.tiktok.com/@example.creator/video/7400000000000000101')
    assert.equal(page.status, 200)
    assert.ok(parseTikTokVideoPage(page.body)?.sound)
    assert.equal(calls.length, 4)
    assert.ok(calls.every((c) => c.redirect === 'manual'), 'redirects are never followed by fetch itself')
  })

  it('a refused link is never requested', async () => {
    stub(() => new Response('should not happen'))
    const err = await failure(fetchTikTokPage('https://169.254.169.254/latest/meta-data/'))
    assert.equal(err.reason, 'refused')
    assert.equal(calls.length, 0)
  })

  for (const [name, location] of [
    ['another host', 'https://evil.example/steal'],
    ['a lookalike', 'https://www.tiktok.com.evil.example/x'],
    ['an IP literal', 'https://127.0.0.1/admin'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['plain http', 'http://www.tiktok.com/@x/video/1'],
    ['a port', 'https://www.tiktok.com:8080/x'],
    ['userinfo', 'https://a:b@www.tiktok.com/x'],
    ['a protocol-relative host', '//evil.example/x'],
    ['another scheme', 'file:///etc/passwd'],
  ]) {
    it(`a redirect to ${name} is refused and never requested`, async () => {
      stub((url) => (url.startsWith('https://vt.tiktok.com/') ? redirect(location) : new Response('reached')))
      const err = await failure(fetchTikTokPage('https://vt.tiktok.com/ZSabc/'))
      assert.equal(err.reason, 'redirect_refused')
      assert.deepEqual(calls.map((c) => c.url), ['https://vt.tiktok.com/ZSabc/'])
    })
  }

  it('a redirect without a Location is refused', async () => {
    stub(() => new Response(null, { status: 302 }))
    assert.equal((await failure(fetchTikTokPage('https://vt.tiktok.com/x/'))).reason, 'redirect_refused')
  })

  it('at most 5 redirects are followed', async () => {
    let n = 0
    stub(() => redirect(`https://www.tiktok.com/hop/${++n}`))
    const err = await failure(fetchTikTokPage('https://vt.tiktok.com/loop/'))
    assert.equal(err.reason, 'too_many_redirects')
    assert.equal(calls.length, 6, 'the first request and 5 redirects')

    let m = 0
    stub((url) => (m++ < 5 ? redirect(`https://www.tiktok.com/hop/${m}`) : new Response(`final ${url}`)))
    assert.equal((await fetchTikTokPage('https://vt.tiktok.com/five/')).body, 'final https://www.tiktok.com/hop/5')
  })

  it('a body over the cap is refused, declared or not', async () => {
    stub(() => new Response('x'.repeat(FETCH_MAX_BYTES + 1)))
    assert.equal((await failure(fetchTikTokPage('https://www.tiktok.com/@x/video/1'))).reason, 'too_large')
    stub(() => new Response('small', { headers: { 'content-length': String(FETCH_MAX_BYTES + 1) } }))
    assert.equal((await failure(fetchTikTokPage('https://www.tiktok.com/@x/video/1'))).reason, 'too_large')
    stub(() => new Response('x'.repeat(FETCH_MAX_BYTES)))
    assert.equal((await fetchTikTokPage('https://www.tiktok.com/@x/video/1')).body.length, FETCH_MAX_BYTES)
  })

  it('a page that does not answer in time is a timeout', async () => {
    stub(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    )
    // AbortSignal.timeout's timer does not hold the event loop open; a real socket would.
    const keepAlive = setTimeout(() => {}, 5000)
    const started = Date.now()
    assert.equal((await failure(fetchTikTokPage('https://www.tiktok.com/@x/video/1', { timeoutMs: 50 }))).reason, 'timeout')
    assert.ok(Date.now() - started < 2000)
    clearTimeout(keepAlive)
  })

  it('a network error says only "unreachable", never the upstream text', async () => {
    stub(() => {
      throw new TypeError('connect ECONNREFUSED internal-detail-10.0.0.5')
    })
    const err = await failure(fetchTikTokPage('https://www.tiktok.com/@x/video/1'))
    assert.equal(err.reason, 'unreachable')
    assert.ok(!err.message.includes('internal-detail'))
  })

  it('a non-2xx page is returned with its status for the caller to judge', async () => {
    stub(() => new Response('gone', { status: 404 }))
    const page = await fetchTikTokPage('https://www.tiktok.com/@x/video/1')
    assert.equal(page.status, 404)
  })
})

describe('the ranking score', () => {
  const now = new Date('2026-11-14T00:00:00.000Z')
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

  it('on fixed numbers', () => {
    // 3 × 2 × 1 + 2 × log10(1e6) / 6 + (51 − 1) / 50 − 0
    close(soundScore({ ourMedianRatio: 2, ourPosts: 3, bestPlays: 999_999, bestRank: 1, lastSeenAt: ago(0), now }), 9)
    // ratio clamped to 5, one post of three; rank beyond 50 counts as 50; 17 days old = 1.0 staleness
    close(soundScore({ ourMedianRatio: 10, ourPosts: 1, bestPlays: 0, bestRank: 60, lastSeenAt: ago(17), now }), 5 + 0.02 - 1)
    // outside evidence only; exactly 7 days old is not stale yet
    close(soundScore({ ourMedianRatio: null, ourPosts: 0, bestPlays: 9, bestRank: null, lastSeenAt: ago(7), now }), 1 / 3)
    // a negative ratio counts as 0; more than 3 posts do not add more
    close(soundScore({ ourMedianRatio: -1, ourPosts: 9, bestPlays: 0, bestRank: null, lastSeenAt: ago(1), now }), 0)
    close(soundScore({ ourMedianRatio: 1, ourPosts: 9, bestPlays: 0, bestRank: null, lastSeenAt: ago(1), now }), 3)
  })

  it('median', () => {
    assert.equal(median([]), null)
    assert.equal(median([3]), 3)
    assert.equal(median([4, 1, 3]), 3)
    assert.equal(median([4, 1, 3, 2]), 2.5)
  })
})
