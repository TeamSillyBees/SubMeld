import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSubscriptionInfo } from '../server/remote.ts'
import { calendarFormatter, upcomingRenewals } from '../shared/subscription.ts'

test('subscription info preserves valid zeroes and ignores missing, malformed and unknown fields', () => {
  const parsed = parseSubscriptionInfo('UPLOAD = 0; total=0; expire=0; download=123; vendor=private')
  assert.ok(parsed)
  const { updatedAt, ...info } = parsed
  assert.deepEqual(info, { upload: 0, total: 0, expire: 0, download: 123 })
  assert.ok(Number.isFinite(Date.parse(updatedAt)))
  assert.equal(parseSubscriptionInfo(undefined), null)
  assert.equal(parseSubscriptionInfo('expire=999999999999; total=9007199254740992; upload=-1; download=5MB'), null)
  assert.deepEqual(Object.keys(parseSubscriptionInfo('upload=; total=10') ?? {}).sort(), ['total', 'updatedAt'])
})

test('renewal windows use local calendar days across DST and prefer an explicit renewal date', () => {
  const format = calendarFormatter('America/New_York')
  const today = '2026-03-07'
  const sources = [
    { id: 'auto' }, { id: 'today', renewalDate: today }, { id: 'late', renewalDate: '2026-03-15' },
    { id: 'past', renewalDate: '2026-03-06' }, { id: 'permanent' }, { id: 'unknown' },
  ].map(source => ({ ...source, name: source.id }))
  // 03:00 UTC on March 15 is still March 14 in New York after the DST switch.
  const withExpiry = { subscriptionInfo: { expire: Date.parse('2026-03-15T03:00:00Z') / 1000 } }
  const records = { auto: withExpiry, today: withExpiry, late: withExpiry, permanent: { subscriptionInfo: { expire: 0 } } }
  const due = upcomingRenewals(sources, records, format, today)
  assert.deepEqual(due.map(({ id, date, days }) => [id, date, days]), [['today', today, 0], ['auto', '2026-03-14', 7]])
})
