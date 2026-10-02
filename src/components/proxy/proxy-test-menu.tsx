import ArrowDropDownRounded from '@mui/icons-material/ArrowDropDownRounded'
import { IconButton, Menu, MenuItem } from '@mui/material'
import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { speedTestStore, type SpeedTestMode } from '@/services/speedtest'

export function ProxyTestMenu({
  onSelect,
}: {
  onSelect: (mode: SpeedTestMode) => void
}) {
  const { t } = useTranslation()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const batch = useSyncExternalStore(
    speedTestStore.subscribe,
    speedTestStore.batch,
  )

  return (
    <>
      <IconButton
        size="small"
        color="inherit"
        disabled={!!batch}
        title={t('proxies.speed.chooseMode')}
        aria-label={t('proxies.speed.chooseMode')}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(event) => {
          event.stopPropagation()
          setAnchor(event.currentTarget)
        }}
        sx={{ p: 0.25 }}
      >
        <ArrowDropDownRounded fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        onClick={(event) => event.stopPropagation()}
      >
        {(['latency', 'download'] as const).map((mode) => (
          <MenuItem
            key={mode}
            disabled={!!batch}
            onClick={() => {
              setAnchor(null)
              onSelect(mode)
            }}
          >
            {t(
              mode === 'latency'
                ? 'proxies.speed.latencyOnly'
                : 'proxies.speed.withDownload',
            )}
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
