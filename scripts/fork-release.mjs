import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { FORK_REPOSITORY, validateManifest } from './fork-updates.mjs'
import { resolveUpdateLog } from './updatelog.mjs'

const output = 'target/fork-release'
const gh = (...args) =>
  execFileSync('gh', args, { encoding: 'utf8', windowsHide: true }).trim()
const api = (endpoint) =>
  JSON.parse(gh('api', `repos/${FORK_REPOSITORY}/${endpoint}`))
const stableVersion = (value) => {
  if (!/^\d+\.\d+\.\d+$/.test(value))
    throw new Error(`Expected a stable version: ${value}`)
  return value.split('.').map(BigInt)
}

export function compareStable(a, b) {
  const left = stableVersion(a)
  const right = stableVersion(b)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  }
  return 0
}

export function releaseMode(version, latest, sameCommit = false) {
  const comparison = compareStable(version, latest)
  return comparison > 0
    ? 'build'
    : comparison === 0 && sameCommit
      ? 'promote'
      : 'skip'
}

export function verifyInstaller(file, signature, publicKey) {
  const pub = Buffer.from(
    Buffer.from(publicKey, 'base64').toString().trim().split('\n')[1],
    'base64',
  )
  const sig = Buffer.from(
    Buffer.from(signature, 'base64').toString().trim().split('\n')[1],
    'base64',
  )
  const key = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      pub.subarray(10),
    ]),
    format: 'der',
    type: 'spki',
  })
  const algorithm = sig.subarray(0, 2).toString()
  if (!['Ed', 'ED'].includes(algorithm))
    throw new Error('Unknown installer signature algorithm')
  const message =
    algorithm === 'ED'
      ? crypto.createHash('blake2b512').update(file).digest()
      : file
  if (
    !pub.subarray(2, 10).equals(sig.subarray(2, 10)) ||
    !crypto.verify(null, message, key, sig.subarray(10))
  )
    throw new Error(
      'Installer signature does not match the packaged updater key',
    )
  return crypto.createHash('sha256').update(file).digest('hex')
}

function sourceVersion() {
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
  stableVersion(version)
  const rust = fs
    .readFileSync('src-tauri/Cargo.toml', 'utf8')
    .match(/^version = "([^"]+)"/m)?.[1]
  const lock = fs
    .readFileSync('Cargo.lock', 'utf8')
    .match(/name = "clash-verge"\r?\nversion = "([^"]+)"/)?.[1]
  const tauri = JSON.parse(
    fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'),
  ).version
  if ([rust, lock, tauri].some((value) => value !== version))
    throw new Error('Package versions do not match')
  return version
}

function tagCommit(tag) {
  return api(`commits/${encodeURIComponent(tag)}`).sha
}

function plan(version) {
  const latest = api('releases/latest')
  const latestVersion = latest.tag_name.replace(/^v/, '')
  const sameCommit =
    latestVersion === version &&
    tagCommit(latest.tag_name) === process.env.GITHUB_SHA
  const mode = releaseMode(version, latestVersion, sameCommit)
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `mode=${mode}\nversion=${version}\n`,
    )
  console.log(JSON.stringify({ version, latest: latestVersion, mode }))
  return mode
}

function assertCurrentHead() {
  if (api('git/ref/heads/dev').object.sha !== process.env.GITHUB_SHA)
    throw new Error('A newer dev commit exists; this run must not publish')
}

async function prepare(version) {
  const name = `Clash.Verge_${version}_x64-setup.exe`
  const file = `target/release/bundle/nsis/Clash Verge_${version}_x64-setup.exe`
  fs.mkdirSync(output, { recursive: true })
  const signature = fs.readFileSync(`${file}.sig`, 'utf8').trim()
  const config = JSON.parse(
    fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'),
  )
  const sha = verifyInstaller(
    fs.readFileSync(file),
    signature,
    config.plugins.updater.pubkey,
  )
  fs.copyFileSync(file, `${output}/${name}`)
  fs.copyFileSync(`${file}.sig`, `${output}/${name}.sig`)
  const artifact = {
    url: `https://github.com/${FORK_REPOSITORY}/releases/download/v${version}/${name}`,
    signature,
  }
  const notes = await resolveUpdateLog(`v${version}`)
  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: { 'windows-x86_64': artifact, 'windows-x86_64-nsis': artifact },
  }
  validateManifest(manifest)
  fs.writeFileSync(`${output}/update.json`, JSON.stringify(manifest, null, 2))
  fs.writeFileSync(`${output}/SHA256SUMS`, `${sha}  ${name}\n`)
  fs.writeFileSync(
    `${output}/release-notes.md`,
    `${notes}\n\nSource commit: ${process.env.GITHUB_SHA}\n`,
  )
  console.log(JSON.stringify({ version, sha256: sha, signatureVerified: true }))
}

async function publish(version) {
  assertCurrentHead()
  const tag = `v${version}`
  const latest = api('releases/latest')
  if (compareStable(version, latest.tag_name.replace(/^v/, '')) < 0)
    throw new Error('Refusing to downgrade the update channel')
  let release = api('releases?per_page=100').find(
    (item) => item.tag_name === tag,
  )
  if (!release) {
    gh(
      'release',
      'create',
      tag,
      '--repo',
      FORK_REPOSITORY,
      '--target',
      process.env.GITHUB_SHA,
      '--draft',
      '--title',
      `Clash Verge Rev ${tag} — Cansiny0320`,
      '--notes-file',
      `${output}/release-notes.md`,
    )
    release = api('releases?per_page=100').find((item) => item.tag_name === tag)
    if (!release) throw new Error('Created draft release was not found')
  }
  if (release.draft) {
    if (release.target_commitish !== process.env.GITHUB_SHA)
      throw new Error('Draft release belongs to a different commit')
    gh(
      'release',
      'upload',
      tag,
      '--repo',
      FORK_REPOSITORY,
      '--clobber',
      ...fs
        .readdirSync(output)
        .filter((file) => file !== 'release-notes.md')
        .map((file) => `${output}/${file}`),
    )
    const uploaded = api(`releases/${release.id}`)
    for (const file of fs
      .readdirSync(output)
      .filter((file) => file !== 'release-notes.md')) {
      const asset = uploaded.assets.find((item) => item.name === file)
      const bytes = fs.readFileSync(`${output}/${file}`)
      const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
      if (!asset || asset.size !== bytes.length || asset.digest !== digest)
        throw new Error(`Uploaded asset mismatch: ${file}`)
    }
    assertCurrentHead()
    gh(
      'release',
      'edit',
      tag,
      '--repo',
      FORK_REPOSITORY,
      '--draft=false',
      '--latest',
      '--notes-file',
      `${output}/release-notes.md`,
    )
  } else {
    if (tagCommit(tag) !== process.env.GITHUB_SHA)
      throw new Error('Published version belongs to a different commit')
    fs.mkdirSync(output, { recursive: true })
    gh(
      'release',
      'download',
      tag,
      '--repo',
      FORK_REPOSITORY,
      '--pattern',
      'update.json',
      '--dir',
      output,
      '--clobber',
    )
  }
  const manifest = JSON.parse(fs.readFileSync(`${output}/update.json`, 'utf8'))
  validateManifest(manifest)
  if (manifest.version !== version)
    throw new Error('Manifest version does not match release')
  assertCurrentHead()
  gh(
    'release',
    'upload',
    'updater',
    `${output}/update.json`,
    '--repo',
    FORK_REPOSITORY,
    '--clobber',
  )
  const url = `https://github.com/${FORK_REPOSITORY}/releases/download/updater/update.json`
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(url, { cache: 'no-store' })
    if (response.ok) {
      const readback = await response.json()
      if (JSON.stringify(readback) === JSON.stringify(manifest)) {
        validateManifest(readback)
        console.log(`Published ${tag}; canonical updater manifest verified`)
        return
      }
    }
    console.log('Waiting for the public updater URL cache to refresh')
    await sleep(30000)
  }
  throw new Error(
    'Release published, but canonical manifest is still stale; rerun this commit to retry promotion',
  )
}

async function main() {
  if (
    process.env.GITHUB_REPOSITORY !== FORK_REPOSITORY ||
    process.env.GITHUB_REF !== 'refs/heads/dev'
  )
    throw new Error('Fork release requires the fork dev branch')
  const version = sourceVersion()
  switch (process.argv[2]) {
    case 'plan':
      plan(version)
      break
    case 'prepare':
      await prepare(version)
      break
    case 'publish':
      await publish(version)
      break
    default:
      throw new Error('Expected plan, prepare or publish')
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
