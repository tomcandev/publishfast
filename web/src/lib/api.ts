export type Role = 'admin' | 'kol'
export type ContentStatus = 'DRAFT' | 'READY' | 'CLAIMED' | 'PUBLISHED' | 'FAILED'
export type Platform = 'tiktok' | 'instagram' | 'youtube_shorts' | 'youtube' | 'facebook' | 'other'

export interface User {
  id: string
  username: string
  email: string | null
  displayName: string
  role: Role
  active: boolean
  notes?: string | null
  bioLink?: string | null
  assignedOnly?: boolean
  createdAt: string
}

export interface Asset {
  id: string
  contentId: string
  originalName: string
  mime: string
  size: number
  sortOrder: number
  type: 'video' | 'image' | 'file'
  /** Set when the media prune deleted the file (after the post was done); downloads answer 410. */
  prunedAt?: string | null
}

/** The files that still exist (not removed by the media prune). */
export const liveAssets = (assets: Asset[]) => assets.filter((a) => !a.prunedAt)

/** The newest prune date among an item's files, or null when none was pruned. */
export function mediaRemovedAt(assets: Asset[]) {
  const dates = assets.map((a) => a.prunedAt).filter((d): d is string => !!d)
  return dates.length ? dates.sort().at(-1)! : null
}

export interface Publication {
  id: string
  contentId: string
  userId: string
  platform: Platform
  status: string
  publishedUrl: string | null
  publishedAt: string | null
  views?: number
  likes?: number
  comments?: number
  shares?: number
  /** TikTok's save count, when read or sent. */
  saves?: number | null
  lastCheckedAt?: string | null
  metricError?: string | null
  soundId?: string | null
  soundTitle?: string | null
  soundAuthor?: string | null
  soundOriginal?: boolean | null
}

/** One row of the sound ranking (GET /api/sounds). */
export interface RankedSound {
  id: string
  title: string | null
  author: string | null
  original: boolean
  url: string | null
  copyText: string
  status: 'active' | 'hidden'
  /** Admins only. */
  note?: string | null
  ours: { posts: number; medianRatio: number | null; enough: boolean }
  sightings: {
    count: number
    bestPlays: number
    bestRank: number | null
    sources: string[]
    newestVideoUrl: string | null
    bestVideoUrl: string | null
    bestVideoPlays: number | null
  }
  score: number
  lastSeenAt: string
}

export interface StorageReport {
  byStatus: { status: ContentStatus; files: number; bytes: number }[]
  pruned: { files: number; bytes: number }
  dropBox: { files: number; bytes: number }
  unfinishedUploads: { uploads: number; bytes: number }
  disk: { freeBytes: number; totalBytes: number } | null
  prune: { afterDays: number | null }
}

export interface Content {
  id: string
  code: string
  title: string | null
  caption: string | null
  contentType: 'video' | 'carousel'
  status: ContentStatus
  assignedUserId: string | null
  /** When set, the assignment ends then and the item goes back to the open queue. */
  assignExpiresAt?: string | null
  claimedBy: string | null
  claimedAt: string | null
  hookId?: string | null
  /** When the post should go public on its platform. */
  publishAt?: string | null
  releaseAt?: string | null
  /** Per-platform details from the pipeline, e.g. meta.youtube.title. */
  meta?: ContentMeta | null
  source?: string | null
  /** Who holds the claim: an agent's token or a person's session. */
  claimedVia?: 'token' | 'session' | null
  claimedByTokenName?: string | null
  createdAt: string
  assets: Asset[]
  publications: Publication[]
}

export interface ContentMeta {
  youtube?: { title?: string; description?: string; tags?: string[] }
  [key: string]: unknown
}

export interface HookPerformanceItem {
  hookId: string
  title: string
  category: string
  totalPosts: number
  totalViews: number
  totalLikes: number
  avgViews: number
  topPostUrl?: string
  status: 'viral' | 'good' | 'average' | 'underperforming' | 'new'
  recommendation: string
}

export interface MetricSummary {
  summary: {
    totalPublications: number
    totalViews: number
    totalLikes: number
    avgViewsPerPost: number
  }
  kols?: {
    totalKols: number
    postedKols: Array<{ id: string; username: string; displayName: string; postCount: number }>
    missingKols: Array<{ id: string; username: string; displayName: string }>
  }
  hooks: HookPerformanceItem[]
  posts: Array<{
    publicationId: string
    contentId: string
    userId?: string
    username?: string
    displayName?: string
    code: string
    title: string
    hookId: string
    hookTitle?: string
    platform: Platform
    publishedUrl: string
    publishedAt: string | null
    views: number
    likes: number
    comments: number
    lastCheckedAt: string | null
  }>
}

export interface Stats {
  available: number
  claimed: number
  published: number
}

export interface ReminderSettingsData {
  enabled: boolean
  reminderTimes: string[]
  timezone: string
  hasSubscription: boolean
  subscriptionCount: number
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })

  if (res.status === 204) return undefined as T

  const text = await res.text()
  const data = text ? JSON.parse(text) : {}

  if (!res.ok) {
    throw new ApiError(data.error ?? `Error ${res.status}`, res.status, data.reason)
  }
  return data as T
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube_shorts: 'YouTube Shorts',
  youtube: 'YouTube',
  facebook: 'Facebook',
  other: 'Other',
}

export const STATUS_LABELS: Record<ContentStatus, string> = {
  DRAFT: 'Draft',
  READY: 'Ready',
  CLAIMED: 'In Progress',
  PUBLISHED: 'Published',
  FAILED: 'Failed',
}

export const api = {
  login: (identifier: string, password: string) =>
    request<{ user: User; sessionToken?: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    }),

  switchAccount: (sessionToken: string) =>
    request<{ user: User; sessionToken: string }>('/api/auth/switch', {
      method: 'POST',
      body: JSON.stringify({ sessionToken }),
    }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  updateProfile: (data: { displayName?: string; email?: string | null; bioLink?: string | null }) =>
    request<{ user: User }>('/api/me', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  vapidKey: () => request<{ publicKey: string }>('/api/notifications/vapid-key'),

  notificationSettings: () => request<ReminderSettingsData>('/api/notifications/settings'),

  updateNotificationSettings: (input: { enabled: boolean; reminderTimes: string[]; timezone?: string }) =>
    request<{ ok: true; enabled: boolean; reminderTimes: string[]; timezone: string }>(
      '/api/notifications/settings',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),

  subscribePush: (input: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ ok: true }>('/api/notifications/subscribe', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  unsubscribePush: (input: { endpoint: string }) =>
    request<{ ok: true }>('/api/notifications/unsubscribe', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  testNotification: () =>
    request<{ ok: true; sentTo: number }>('/api/notifications/test', {
      method: 'POST',
    }),

  resetNotifications: () =>
    request<{ ok: true; cleared: number }>('/api/notifications/reset', {
      method: 'POST',
    }),

  me: () => request<{ user: User }>('/api/me'),

  stats: () => request<Stats>('/api/contents/stats'),

  contents: (status?: ContentStatus) =>
    request<{ contents: Content[] }>(`/api/contents${status ? `?status=${status}` : ''}`),

  content: (id: string) => request<{ content: Content }>(`/api/contents/${id}`),

  claimNext: () => request<{ content: Content }>('/api/contents/claim-next', { method: 'POST' }),

  claim: (id: string) => request<{ content: Content }>(`/api/contents/${id}/claim`, { method: 'POST' }),

  release: (id: string) => request<{ ok: true }>(`/api/contents/${id}/release`, { method: 'POST' }),

  complete: (id: string) =>
    request<{ content: Content }>(`/api/contents/${id}/complete`, { method: 'POST' }),

  history: () => request<{ contents: Content[] }>('/api/history'),

  savePublication: (input: { contentId: string; platform: Platform; publishedUrl: string }) =>
    request<{ publication: Publication }>('/api/publications', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deletePublication: (id: string) =>
    request<{ ok: true }>(`/api/publications/${id}`, { method: 'DELETE' }),

  sounds: (window: 7 | 14 | 30 = 14, opts: { limit?: number; hidden?: boolean } = {}) =>
    request<{ window: number; sounds: RankedSound[] }>(
      `/api/sounds?window=${window}&limit=${opts.limit ?? 50}${opts.hidden ? '&hidden=1' : ''}`,
    ),

  soundFromLink: (videoUrl: string) =>
    request<{ status: 'recorded' | 'known'; reason?: string; sound: { id: string; title?: string | null; author?: string | null; copyText?: string } }>(
      '/api/sounds/from-link',
      { method: 'POST', body: JSON.stringify({ videoUrl }) },
    ),

  admin: {
    updateSound: (id: string, patch: { status?: 'active' | 'hidden'; note?: string | null }) =>
      request<{ sound: { id: string; status: 'active' | 'hidden'; note: string | null } }>(
        `/api/admin/sounds/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      ),
    storage: () => request<StorageReport>('/api/admin/storage'),
    users: () => request<{ users: User[] }>('/api/admin/users'),
    createUser: (input: {
      username: string
      password: string
      email?: string
      displayName?: string
      role: Role
      notes?: string
      bioLink?: string
    }) => request<{ user: User }>('/api/admin/users', { method: 'POST', body: JSON.stringify(input) }),
    updateUser: (
      id: string,
      patch: Partial<{
        active: boolean
        role: Role
        password: string
        displayName: string
        email: string | null
        notes: string | null
        bioLink: string | null
      }>,
    ) => request<{ user: User }>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    getUserNotificationStatus: (userId: string) =>
      request<{
        subscriptionCount: number
        enabled: boolean
        reminderTimes: string[]
        lastNotifiedDate: string | null
      }>(`/api/admin/users/${userId}/notifications`),
    resetUserNotifications: (userId: string) =>
      request<{ ok: true; cleared: number }>(`/api/admin/users/${userId}/reset-notifications`, {
        method: 'POST',
      }),

    contents: () => request<{ contents: Content[] }>('/api/admin/contents'),
    updateContent: (
      id: string,
      patch: Partial<{
        code: string
        status: ContentStatus
        title: string | null
        caption: string | null
        contentType: 'video' | 'carousel'
        assignedUserId: string | null
      }>,
    ) =>
      request<{ content: Content }>(`/api/admin/contents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    deleteContent: (id: string) => request<{ ok: true }>(`/api/admin/contents/${id}`, { method: 'DELETE' }),
    bulkDeleteContents: (ids: string[]) =>
      request<{ deleted: number }>('/api/admin/contents/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    bulkUpdateContentStatus: (ids: string[], status: ContentStatus) =>
      request<{ updated: number }>('/api/admin/contents/bulk-status', {
        method: 'POST',
        body: JSON.stringify({ ids, status }),
      }),
    releaseStale: (hours: number) =>
      request<{ released: number }>('/api/admin/release-stale', {
        method: 'POST',
        body: JSON.stringify({ hours }),
      }),

    tokens: () =>
      request<{ tokens: { id: string; name: string; role: Role; createdAt: string; lastUsedAt: string | null }[] }>(
        '/api/admin/tokens',
      ),
    createToken: (name: string) =>
      request<{ token: string }>('/api/admin/tokens', { method: 'POST', body: JSON.stringify({ name }) }),
    deleteToken: (id: string) => request<{ ok: true }>(`/api/admin/tokens/${id}`, { method: 'DELETE' }),

    createContent: (input: { code: string; title?: string; caption?: string; contentType: 'video' | 'carousel'; status: 'DRAFT' | 'READY' }) =>
      request<{ content: Content }>('/api/ingest/contents', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    uploadAssets: async (contentId: string, files: FileList | File[]) => {
      const form = new FormData()
      Array.from(files).forEach((file, i) => form.append(`file${i}`, file))
      const res = await fetch(`/api/ingest/contents/${contentId}/assets`, {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new ApiError(data.error ?? 'Upload failed', res.status)
      return data as { assets: Asset[] }
    },

    metrics: () => request<MetricSummary>('/api/admin/metrics'),
    syncMetrics: () =>
      request<{ totalChecked: number; updated: number; errors: number; summary: MetricSummary }>(
        '/api/admin/metrics/sync',
        { method: 'POST' },
      ),
    updatePublicationMetrics: (
      id: string,
      patch: { views?: number; likes?: number; comments?: number; shares?: number },
    ) =>
      request<{ publication: Publication }>(`/api/admin/publications/${id}/metrics`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
  },
}

export const assetUrl = (id: string) => `/api/assets/${id}`
export const assetDownloadUrl = (id: string) => `/api/assets/${id}/download`
export const zipUrl = (contentId: string) => `/api/contents/${contentId}/assets.zip`
