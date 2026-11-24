export type FeedbackTone = 'success' | 'warning' | 'danger' | 'info'

export interface FeedbackToastAdapter {
  dismiss: () => unknown
  show: (message: string, tone: FeedbackTone, duration: number) => unknown
}

export function createFeedbackNotifier(adapter: FeedbackToastAdapter) {
  let pending: { message: string; tone: FeedbackTone } | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let mountTimer: ReturnType<typeof setTimeout> | null = null
  let mounting = false
  let disposed = false

  const scheduleFlush = () => {
    if (disposed || mounting || flushTimer !== null) return
    flushTimer = setTimeout(flush, 0)
  }

  const flush = () => {
    flushTimer = null
    if (disposed || mounting || !pending) return
    const next = pending
    pending = null
    adapter.dismiss()
    adapter.show(next.message, next.tone, next.tone === 'danger' ? 6500 : 2800)
    mounting = true
    mountTimer = setTimeout(() => {
      mountTimer = null
      mounting = false
      if (!disposed && pending) scheduleFlush()
    }, 0)
  }

  const notify = (message: string, tone: FeedbackTone = 'success') => {
    if (disposed) return
    pending = { message, tone }
    scheduleFlush()
  }

  const dispose = () => {
    disposed = true
    pending = null
    mounting = false
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (mountTimer !== null) {
      clearTimeout(mountTimer)
      mountTimer = null
    }
  }

  const activate = () => {
    disposed = false
  }

  return { notify, dispose, activate }
}
