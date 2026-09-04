import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Alert, ContentTypeBadge, CopyButton, Empty, Snackbar, Spinner, StatusBadge, formatBytes, formatDate } from '../components/ui'
import {
  PLATFORM_LABELS,
  api,
  assetDownloadUrl,
  assetUrl,
  zipUrl,
  type Asset,
  type Content,
  type Platform,
} from '../lib/api'

const PLATFORM_ORDER: Platform[] = ['tiktok', 'instagram', 'youtube_shorts', 'facebook', 'other']

function detectPlatform(url: string): Platform {
  const lower = url.toLowerCase()
  if (lower.includes('tiktok.com')) return 'tiktok'
  if (lower.includes('instagram.com') || lower.includes('instagr.am')) return 'instagram'
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube_shorts'
  if (lower.includes('facebook.com') || lower.includes('fb.watch') || lower.includes('fb.com')) return 'facebook'
  return 'other'
}

function getPlatformDeepLink(platform: Platform): { appUrl: string; webUrl: string } {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
  const isIOS = /iPad|iPhone|iPod/.test(ua)
  const isAndroid = /Android/.test(ua)

  switch (platform) {
    case 'tiktok':
      return {
        appUrl: isIOS ? 'snssdk1233://' : isAndroid ? 'snssdk1180://' : 'tiktok://',
        webUrl: 'https://www.tiktok.com/',
      }
    case 'instagram':
      return {
        appUrl: 'instagram://app',
        webUrl: 'https://www.instagram.com/',
      }
    case 'youtube_shorts':
      return {
        appUrl: isAndroid ? 'vnd.youtube://' : 'youtube://',
        webUrl: 'https://www.youtube.com/shorts',
      }
    case 'facebook':
      return {
        appUrl: 'fb://',
        webUrl: 'https://www.facebook.com/',
      }
    default:
      return {
        appUrl: '',
        webUrl: 'https://www.google.com/',
      }
  }
}

export function Post() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [content, setContent] = useState<Content | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toastNotice, setToastNotice] = useState<string | null>(null)
  const [urls, setUrls] = useState<Partial<Record<Platform, string>>>({})
  const [saveStatus, setSaveStatus] = useState<Partial<Record<Platform, 'idle' | 'saving' | 'saved'>>>({})
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [captionCopied, setCaptionCopied] = useState(false)
  const [mode, setMode] = useState<'direct' | 'auto' | 'manual'>('direct')
  const debounceTimers = useRef<Partial<Record<Platform, NodeJS.Timeout>>>({})
  const preloadedFilesRef = useRef<File[] | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    try {
      const { content } = await api.content(id)
      setContent(content)
      const existing: Partial<Record<Platform, string>> = {}
      for (const p of content.publications) {
        if (p.publishedUrl) existing[p.platform] = p.publishedUrl
      }
      setUrls(existing)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load post')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  // Preload media assets immediately into memory so iOS Safari transient user gesture never times out
  useEffect(() => {
    if (!content?.assets?.length) {
      preloadedFilesRef.current = null
      return
    }
    let cancelled = false
    const assetsList = content.assets

    void (async () => {
      try {
        const files = await Promise.all(
          assetsList.map(async (a, idx) => {
            const res = await fetch(assetDownloadUrl(a.id))
            const blob = await res.blob()
            const isVid = a.type === 'video' || (a.mime && a.mime.startsWith('video/'))
            const mime = isVid ? 'video/mp4' : a.mime && a.mime.startsWith('image/') ? a.mime : 'image/jpeg'
            const ext = isVid ? 'mp4' : mime.includes('png') ? 'png' : 'jpg'
            const name = `${content.code || 'media'}_${idx + 1}.${ext}`
            return new File([blob], name, { type: mime })
          }),
        )
        if (!cancelled) {
          preloadedFilesRef.current = files
        }
      } catch (err) {
        console.warn('Media preload warning:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [content?.assets, content?.code])

  const doSaveLink = useCallback(
    async (platform: Platform, url: string) => {
      if (!content) return
      const trimmed = url.trim()
      if (!trimmed) return
      setSaveStatus((prev) => ({ ...prev, [platform]: 'saving' }))
      setError(null)
      try {
        await api.savePublication({ contentId: content.id, platform, publishedUrl: trimmed })
        setSaveStatus((prev) => ({ ...prev, [platform]: 'saved' }))
        const updated = await api.content(content.id)
        setContent(updated.content)
        setTimeout(() => {
          setSaveStatus((prev) => ({ ...prev, [platform]: 'idle' }))
        }, 2500)
      } catch (err) {
        setSaveStatus((prev) => ({ ...prev, [platform]: 'idle' }))
        setError(err instanceof Error ? err.message : 'Failed to save link')
      }
    },
    [content],
  )

  const handleUrlChange = useCallback(
    (platform: Platform, value: string) => {
      setUrls((u) => ({ ...u, [platform]: value }))
      if (debounceTimers.current[platform]) {
        clearTimeout(debounceTimers.current[platform]!)
      }
      if (value.trim().startsWith('http')) {
        debounceTimers.current[platform] = setTimeout(() => {
          void doSaveLink(platform, value)
        }, 750)
      }
    },
    [doSaveLink],
  )

  const handleUrlBlur = useCallback(
    (platform: Platform) => {
      const val = (urls[platform] ?? '').trim()
      const saved = content?.publications.find((p) => p.platform === platform)
      if (val && val !== saved?.publishedUrl) {
        if (debounceTimers.current[platform]) {
          clearTimeout(debounceTimers.current[platform]!)
        }
        void doSaveLink(platform, val)
      }
    },
    [content?.publications, doSaveLink, urls],
  )

  const handlePaste = useCallback(
    async (platform: Platform) => {
      try {
        const text = await navigator.clipboard.readText()
        if (text && text.trim()) {
          const trimmed = text.trim()
          setUrls((u) => ({ ...u, [platform]: trimmed }))
          await doSaveLink(platform, trimmed)
        }
      } catch {
        const val = window.prompt('Paste published link:')
        if (val && val.trim()) {
          const trimmed = val.trim()
          setUrls((u) => ({ ...u, [platform]: trimmed }))
          await doSaveLink(platform, trimmed)
        }
      }
    },
    [doSaveLink],
  )

  const handleAutoPasteAny = useCallback(async () => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      text = window.prompt('Paste published post URL:') || ''
    }
    const trimmed = text.trim()
    if (!trimmed) return
    const platform = detectPlatform(trimmed)
    setUrls((u) => ({ ...u, [platform]: trimmed }))
    await doSaveLink(platform, trimmed)
  }, [doSaveLink])

  const handleDownloadAllSeparate = useCallback(
    async (assetsList: Asset[]) => {
      if (!assetsList.length) return
      setDownloading(true)
      try {
        for (let i = 0; i < assetsList.length; i++) {
          const a = assetsList[i]!
          const link = document.createElement('a')
          link.href = assetDownloadUrl(a.id)
          link.download = a.originalName || `${content?.code || 'media'}_${i + 1}.${a.type === 'video' ? 'mp4' : 'jpg'}`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          if (i < assetsList.length - 1) {
            await new Promise((r) => setTimeout(r, 450))
          }
        }
      } finally {
        setTimeout(() => setDownloading(false), 1200)
      }
    },
    [content?.code],
  )

  const handleShareOrDownload = useCallback(
    async (assetsList: Asset[]) => {
      if (!assetsList.length) return
      setDownloading(true)

      const isSharingSupported =
        typeof navigator !== 'undefined' &&
        typeof navigator.share === 'function' &&
        typeof navigator.canShare === 'function'

      if (isSharingSupported) {
        try {
          // Use preloaded in-memory files if ready to preserve transient user activation on iOS Safari
          let files = preloadedFilesRef.current
          if (!files || files.length !== assetsList.length) {
            files = await Promise.all(
              assetsList.map(async (a, idx) => {
                const res = await fetch(assetDownloadUrl(a.id))
                const blob = await res.blob()
                const isVid = a.type === 'video' || (a.mime && a.mime.startsWith('video/'))
                const mime = isVid ? 'video/mp4' : (a.mime && a.mime.startsWith('image/') ? a.mime : 'image/jpeg')
                const ext = isVid ? 'mp4' : (mime.includes('png') ? 'png' : 'jpg')
                const name = `${content?.code || 'media'}_${idx + 1}.${ext}`
                return new File([blob], name, { type: mime })
              }),
            )
            preloadedFilesRef.current = files
          }

          if (navigator.canShare({ files })) {
            // Share pure files so iOS presents "Save X Images" directly into Camera Roll / Photos
            await navigator.share({ files })
            setDownloading(false)
            return
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            setDownloading(false)
            return
          }
          console.warn('Native share failed, falling back to direct download', err)
        }
      }

      // Fallback: direct download separate files (desktop / unsupported browsers)
      await handleDownloadAllSeparate(assetsList)
    },
    [content?.code, handleDownloadAllSeparate],
  )

  const handleAutoShareAndCopy = useCallback(
    async (assetsList: Asset[]) => {
      if (content?.caption) {
        try {
          await navigator.clipboard.writeText(content.caption)
          setCaptionCopied(true)
          setTimeout(() => setCaptionCopied(false), 3500)
        } catch {
          // ignore
        }
      }
      await handleShareOrDownload(assetsList)
    },
    [content?.caption, handleShareOrDownload],
  )

  // Auto-detect copied post link from clipboard when user returns to PublishFast
  useEffect(() => {
    async function checkClipboardOnReturn() {
      if (document.visibilityState !== 'visible') return
      try {
        if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
          const clipText = await navigator.clipboard.readText()
          if (clipText && clipText.trim().startsWith('http')) {
            const trimmed = clipText.trim()
            const detected = detectPlatform(trimmed)
            if (detected && content) {
              const alreadySaved = content.publications.find((p) => p.platform === detected)?.publishedUrl
              if (alreadySaved !== trimmed) {
                await doSaveLink(detected, trimmed)
                setToastNotice(`✓ Auto-detected & saved ${PLATFORM_LABELS[detected]} link from clipboard!`)
                setTimeout(() => setToastNotice(null), 4000)
              }
            }
          }
        }
      } catch {
        // Browser requires direct user click to read clipboard (handled by 1-tap paste button)
      }
    }

    window.addEventListener('visibilitychange', checkClipboardOnReturn)
    window.addEventListener('focus', checkClipboardOnReturn)
    return () => {
      window.removeEventListener('visibilitychange', checkClipboardOnReturn)
      window.removeEventListener('focus', checkClipboardOnReturn)
    }
  }, [content, doSaveLink])

  const handleDirectOpenPlatform = useCallback(
    async (platform: Platform) => {
      if (!content) return

      // 1. Auto-copy caption to clipboard
      if (content.caption) {
        try {
          await navigator.clipboard.writeText(content.caption)
          setCaptionCopied(true)
          setTimeout(() => setCaptionCopied(false), 3500)
        } catch (err) {
          console.warn('Failed to copy caption:', err)
        }
      }

      // 2. Trigger media download so files are on user's device
      if (content.assets?.length) {
        const vids = content.assets.filter((a) => a.type === 'video')
        const imgs = content.assets.filter((a) => a.type === 'image')

        if (content.contentType === 'video' && vids.length > 0) {
          const v = vids[0]!
          const link = document.createElement('a')
          link.href = assetDownloadUrl(v.id)
          link.download = v.originalName || `${content.code || 'video'}.mp4`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
        } else if (imgs.length > 0) {
          void handleDownloadAllSeparate(imgs)
        }
      }

      setToastNotice(`✓ Caption copied! Opening ${PLATFORM_LABELS[platform]}…`)
      setTimeout(() => setToastNotice(null), 3500)

      // 3. Launch Native App via Deep Link with web fallback
      const { appUrl, webUrl } = getPlatformDeepLink(platform)
      if (appUrl) {
        const start = Date.now()
        window.location.href = appUrl
        setTimeout(() => {
          if (document.visibilityState === 'visible' && Date.now() - start < 2400) {
            window.open(webUrl, '_blank')
          }
        }, 1400)
      } else {
        window.open(webUrl, '_blank')
      }
    },
    [content, handleDownloadAllSeparate],
  )

  async function complete() {
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      await api.complete(content.id)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete post')
      setBusy(false)
    }
  }

  async function release() {
    if (!content) return
    if (!confirm('Return this post back to the queue for someone else?')) return
    setBusy(true)
    try {
      await api.release(content.id)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to return post')
      setBusy(false)
    }
  }

  if (loading) return <Spinner />
  if (!content) {
    return (
      <div className="page stack">
        <Snackbar
          message={error ?? 'Post not found or inaccessible'}
          kind="error"
          onClose={() => setError(null)}
        />
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('/')}>
          ← Back
        </button>
        <Empty>Post not found. It may have been claimed or removed.</Empty>
      </div>
    )
  }

  const videos = content.assets.filter((a) => a.type === 'video')
  const images = content.assets.filter((a) => a.type === 'image')
  const savedCount = content.publications.filter((p) => p.publishedUrl).length
  const videosTotalSize = videos.reduce((sum, v) => sum + v.size, 0)
  const imagesTotalSize = images.reduce((sum, img) => sum + img.size, 0)
  const allMedia = videos.length > 0 ? videos : images

  return (
    <div className="page stack">
      <div className="mode-toggle-bar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          ← Back
        </button>

        <div className="mode-toggle" role="tablist" aria-label="Workflow Mode">
          <button
            type="button"
            className={`mode-toggle-btn ${mode === 'direct' ? 'active' : ''}`}
            onClick={() => setMode('direct')}
            role="tab"
            aria-selected={mode === 'direct'}
          >
            🚀 Direct 1-Tap
          </button>
          <button
            type="button"
            className={`mode-toggle-btn ${mode === 'auto' ? 'active' : ''}`}
            onClick={() => setMode('auto')}
            role="tab"
            aria-selected={mode === 'auto'}
          >
            ⚡ Fast Auto (2 Steps)
          </button>
          <button
            type="button"
            className={`mode-toggle-btn ${mode === 'manual' ? 'active' : ''}`}
            onClick={() => setMode('manual')}
            role="tab"
            aria-selected={mode === 'manual'}
          >
            🛠️ Manual (3 Steps)
          </button>
        </div>
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <div className="row-tight">
          <span className="code">{content.code}</span>
          <ContentTypeBadge contentType={content.contentType} assetCount={content.assets?.length} />
          <StatusBadge status={content.status} />
        </div>
        {content.title && <h1>{content.title}</h1>}
      </div>

      {error && <Snackbar message={error} kind="error" onClose={() => setError(null)} />}
      {toastNotice && <Snackbar message={toastNotice} kind="ok" onClose={() => setToastNotice(null)} />}

      {/* ==================== DIRECT 1-TAP MODE ==================== */}
      {mode === 'direct' && (
        <>
          {/* Quick Guide Card */}
          <div className="guide-card" aria-label="Direct 1-tap workflow guide">
            <div className="guide-title">🚀 1-Tap Direct App Posting:</div>
            <p className="hint" style={{ margin: 0, fontSize: '0.86rem' }}>
              Tap any platform below to copy the caption, prepare media, and jump directly into the app. When you return with your copied post link, PublishFast auto-detects and saves it!
            </p>
          </div>

          {/* Media Quick Actions & Thumbnail Preview */}
          {content.assets.length > 0 && (
            <div className="card stack" style={{ gap: 12 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 650, fontSize: '0.95rem' }}>Attached Media</span>
                  <span className="badge">
                    {videos.length > 0 ? `${videos.length} Video` : `${images.length} Images`}
                  </span>
                </div>

                <div className="row" style={{ gap: 8 }}>
                  <CopyButton
                    text={content.caption || ''}
                    label="📋 Copy Caption"
                    className="btn btn-ghost btn-sm"
                  />

                  {videos.length > 0 ? (
                    <a
                      href={assetDownloadUrl(videos[0]!.id)}
                      download={videos[0]!.originalName || 'video.mp4'}
                      className="btn btn-sm btn-outline"
                      style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      ⬇️ Download Video ({formatBytes(videosTotalSize)})
                    </a>
                  ) : (
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline"
                        onClick={() => void handleDownloadAllSeparate(images)}
                        disabled={downloading}
                      >
                        {downloading ? '⏳ Downloading…' : `⬇️ Download All (${images.length} imgs)`}
                      </button>
                      <a
                        href={zipUrl(content.id)}
                        className="btn btn-sm btn-ghost"
                        title="Download all as ZIP archive"
                        style={{ textDecoration: 'none' }}
                      >
                        📦 ZIP
                      </a>
                    </div>
                  )}
                </div>
              </div>

              {/* Media preview */}
              {images.length > 0 && (
                <div className="carousel-scroll-gallery" aria-label="Carousel image sequence">
                  {images.map((img, idx) => (
                    <a
                      key={img.id}
                      href={assetUrl(img.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="carousel-scroll-item"
                      title={`Slide ${idx + 1}: ${img.originalName} (tap to view full)`}
                    >
                      <img className="carousel-scroll-img" src={assetUrl(img.id)} alt={img.originalName} loading="lazy" />
                      <span className="carousel-scroll-badge">{idx + 1}</span>
                    </a>
                  ))}
                </div>
              )}

              {videos.length > 0 && (
                <div>
                  {videos.map((v) => (
                    <video key={v.id} className="media" src={assetUrl(v.id)} controls preload="metadata" playsInline />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Top Auto-Paste from Clipboard Button */}
          <button
            type="button"
            className="btn-auto-paste"
            onClick={() => void handleAutoPasteAny()}
          >
            <PasteIcon />
            <span>📋 Auto-Detect & Paste Link from Clipboard</span>
          </button>

          {/* Platform Cards */}
          <div className="direct-platforms-grid">
            {PLATFORM_ORDER.map((platform) => {
              const saved = content.publications.find((p) => p.platform === platform)
              const isSaved = !!saved?.publishedUrl
              const currentUrl = urls[platform] ?? saved?.publishedUrl ?? ''
              const status = saveStatus[platform] ?? 'idle'

              return (
                <div key={platform} className={`direct-platform-card ${isSaved ? 'saved' : ''}`}>
                  <div className="direct-platform-header">
                    <div className="direct-platform-brand">
                      <div className={`direct-platform-icon ${platform}`}>
                        <PlatformIcon platform={platform} />
                      </div>
                      <div>
                        <div className="direct-platform-name">{PLATFORM_LABELS[platform]}</div>
                        <div style={{ fontSize: '0.78rem', color: isSaved ? 'var(--accent)' : 'var(--text-soft)' }}>
                          {isSaved ? '✓ Published live' : 'Ready to post'}
                        </div>
                      </div>
                    </div>

                    {isSaved ? (
                      <span className="badge badge-published" style={{ gap: 4 }}>
                        ✓ Published
                      </span>
                    ) : (
                      <span className="badge badge-ready">Ready</span>
                    )}
                  </div>

                  {isSaved && saved?.publishedUrl && (
                    <div className="direct-link-display">
                      <a
                        href={saved.publishedUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate"
                        style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none', flex: 1 }}
                        title={saved.publishedUrl}
                      >
                        {saved.publishedUrl} ↗
                      </a>
                      <span className="hint" style={{ flexShrink: 0, fontSize: '0.75rem' }}>
                        {saved.publishedAt ? formatDate(saved.publishedAt) : ''}
                      </span>
                    </div>
                  )}

                  <div className="direct-platform-actions">
                    <button
                      type="button"
                      className={`btn-direct-open ${isSaved ? 'btn-direct-reopen' : ''}`}
                      onClick={() => void handleDirectOpenPlatform(platform)}
                      title={`Copy caption, prepare media, and open ${PLATFORM_LABELS[platform]}`}
                    >
                      {isSaved ? (
                        <>
                          <span>🔄 Re-open in {PLATFORM_LABELS[platform]}</span>
                        </>
                      ) : (
                        <>
                          <span>🚀 Open {PLATFORM_LABELS[platform]}</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      className="btn-direct-paste"
                      onClick={() => void handlePaste(platform)}
                      disabled={status === 'saving'}
                      title={`Paste copied link for ${PLATFORM_LABELS[platform]}`}
                    >
                      {status === 'saving' ? (
                        <span>Saving…</span>
                      ) : isSaved ? (
                        <>
                          <PasteIcon />
                          <span>Update Link</span>
                        </>
                      ) : (
                        <>
                          <PasteIcon />
                          <span>Paste Link</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="row-tight" style={{ marginTop: 2 }}>
                    <input
                      className="input input-sm"
                      type="url"
                      placeholder={`Or enter ${PLATFORM_LABELS[platform]} URL manually…`}
                      value={currentUrl}
                      onChange={(e) => handleUrlChange(platform, e.target.value)}
                      onBlur={() => handleUrlBlur(platform)}
                      style={{ fontSize: '0.8rem' }}
                      disabled={status === 'saving'}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ==================== AUTO MODE (2 STEPS) ==================== */}
      {mode === 'auto' && (
        <>
          {/* Quick 2-step Guide Card */}
          <div className="guide-card" aria-label="Auto workflow guide">
            <div className="guide-title">⚡ Fast 2-Step Publishing:</div>
            <div className="guide-steps">
              <div className="guide-step">
                <div className="guide-step-badge">1</div>
                <div className="guide-step-body">
                  <strong>1-Tap Share & Copy</strong>
                  <span>Auto-copies caption + opens TikTok/IG share sheet to post</span>
                </div>
              </div>

              <div className="guide-step">
                <div className="guide-step-badge">2</div>
                <div className="guide-step-body">
                  <strong>Paste Live Link</strong>
                  <span>Auto-detects platform and saves your live post link</span>
                </div>
              </div>
            </div>
          </div>

          {/* Step 1: 1-Tap Share & Copy */}
          {content.assets.length > 0 && (
            <div className="card">
              <div className="step-split">
                <div className="step-split-left">
                  <div className="step-header">
                    <span className="step-badge">Step 1</span>
                    <h2>1-Tap Share & Copy</h2>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-step-action"
                    style={{ padding: '15px 18px' }}
                    onClick={() => void handleAutoShareAndCopy(allMedia)}
                    disabled={downloading}
                  >
                    <span className="btn-step-title" style={{ fontSize: '1rem' }}>
                      {downloading ? '⏳ Preparing & Copying…' : '⚡ Share & Copy Caption'}
                    </span>
                    <span className="btn-step-sub">
                      {videos.length > 0
                        ? `Auto-copies caption + shares video (${formatBytes(videosTotalSize)})`
                        : `Auto-copies caption + shares ${images.length} images (${formatBytes(imagesTotalSize)})`}
                    </span>
                  </button>

                  {captionCopied && (
                    <div className="center-note" style={{ color: 'var(--accent)', fontWeight: 600, fontSize: '0.82rem', padding: '6px 0' }}>
                      ✓ Caption copied to clipboard!
                    </div>
                  )}
                </div>

                <div className="step-split-right">
                  {videos.map((v) => (
                    <video key={v.id} className="media" src={assetUrl(v.id)} controls preload="metadata" playsInline />
                  ))}

                  {images.length > 0 && (
                    <div className="carousel-scroll-gallery" aria-label="Carousel image sequence">
                      {images.map((img, idx) => (
                        <a
                          key={img.id}
                          href={assetUrl(img.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="carousel-scroll-item"
                          title={`Slide ${idx + 1}: ${img.originalName} (tap to view full)`}
                        >
                          <img className="carousel-scroll-img" src={assetUrl(img.id)} alt={img.originalName} loading="lazy" />
                          <span className="carousel-scroll-badge">{idx + 1}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Auto Paste & Platform Links */}
          <div className="card stack">
            <div className="stack" style={{ gap: 6 }}>
              <div className="step-header">
                <span className="step-badge">Step 2</span>
                <h2>Publish & Paste Live Link</h2>
              </div>
              <p className="hint">
                After publishing on your channel, copy the post link and tap below to auto-save.
              </p>
            </div>

            <button type="button" className="btn-auto-paste" onClick={() => void handleAutoPasteAny()}>
              <PasteIcon />
              <span>📋 Auto-Detect & Paste Copied Link</span>
            </button>

            <div className="link-rows" style={{ marginTop: 4 }}>
              {PLATFORM_ORDER.map((platform) => {
                const saved = content.publications.find((p) => p.platform === platform)
                const status = saveStatus[platform]
                const isSaved = !!saved?.publishedUrl && (urls[platform] ?? '').trim() === saved.publishedUrl

                return (
                  <div className="link-row" key={platform}>
                    <label className="link-row-label" htmlFor={`url-auto-${platform}`}>
                      <PlatformIcon platform={platform} />
                      <span>{PLATFORM_LABELS[platform]}</span>
                    </label>
                    <div className="link-row-input-wrap">
                      <input
                        id={`url-auto-${platform}`}
                        className="input link-row-input"
                        type="url"
                        inputMode="url"
                        placeholder="Paste live link (https://…)"
                        value={urls[platform] ?? ''}
                        onChange={(e) => handleUrlChange(platform, e.target.value)}
                        onBlur={() => handleUrlBlur(platform)}
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm paste-btn"
                        onClick={() => void handlePaste(platform)}
                        title="Paste from clipboard"
                      >
                        {status === 'saving' ? (
                          <span className="save-indicator saving">Saving…</span>
                        ) : status === 'saved' || isSaved ? (
                          <span className="save-indicator saved" title="Saved">
                            ✓
                          </span>
                        ) : (
                          <>
                            <PasteIcon />
                            <span>Paste</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* ==================== MANUAL MODE (3 STEPS) ==================== */}
      {mode === 'manual' && (
        <>
          {/* 3-step quick guide */}
          <div className="guide-card" aria-label="Manual workflow guide">
            <div className="guide-title">🛠️ Manual 3-Step Publishing:</div>
            <div className="guide-steps">
              <div className="guide-step">
                <div className="guide-step-badge">1</div>
                <div className="guide-step-body">
                  <strong>Download Media</strong>
                  <span>Save video or carousel images to your device</span>
                </div>
              </div>

              <div className="guide-step">
                <div className="guide-step-badge">2</div>
                <div className="guide-step-body">
                  <strong>Copy Caption & Customize</strong>
                  <span>Copy caption, add trending audio, stickers & tags in the app</span>
                </div>
              </div>

              <div className="guide-step">
                <div className="guide-step-badge">3</div>
                <div className="guide-step-body">
                  <strong>Publish & Paste Live Link</strong>
                  <span>Publish on your channel, copy the live post link, and paste below</span>
                </div>
              </div>
            </div>
          </div>

          {/* Step 1: Media */}
          {content.assets.length > 0 && (
            <div className="card">
              <div className="step-split">
                <div className="step-split-left">
                  <div className="step-header">
                    <span className="step-badge">Step 1</span>
                    <h2>Download Media</h2>
                  </div>
                  <div className="stack" style={{ gap: 8 }}>
                    {videos.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-primary btn-step-action"
                        onClick={() => void handleDownloadAllSeparate(videos)}
                        disabled={downloading}
                      >
                        <span className="btn-step-title">
                          {downloading ? '⏳ Downloading…' : '⬇ Download Video'}
                        </span>
                        <span className="btn-step-sub">
                          {videos.length === 1 ? '1 video' : `${videos.length} videos`} • {formatBytes(videosTotalSize)}
                        </span>
                      </button>
                    )}
                    {images.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-primary btn-step-action"
                        onClick={() => void handleDownloadAllSeparate(images)}
                        disabled={downloading}
                      >
                        <span className="btn-step-title">
                          {downloading ? '⏳ Downloading…' : '⬇ Download All Images'}
                        </span>
                        <span className="btn-step-sub">
                          {images.length === 1 ? '1 image' : `${images.length} separate images`} • {formatBytes(imagesTotalSize)}
                        </span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="step-split-right">
                  {videos.map((v) => (
                    <video key={v.id} className="media" src={assetUrl(v.id)} controls preload="metadata" playsInline />
                  ))}

                  {images.length > 0 && (
                    <div className="carousel-scroll-gallery" aria-label="Carousel image sequence">
                      {images.map((img, idx) => (
                        <a
                          key={img.id}
                          href={assetUrl(img.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="carousel-scroll-item"
                          title={`Slide ${idx + 1}: ${img.originalName} (tap to view full)`}
                        >
                          <img className="carousel-scroll-img" src={assetUrl(img.id)} alt={img.originalName} loading="lazy" />
                          <span className="carousel-scroll-badge">{idx + 1}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Caption */}
          {content.caption && (
            <div className="card">
              <div className="step-split">
                <div className="step-split-left">
                  <div className="step-header">
                    <span className="step-badge">Step 2</span>
                    <h2>Copy Caption</h2>
                  </div>
                  <CopyButton
                    text={content.caption}
                    className="btn btn-primary btn-step-action"
                    label="📋 Copy Caption"
                  />
                </div>

                <div className="step-split-right">
                  <div className="caption-box" style={{ margin: 0 }}>
                    {content.caption}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Links */}
          <div className="card stack">
            <div className="stack" style={{ gap: 3 }}>
              <div className="step-header">
                <span className="step-badge">Step 3</span>
                <h2>Publish & Paste Live Links</h2>
              </div>
              <p className="hint">
                After publishing natively, copy the live post URL and paste it here. Links are saved automatically.
              </p>
            </div>

            <div className="link-rows">
              {PLATFORM_ORDER.map((platform) => {
                const saved = content.publications.find((p) => p.platform === platform)
                const status = saveStatus[platform]
                const isSaved = !!saved?.publishedUrl && (urls[platform] ?? '').trim() === saved.publishedUrl

                return (
                  <div className="link-row" key={platform}>
                    <label className="link-row-label" htmlFor={`url-manual-${platform}`}>
                      <PlatformIcon platform={platform} />
                      <span>{PLATFORM_LABELS[platform]}</span>
                    </label>
                    <div className="link-row-input-wrap">
                      <input
                        id={`url-manual-${platform}`}
                        className="input link-row-input"
                        type="url"
                        inputMode="url"
                        placeholder="Paste live post link (https://…)"
                        value={urls[platform] ?? ''}
                        onChange={(e) => handleUrlChange(platform, e.target.value)}
                        onBlur={() => handleUrlBlur(platform)}
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm paste-btn"
                        onClick={() => void handlePaste(platform)}
                        title="Paste from clipboard"
                      >
                        {status === 'saving' ? (
                          <span className="save-indicator saving">Saving…</span>
                        ) : status === 'saved' || isSaved ? (
                          <span className="save-indicator saved" title="Saved">
                            ✓
                          </span>
                        ) : (
                          <>
                            <PasteIcon />
                            <span>Paste</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* ---- finish ---- */}
      {content.status === 'CLAIMED' && (
        <div className="stack">
          <button className="btn btn-primary btn-lg btn-block" onClick={complete} disabled={busy || savedCount === 0}>
            {busy ? 'Saving…' : 'Complete'}
          </button>
          {savedCount === 0 && <p className="hint">Please paste at least one published link before completing.</p>}
          <button className="btn btn-danger btn-block" onClick={release} disabled={busy}>
            Return post to queue
          </button>
        </div>
      )}

      {content.status === 'PUBLISHED' && <Alert kind="ok">This post has been published. Thank you!</Alert>}
    </div>
  )
}

function PlatformIcon({ platform }: { platform: Platform }) {
  switch (platform) {
    case 'tiktok':
      return <TikTokIcon />
    case 'instagram':
      return <InstagramIcon />
    case 'youtube_shorts':
      return <YouTubeIcon />
    case 'facebook':
      return <FacebookIcon />
    default:
      return <LinkIcon />
  }
}

function TikTokIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64c.298-.002.595.042.88.13V9.4a6.33 6.33 0 0 0-1-.08A6.34 6.34 0 0 0 3 15.66a6.34 6.34 0 0 0 10.82 4.49 6.27 6.27 0 0 0 1.96-4.51V8.5a8.28 8.28 0 0 0 5.06 1.72v-3.53Z" />
    </svg>
  )
}

function InstagramIcon({ size = 18 }: { size?: number }) {
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
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  )
}

function YouTubeIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  )
}

function FacebookIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  )
}

function LinkIcon({ size = 18 }: { size?: number }) {
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
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function PasteIcon({ size = 14 }: { size?: number }) {
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
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  )
}
