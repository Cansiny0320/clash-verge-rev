export const FORK_REPOSITORY = 'Cansiny0320/clash-verge-rev'

export function requireForkRepository({ owner, repo }) {
  if (`${owner}/${repo}` !== FORK_REPOSITORY) {
    throw new Error(
      `Update manifests must be published from ${FORK_REPOSITORY}`,
    )
  }
}

export function validatePlatforms(platforms) {
  if (!Object.keys(platforms).length)
    throw new Error('No update artifacts found')
  for (const [platform, artifact] of Object.entries(platforms)) {
    const url = new URL(artifact.url)
    if (
      url.origin !== 'https://github.com' ||
      !url.pathname.startsWith(`/${FORK_REPOSITORY}/releases/download/`)
    ) {
      throw new Error(`Update artifact for ${platform} is outside the fork`)
    }
    if (
      !artifact.signature?.trim() ||
      artifact.signature.includes('https://')
    ) {
      throw new Error(`Missing update signature for ${platform}`)
    }
  }
}
