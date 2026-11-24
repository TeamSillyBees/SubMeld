import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { createFeedbackNotifier, type FeedbackTone } from '../src/notify.ts'

async function until(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for notifier condition')
    await wait(10)
  }
}

test('createFeedbackNotifier delivers single notifications with expected durations', async () => {
  const calls: Array<{ type: 'dismiss' } | { type: 'show'; message: string; tone: FeedbackTone; duration: number }> = []
  const notifier = createFeedbackNotifier({
    dismiss: () => calls.push({ type: 'dismiss' }),
    show: (message, tone, duration) => calls.push({ type: 'show', message, tone, duration }),
  })

  notifier.notify('已保存')
  assert.deepEqual(calls, [])
  await until(() => calls.length >= 2)
  assert.deepEqual(calls, [
    { type: 'dismiss' },
    { type: 'show', message: '已保存', tone: 'success', duration: 2800 },
  ])

  calls.length = 0
  notifier.notify('保存失败', 'danger')
  await until(() => calls.length >= 2)
  assert.deepEqual(calls, [
    { type: 'dismiss' },
    { type: 'show', message: '保存失败', tone: 'danger', duration: 6500 },
  ])
  notifier.dispose()
})

test('createFeedbackNotifier coalesces same-tick bursts to the latest notification', async () => {
  const calls: Array<{ type: 'dismiss' } | { type: 'show'; message: string; tone: FeedbackTone; duration: number }> = []
  const notifier = createFeedbackNotifier({
    dismiss: () => calls.push({ type: 'dismiss' }),
    show: (message, tone, duration) => calls.push({ type: 'show', message, tone, duration }),
  })

  notifier.notify('Burst-1', 'success')
  notifier.notify('Burst-2', 'danger')
  notifier.notify('Burst-3', 'warning')
  notifier.notify('Burst-4', 'success')

  await until(() => calls.length >= 2)
  await wait(80)
  assert.deepEqual(calls, [
    { type: 'dismiss' },
    { type: 'show', message: 'Burst-4', tone: 'success', duration: 2800 },
  ])
  notifier.dispose()
})

test('createFeedbackNotifier gates dismiss during mounting === true and flushes latest queued call afterward', async () => {
  const events: string[] = []
  let showCount = 0
  let notifier!: ReturnType<typeof createFeedbackNotifier>

  notifier = createFeedbackNotifier({
    dismiss: () => events.push('dismiss'),
    show: (message, tone, duration) => {
      showCount++
      events.push(`show:${message}:${tone}:${duration}`)
      if (showCount === 1) {
        // Simulate re-entrant & microtask notifications arriving while mounting === true
        notifier.notify('Queued-1', 'danger')
        queueMicrotask(() => notifier.notify('Queued-2', 'info'))
      }
    },
  })

  notifier.notify('First', 'success')
  await until(() => events.length >= 4)

  assert.deepEqual(events, [
    'dismiss',
    'show:First:success:2800',
    'dismiss',
    'show:Queued-2:info:2800',
  ])
  notifier.dispose()
})

test('createFeedbackNotifier dispose clears pending timers, suppresses post-dispose calls, and activate restores delivery', async () => {
  const calls: Array<string> = []
  const notifier = createFeedbackNotifier({
    dismiss: () => calls.push('dismiss'),
    show: (message, tone, duration) => calls.push(`show:${message}:${tone}:${duration}`),
  })

  notifier.notify('Before dispose', 'warning')
  notifier.dispose()
  notifier.notify('After dispose', 'danger')

  await wait(100)
  assert.deepEqual(calls, [])

  // React StrictMode / re-mount calls activate() on the memoized notifier instance
  notifier.activate()
  notifier.notify('After activate', 'success')
  await until(() => calls.length >= 2)
  assert.deepEqual(calls, [
    'dismiss',
    'show:After activate:success:2800',
  ])
  notifier.dispose()
})
