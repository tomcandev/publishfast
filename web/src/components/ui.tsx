import { useEffect, useState, type ReactNode } from 'react'
import { STATUS_LABELS, type ContentStatus } from '../lib/api'

export function StatusBadge({ status }: { status: ContentStatus }) {
  const cls =
    status === 'READY'
      ? 'badge-ready'
      : status === 'CLAIMED'
        ? 'badge-claimed'
        : status === 'PUBLISHED'
          ? 'badge-published'
          : 'badge-draft'
  return <span className={`badge ${cls}`}>{STATUS_LABELS[status]}</span>
}

export function ContentTypeBadge({
  contentType,
  assetCount,
}: {
  contentType: 'video' | 'carousel'
  assetCount?: number
}) {
  if (contentType === 'video') {
    const count = assetCount && assetCount > 0 ? assetCount : 1
    return (
      <span className="badge badge-media-subtle" title={`${count} Video(s)`}>
        <span>{count}</span>
        <VideoIcon size={11} />
      </span>
    )
  }

  const count = assetCount && assetCount > 0 ? assetCount : 4
  return (
    <span className="badge badge-media-subtle" title={`${count} Images`}>
      <span>{count}</span>
      <ImageIcon size={11} />
    </span>
  )
}

function VideoIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  )
}

function ImageIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

/** Copy button that confirms inline — the one-tap caption copy from plan.txt §23. */
export function CopyButton({
  text,
  label = 'Copy caption',
  className = 'btn',
}: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(t)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Clipboard API needs a secure context; fall back to a temp selection.
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
        setCopied(true)
      } catch {
        window.prompt('Copy caption:', text)
      }
      document.body.removeChild(ta)
    }
  }

  return (
    <button type="button" className={className} onClick={copy} disabled={!text}>
      {copied ? '✓ Copied' : label}
    </button>
  )
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'ok' | 'warn'; children: ReactNode }) {
  return <div className={`alert alert-${kind}`}>{children}</div>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="center-note">{label}</div>
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

export function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ErrorDialog({
  title = 'Error',
  message,
  onClose,
}: {
  title?: string
  message: string
  onClose: () => void
}) {
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-card stack" style={{ maxWidth: 380, gap: 16 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'var(--danger-soft)',
              color: 'var(--danger)',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              fontSize: '1rem',
              fontWeight: 700,
            }}
          >
            !
          </span>
          <h2 style={{ fontSize: '1.15rem', margin: 0 }}>{title}</h2>
        </div>

        <p style={{ color: 'var(--text-soft)', fontSize: '0.92rem', lineHeight: 1.5, margin: 0 }}>
          {message}
        </p>

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

export function Snackbar({
  message,
  kind = 'error',
  onClose,
  duration = 4000,
}: {
  message: string
  kind?: 'error' | 'ok' | 'warn'
  onClose: () => void
  duration?: number
}) {
  useEffect(() => {
    if (!duration) return
    const timer = setTimeout(() => {
      onClose()
    }, duration)
    return () => clearTimeout(timer)
  }, [duration, onClose])

  return (
    <div className="snackbar-wrap">
      <div className={`snackbar snackbar-${kind}`} role="alert">
        <span className="snackbar-icon" aria-hidden="true">
          {kind === 'error' ? '!' : kind === 'ok' ? '✓' : 'ℹ'}
        </span>
        <span style={{ flex: 1 }}>{message}</span>
        <button
          type="button"
          className="snackbar-close"
          onClick={onClose}
          aria-label="Dismiss notification"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
