import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  requireForkRepository,
  validateManifest,
  validatePlatforms,
} from './fork-updates.mjs'

test('all packaged updater configurations use the fork and the same signing key', () => {
  const configs = [
    'tauri.conf.json',
    'webview2.x64.json',
    'webview2.x86.json',
    'webview2.arm64.json',
  ].map((file) =>
    JSON.parse(
      fs.readFileSync(new URL(`../src-tauri/${file}`, import.meta.url), 'utf8'),
    ),
  )
  const pubkey = configs[0].plugins.updater.pubkey
  assert.ok(pubkey)
  for (const config of configs) {
    assert.equal(config.plugins.updater.pubkey, pubkey)
    for (const endpoint of config.plugins.updater.endpoints) {
      assert.ok(
        endpoint.startsWith(
          'https://github.com/Cansiny0320/clash-verge-rev/releases/download/',
        ),
      )
    }
  }
})

test('manifests reject upstream downloads and missing signatures', () => {
  assert.throws(() =>
    requireForkRepository({
      owner: 'clash-verge-rev',
      repo: 'clash-verge-rev',
    }),
  )
  assert.throws(() =>
    validatePlatforms({
      windows: {
        url: 'https://github.com/clash-verge-rev/clash-verge-rev/releases/download/v1/app.exe',
        signature: 'signed',
      },
    }),
  )
  assert.throws(() =>
    validatePlatforms({
      windows: {
        url: 'https://github.com/Cansiny0320/clash-verge-rev/releases/download/v1/app.exe',
        signature: '',
      },
    }),
  )
  assert.doesNotThrow(() =>
    validatePlatforms({
      windows: {
        url: 'https://github.com/Cansiny0320/clash-verge-rev/releases/download/v1/app.exe',
        signature: 'signed',
      },
    }),
  )
})

test('manifests reject the duplicate version alias rejected by the updater', () => {
  const manifest = {
    version: '2.5.6',
    platforms: {
      'windows-x86_64': {
        url: 'https://github.com/Cansiny0320/clash-verge-rev/releases/download/v2.5.6/app.exe',
        signature: 'signed',
      },
    },
  }
  assert.doesNotThrow(() => validateManifest(manifest))
  assert.throws(
    () => validateManifest({ ...manifest, name: 'v2.5.6' }),
    /duplicate.*version/i,
  )
})
