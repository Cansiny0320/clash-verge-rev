import { Box } from '@mui/material'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { speedKey, speedTestStore } from '@/services/speedtest'
import type { ResolvedProxyMember } from '@/types/proxy-view'

export function ProxySpeed({
  group,
  member,
}: {
  group: string
  member: ResolvedProxyMember
}) {
  const { t } = useTranslation()
  const result = useSyncExternalStore(speedTestStore.subscribe, () =>
    speedTestStore.result(group, speedKey(member)),
  )
  if (!result) return null
  const speed = result.bytesPerSecond
  const label =
    result.status === 'done' && speed != null
      ? `↓ ${(speed / 1_000_000).toFixed(2)} MB/s`
      : t(`proxies.speed.${result.status}`)
  return (
    <Box
      component="span"
      title={result.error || t('proxies.speed.description')}
      sx={{
        display: 'block',
        fontSize: 11,
        whiteSpace: 'nowrap',
        textAlign: 'right',
        color: result.status === 'error' ? 'error.main' : 'text.secondary',
        px: 0.5,
      }}
    >
      {label}
    </Box>
  )
}
