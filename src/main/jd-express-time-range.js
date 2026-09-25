'use strict'

const TIME_RANGE_DAY_COUNT = 7
const TIME_RANGE_HOUR_COUNT = 24
const DEFAULT_TIME_RANGE_COEFFICIENT = 100

function createFullTimeRangeSchedule(coefficient = DEFAULT_TIME_RANGE_COEFFICIENT) {
  return Array.from({ length: TIME_RANGE_DAY_COUNT }, () =>
    Array(TIME_RANGE_HOUR_COUNT).fill(coefficient))
}

function isValidTimeRangeCoefficient(value) {
  const coefficient = Number(value)
  return Number.isInteger(coefficient) && (coefficient === 0 || (coefficient >= 30 && coefficient <= 500))
}

function timeRangeConfigError(config = {}) {
  if (config.timeRangeMode !== 'custom') return ''
  const schedule = config.timeRangeSchedule
  if (!Array.isArray(schedule) || schedule.length !== TIME_RANGE_DAY_COUNT) {
    return '投放时段数据不完整，请重新设置'
  }
  let activeHours = 0
  for (let day = 0; day < TIME_RANGE_DAY_COUNT; day += 1) {
    if (!Array.isArray(schedule[day]) || schedule[day].length !== TIME_RANGE_HOUR_COUNT) {
      return '投放时段数据不完整，请重新设置'
    }
    for (let hour = 0; hour < TIME_RANGE_HOUR_COUNT; hour += 1) {
      if (!isValidTimeRangeCoefficient(schedule[day][hour])) {
        return '实时折扣系数只能为 0（停投）或 30%～500% 的整数'
      }
      if (Number(schedule[day][hour]) > 0) activeHours += 1
    }
  }
  return activeHours ? '' : '自定义时段不能全部停投，请至少保留 1 个投放小时'
}

function normalizeTimeRangeSchedule(schedule) {
  if (!Array.isArray(schedule) || schedule.length !== TIME_RANGE_DAY_COUNT ||
      schedule.some((day) => !Array.isArray(day) || day.length !== TIME_RANGE_HOUR_COUNT ||
        day.some((value) => !isValidTimeRangeCoefficient(value)))) {
    return createFullTimeRangeSchedule()
  }
  return schedule.map((day) => day.map(Number))
}

function normalizeTimeRangeConfig(config = {}) {
  const timeRangeMode = config.timeRangeMode === 'custom' ? 'custom' : 'all'
  if (timeRangeMode === 'custom') {
    const error = timeRangeConfigError(config)
    if (error) {
      const exception = new Error(error)
      exception.code = 'JD_EXPRESS_TIME_RANGE_INVALID'
      exception.creationStage = 'time_range_validation'
      throw exception
    }
  }
  return {
    timeRangeMode,
    timeRangeSchedule: normalizeTimeRangeSchedule(config.timeRangeSchedule)
  }
}

function serializeTimeRangePriceCoef(config = {}) {
  const normalized = normalizeTimeRangeConfig(config)
  if (normalized.timeRangeMode !== 'custom') return ''
  const detail = {}
  let activeHours = 0
  for (let day = 0; day < TIME_RANGE_DAY_COUNT; day += 1) {
    const priceCoef = [...normalized.timeRangeSchedule[day]]
    activeHours += priceCoef.filter((value) => value > 0).length
    detail[String(day)] = { price_coef: priceCoef }
  }
  const percentage = Number((activeHours / (TIME_RANGE_DAY_COUNT * TIME_RANGE_HOUR_COUNT) * 100).toFixed(2))
  return JSON.stringify({ detail, per: `${percentage}%` })
}

module.exports = {
  DEFAULT_TIME_RANGE_COEFFICIENT,
  TIME_RANGE_DAY_COUNT,
  TIME_RANGE_HOUR_COUNT,
  createFullTimeRangeSchedule,
  isValidTimeRangeCoefficient,
  normalizeTimeRangeConfig,
  normalizeTimeRangeSchedule,
  serializeTimeRangePriceCoef,
  timeRangeConfigError
}
