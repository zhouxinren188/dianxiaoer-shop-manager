export const JD_TIME_RANGE_DAYS = Object.freeze([
  { apiIndex: 1, label: '周一' },
  { apiIndex: 2, label: '周二' },
  { apiIndex: 3, label: '周三' },
  { apiIndex: 4, label: '周四' },
  { apiIndex: 5, label: '周五' },
  { apiIndex: 6, label: '周六' },
  { apiIndex: 0, label: '周日' }
])

export function createFullTimeRangeSchedule(coefficient = 100) {
  return Array.from({ length: 7 }, () => Array(24).fill(coefficient))
}

export function isValidTimeRangeCoefficient(value) {
  const coefficient = Number(value)
  return Number.isInteger(coefficient) && (coefficient === 0 || (coefficient >= 30 && coefficient <= 500))
}

export function normalizeTimeRangeSchedule(schedule) {
  if (!Array.isArray(schedule) || schedule.length !== 7 ||
      schedule.some((day) => !Array.isArray(day) || day.length !== 24 ||
        day.some((value) => !isValidTimeRangeCoefficient(value)))) {
    return createFullTimeRangeSchedule()
  }
  return schedule.map((day) => day.map(Number))
}

export function timeRangeScheduleError(schedule) {
  if (!Array.isArray(schedule) || schedule.length !== 7 ||
      schedule.some((day) => !Array.isArray(day) || day.length !== 24)) {
    return '投放时段数据不完整，请重新设置'
  }
  let activeHours = 0
  for (const day of schedule) {
    for (const value of day) {
      if (!isValidTimeRangeCoefficient(value)) return '实时折扣系数只能为 0（停投）或 30%～500% 的整数'
      if (Number(value) > 0) activeHours += 1
    }
  }
  return activeHours ? '' : '自定义时段不能全部停投，请至少保留 1 个投放小时'
}

export function summarizeTimeRangeSchedule(mode, schedule) {
  if (mode !== 'custom') return '全天投放 · 100%'
  const normalized = normalizeTimeRangeSchedule(schedule)
  const active = normalized.flat().filter((value) => value > 0)
  if (!active.length) return '尚未设置有效时段'
  const minimum = Math.min(...active)
  const maximum = Math.max(...active)
  const range = minimum === maximum ? `${minimum}%` : `${minimum}%～${maximum}%`
  return `每周 ${active.length}/168 小时 · ${range}`
}

const TIME_RANGE_COLOR_STOPS = Object.freeze([
  { value: 30, color: [255, 244, 231] },
  { value: 100, color: [255, 211, 173] },
  { value: 200, color: [255, 127, 132] },
  { value: 300, color: [190, 84, 187] },
  { value: 400, color: [132, 74, 205] },
  { value: 500, color: [76, 101, 211] }
])

export function timeRangeCoefficientColor(value) {
  const coefficient = Number(value)
  // 京东的 0 表示该小时不投放，界面保持空白，避免被误解为一个很低的折扣档位。
  if (!Number.isFinite(coefficient) || coefficient <= 0) return '#fff'
  const clamped = Math.min(Math.max(coefficient, 30), 500)
  const upperIndex = TIME_RANGE_COLOR_STOPS.findIndex((stop) => clamped <= stop.value)
  const upper = TIME_RANGE_COLOR_STOPS[Math.max(upperIndex, 0)]
  const lower = TIME_RANGE_COLOR_STOPS[Math.max(upperIndex - 1, 0)]
  const ratio = upper.value === lower.value ? 0 : (clamped - lower.value) / (upper.value - lower.value)
  const color = lower.color.map((channel, index) => Math.round(channel + (upper.color[index] - channel) * ratio))
  return `rgb(${color.join(', ')})`
}
