import { Channel, invoke } from '@tauri-apps/api/core'

import delayManager from '@/services/delay'
import {
  resolveMember,
  type InteractableProxyMember,
  type ProxyViewV1,
  type ResolvedProxyMember,
} from '@/types/proxy-view'

export const DEFAULT_DOWNLOAD_URL =
  'https://speed.cloudflare.com/__down?bytes=50000000'
export type SpeedTestMode = 'latency' | 'download'
export type SpeedStatus =
  | 'queued'
  | 'testing'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'finished'
export interface SpeedEvent {
  key: string
  status: SpeedStatus
  bytes: number
  bytesPerSecond?: number | null
  error?: string | null
}
export interface SpeedTarget {
  key: string
  name: string
  provider?: string
}
interface Batch {
  id: string
  group: string
  phase: 'latency' | 'download'
  completed: number
  total: number
  stopping: boolean
}
interface Transport {
  delay: (
    members: InteractableProxyMember[],
    group: string,
    timeout: number,
    signal: AbortSignal,
  ) => Promise<void>
  start: (
    id: string,
    targets: SpeedTarget[],
    selections: Record<string, string>,
    event: (event: SpeedEvent) => void,
  ) => Promise<void>
  cancel: (id: string) => Promise<void>
}

export const speedKey = (member: ResolvedProxyMember) =>
  member.kind === 'node' ? member.node.recordId : `group:${member.ref.name}`

export function resolveSpeedTargets(
  members: ResolvedProxyMember[],
  view: ProxyViewV1,
): SpeedTarget[] {
  return members.flatMap((member) => {
    const key = speedKey(member)
    const seen = new Set<string>()
    while (member.kind === 'group') {
      if (seen.has(member.ref.name) || !member.group.now) return []
      seen.add(member.ref.name)
      const current = member.group.now
      const matches = member.group.members.filter((ref) => ref.name === current)
      if (matches.length !== 1) return []
      member = resolveMember(view, matches[0])
    }
    if (
      member.kind !== 'node' ||
      ['Direct', 'Reject', 'RejectDrop', 'Pass', 'Compatible'].includes(
        member.node.type,
      )
    )
      return []
    const source = member.node.source
    return [
      {
        key,
        name: source.proxyName,
        ...(source.kind === 'provider'
          ? { provider: source.providerName }
          : {}),
      },
    ]
  })
}

export function validDownloadUrl(value: string) {
  if (!value.trim()) return true
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

export class SpeedTestStore {
  private active: Batch | null = null
  private results = new Map<string, SpeedEvent>()
  private listeners = new Set<() => void>()
  private abort: AbortController | null = null
  private starting: Promise<void> | null = null
  constructor(private transport: Transport) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  batch = () => this.active
  result = (group: string, key: string) =>
    this.results.get(JSON.stringify([group, key]))
  private notify() {
    for (const listener of this.listeners) listener()
  }
  private put(group: string, event: SpeedEvent) {
    this.results.set(JSON.stringify([group, event.key]), event)
  }

  async runSingle(
    group: string,
    member: InteractableProxyMember,
    view: ProxyViewV1,
    timeout: number,
    mode: SpeedTestMode = 'download',
  ) {
    // A card click must not toggle off another node or an active group batch.
    if (this.active) return
    await this.run(group, [member], view, timeout, mode)
  }

  async run(
    group: string,
    members: InteractableProxyMember[],
    view: ProxyViewV1,
    timeout: number,
    mode: SpeedTestMode = 'download',
  ) {
    if (this.active) {
      if (this.active.group === group) await this.cancel()
      return
    }
    const targets =
      mode === 'download' ? resolveSpeedTargets(members, view) : []
    const id = crypto.randomUUID()
    const abort = new AbortController()
    this.abort = abort
    this.active = {
      id,
      group,
      phase: 'latency',
      completed: 0,
      total: mode === 'download' ? targets.length : members.length,
      stopping: false,
    }
    if (mode === 'download') {
      for (const member of members) {
        const key = speedKey(member)
        this.results.delete(JSON.stringify([group, key]))
      }
    }
    for (const target of targets)
      this.put(group, { key: target.key, status: 'queued', bytes: 0 })
    this.notify()
    try {
      await this.transport.delay(members, group, timeout, abort.signal)
      if (this.active?.id !== id) return
      if (abort.signal.aborted || !targets.length) {
        this.finish(id, abort.signal.aborted ? 'cancelled' : 'finished')
        return
      }
      this.active = { ...this.active, phase: 'download' }
      this.notify()
      const selections = Object.fromEntries(
        view.groups.flatMap((item) =>
          item.now ? [[item.name, item.now]] : [],
        ),
      )
      this.starting = this.transport.start(id, targets, selections, (event) => {
        if (this.active?.id !== id) return
        if (!event.key) {
          if (event.status === 'error') this.finish(id, 'error', event.error)
          else if (event.status === 'finished' || event.status === 'cancelled')
            this.finish(id, event.status)
          return
        }
        if (!targets.some((target) => target.key === event.key)) return
        this.put(group, event)
        if (event.status === 'done' || event.status === 'error')
          this.active = { ...this.active, completed: this.active.completed + 1 }
        this.notify()
      })
      await this.starting
    } catch (error) {
      this.finish(
        id,
        'error',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private finish(id: string, status: SpeedStatus, error?: string | null) {
    if (this.active?.id !== id) return
    const { group } = this.active
    for (const [key, result] of this.results) {
      if (
        JSON.parse(key)[0] === group &&
        ['queued', 'testing'].includes(result.status)
      ) {
        this.results.set(key, {
          ...result,
          status: status === 'finished' ? 'error' : status,
          error: error ?? result.error,
        })
      }
    }
    this.active = null
    this.notify()
  }

  async cancel() {
    const active = this.active
    if (!active) return
    this.abort?.abort()
    this.active = { ...active, stopping: true }
    this.notify()
    if (active.phase === 'download') {
      try {
        await this.starting
        await this.transport.cancel(active.id)
      } catch (error) {
        this.finish(active.id, 'error', String(error))
      }
    }
  }

  async reset() {
    const cancelling = this.cancel()
    this.active = null
    this.results.clear()
    this.notify()
    await cancelling
  }
}

export const speedTestStore = new SpeedTestStore({
  delay: (members, group, timeout, signal) =>
    delayManager.checkListDelay(members, group, timeout, 10, signal),
  start: (sessionId, targets, selections, event) => {
    const onEvent = new Channel<SpeedEvent>()
    onEvent.onmessage = event
    return invoke('start_download_test', {
      sessionId,
      targets,
      selections,
      onEvent,
    })
  },
  cancel: (sessionId) => invoke('cancel_download_test', { sessionId }),
})
