import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { contents, pushSubscriptions, reminderSettings, users } from '../db/schema.js'
import { claimableBy } from './claim.js'
import { sendPushNotification } from './push.js'

let intervalTimer: NodeJS.Timeout | null = null

/**
 * Formats a Date object to "HH:MM" in a specific IANA timezone (e.g. "Asia/Ho_Chi_Minh").
 */
function getTimeInTimezone(date: Date, timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    return formatter.format(date)
  } catch {
    // Fallback to UTC if timezone invalid
    const h = String(date.getUTCHours()).padStart(2, '0')
    const m = String(date.getUTCMinutes()).padStart(2, '0')
    return `${h}:${m}`
  }
}

/**
 * Gets today's date string "YYYY-MM-DD" in a specific timezone.
 */
function getDateInTimezone(date: Date, timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    return formatter.format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

export async function checkAndSendReminders() {
  const now = new Date()

  // Find all users with reminders enabled
  const allSettings = db
    .select()
    .from(reminderSettings)
    .where(eq(reminderSettings.enabled, true))
    .all()

  for (const setting of allSettings) {
    const tz = setting.timezone || 'Asia/Ho_Chi_Minh'
    const currentTime = getTimeInTimezone(now, tz)
    const currentDate = getDateInTimezone(now, tz)

    const times = setting.reminderTimes
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)

    // Check if current minute matches any configured reminder time
    if (!times.includes(currentTime)) {
      continue
    }

    // Check if already notified at this exact time today
    const notificationKey = `${currentDate}_${currentTime}`
    if (setting.lastNotifiedDate === notificationKey) {
      continue
    }

    // Check if user has active tasks in progress or if ready queue has posts
    const activeTasks = db
      .select({ count: sql<number>`count(*)` })
      .from(contents)
      .where(and(eq(contents.claimedBy, setting.userId), eq(contents.status, 'CLAIMED')))
      .get()

    const assignedOnly =
      db.select({ assignedOnly: users.assignedOnly }).from(users).where(eq(users.id, setting.userId)).get()
        ?.assignedOnly ?? false
    const readyQueue = db
      .select({ count: sql<number>`count(*)` })
      .from(contents)
      .where(claimableBy(setting.userId, assignedOnly))
      .get()

    const inProgressCount = activeTasks?.count ?? 0
    const readyCount = readyQueue?.count ?? 0

    // Only send notification if there is work to do
    if (inProgressCount === 0 && readyCount === 0) {
      continue
    }

    let title = '⏰ Time to publish your post!'
    let body = ''

    if (inProgressCount > 0) {
      body = `You have ${inProgressCount} post(s) in progress. Complete and paste live links now!`
    } else {
      body = `The queue has ${readyCount} new post(s) ready. Claim and post now!`
    }

    // Get all push subscriptions for this user
    const subs = db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, setting.userId))
      .all()

    if (subs.length > 0) {
      for (const sub of subs) {
        const result = await sendPushNotification(sub, {
          title,
          body,
          icon: '/favicon.ico',
          badge: '/favicon.ico',
          tag: `reminder-${setting.userId}`,
          data: { url: '/' },
        })

        // Clean up dead subscriptions
        if (result.expired) {
          db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).run()
        }
      }
    }

    // Update lastNotifiedDate to prevent duplicate notifications in same minute
    db.update(reminderSettings)
      .set({
        lastNotifiedDate: notificationKey,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(reminderSettings.userId, setting.userId))
      .run()
  }
}

export function startReminderScheduler() {
  if (intervalTimer) return

  // Run every 60 seconds
  intervalTimer = setInterval(() => {
    void checkAndSendReminders().catch((err) => {
      console.warn('Error running reminder scheduler:', err)
    })
  }, 60000)

  // Run initial check after 5 seconds on startup
  setTimeout(() => {
    void checkAndSendReminders().catch(() => {})
  }, 5000)
}

export function stopReminderScheduler() {
  if (intervalTimer) {
    clearInterval(intervalTimer)
    intervalTimer = null
  }
}
