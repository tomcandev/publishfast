import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const here = dirname(fileURLToPath(import.meta.url))
/** Repo root — src/lib -> src -> server -> repo */
export const repoRoot = resolve(here, '../../..')

dotenv.config({ path: join(repoRoot, '.env') })

function resolveFromRoot(p: string) {
  return isAbsolute(p) ? p : resolve(repoRoot, p)
}

const dataDir = resolveFromRoot(process.env.DATA_DIR ?? './data')

export const config = {
  port: Number(process.env.PORT ?? 8055),
  host: process.env.HOST ?? '127.0.0.1',
  publicUrl: (process.env.PUBLIC_URL ?? 'http://localhost:8055').replace(/\/$/, ''),
  dataDir,
  dbPath: join(dataDir, 'publishfast.db'),
  uploadsDir: join(dataDir, 'uploads'),
  /** Drop box bytes (routes/files.ts), kept apart from content uploads. */
  filesDir: join(dataDir, 'files'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 536_870_912),
  /** Per drop-box file. */
  maxFileBytes: Number(process.env.MAX_FILE_BYTES ?? 209_715_200),
  isProd: process.env.NODE_ENV === 'production',
  /**
   * In development we fall back to a fixed secret so `npm run dev` works with
   * zero config. In production a real secret is mandatory — refuse to boot
   * without one rather than silently signing sessions with a public value.
   */
  authSecret: (() => {
    const secret = process.env.AUTH_SECRET
    if (secret && secret.length >= 16) return secret
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AUTH_SECRET must be set (min 16 chars) when NODE_ENV=production')
    }
    return 'dev-only-insecure-secret-do-not-use-in-production'
  })(),
}

export function ensureDataDirs() {
  for (const dir of [config.dataDir, config.uploadsDir, config.filesDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}
