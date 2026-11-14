import { existsSync } from 'node:fs'
import { join } from 'node:path'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { config, repoRoot } from './lib/config.js'
import { recordTokenEvent } from './lib/audit.js'
import { attachIdentity } from './lib/guards.js'
import { adminRoutes } from './routes/admin.js'
import { assetRoutes } from './routes/assets.js'
import { authRoutes } from './routes/auth.js'
import { contentRoutes } from './routes/contents.js'
import { exportRoutes } from './routes/export.js'
import { fileRoutes } from './routes/files.js'
import { ingestRoutes } from './routes/ingest.js'
import { notificationRoutes } from './routes/notifications.js'
import { publicationMetricRoutes } from './routes/publicationMetrics.js'
import { publicationRoutes } from './routes/publications.js'
import { uploadRoutes } from './routes/uploads.js'

/**
 * Builds the Fastify app without listening, so tests can drive it with
 * `app.inject()`. index.ts adds the migration, schedulers and the listener.
 */
export async function buildApp(
  opts: { logger?: boolean; onRoute?: (route: { method: string | string[]; url: string }) => void } = {},
) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.isProd ? 'info' : 'warn' },
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: config.requestTimeoutMs,
    trustProxy: true, // behind the Cloudflare Tunnel
  })

  // Lets tests enumerate every route, so the scope allow-list is checked against all of them.
  if (opts.onRoute) app.addHook('onRoute', opts.onRoute)

  await app.register(cookie)
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 20 },
  })

  // Resolves the caller and enforces the token-scope allow-list (lib/scopes.ts)
  // before any route's own guard runs.
  app.addHook('preHandler', attachIdentity)
  // One token_events row per successful state-changing call made with a token.
  app.addHook('onSend', async (req, reply, payload) => {
    recordTokenEvent(req, reply)
    return payload
  })

  await app.register(authRoutes)
  await app.register(contentRoutes)
  await app.register(publicationRoutes)
  await app.register(assetRoutes)
  await app.register(ingestRoutes)
  await app.register(adminRoutes)
  await app.register(notificationRoutes)
  await app.register(publicationMetricRoutes)
  await app.register(exportRoutes)
  await app.register(fileRoutes)
  await app.register(uploadRoutes)

  app.get('/api/health', async () => ({ ok: true }))

  // Serve the built SPA when it exists (production); in dev, Vite serves it.
  const webDist = join(repoRoot, 'web', 'dist')
  if (existsSync(webDist)) {
    // index must be enabled, otherwise a request for "/" is treated as a
    // directory listing and rejected with 403 before the SPA can load.
    await app.register(fastifyStatic, { root: webDist, index: ['index.html'] })

    app.setNotFoundHandler((req, reply) => {
      // API 404s stay JSON; everything else falls through to the SPA router.
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' })
      }
      return reply.sendFile('index.html')
    })
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'Not found' }))
  }

  return app
}
