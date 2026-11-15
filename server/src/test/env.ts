/**
 * Import this FIRST in a test file. It points DATA_DIR at a fresh temporary
 * directory before db/index.ts opens the database, so route tests never touch
 * the developer's ./data database. node --test runs each file in its own
 * process, so every test file gets its own empty database.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pf-test-'))
// The free-space floor is tested explicitly (review.test.ts); elsewhere a full
// developer disk must not turn uploads into 507s.
process.env.MIN_FREE_BYTES ??= '0'
// tikwm's one-a-second spacing is tested explicitly (tiktok.test.ts); elsewhere it would only slow the fakes.
process.env.TIKWM_GAP_MS ??= '0'
