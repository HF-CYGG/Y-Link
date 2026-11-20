export const DEFAULT_STORE_BUSINESS_HOURS = '10:00 - 22:00'
export const DEFAULT_STORE_PICKUP_ADDRESS = '海右书院112房间'
export const STORE_BUSINESS_HOURS_MAX_LENGTH = 100
export const PICKUP_SLOT_STEP_MINUTES = 30

export interface StoreBusinessPeriod {
  open: string
  close: string
}

const timeRangePattern = '(\\d{1,2}:\\d{2})\\s*[-~～—–至]\\s*(\\d{1,2}:\\d{2})'
const fullTimeRange = new RegExp(`^${timeRangePattern}$`)
const legacyTimeRange = new RegExp(timeRangePattern)

const minuteOfDay = (value: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return NaN
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (minute >= 60 || hour > 24 || (hour === 24 && minute !== 0)) return NaN
  return hour * 60 + minute
}

const formatMinute = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

const normalizeBusinessPeriods = (periods: StoreBusinessPeriod[]) => {
  const ranges = periods.map(({ open, close }) => ({ open: minuteOfDay(open), close: minuteOfDay(close) }))
  if (!ranges.length || ranges.some(({ open, close }) => !(close - open >= PICKUP_SLOT_STEP_MINUTES))) return null
  ranges.sort((left, right) => left.open - right.open)
  if (ranges.some((range, index) => index > 0 && range.open < ranges[index - 1]!.close)) return null
  return ranges
}

const parseBusinessPeriods = (text: string) => {
  const periods: StoreBusinessPeriod[] = []
  for (const part of text.split('；')) {
    const match = fullTimeRange.exec(part.trim())
    if (!match) return null
    periods.push({ open: match[1]!, close: match[2]! })
  }
  return normalizeBusinessPeriods(periods)
}

export const parseEditableStoreBusinessHours = (text: string): StoreBusinessPeriod[] | null => {
  const ranges = parseBusinessPeriods(text)
  // 日期控件只支持 00:00 到 23:59；历史 24:00 收店仍由客户端解释，并予以原样保留。
  if (!ranges || ranges.some(({ close }) => close === 24 * 60)) return null
  return ranges.map(({ open, close }) => ({ open: formatMinute(open), close: formatMinute(close) }))
}

export const formatStoreBusinessHours = (periods: StoreBusinessPeriod[]) => {
  const ranges = normalizeBusinessPeriods(periods)
  if (!ranges || ranges.some(({ close }) => close === 24 * 60)) return null
  const text = ranges.map(({ open, close }) => `${formatMinute(open)} - ${formatMinute(close)}`).join('；')
  return text.length <= STORE_BUSINESS_HOURS_MAX_LENGTH ? text : null
}

export const resolvePickupSlotMinutes = (businessHours: string): number[] => {
  let ranges = parseBusinessPeriods(businessHours)
  if (!ranges) {
    const legacy = legacyTimeRange.exec(businessHours)
    if (legacy) ranges = normalizeBusinessPeriods([{ open: legacy[1]!, close: legacy[2]! }])
  }
  const minutes: number[] = []
  for (const range of ranges ?? [{ open: 10 * 60, close: 22 * 60 }]) {
    for (let slot = range.open; slot <= range.close - PICKUP_SLOT_STEP_MINUTES; slot += PICKUP_SLOT_STEP_MINUTES) {
      minutes.push(slot)
    }
  }
  return minutes
}
