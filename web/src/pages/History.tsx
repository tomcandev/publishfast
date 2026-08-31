import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, ContentTypeBadge, Empty, Spinner, formatDate } from '../components/ui'
import { PLATFORM_LABELS, api, type Content } from '../lib/api'

export function History() {
  const [items, setItems] = useState<Content[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .history()
      .then(({ contents }) => setItems(contents))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load history'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner />

  return (
    <div className="page stack">
      <h1>Publishing History</h1>
      {error && <Alert>{error}</Alert>}

      {items.length === 0 ? (
        <Empty>You have not published any posts yet.</Empty>
      ) : (
        <div className="list">
          {items.map((c) => (
            <div key={c.id} className="list-item" style={{ alignItems: 'flex-start' }}>
              <div className="stack min0" style={{ gap: 6, flex: 1 }}>
                <div className="row-tight">
                  <span className="code">{c.code}</span>
                  <ContentTypeBadge contentType={c.contentType} assetCount={c.assets?.length} />
                  <span className="hint">{formatDate(c.claimedAt)}</span>
                </div>
                {c.title && <div className="truncate" style={{ fontWeight: 550 }}>{c.title}</div>}
                <div className="row" style={{ gap: 6 }}>
                  {c.publications
                    .filter((p) => p.publishedUrl)
                    .map((p) => (
                      <a
                        key={p.id}
                        className="badge"
                        href={p.publishedUrl!}
                        target="_blank"
                        rel="noreferrer"
                        style={{ textDecoration: 'none' }}
                      >
                        {PLATFORM_LABELS[p.platform]} ↗
                      </a>
                    ))}
                </div>
              </div>
              <Link to={`/post/${c.id}`} className="btn btn-sm">
                View
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
