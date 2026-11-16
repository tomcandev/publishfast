import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { BottomNav } from '../components/BottomNav'
import { Alert, CopyButton, Empty, Spinner } from '../components/ui'
import { api, type RankedSound } from '../lib/api'
import { useAuth } from '../lib/auth'

const WINDOWS = [7, 14, 30] as const
type Window = (typeof WINDOWS)[number]

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

/** Only https links are ever rendered as links (they are server-made TikTok URLs). */
export function safeHttps(url: string | null | undefined) {
  if (!url) return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** "our posts: 4, 2.3× the account's usual", or the not-enough note. */
export function ourPostsText(s: RankedSound) {
  const { posts, medianRatio, enough } = s.ours
  if (posts === 0) return null
  const ratio = medianRatio === null ? '' : `, ${medianRatio}× the account's usual`
  return enough ? `our posts: ${posts}${ratio}` : `our posts: ${posts}${ratio} · not enough of our own posts yet`
}

/** Why a sound is left out of the list people see (admins see it under "Show hidden"). */
const QUALITY_TITLE: Record<RankedSound['quality']['reason'], string> = {
  ours: '',
  trend: '',
  plays: '',
  speech: 'An original sound used by fewer than 2 other creators: probably someone talking',
  no_evidence: 'No trend rank, no outside video over 20K plays, and our posts are not clearly above usual',
}

export function SoundBadges({ s }: { s: RankedSound }) {
  return (
    <>
      {s.sightings.bestRank !== null && <span className="badge badge-ready">trend #{s.sightings.bestRank}</span>}
      {s.sightings.sources.includes('viral') && <span className="badge badge-claimed">viral</span>}
      {s.ours.posts > 0 && <span className="badge badge-published">ours</span>}
      {s.status === 'hidden' && <span className="badge badge-draft">hidden</span>}
      {s.quality && !s.quality.pass && (
        <span className="badge badge-draft" title={QUALITY_TITLE[s.quality.reason]}>
          {s.quality.reason === 'speech' ? 'speech?' : 'not enough evidence'}
        </span>
      )}
    </>
  )
}

export function Sounds() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [days, setDays] = useState<Window>(14)
  const [showHidden, setShowHidden] = useState(false)
  const [items, setItems] = useState<RankedSound[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [link, setLink] = useState('')
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await api.sounds(days, { limit: 100, hidden: isAdmin && showHidden })
      setItems(res.sounds)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sounds')
    } finally {
      setLoading(false)
    }
  }, [days, showHidden, isAdmin])

  useEffect(() => {
    void load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    const videoUrl = link.trim()
    if (!videoUrl) return
    setAdding(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api.soundFromLink(videoUrl)
      const name = res.sound.copyText || res.sound.title || 'the sound'
      setNotice(res.status === 'recorded' ? `Added: ${name}` : `Already in the bank: ${name}`)
      setLink('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that link')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="page stack" style={{ paddingBottom: 88 }}>
      <div className="stack" style={{ gap: 4 }}>
        <h1>Sounds</h1>
        <p className="hint">
          Background sounds worth using, best first: music with proof it works, not voiceovers. Tap{' '}
          <strong>Copy</strong>, then paste it into TikTok's “Add sound” search.
        </p>
      </div>

      <form className="card stack" style={{ gap: 10 }} onSubmit={add}>
        <label className="label" htmlFor="sound-link">
          Saw a viral video? Paste its TikTok link
        </label>
        <div className="row-tight">
          <input
            id="sound-link"
            className="input"
            type="url"
            inputMode="url"
            placeholder="https://www.tiktok.com/@…/video/…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            autoCapitalize="none"
            spellCheck={false}
          />
          <button className="btn btn-primary" disabled={adding || !link.trim()}>
            {adding ? 'Reading…' : 'Add'}
          </button>
        </div>
      </form>

      {notice && <Alert kind="ok">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}

      <div className="row" style={{ gap: 6 }}>
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            className={`btn btn-sm ${days === w ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setDays(w)}
          >
            {w} days
          </button>
        ))}
        {isAdmin && (
          <label className="hint row-tight" style={{ marginLeft: 'auto', gap: 6 }}>
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show hidden
          </label>
        )}
      </div>

      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty>No sounds yet. Paste a TikTok video link above to add its sound.</Empty>
      ) : (
        <div className="list">
          {items.map((s, i) => (
            <SoundRow key={s.id} s={s} place={i + 1} isAdmin={isAdmin} onChanged={load} />
          ))}
        </div>
      )}

      <BottomNav active="sounds" />
    </div>
  )
}

function SoundRow({ s, place, isAdmin, onChanged }: { s: RankedSound; place: number; isAdmin: boolean; onChanged: () => Promise<void> }) {
  const [note, setNote] = useState(s.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = safeHttps(s.url) ?? safeHttps(s.sightings.bestVideoUrl) ?? safeHttps(s.sightings.newestVideoUrl)
  const example = safeHttps(s.sightings.bestVideoUrl)
  const ours = ourPostsText(s)

  async function patch(change: { status?: 'active' | 'hidden'; note?: string | null }) {
    setBusy(true)
    setError(null)
    try {
      await api.admin.updateSound(s.id, change)
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="list-item sound-row">
      <span className="sound-place" aria-label={`Place ${place}`}>
        {place}
      </span>
      <div className="stack min0" style={{ gap: 6, flex: 1 }}>
        <div className="sound-name">
          <strong>{s.title || (s.original ? 'original sound' : 'Untitled sound')}</strong>
          {s.author && <span className="hint"> · {s.author}</span>}
        </div>
        <div className="row-tight" style={{ flexWrap: 'wrap', gap: 6 }}>
          <SoundBadges s={s} />
        </div>
        {ours && <div className="hint">{ours}</div>}
        {s.sightings.reusers > 0 && (
          <div className="hint">
            Used by {s.sightings.reusers} other creator{s.sightings.reusers === 1 ? '' : 's'}
          </div>
        )}
        {example && (
          <div className="hint">
            Best outside video:{' '}
            <a href={example} target="_blank" rel="noreferrer noopener">
              {s.sightings.bestVideoPlays !== null ? `${compact.format(s.sightings.bestVideoPlays)} plays` : 'open'} ↗
            </a>
          </div>
        )}
        <div className="row sound-actions">
          <CopyButton text={s.copyText} className="btn btn-sm btn-primary" label="Copy" />
          {open && (
            <a className="btn btn-sm" href={open} target="_blank" rel="noreferrer noopener">
              Open in TikTok ↗
            </a>
          )}
          {isAdmin && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => void patch({ status: s.status === 'hidden' ? 'active' : 'hidden' })}
            >
              {s.status === 'hidden' ? 'Unhide' : 'Hide'}
            </button>
          )}
        </div>
        {isAdmin && (
          <form
            className="row-tight"
            onSubmit={(e) => {
              e.preventDefault()
              void patch({ note: note.trim() || null })
            }}
          >
            <input
              className="input"
              style={{ minHeight: 34, padding: '5px 10px', fontSize: '0.85rem' }}
              placeholder="Note (only admins see it)"
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button className="btn btn-sm" disabled={busy || note.trim() === (s.note ?? '')}>
              Save
            </button>
          </form>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    </div>
  )
}

/** The top 3 sounds, for the claimed-post screen. Hidden when there are none or they cannot load. */
export function TopSounds() {
  const [items, setItems] = useState<RankedSound[] | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .sounds(14, { limit: 3 })
      .then((res) => !cancelled && setItems(res.sounds))
      .catch(() => !cancelled && setItems([]))
    return () => {
      cancelled = true
    }
  }, [])

  if (!items || items.length === 0) return null
  return (
    <div className="card stack" style={{ gap: 10 }}>
      <div className="row-tight" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: '1rem', margin: 0 }}>Sounds to try</h2>
        <Link to="/sounds" className="hint">
          All sounds →
        </Link>
      </div>
      {items.map((s) => (
        <div key={s.id} className="row-tight" style={{ justifyContent: 'space-between' }}>
          <div className="min0" style={{ flex: 1 }}>
            <div className="truncate" style={{ fontWeight: 600 }}>
              {s.title || (s.original ? 'original sound' : 'Untitled sound')}
            </div>
            <div className="hint truncate">
              {s.author}
              {s.sightings.bestRank !== null ? ` · trend #${s.sightings.bestRank}` : ''}
            </div>
          </div>
          <CopyButton text={s.copyText} className="btn btn-sm" label="Copy" />
        </div>
      ))}
    </div>
  )
}
