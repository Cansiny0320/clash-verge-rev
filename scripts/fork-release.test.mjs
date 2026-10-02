import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import { compareStable, releaseMode, verifyInstaller } from './fork-release.mjs'

test('release decisions require a higher stable version except same-commit promotion retries', () => {
  assert.equal(releaseMode('2.5.6', '2.5.5'), 'build')
  assert.equal(releaseMode('2.5.5', '2.5.5'), 'skip')
  assert.equal(releaseMode('2.5.4', '2.5.5', true), 'skip')
  assert.equal(releaseMode('2.5.5', '2.5.5', true), 'promote')
  assert.equal(compareStable('2.10.0', '2.9.9'), 1)
  assert.throws(() => releaseMode('2.5.6-rc.1', '2.5.5'), /stable/)
})

test('installer verification rejects changed bytes and a different key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const bytes = Buffer.from('signed release artifact')
  const keyId = Buffer.alloc(8, 1)
  const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const encode = (value) =>
    Buffer.from(
      `untrusted comment: fixture\n${value.toString('base64')}\n`,
    ).toString('base64')
  const pub = encode(Buffer.concat([Buffer.from('Ed'), keyId, key]))
  const signature = encode(
    Buffer.concat([
      Buffer.from('ED'),
      keyId,
      crypto.sign(
        null,
        crypto.createHash('blake2b512').update(bytes).digest(),
        privateKey,
      ),
    ]),
  )
  assert.equal(
    verifyInstaller(bytes, signature, pub),
    crypto.createHash('sha256').update(bytes).digest('hex'),
  )
  assert.throws(
    () => verifyInstaller(Buffer.from('modified'), signature, pub),
    /signature/,
  )
  const other = crypto
    .generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .subarray(-32)
  assert.throws(
    () =>
      verifyInstaller(
        bytes,
        signature,
        encode(Buffer.concat([Buffer.from('Ed'), keyId, other])),
      ),
    /signature/,
  )
})
