import { buildApp } from './app.js'
import { migrate } from './db/migrate.js'
import { config } from './lib/config.js'
import { startReleaseScheduler, stopReleaseScheduler } from './lib/releaseScheduler.js'
import { startReminderScheduler, stopReminderScheduler } from './lib/reminderScheduler.js'

const app = await buildApp()

startReminderScheduler()
// Flips DRAFTs whose release_at has come to READY, every 60 seconds.
startReleaseScheduler()

migrate()

await app.listen({ port: config.port, host: config.host })
console.log(`PublishFast API on http://${config.host}:${config.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopReminderScheduler()
    stopReleaseScheduler()
    await app.close()
    process.exit(0)
  })
}
