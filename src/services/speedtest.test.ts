import { describe, expect, test, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))
vi.mock('@/services/delay', () => ({ default: {} }))

import type { ProxyViewV1, InteractableProxyMember } from '@/types/proxy-view'

import {
  resolveSpeedTargets,
  SpeedTestStore,
  type SpeedEvent,
} from './speedtest'

const node = (name: string, provider: string): InteractableProxyMember =>
  ({
    kind: 'node',
    ref: { kind: 'node', name, recordId: provider + name },
    node: {
      name,
      recordId: provider + name,
      source: { kind: 'provider', providerName: provider, proxyName: name },
    },
  }) as InteractableProxyMember

describe('group download test', () => {
  test.each(['group', 'single'] as const)(
    '%s latency-only testing never downloads or replaces saved speeds',
    async (scope) => {
      let event!: (value: SpeedEvent) => void
      const delay = vi.fn(async () => {})
      const start = vi.fn(async (_id, _targets, _selections, callback) => {
        event = callback
      })
      const store = new SpeedTestStore({ delay, start, cancel: vi.fn() })
      const member = node('n', 'p')
      const view = { groups: [] } as unknown as ProxyViewV1
      await store.run('g', [member], view, 1000)
      event({ key: 'pn', status: 'done', bytes: 1000, bytesPerSecond: 2000 })
      event({ key: '', status: 'finished', bytes: 0 })
      start.mockClear()
      if (scope === 'single')
        await store.runSingle('g', member, view, 1000, 'latency')
      else await store.run('g', [member], view, 1000, 'latency')
      expect(delay).toHaveBeenCalledTimes(2)
      expect(start).not.toHaveBeenCalled()
      expect(store.batch()).toBeNull()
      expect(store.result('g', 'pn')?.bytesPerSecond).toBe(2000)
    },
  )

  test('single-node testing measures only the clicked provider node and preserves other results', async () => {
    let event!: (value: SpeedEvent) => void
    const delay = vi.fn(async (_members: InteractableProxyMember[]) => {})
    const start = vi.fn(async (_id, _targets, _selections, callback) => {
      event = callback
    })
    const store = new SpeedTestStore({ delay, start, cancel: vi.fn() })
    const first = node('same', 'a')
    const clicked = node('same', 'b')
    const view = { groups: [] } as unknown as ProxyViewV1
    await store.run('g', [first], view, 1000)
    event({ key: 'asame', status: 'done', bytes: 1000, bytesPerSecond: 2000 })
    event({ key: '', status: 'finished', bytes: 0 })
    await store.runSingle('g', clicked, view, 1000)
    expect(delay.mock.calls.at(-1)?.[0]).toEqual([clicked])
    expect(start.mock.calls.at(-1)?.[1]).toEqual([
      { key: 'bsame', name: 'same', provider: 'b' },
    ])
    expect(store.batch()?.total).toBe(1)
    expect(store.result('g', 'asame')?.bytesPerSecond).toBe(2000)
  })

  test('a node click does not cancel or replace an existing test', async () => {
    const start = vi.fn(async () => {})
    const cancel = vi.fn()
    const store = new SpeedTestStore({ delay: async () => {}, start, cancel })
    const view = { groups: [] } as unknown as ProxyViewV1
    await store.run('g', [node('one', 'p'), node('two', 'p')], view, 1000)
    await store.runSingle('g', node('two', 'p'), view, 1000)
    expect(start).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
    expect(store.batch()?.total).toBe(2)
  })

  test('keeps identical names from different providers distinct', () => {
    const targets = resolveSpeedTargets(
      [node('same', 'a'), node('same', 'b')],
      { groups: [] } as unknown as ProxyViewV1,
    )
    expect(targets.map((target) => target.provider)).toEqual(['a', 'b'])
    expect(targets[0].key).not.toBe(targets[1].key)
  })

  test('cancelling latency never starts a download', async () => {
    let release!: () => void
    const delay = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const start = vi.fn()
    const store = new SpeedTestStore({ delay, start, cancel: vi.fn() })
    const run = store.run(
      'g',
      [node('n', 'p')],
      { groups: [] } as unknown as ProxyViewV1,
      1000,
    )
    await store.cancel()
    release()
    await run
    expect(start).not.toHaveBeenCalled()
    expect(store.batch()).toBeNull()
    expect(store.result('g', 'pn')?.status).toBe('cancelled')
  })

  test('profile reset rejects late events from a previous batch', async () => {
    let event!: (value: SpeedEvent) => void
    const store = new SpeedTestStore({
      delay: async () => {},
      start: async (_id, _targets, _selections, callback) => {
        event = callback
      },
      cancel: async () => {},
    })
    await store.run(
      'g',
      [node('n', 'p')],
      { groups: [] } as unknown as ProxyViewV1,
      1000,
    )
    await store.reset()
    event({ key: 'pn', status: 'done', bytes: 1000, bytesPerSecond: 2000 })
    expect(store.result('g', 'pn')).toBeUndefined()
  })

  test('download cancellation preserves completed results and stops pending nodes', async () => {
    let event!: (value: SpeedEvent) => void
    const cancel = vi.fn(async () => {
      event({ key: '', status: 'cancelled', bytes: 0 })
    })
    const start = vi.fn(async (_id, _targets, _selections, callback) => {
      event = callback
    })
    const store = new SpeedTestStore({ delay: async () => {}, start, cancel })
    const members = [node('one', 'p'), node('two', 'p')]
    const view = { groups: [] } as unknown as ProxyViewV1
    await store.run('g', members, view, 1000)
    event({ key: 'pone', status: 'done', bytes: 1000, bytesPerSecond: 2000 })
    await store.run('other', members, view, 1000)
    expect(start).toHaveBeenCalledTimes(1)
    expect(store.batch()?.completed).toBe(1)
    await store.cancel()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(store.batch()).toBeNull()
    expect(store.result('g', 'pone')?.status).toBe('done')
    expect(store.result('g', 'ptwo')?.status).toBe('cancelled')
  })
})
