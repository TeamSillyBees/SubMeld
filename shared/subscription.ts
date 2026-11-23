import type { Source, SubscriptionInfo } from './model.ts'

export const renewalNoticeDays = 7
const dayMs = 86400000
export const reminderKey = ({ id, date }: { id: string; date: string }) => id + '/' + date

// ISO calendar days sort in billing order and keep date-only renewals independent of DST.
export function calendarFormatter(timeZone?: string) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function upcomingRenewals(sources: Pick<Source, 'id' | 'name' | 'renewalDate'>[], records: Record<string, { subscriptionInfo?: Pick<SubscriptionInfo, 'expire'> | null }>, format: Intl.DateTimeFormat, today = format.format(Date.now())) {
  const start = Date.parse(today)
  const reminders = []
  for (const source of sources) {
    const expire = records[source.id]?.subscriptionInfo?.expire ?? 0
    const date = source.renewalDate || (expire > 0 && format.format(expire * 1000))
    if (!date) continue
    const days = (Date.parse(date) - start) / dayMs
    if (days >= 0 && days <= renewalNoticeDays) {
      reminders.push({ id: source.id, name: source.name, date, days, expire: source.renewalDate ? null : expire })
    }
  }
  return reminders.sort((a, b) => a.days - b.days)
}
