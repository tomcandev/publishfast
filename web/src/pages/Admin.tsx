import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Alert, Spinner, StatusBadge, formatBytes, formatDate } from '../components/ui'
import { STATUS_LABELS, api, assetUrl, liveAssets, mediaRemovedAt, type StorageReport, type Asset, type Content, type ContentStatus, type HookPerformanceItem, type MetricSummary, type Role, type User } from '../lib/api'

type Tab = 'contents' | 'analytics' | 'users' | 'tokens' | 'storage'

export function Admin() {
  const [tab, setTab] = useState<Tab>('contents')
  return (
    <div className="page page-wide stack">
      <h1>Admin</h1>
      <div className="nav" role="tablist" style={{ flexWrap: 'wrap' }}>
        {(
          [
            ['contents', 'Content'],
            ['analytics', '📊 Analytics & Hooks'],
            ['users', 'Users'],
            ['tokens', 'API Tokens'],
            ['storage', 'Storage'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={`btn btn-sm ${tab === key ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'contents' && <ContentsTab />}
      {tab === 'analytics' && <AnalyticsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'tokens' && <TokensTab />}
      {tab === 'storage' && <StorageTab />}
    </div>
  )
}

/* ---------------- contents ---------------- */

function ContentsTab() {
  const [items, setItems] = useState<Content[]>([])
  const [editingContent, setEditingContent] = useState<Content | null>(null)
  const [allUsers, setAllUsers] = useState<User[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [busyAction, setBusyAction] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [form, setForm] = useState({
    code: '',
    title: '',
    caption: '',
    contentType: 'video' as 'video' | 'carousel',
  })

  const load = useCallback(async () => {
    try {
      const [{ contents }, usersRes] = await Promise.all([
        api.admin.contents(),
        api.admin.users().catch(() => ({ users: [] })),
      ])
      setItems(contents)
      setAllUsers(usersRes.users)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function toggleSelectAll() {
    if (selectedIds.size === items.length && items.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(items.map((c) => c.id)))
    }
  }

  function toggleSelectOne(id: string) {
    const updated = new Set(selectedIds)
    if (updated.has(id)) updated.delete(id)
    else updated.add(id)
    setSelectedIds(updated)
  }

  async function handleBulkDelete() {
    const count = selectedIds.size
    if (count === 0) return
    if (
      !confirm(
        `Delete ${count} selected content items? All attached media files and publication links will be permanently deleted.`,
      )
    ) {
      return
    }

    setBusyAction(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api.admin.bulkDeleteContents(Array.from(selectedIds))
      setSelectedIds(new Set())
      setNotice(`✓ Successfully deleted ${res.deleted} content items.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk deletion failed')
    } finally {
      setBusyAction(false)
    }
  }

  async function handleBulkSetStatus(status: ContentStatus) {
    const count = selectedIds.size
    if (count === 0) return

    setBusyAction(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api.admin.bulkUpdateContentStatus(Array.from(selectedIds), status)
      setSelectedIds(new Set())
      setNotice(`✓ Updated status to "${status}" for ${res.updated} content items.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk status update failed')
    } finally {
      setBusyAction(false)
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    setNotice(null)
    try {
      const { content } = await api.admin.createContent({
        code: form.code.trim(),
        title: form.title.trim() || undefined,
        caption: form.caption.trim() || undefined,
        contentType: form.contentType,
        status: 'DRAFT',
      })

      const files = fileRef.current?.files
      if (files && files.length > 0) {
        await api.admin.uploadAssets(content.id, files)
      }

      setNotice(`Created ${content.code}. Set status to “Ready” for KOLs to claim.`)
      setForm({ code: '', title: '', caption: '', contentType: 'video' })
      if (fileRef.current) fileRef.current.value = ''
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Creation failed')
    } finally {
      setCreating(false)
    }
  }

  async function setStatus(id: string, status: ContentStatus) {
    try {
      await api.admin.updateContent(id, { status })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    }
  }

  async function remove(id: string, code: string) {
    if (!confirm(`Delete "${code}"? All attached media and links will be permanently removed.`)) return
    try {
      await api.admin.deleteContent(id)
      const updated = new Set(selectedIds)
      updated.delete(id)
      setSelectedIds(updated)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deletion failed')
    }
  }

  if (loading) return <Spinner />

  const allSelected = items.length > 0 && selectedIds.size === items.length

  return (
    <div className="stack">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      <form className="card stack" onSubmit={create}>
        <h2>Add Content</h2>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: '1 1 180px' }}>
            <label className="label" htmlFor="code">Code *</label>
            <input
              id="code"
              className="input"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="PTE-RS-001"
              required
            />
          </div>
          <div className="field" style={{ flex: '2 1 240px' }}>
            <label className="label" htmlFor="title">Title</label>
            <input
              id="title"
              className="input"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div className="field" style={{ flex: '0 1 150px' }}>
            <label className="label" htmlFor="ctype">Type</label>
            <select
              id="ctype"
              className="select"
              value={form.contentType}
              onChange={(e) => setForm({ ...form, contentType: e.target.value as 'video' | 'carousel' })}
            >
              <option value="video">Video</option>
              <option value="carousel">Carousel</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="caption">Caption</label>
          <textarea
            id="caption"
            className="textarea"
            value={form.caption}
            onChange={(e) => setForm({ ...form, caption: e.target.value })}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="files">Video / Images</label>
          <input id="files" ref={fileRef} className="input" type="file" multiple accept="video/*,image/*" />
          <span className="hint">Select multiple images for carousels — order follows selection.</span>
        </div>

        <button className="btn btn-primary" disabled={creating}>
          {creating ? 'Creating…' : 'Create Content'}
        </button>
      </form>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="bulk-action-bar">
          <div className="bulk-action-info">
            <span>✓</span>
            <span>{selectedIds.size} of {items.length} items selected</span>
          </div>
          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => handleBulkSetStatus('READY')}
              disabled={busyAction}
            >
              Set Ready ({selectedIds.size})
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => handleBulkSetStatus('DRAFT')}
              disabled={busyAction}
            >
              Set Draft ({selectedIds.size})
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={handleBulkDelete}
              disabled={busyAction}
            >
              {busyAction ? 'Deleting…' : `🗑️ Delete Selected (${selectedIds.size})`}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setSelectedIds(new Set())}
              disabled={busyAction}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="Select all content items"
                />
              </th>
              <th>Code</th>
              <th>Title</th>
              <th>Status</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => {
              const isSelected = selectedIds.has(c.id)
              return (
                <tr
                  key={c.id}
                  style={{
                    background: isSelected ? 'var(--accent-soft)' : undefined,
                    transition: 'background 0.12s ease',
                  }}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelectOne(c.id)}
                      aria-label={`Select ${c.code}`}
                    />
                  </td>
                  <td><span className="code">{c.code}</span></td>
                  <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.title || <span className="hint">—</span>}
                  </td>
                  <td><StatusBadge status={c.status} /></td>
                  <td className="hint">{formatDate(c.createdAt)}</td>
                  <td>
                    <div className="row-tight">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setEditingContent(c)}
                      >
                        ✏️ Edit
                      </button>
                      {c.status === 'DRAFT' && (
                        <button className="btn btn-sm btn-primary" onClick={() => setStatus(c.id, 'READY')}>
                          Ready
                        </button>
                      )}
                      {c.status === 'READY' && (
                        <button className="btn btn-sm" onClick={() => setStatus(c.id, 'DRAFT')}>
                          Draft
                        </button>
                      )}
                      <button className="btn btn-sm btn-danger" onClick={() => remove(c.id, c.code)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="hint" style={{ textAlign: 'center', padding: 28 }}>
                  No content items found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editingContent && (
        <EditContentModal
          content={editingContent}
          users={allUsers}
          onClose={() => setEditingContent(null)}
          onSaved={async () => {
            setNotice(`✓ Updated content "${editingContent.code}" successfully.`)
            await load()
          }}
          onDeleted={async () => {
            setNotice(`✓ Deleted content "${editingContent.code}".`)
            await load()
          }}
        />
      )}
    </div>
  )
}

function EditContentModal({
  content,
  users,
  onClose,
  onSaved,
  onDeleted,
}: {
  content: Content
  users: User[]
  onClose: () => void
  onSaved: () => Promise<void>
  onDeleted: () => Promise<void>
}) {
  const [code, setCode] = useState(content.code)
  const [title, setTitle] = useState(content.title || '')
  const [caption, setCaption] = useState(content.caption || '')
  const [contentType, setContentType] = useState<'video' | 'carousel'>(content.contentType)
  const [status, setStatus] = useState<ContentStatus>(content.status)
  const [assignedUserId, setAssignedUserId] = useState<string>(content.assignedUserId || '')
  const [activeImageIndex, setActiveImageIndex] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Files removed by the media prune are listed as removed, not previewed.
  const media = content.assets ? liveAssets(content.assets) : []
  const removedAt = content.assets ? mediaRemovedAt(content.assets) : null
  const videos = media.filter((a) => a.type === 'video' || (a.mime && a.mime.startsWith('video/')))
  const images = media.filter((a) => a.type === 'image' || (a.mime && a.mime.startsWith('image/')))

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && activeImageIndex === null) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeImageIndex, onClose])

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.admin.updateContent(content.id, {
        code: code.trim(),
        title: title.trim() || null,
        caption: caption.trim() || null,
        contentType,
        status,
        assignedUserId: assignedUserId || null,
      })
      await onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete content "${content.code}"? All attached media files and links will be permanently deleted.`)) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.admin.deleteContent(content.id)
      await onDeleted()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deletion failed')
      setBusy(false)
    }
  }

  return (
    <>
      <div
        className="modal-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div className="modal-card stack" style={{ maxWidth: 640, maxHeight: '90vh', overflowY: 'auto' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="row-tight" style={{ gap: 8 }}>
              <h2 style={{ fontSize: '1.2rem', margin: 0 }}>Review & Edit Content</h2>
              <span className="code">{content.code}</span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
              ✕
            </button>
          </div>

          {error && <Alert>{error}</Alert>}

          {removedAt && (
            <Alert kind="warn">
              Media removed {new Date(removedAt).toLocaleDateString()} ({content.assets.length - media.length} file
              {content.assets.length - media.length === 1 ? '' : 's'}). The post, its links and its numbers are kept.
            </Alert>
          )}

          {/* Media Preview Section */}
          {media.length > 0 && (
            <div
              className="stack"
              style={{
                padding: 12,
                background: 'var(--bg)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
                gap: 8,
              }}
            >
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="label" style={{ fontSize: '0.8rem', fontWeight: 650 }}>
                  Attached Media ({media.length} file{media.length > 1 ? 's' : ''})
                </span>
                <span className="hint" style={{ fontSize: '0.75rem' }}>
                  {content.contentType === 'carousel' ? '📸 Carousel Slides (tap to enlarge)' : '🎬 Video'}
                </span>
              </div>

              {videos.length > 0 && (
                <div className="stack" style={{ gap: 8 }}>
                  {videos.map((v) => (
                    <video
                      key={v.id}
                      src={assetUrl(v.id)}
                      controls
                      preload="metadata"
                      playsInline
                      style={{ maxHeight: 240, width: '100%', borderRadius: 'var(--radius-sm)' }}
                    />
                  ))}
                </div>
              )}

              {images.length > 0 && (
                <div
                  className="carousel-scroll-gallery"
                  style={{
                    padding: '6px 2px',
                    overflowX: 'auto',
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                  }}
                >
                  {images.map((img, idx) => (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => setActiveImageIndex(idx)}
                      className="carousel-scroll-item"
                      title={`Slide ${idx + 1}: ${img.originalName} (tap to view full screen)`}
                      style={{
                        flexShrink: 0,
                        position: 'relative',
                        height: 130,
                        maxWidth: 180,
                        minWidth: 70,
                        padding: 4,
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-elevated, rgba(0,0,0,0.03))',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        transition: 'transform 0.15s ease, border-color 0.15s ease',
                      }}
                    >
                      <img
                        src={assetUrl(img.id)}
                        alt={img.originalName}
                        style={{
                          maxHeight: '100%',
                          maxWidth: '100%',
                          width: 'auto',
                          height: 'auto',
                          objectFit: 'contain',
                          display: 'block',
                          borderRadius: 3,
                        }}
                      />
                      <span
                        className="carousel-scroll-badge"
                        style={{
                          position: 'absolute',
                          top: 6,
                          left: 6,
                          background: 'rgba(0,0,0,0.75)',
                          color: '#fff',
                          padding: '1px 6px',
                          borderRadius: 4,
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          pointerEvents: 'none',
                        }}
                      >
                        {idx + 1}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Edit Form */}
          <form className="stack" style={{ gap: 14 }} onSubmit={handleSave}>
            <div className="row" style={{ gap: 12 }}>
              <div className="field" style={{ flex: '1 1 140px' }}>
                <label className="label" htmlFor="edit-code">
                  Code *
                </label>
                <input
                  id="edit-code"
                  className="input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </div>

              <div className="field" style={{ flex: '1 1 120px' }}>
                <label className="label" htmlFor="edit-status">
                  Status
                </label>
                <select
                  id="edit-status"
                  className="select"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as ContentStatus)}
                >
                  <option value="DRAFT">DRAFT</option>
                  <option value="READY">READY</option>
                  <option value="CLAIMED">CLAIMED</option>
                  <option value="PUBLISHED">PUBLISHED</option>
                  <option value="FAILED">FAILED</option>
                </select>
              </div>

              <div className="field" style={{ flex: '1 1 120px' }}>
                <label className="label" htmlFor="edit-ctype">
                  Type
                </label>
                <select
                  id="edit-ctype"
                  className="select"
                  value={contentType}
                  onChange={(e) => setContentType(e.target.value as 'video' | 'carousel')}
                >
                  <option value="video">Video</option>
                  <option value="carousel">Carousel</option>
                </select>
              </div>
            </div>

            <div className="field">
              <label className="label" htmlFor="edit-title">
                Title
              </label>
              <input
                id="edit-title"
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. PTE Speaking Repeat Sentence Strategy"
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="edit-assigned">
                Assigned KOL (Optional)
              </label>
              <select
                id="edit-assigned"
                className="select"
                value={assignedUserId}
                onChange={(e) => setAssignedUserId(e.target.value)}
              >
                <option value="">-- Open Queue (Any KOL can claim) --</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    @{u.username} ({u.displayName}){u.notes ? ` - ${u.notes}` : ''}
                  </option>
                ))}
              </select>
              <span className="hint" style={{ fontSize: '0.75rem' }}>
                If set, only this specific KOL will see and be able to claim this content item.
              </span>
            </div>

            <div className="field">
              <label className="label" htmlFor="edit-caption">
                Caption & Hashtags
              </label>
              <textarea
                id="edit-caption"
                className="textarea"
                rows={4}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Caption text with hashtags..."
              />
            </div>

            {content.publications && content.publications.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <span className="label" style={{ fontSize: '0.8rem' }}>Submitted Proof of Work Links:</span>
                {content.publications.map((p) => (
                  <div key={p.id} className="row-tight" style={{ fontSize: '0.82rem' }}>
                    <span className="badge">{p.platform}</span>
                    {p.publishedUrl ? (
                      <a href={p.publishedUrl} target="_blank" rel="noreferrer" className="code" style={{ textDecoration: 'underline' }}>
                        {p.publishedUrl}
                      </a>
                    ) : (
                      <span className="hint">No link provided</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleDelete}
                disabled={busy}
              >
                🗑️ Delete Content
              </button>
              <div className="row-tight" style={{ gap: 8 }}>
                <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {busy ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>

      {/* Lightbox Dialog for Full-Screen Image View */}
      {activeImageIndex !== null && images.length > 0 && (
        <ImageLightboxModal
          images={images}
          currentIndex={activeImageIndex}
          onClose={() => setActiveImageIndex(null)}
          onChangeIndex={(nextIdx) => setActiveImageIndex(nextIdx)}
        />
      )}
    </>
  )
}

function ImageLightboxModal({
  images,
  currentIndex,
  onClose,
  onChangeIndex,
}: {
  images: Asset[]
  currentIndex: number
  onClose: () => void
  onChangeIndex: (nextIdx: number) => void
}) {
  const current = images[currentIndex]
  if (!current) return null

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && currentIndex > 0) {
        onChangeIndex(currentIndex - 1)
      } else if (e.key === 'ArrowRight' && currentIndex < images.length - 1) {
        onChangeIndex(currentIndex + 1)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [currentIndex, images.length, onChangeIndex, onClose])

  return (
    <div
      className="modal-overlay"
      style={{
        background: 'rgba(0, 0, 0, 0.9)',
        zIndex: 1200,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px 8px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 900,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          color: '#fff',
          marginBottom: 10,
          padding: '0 8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              background: 'rgba(255, 255, 255, 0.22)',
              padding: '3px 12px',
              borderRadius: 20,
              fontSize: '0.82rem',
              fontWeight: 650,
            }}
          >
            Slide {currentIndex + 1} of {images.length}
          </span>
          <span style={{ fontSize: '0.85rem', opacity: 0.85 }}>{current.originalName}</span>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          style={{
            background: 'rgba(255, 255, 255, 0.2)',
            color: '#fff',
            border: 'none',
            fontSize: '0.95rem',
            padding: '4px 12px',
            cursor: 'pointer',
          }}
          onClick={onClose}
        >
          ✕ Close
        </button>
      </div>

      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          maxWidth: '100%',
          maxHeight: '82vh',
        }}
      >
        {currentIndex > 0 && (
          <button
            type="button"
            className="btn"
            style={{
              position: 'absolute',
              left: 8,
              zIndex: 10,
              background: 'rgba(0, 0, 0, 0.65)',
              color: '#fff',
              border: '1px solid rgba(255, 255, 255, 0.3)',
              borderRadius: '50%',
              width: 44,
              height: 44,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.4rem',
              cursor: 'pointer',
            }}
            onClick={(e) => {
              e.stopPropagation()
              onChangeIndex(currentIndex - 1)
            }}
            title="Previous slide (Left Arrow)"
          >
            ‹
          </button>
        )}

        <img
          src={assetUrl(current.id)}
          alt={current.originalName}
          style={{
            maxWidth: '92vw',
            maxHeight: '80vh',
            width: 'auto',
            height: 'auto',
            objectFit: 'contain',
            borderRadius: 'var(--radius)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          }}
          onClick={(e) => e.stopPropagation()}
        />

        {currentIndex < images.length - 1 && (
          <button
            type="button"
            className="btn"
            style={{
              position: 'absolute',
              right: 8,
              zIndex: 10,
              background: 'rgba(0, 0, 0, 0.65)',
              color: '#fff',
              border: '1px solid rgba(255, 255, 255, 0.3)',
              borderRadius: '50%',
              width: 44,
              height: 44,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.4rem',
              cursor: 'pointer',
            }}
            onClick={(e) => {
              e.stopPropagation()
              onChangeIndex(currentIndex + 1)
            }}
            title="Next slide (Right Arrow)"
          >
            ›
          </button>
        )}
      </div>
    </div>
  )
}

/* ---------------- users ---------------- */

function UsersTab() {
  const [users, setUsers] = useState<User[]>([])
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    username: '',
    password: '',
    email: '',
    displayName: '',
    role: 'kol' as Role,
    notes: '',
    bioLink: '',
  })
  const [copiedUserId, setCopiedUserId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { users } = await api.admin.users()
      setUsers(users)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function handleAutoGenerateBioLink() {
    const u = form.username.trim().toLowerCase() || 'username'
    const link = `https://pteflow.com/?ref=${u}&utm_source=tiktok&utm_medium=bio&utm_campaign=kol_${u}`
    setForm({ ...form, bioLink: link })
  }

  async function handleQuickGenerateLink(u: User) {
    const link = `https://pteflow.com/?ref=${u.username}&utm_source=tiktok&utm_medium=bio&utm_campaign=kol_${u.username}`
    try {
      await api.admin.updateUser(u.id, { bioLink: link })
      setNotice(`✓ Generated tracking bio link for @${u.username}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update bio link')
    }
  }

  function handleCopyBioLink(userId: string, link: string) {
    void navigator.clipboard.writeText(link)
    setCopiedUserId(userId)
    setTimeout(() => setCopiedUserId(null), 2000)
  }

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.admin.createUser({
        username: form.username.trim().toLowerCase(),
        password: form.password,
        email: form.email.trim() || undefined,
        displayName: form.displayName.trim() || undefined,
        role: form.role,
        notes: form.notes.trim() || undefined,
        bioLink: form.bioLink.trim() || undefined,
      })
      setNotice(`Created account "${form.username}".`)
      setForm({ username: '', password: '', email: '', displayName: '', role: 'kol', notes: '', bioLink: '' })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Creation failed')
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(u: User) {
    try {
      await api.admin.updateUser(u.id, { active: !u.active })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
    }
  }

  if (loading) return <Spinner />

  return (
    <div className="stack">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      <form className="card stack" onSubmit={create}>
        <h2>Add User</h2>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: '1 1 150px' }}>
            <label className="label" htmlFor="u-name">Username *</label>
            <input
              id="u-name"
              className="input"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="yoga"
              autoCapitalize="none"
              required
            />
            <span className="hint">Lowercase, no @ symbol</span>
          </div>
          <div className="field" style={{ flex: '1 1 150px' }}>
            <label className="label" htmlFor="u-pass">Password *</label>
            <input
              id="u-pass"
              className="input"
              type="text"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="at least 8 characters"
              required
            />
          </div>
          <div className="field" style={{ flex: '1 1 180px' }}>
            <label className="label" htmlFor="u-email">Email (optional)</label>
            <input
              id="u-email"
              className="input"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="field" style={{ flex: '0 1 130px' }}>
            <label className="label" htmlFor="u-role">Role</label>
            <select
              id="u-role"
              className="select"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            >
              <option value="kol">KOL</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </div>

        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="label" htmlFor="u-biolink">🔗 Bio / Affiliate Link (optional)</label>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={handleAutoGenerateBioLink}
              style={{ fontSize: '0.78rem' }}
            >
              ⚡ Auto-generate PTE Flow Link
            </button>
          </div>
          <input
            id="u-biolink"
            className="input"
            value={form.bioLink}
            onChange={(e) => setForm({ ...form, bioLink: e.target.value })}
            placeholder="e.g. https://pteflow.com/?ref=username&utm_source=tiktok&utm_medium=bio&utm_campaign=kol_username"
          />
          <span className="hint">
            Directs traffic to PTE Flow with UTM and referral parameters for app install attribution.
          </span>
        </div>

        <div className="field">
          <label className="label" htmlFor="u-notes">Notes (optional)</label>
          <input
            id="u-notes"
            className="input"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="e.g. TikTok @handle, niche, schedule, target platforms..."
          />
        </div>

        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create User'}
        </button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Bio / Affiliate Link</th>
              <th>Notes</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><span className="code">{u.username}</span></td>
                <td>{u.displayName}</td>
                <td className="hint">{u.email || '—'}</td>
                <td><span className="badge">{u.role}</span></td>
                <td style={{ minWidth: 180 }}>
                  {u.bioLink ? (
                    <div className="row-tight" style={{ alignItems: 'center', gap: 6 }}>
                      <a
                        href={u.bioLink}
                        target="_blank"
                        rel="noreferrer"
                        className="hint"
                        style={{
                          maxWidth: 140,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          display: 'inline-block',
                          color: 'var(--primary)',
                          textDecoration: 'underline',
                        }}
                        title={u.bioLink}
                      >
                        🔗 {u.bioLink.replace(/^https?:\/\//, '')}
                      </a>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => handleCopyBioLink(u.id, u.bioLink!)}
                        title="Copy Affiliate Bio Link"
                        style={{ padding: '2px 6px', fontSize: '0.78rem' }}
                      >
                        {copiedUserId === u.id ? '✓ Copied' : '📋 Copy'}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => handleQuickGenerateLink(u)}
                      style={{ fontSize: '0.78rem', color: 'var(--primary)' }}
                    >
                      ⚡ Generate Link
                    </button>
                  )}
                </td>
                <td
                  style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  className="hint"
                  title={u.notes || undefined}
                >
                  {u.notes ? <span>📝 {u.notes}</span> : '—'}
                </td>
                <td>
                  <span className={`badge ${u.active ? 'badge-ready' : ''}`}>
                    {u.active ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td>
                  <div className="row-tight">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setEditingUser(u)}
                    >
                      ✏️ Edit
                    </button>
                    <button className="btn btn-sm" onClick={() => toggleActive(u)}>
                      {u.active ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editingUser && (
        <EditUserModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSaved={async () => {
            setNotice(`✓ Updated user @${editingUser.username} successfully.`)
            await load()
          }}
        />
      )}
    </div>
  )
}

function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: User
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [displayName, setDisplayName] = useState(user.displayName || '')
  const [email, setEmail] = useState(user.email || '')
  const [role, setRole] = useState<Role>(user.role)
  const [active, setActive] = useState(user.active)
  const [notes, setNotes] = useState(user.notes || '')
  const [bioLink, setBioLink] = useState(user.bioLink || '')
  const [copiedBio, setCopiedBio] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [notifStatus, setNotifStatus] = useState<{
    subscriptionCount: number
    enabled: boolean
    reminderTimes: string[]
    lastNotifiedDate: string | null
  } | null>(null)
  const [resettingNotifs, setResettingNotifs] = useState(false)
  const [notifNotice, setNotifNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.admin.getUserNotificationStatus(user.id)
        setNotifStatus(res)
      } catch {
        // ignore
      }
    })()
  }, [user.id])

  function handleAutoGenerateModalBioLink() {
    const link = `https://pteflow.com/?ref=${user.username}&utm_source=tiktok&utm_medium=bio&utm_campaign=kol_${user.username}`
    setBioLink(link)
  }

  function handleCopyModalBioLink() {
    if (!bioLink) return
    void navigator.clipboard.writeText(bioLink)
    setCopiedBio(true)
    setTimeout(() => setCopiedBio(false), 2000)
  }

  async function handleResetUserNotifications() {
    if (!confirm(`Reset all registered push notification devices and reminder history for @${user.username}?`)) {
      return
    }
    setResettingNotifs(true)
    setNotifNotice(null)
    try {
      const res = await api.admin.resetUserNotifications(user.id)
      setNotifStatus((prev) => (prev ? { ...prev, subscriptionCount: 0 } : null))
      setNotifNotice(`✓ Cleared ${res.cleared} registered device subscription(s).`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset notifications')
    } finally {
      setResettingNotifs(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (newPassword && newPassword.length < 8) {
      setError('New password must be at least 8 characters')
      return
    }

    setBusy(true)
    setError(null)
    try {
      await api.admin.updateUser(user.id, {
        displayName: displayName.trim() || user.username,
        email: email.trim() || null,
        role,
        active,
        notes: notes.trim() || null,
        bioLink: bioLink.trim() || null,
        password: newPassword ? newPassword : undefined,
      })
      await onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed')
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-card stack" style={{ maxWidth: 460 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: '1.2rem' }}>Edit User @{user.username}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <Alert>{error}</Alert>}

        <form className="stack" style={{ gap: 14 }} onSubmit={handleSubmit}>
          <div className="field">
            <label className="label" htmlFor="edit-display-name">
              Display Name
            </label>
            <input
              id="edit-display-name"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={user.username}
              required
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="edit-email">
              Email (optional)
            </label>
            <input
              id="edit-email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
            />
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: '1 1 140px' }}>
              <label className="label" htmlFor="edit-role">
                Role
              </label>
              <select
                id="edit-role"
                className="select"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                <option value="kol">KOL</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <div className="field" style={{ flex: '1 1 140px' }}>
              <label className="label" htmlFor="edit-active">
                Account Status
              </label>
              <select
                id="edit-active"
                className="select"
                value={active ? 'active' : 'disabled'}
                onChange={(e) => setActive(e.target.value === 'active')}
              >
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
          </div>

          {/* Bio / Affiliate Link */}
          <div className="field stack" style={{ gap: 6 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="label" htmlFor="edit-biolink" style={{ fontWeight: 650 }}>
                🔗 Bio / Affiliate Tracking Link
              </label>
              <div className="row-tight" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={handleAutoGenerateModalBioLink}
                  style={{ fontSize: '0.75rem' }}
                >
                  ⚡ Auto-generate
                </button>
                {bioLink && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={handleCopyModalBioLink}
                    style={{ fontSize: '0.75rem' }}
                  >
                    {copiedBio ? '✓ Copied' : '📋 Copy'}
                  </button>
                )}
              </div>
            </div>
            <input
              id="edit-biolink"
              className="input"
              value={bioLink}
              onChange={(e) => setBioLink(e.target.value)}
              placeholder={`https://pteflow.com/?ref=${user.username}&utm_source=tiktok&utm_medium=bio&utm_campaign=kol_${user.username}`}
            />
            <span className="hint" style={{ fontSize: '0.76rem' }}>
              Put this link into TikTok/Instagram Bio. The app install referrer attributes all downloads & signups back to @{user.username}.
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="edit-notes">
              Admin Notes (optional)
            </label>
            <textarea
              id="edit-notes"
              className="textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. TikTok @handle, niche, posting schedule, target tags..."
              rows={2}
            />
          </div>

          {/* Push Notifications & Device Management */}
          <div
            className="field stack"
            style={{
              padding: '12px',
              background: 'var(--bg)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              gap: 8,
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <strong style={{ fontSize: '0.88rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>🔔</span>
                  <span>Push Notifications & Devices</span>
                </strong>
                <span className="hint" style={{ fontSize: '0.78rem' }}>
                  {notifStatus
                    ? `${notifStatus.subscriptionCount} device(s) registered • Reminders: ${notifStatus.enabled ? notifStatus.reminderTimes.join(', ') : 'Disabled'}`
                    : 'Loading device status...'}
                </span>
              </div>

              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={handleResetUserNotifications}
                disabled={resettingNotifs || busy}
                title="Disconnect all old/foreign devices and reset push tokens"
                style={{ color: 'var(--danger)', fontSize: '0.8rem' }}
              >
                {resettingNotifs ? 'Resetting...' : '🔄 Reset All Devices'}
              </button>
            </div>
            {notifNotice && (
              <span className="hint" style={{ color: '#10b981', fontWeight: 600, fontSize: '0.8rem' }}>
                {notifNotice}
              </span>
            )}
          </div>

          <div
            className="field stack"
            style={{
              padding: '12px',
              background: 'var(--bg)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              gap: 6,
            }}
          >
            <label className="label" htmlFor="edit-password" style={{ fontWeight: 650 }}>
              🔑 Set New Password (optional)
            </label>
            <input
              id="edit-password"
              className="input"
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Leave blank to keep current password (min 8 chars)"
            />
            <span className="hint" style={{ fontSize: '0.76rem' }}>
              If filled, user's password will be immediately updated to this new password.
            </span>
          </div>

          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ---------------- tokens ---------------- */

function TokensTab() {
  const [tokens, setTokens] = useState<Awaited<ReturnType<typeof api.admin.tokens>>['tokens']>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { tokens } = await api.admin.tokens()
      setTokens(tokens)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function create(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const { token } = await api.admin.createToken(name.trim())
      setFresh(token)
      setName('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create token')
    }
  }

  async function remove(id: string) {
    if (!confirm('Revoke this token?')) return
    await api.admin.deleteToken(id).catch(() => {})
    await load()
  }

  if (loading) return <Spinner />

  return (
    <div className="stack">
      {error && <Alert>{error}</Alert>}

      {fresh && (
        <Alert kind="warn">
          <div className="stack" style={{ gap: 6 }}>
            <strong>Token is displayed once — save it now:</strong>
            <code className="code" style={{ wordBreak: 'break-all', display: 'block', padding: 8 }}>{fresh}</code>
          </div>
        </Alert>
      )}

      <form className="card stack" onSubmit={create}>
        <h2>Generate API Token</h2>
        <p className="hint">Used by AI ingestion pipelines to push content into the queue.</p>
        <div className="row-tight">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ai-pipeline"
            required
          />
          <button className="btn btn-primary">Generate</button>
        </div>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th>Last Used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td className="hint">{formatDate(t.createdAt)}</td>
                <td className="hint">{formatDate(t.lastUsedAt)}</td>
                <td>
                  <button className="btn btn-sm btn-danger" onClick={() => remove(t.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
            {tokens.length === 0 && (
              <tr>
                <td colSpan={4} className="hint" style={{ textAlign: 'center', padding: 28 }}>
                  No API tokens found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ---------------- storage ---------------- */

function StorageTab() {
  const [data, setData] = useState<StorageReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.admin
      .storage()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load storage'))
  }, [])

  if (error) return <Alert>{error}</Alert>
  if (!data) return <Spinner />

  const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : formatBytes(b))
  const rows: [string, string, number][] = [
    ...data.byStatus.map((r): [string, string, number] => [`Media: ${STATUS_LABELS[r.status] ?? r.status}`, `${r.files} files`, r.bytes]),
    ['Media removed so far (pruned)', `${data.pruned.files} files`, data.pruned.bytes],
    ['Drop box', `${data.dropBox.files} files`, data.dropBox.bytes],
    ['Unfinished uploads', `${data.unfinishedUploads.uploads} uploads`, data.unfinishedUploads.bytes],
  ]
  return (
    <div className="stack">
      <p className="hint">
        {data.prune.afterDays
          ? `Media of published posts is deleted ${data.prune.afterDays} day(s) after their newest publication.`
          : 'Media is never deleted automatically (PRUNE_PUBLISHED_AFTER_DAYS is not set).'}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>What</th>
              <th>Count</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([what, count, bytes]) => (
              <tr key={what}>
                <td>{what}</td>
                <td className="hint">{count}</td>
                <td>{size(bytes)}</td>
              </tr>
            ))}
            {data.disk && (
              <tr>
                <td>Free disk</td>
                <td className="hint">of {size(data.disk.totalBytes)}</td>
                <td>{size(data.disk.freeBytes)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ---------------- analytics & hooks ---------------- */

function AnalyticsTab() {
  const [data, setData] = useState<MetricSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editingPost, setEditingPost] = useState<MetricSummary['posts'][0] | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.admin.metrics()
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleSync() {
    setSyncing(true)
    setError(null)
    setNotice(null)
    try {
      const res = await api.admin.syncMetrics()
      setData(res.summary)
      setNotice(`✓ Sync completed! Scanned ${res.totalChecked} links, updated ${res.updated}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  if (loading) return <Spinner />

  const summary = data?.summary || {
    totalPublications: 0,
    totalViews: 0,
    totalLikes: 0,
    avgViewsPerPost: 0,
  }

  const topHook = data?.hooks.find((h) => h.totalPosts > 0 && h.avgViews > 0)

  return (
    <div className="stack" style={{ gap: 24 }}>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="ok">{notice}</Alert>}

      {/* Header & Sync Controls */}
      <div className="card row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Social Media & Hook Analytics</h2>
          <span className="hint">Daily view counts, engagement metrics, and hook performance matrix</span>
        </div>
        <button
          className="btn btn-primary"
          onClick={handleSync}
          disabled={syncing}
          style={{ minWidth: 160 }}
        >
          {syncing ? '🔄 Crawling Views...' : '🔄 Sync All Metrics Now'}
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid-stats">
        <div className="card stat-card">
          <div className="stat-value">{summary.totalViews.toLocaleString()}</div>
          <div className="stat-label">👁️ Total Tracked Views</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value">{summary.totalPublications}</div>
          <div className="stat-label">🎬 Verified Posts</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value">{summary.avgViewsPerPost.toLocaleString()}</div>
          <div className="stat-label">📈 Avg Views / Post</div>
        </div>
        <div className="card stat-card">
          <div className="stat-value" style={{ fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {topHook ? topHook.title : 'Awaiting data'}
          </div>
          <div className="stat-label">🏆 Top Performing Hook</div>
        </div>
      </div>

      {/* Hook Leaderboard */}
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>🎯 Hook Performance Matrix</h3>
          <span className="hint">Ranked by average views per published post</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>Hook & Topic</th>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>Posts</th>
                <th style={{ textAlign: 'right' }}>Total Views</th>
                <th style={{ textAlign: 'right' }}>Avg Views</th>
                <th>Recommendation</th>
              </tr>
            </thead>
            <tbody>
              {data?.hooks.map((h, idx) => (
                <tr key={h.hookId} style={idx === 0 && h.totalPosts > 0 ? { background: 'var(--surface-hover)' } : undefined}>
                  <td style={{ fontWeight: 'bold' }}>{idx + 1}</td>
                  <td>
                    <div><strong>{h.title}</strong></div>
                    <code className="hint" style={{ fontSize: 11 }}>{h.hookId}</code>
                  </td>
                  <td>
                    <span className="badge" style={{ textTransform: 'capitalize' }}>
                      {h.category.replace('_', ' ')}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{h.totalPosts}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{h.totalViews.toLocaleString()}</td>
                  <td style={{ textAlign: 'right', fontWeight: 'bold', color: h.avgViews >= 2000 ? 'var(--primary)' : 'inherit' }}>
                    {h.avgViews.toLocaleString()}
                  </td>
                  <td>
                    <span
                      className="badge"
                      style={{
                        background:
                          h.status === 'viral'
                            ? 'rgba(16, 185, 129, 0.15)'
                            : h.status === 'good'
                              ? 'rgba(59, 130, 246, 0.15)'
                              : h.status === 'underperforming'
                                ? 'rgba(239, 68, 68, 0.15)'
                                : 'var(--border)',
                        color:
                          h.status === 'viral'
                            ? '#10b981'
                            : h.status === 'good'
                              ? '#3b82f6'
                              : h.status === 'underperforming'
                                ? '#ef4444'
                                : 'inherit',
                      }}
                    >
                      {h.recommendation}
                    </span>
                  </td>
                </tr>
              ))}
              {(!data?.hooks || data.hooks.length === 0) && (
                <tr>
                  <td colSpan={7} className="hint" style={{ textAlign: 'center', padding: 24 }}>
                    No hook analytics available yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Published Links & Per-Post Tracker */}
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>📋 Published Post Tracker</h3>
          <span className="hint">{data?.posts.length || 0} live submissions tracked</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Code & Title</th>
                <th>Platform</th>
                <th style={{ textAlign: 'right' }}>Views 👁️</th>
                <th style={{ textAlign: 'right' }}>Likes ❤️</th>
                <th>Published At</th>
                <th>Last Checked</th>
                <th>Proof of Work</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {data?.posts.map((p) => (
                <tr key={p.publicationId}>
                  <td>
                    <div><strong>{p.code}</strong></div>
                    <span className="hint" style={{ fontSize: 12 }}>{p.title}</span>
                  </td>
                  <td>
                    <span className="badge" style={{ textTransform: 'capitalize' }}>
                      {p.platform.replace('_', ' ')}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 'bold' }}>
                    {(p.views || 0).toLocaleString()}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {(p.likes || 0).toLocaleString()}
                  </td>
                  <td className="hint">{p.publishedAt ? formatDate(p.publishedAt) : '—'}</td>
                  <td className="hint">{p.lastCheckedAt ? formatDate(p.lastCheckedAt) : 'Never'}</td>
                  <td>
                    <a
                      href={p.publishedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-xs"
                    >
                      🔗 Live Link
                    </a>
                  </td>
                  <td>
                    <button
                      className="btn btn-xs btn-ghost"
                      onClick={() => setEditingPost(p)}
                    >
                      ✏️ Edit
                    </button>
                  </td>
                </tr>
              ))}
              {(!data?.posts || data.posts.length === 0) && (
                <tr>
                  <td colSpan={8} className="hint" style={{ textAlign: 'center', padding: 24 }}>
                    No published posts submitted yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editingPost && (
        <EditMetricModal
          post={editingPost}
          onClose={() => setEditingPost(null)}
          onSaved={async () => {
            setNotice(`✓ Updated metrics for post ${editingPost.code}`)
            await load()
          }}
        />
      )}
    </div>
  )
}

function EditMetricModal({
  post,
  onClose,
  onSaved,
}: {
  post: MetricSummary['posts'][0]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [views, setViews] = useState(post.views || 0)
  const [likes, setLikes] = useState(post.likes || 0)
  const [comments, setComments] = useState(post.comments || 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.admin.updatePublicationMetrics(post.publicationId, {
        views: Number(views) || 0,
        likes: Number(likes) || 0,
        comments: Number(comments) || 0,
      })
      await onSaved()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update metrics')
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-card stack" style={{ maxWidth: 400 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h3>Edit Post Metrics</h3>
            <span className="hint">{post.code} ({post.platform})</span>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={onClose} type="button">
            ✕
          </button>
        </div>

        {error && <Alert>{error}</Alert>}

        <form className="stack" onSubmit={handleSubmit} style={{ gap: 14 }}>
          <div className="field">
            <label className="label">Total Views 👁️</label>
            <input
              className="input"
              type="number"
              min="0"
              value={views}
              onChange={(e) => setViews(parseInt(e.target.value, 10) || 0)}
              required
            />
          </div>

          <div className="field">
            <label className="label">Likes ❤️</label>
            <input
              className="input"
              type="number"
              min="0"
              value={likes}
              onChange={(e) => setLikes(parseInt(e.target.value, 10) || 0)}
            />
          </div>

          <div className="field">
            <label className="label">Comments 💬</label>
            <input
              className="input"
              type="number"
              min="0"
              value={comments}
              onChange={(e) => setComments(parseInt(e.target.value, 10) || 0)}
            />
          </div>

          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving...' : 'Save Metrics'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

