import { existsSync } from 'node:fs'
import { join } from 'node:path'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { config, repoRoot } from './lib/config.js'
import { attachIdentity } from './lib/guards.js'
import { adminRoutes } from './routes/admin.js'
import { assetRoutes } from './routes/assets.js'
import { authRoutes } from './routes/auth.js'
import { contentRoutes } from './routes/contents.js'
import { ingestRoutes } from './routes/ingest.js'
import { notificationRoutes } from './routes/notifications.js'
import { publicationRoutes } from './routes/publications.js'

/**
 * Builds the Fastify app without listening, so tests can drive it with
 * `app.inject()`. index.ts adds the migration, schedulers and the listener.
 */
export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.isProd ? 'info' : 'warn' },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true, // behind the Cloudflare Tunnel
  })

  await app.register(cookie)
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 20 },
  })

  app.addHook('preHandler', attachIdentity)

  await app.register(authRoutes)
  await app.register(contentRoutes)
  await app.register(publicationRoutes)
  await app.register(assetRoutes)
  await app.register(ingestRoutes)
  await app.register(adminRoutes)
  await app.register(notificationRoutes)

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
