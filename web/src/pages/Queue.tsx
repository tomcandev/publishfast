import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { BottomNav } from '../components/BottomNav'
import { ReminderSettingsModal } from '../components/ReminderSettingsModal'
import { Alert, ContentTypeBadge, Empty, Spinner, StatusBadge, formatDate } from '../components/ui'
import { ApiError, PLATFORM_LABELS, api, type Content, type Stats } from '../lib/api'
import { useAuth } from '../lib/auth'

export function Queue() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const currentTab = searchParams.get('tab') === 'history' ? 'history' : 'tasks'

  const [stats, setStats] = useState<Stats | null>(null)
  const [mine, setMine] = useState<Content[]>([])
  const [available, setAvailable] = useState<Content[]>([])
  const [historyItems, setHistoryItems] = useState<Content[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [pullDistance, setPullDistance] = useState(0)
  const [touchStartY, setTouchStartY] = useState<number | null>(null)
  const [claimingId, setClaimingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showReminderModal, setShowReminderModal] = useState(false)

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const [s, claimedList, readyList, hist] = await Promise.all([
          api.stats(),
          api.contents('CLAIMED'),
          api.contents('READY'),
          api.history(),
        ])
        setStats(s)
        setMine(claimedList.contents.filter((c) => c.claimedBy === user?.id))
        setAvailable(readyList.contents.slice(0, 5))
        setHistoryItems(hist.contents)
        setError(null)
      } catch (err) {
        if (!silent) {
          setError(err instanceof Error ? err.message : 'Failed to load data')
        }
      } finally {
        setLoading(false)
        setRefreshing(false)
        setPullDistance(0)
      }
    },
    [user?.id],
  )

  useEffect(() => {
    void load()
  }, [load])

  // 1. Auto-refresh whenever user returns to app or browser tab gains focus
  useEffect(() => {
    function onVisibilityOrFocus() {
      if (document.visibilityState === 'visible') {
        void load(true)
      }
    }
    window.addEventListener('visibilitychange', onVisibilityOrFocus)
    window.addEventListener('focus', onVisibilityOrFocus)
    return () => {
      window.removeEventListener('visibilitychange', onVisibilityOrFocus)
      window.removeEventListener('focus', onVisibilityOrFocus)
    }
  }, [load])

  // 2. Real-time background sync polling every 15s to keep queue synchronized across KOLs
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !document.hidden) {
        void load(true)
      }
    }, 15000)
    return () => clearInterval(timer)
  }, [load])

  // 3. Touch pull-to-refresh handlers for PWA / Mobile
  function handleTouchStart(e: React.TouchEvent) {
    if (window.scrollY <= 0 && e.touches[0]) {
      setTouchStartY(e.touches[0].clientY)
    } else {
      setTouchStartY(null)
    }
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (touchStartY === null || refreshing || !e.touches[0]) return
    if (window.scrollY <= 0) {
      const currentY = e.touches[0].clientY
      const diff = currentY - touchStartY
      if (diff > 0) {
        const dist = Math.min(75, Math.pow(diff, 0.85))
        setPullDistance(dist)
      }
    } else {
      setPullDistance(0)
    }
  }

  function handleTouchEnd() {
    if (pullDistance > 45 && !refreshing) {
      setRefreshing(true)
      setPullDistance(44)
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(12)
        } catch {
          // ignore
        }
      }
      void load(true)
    } else {
      setPullDistance(0)
    }
    setTouchStartY(null)
  }

  async function handleClaim(id: string) {
    setClaimingId(id)
    setError(null)
    try {
      const { content } = await api.claim(id)
      navigate(`/post/${content.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to claim post')
      void load(true)
    } finally {
      setClaimingId(null)
    }
  }

  function selectTab(tab: 'tasks' | 'history') {
    setSearchParams(tab === 'history' ? { tab: 'history' } : {})
  }

  if (loading) return <Spinner />

  return (
    <div
      className="page stack"
      style={{ paddingBottom: 88 }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Pull-to-refresh Indicator */}
      <div
        className={`pull-refresh-indicator ${refreshing ? 'refreshing' : ''}`}
        style={{
          height: refreshing ? 44 : pullDistance,
          opacity: refreshing ? 1 : Math.min(1, pullDistance / 35),
          marginBottom: refreshing || pullDistance > 0 ? 8 : 0,
        }}
      >
        {refreshing ? (
          <>
            <span className="pull-refresh-spinner" />
            <span>Refreshing queue…</span>
          </>
        ) : pullDistance > 45 ? (
          <>
            <span>↑</span>
            <span>Release to refresh</span>
          </>
        ) : (
          <>
            <span>↓</span>
            <span>Pull down to refresh</span>
          </>
        )}
      </div>

      {error && <Alert>{error}</Alert>}

      {/* Reminder Banner */}
      {currentTab === 'tasks' && (mine.length > 0 || available.length > 0) && (
        <div className="reminder-banner">
          <div className="reminder-banner-content">
            <span className="reminder-banner-icon">⏰</span>
            <div>
              <strong>Daily Post Reminder:</strong>{' '}
              <span>
                {mine.length > 0
                  ? `You have ${mine.length} post(s) in progress waiting to be published.`
                  : `${stats?.available ?? available.length} new post(s) available in the queue.`}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ border: '1px solid var(--accent)', color: 'var(--accent)', flexShrink: 0 }}
            onClick={() => setShowReminderModal(true)}
          >
            ⚙️ Reminder Settings
          </button>
        </div>
      )}

      {currentTab === 'tasks' ? (
        <>
          {/* Active / In-progress posts held by KOL */}
          {mine.length > 0 && (
            <div className="list">
              {mine.map((c) => (
                <Link key={c.id} to={`/post/${c.id}`} className="list-item">
                  <div className="stack min0" style={{ gap: 3, flex: 1 }}>
                    <div className="row-tight">
                      <span className="code">{c.code}</span>
                      <ContentTypeBadge contentType={c.contentType} assetCount={c.assets?.length} />
                      <StatusBadge status={c.status} />
                    </div>
                    <div className="truncate" style={{ color: 'var(--text-soft)', fontSize: '0.9rem' }}>
                      {c.title || c.caption || 'Untitled'}
                    </div>
                  </div>
                  <span style={{ color: 'var(--text-faint)' }}>›</span>
                </Link>
              ))}
            </div>
          )}

          {/* Available posts up to 5 */}
          {available.length > 0 && (
            <div className="stack" style={{ gap: 10 }}>
              <div className="list">
                {available.map((c) => (
                  <div key={c.id} className="list-item">
                    <div className="stack min0" style={{ gap: 3, flex: 1 }}>
                      <div className="row-tight" style={{ flexWrap: 'wrap' }}>
                        <span className="code">{c.code}</span>
                        <ContentTypeBadge contentType={c.contentType} assetCount={c.assets?.length} />
                        {c.assignExpiresAt && c.assignedUserId === user?.id && (
                          <span className="hint">yours until {formatDate(c.assignExpiresAt)}</span>
                        )}
                      </div>
                      <div className="truncate" style={{ color: 'var(--text-soft)', fontSize: '0.9rem' }}>
                        {c.title || c.caption || 'Untitled'}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={claimingId === c.id}
                      onClick={() => void handleClaim(c.id)}
                    >
                      {claimingId === c.id ? 'Claiming…' : 'Claim'}
                    </button>
                  </div>
                ))}
              </div>

              {(stats?.available ?? 0) > 5 && (
                <div className="center-note" style={{ padding: '4px 0', fontSize: '0.82rem' }}>
                  +{stats!.available - 5} more available posts waiting
                </div>
              )}
            </div>
          )}

          {mine.length === 0 && available.length === 0 && (
            <Empty>No posts available right now. Check back soon!</Empty>
          )}
        </>
      ) : (
        <>
          {historyItems.length === 0 ? (
            <Empty>You haven’t published any posts yet.</Empty>
          ) : (
            <div className="list">
              {historyItems.map((c) => (
                <Link key={c.id} to={`/post/${c.id}`} className="list-item">
                  <div className="stack min0" style={{ gap: 4, flex: 1 }}>
                    <div className="row-tight">
                      <span className="code">{c.code}</span>
                      <ContentTypeBadge contentType={c.contentType} assetCount={c.assets?.length} />
                      <span className="hint">{formatDate(c.claimedAt)}</span>
                    </div>
                    <div className="truncate" style={{ color: 'var(--text)', fontSize: '0.92rem', fontWeight: 550 }}>
                      {c.title || c.caption || 'Untitled'}
                    </div>
                    {c.publications.some((p) => p.publishedUrl) && (
                      <div className="row" style={{ gap: 6, marginTop: 2 }}>
                        {c.publications
                          .filter((p) => p.publishedUrl)
                          .map((p) => (
                            <a
                              key={p.id}
                              className="badge"
                              href={p.publishedUrl!}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              style={{ textDecoration: 'none' }}
                            >
                              {PLATFORM_LABELS[p.platform]} ↗
                            </a>
                          ))}
                      </div>
                    )}
                  </div>
                  <span style={{ color: 'var(--text-faint)' }}>›</span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}

      {/* Bottom Navigation */}
      <BottomNav active={currentTab} onSelect={selectTab} />

      {showReminderModal && <ReminderSettingsModal onClose={() => setShowReminderModal(false)} />}
    </div>
  )
}

