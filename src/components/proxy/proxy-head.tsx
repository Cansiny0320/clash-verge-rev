import {
  AccessTimeRounded,
  MyLocationRounded,
  NetworkCheckRounded,
  SearchOffRounded,
  SearchRounded,
  VisibilityRounded,
  VisibilityOffRounded,
  WifiTetheringRounded,
  WifiTetheringOffRounded,
  SortByAlphaRounded,
  SortRounded,
} from '@mui/icons-material'
import StopRounded from '@mui/icons-material/StopRounded'
import { Box, IconButton, TextField, type SxProps } from '@mui/material'
import { useSyncExternalStore } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseSearchBox } from '@/components/base'
import { useVerge } from '@/hooks/use-verge'
import delayManager from '@/services/delay'
import { showNotice } from '@/services/notice-service'
import { speedTestStore, type SpeedTestMode } from '@/services/speedtest'
import { isValidUrl } from '@/utils/network'

import { ProxyTestMenu } from './proxy-test-menu'
import type { ProxySortType } from './use-filter-sort'
import type { HeadState } from './use-head-state'

interface Props {
  sx?: SxProps
  url?: string
  groupName: string
  headState: HeadState
  onLocation: () => void
  onCheckDelay: (mode?: SpeedTestMode) => void
  onHeadState: (val: Partial<HeadState>) => void
}

const defaultSx: SxProps = {}

export const ProxyHead = ({
  sx = defaultSx,
  url,
  groupName,
  headState,
  onHeadState,
  onLocation,
  onCheckDelay,
}: Props) => {
  const {
    showType,
    sortType,
    filterText,
    textState,
    testUrl,
    filterMatchCase,
    filterMatchWholeWord,
    filterUseRegularExpression,
  } = headState

  const { t } = useTranslation()
  const batch = useSyncExternalStore(
    speedTestStore.subscribe,
    speedTestStore.batch,
  )
  const testing = batch?.group === groupName

  const [autoFocus, setAutoFocus] = useState(false)

  useEffect(() => {
    // fix the focus conflict
    const timer = setTimeout(() => setAutoFocus(true), 100)
    return () => clearTimeout(timer)
  }, [])

  const { verge } = useVerge()
  const defaultLatencyUrl =
    verge?.default_latency_test?.trim() ||
    'http://cp.cloudflare.com/generate_204'

  useEffect(() => {
    delayManager.setUrl(groupName, testUrl?.trim() || url || defaultLatencyUrl)
  }, [groupName, testUrl, defaultLatencyUrl, url])

  const runTest = (mode: SpeedTestMode = 'download') => {
    if (testing) {
      onCheckDelay(mode)
      return
    }
    if (testUrl?.trim() && textState !== 'filter')
      onHeadState({ textState: 'url' })
    if (testUrl?.trim() && !isValidUrl(testUrl)) {
      showNotice.warning('proxies.feedback.warnings.invalidTestUrl')
      return
    }
    onCheckDelay(mode)
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ...sx }}>
      <IconButton
        size="small"
        color="inherit"
        title={t('proxies.page.tooltips.locate')}
        onClick={onLocation}
      >
        <MyLocationRounded />
      </IconButton>

      <IconButton
        size="small"
        color="inherit"
        disabled={!!batch && (!testing || batch.stopping)}
        title={
          testing
            ? t('proxies.speed.stop', {
                completed: batch.completed,
                total: batch.total,
              })
            : t('proxies.speed.start')
        }
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          runTest()
        }}
      >
        {testing ? <StopRounded /> : <NetworkCheckRounded />}
      </IconButton>
      <ProxyTestMenu onSelect={runTest} />

      {testing && (
        <Box component="span" sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {batch.phase === 'latency'
            ? t('proxies.speed.latencyTesting')
            : `${batch.completed}/${batch.total}`}
        </Box>
      )}

      <IconButton
        size="small"
        color="inherit"
        title={
          [
            t('proxies.page.tooltips.sortDefault'),
            t('proxies.page.tooltips.sortDelay'),
            t('proxies.page.tooltips.sortName'),
          ][sortType]
        }
        onClick={() =>
          onHeadState({ sortType: ((sortType + 1) % 3) as ProxySortType })
        }
      >
        {sortType !== 1 && sortType !== 2 && <SortRounded />}
        {sortType === 1 && <AccessTimeRounded />}
        {sortType === 2 && <SortByAlphaRounded />}
      </IconButton>

      <IconButton
        size="small"
        color="inherit"
        title={t('proxies.page.tooltips.delayCheckUrl')}
        onClick={() =>
          onHeadState({ textState: textState === 'url' ? null : 'url' })
        }
      >
        {textState === 'url' ? (
          <WifiTetheringRounded />
        ) : (
          <WifiTetheringOffRounded />
        )}
      </IconButton>

      <IconButton
        size="small"
        color="inherit"
        title={
          showType
            ? t('proxies.page.tooltips.showBasic')
            : t('proxies.page.tooltips.showDetail')
        }
        onClick={() => onHeadState({ showType: !showType })}
      >
        {showType ? <VisibilityRounded /> : <VisibilityOffRounded />}
      </IconButton>

      <IconButton
        size="small"
        color="inherit"
        title={t('proxies.page.tooltips.filter')}
        onClick={() =>
          onHeadState({ textState: textState === 'filter' ? null : 'filter' })
        }
      >
        {textState === 'filter' ? <SearchOffRounded /> : <SearchRounded />}
      </IconButton>

      {textState === 'filter' && (
        <Box sx={{ ml: 0.5, flex: '1 1 auto' }}>
          <BaseSearchBox
            autoFocus={autoFocus}
            value={filterText}
            searchState={{
              matchCase: filterMatchCase,
              matchWholeWord: filterMatchWholeWord,
              useRegularExpression: filterUseRegularExpression,
            }}
            onSearch={(_, state) =>
              onHeadState({
                filterText: state.text,
                filterMatchCase: state.matchCase,
                filterMatchWholeWord: state.matchWholeWord,
                filterUseRegularExpression: state.useRegularExpression,
              })
            }
          />
        </Box>
      )}

      {textState === 'url' && (
        <TextField
          autoComplete="new-password"
          autoFocus={autoFocus}
          hiddenLabel
          autoSave="off"
          value={testUrl}
          size="small"
          variant="outlined"
          placeholder={t('proxies.page.placeholders.delayCheckUrl')}
          onChange={(e) => onHeadState({ testUrl: e.target.value })}
          sx={{ ml: 0.5, flex: '1 1 auto', input: { py: 0.65, px: 1 } }}
        />
      )}
    </Box>
  )
}
