import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  JD_TIME_RANGE_DAYS,
  createFullTimeRangeSchedule as createRendererSchedule,
  normalizeTimeRangeSchedule as normalizeRendererSchedule,
  summarizeTimeRangeSchedule,
  timeRangeCoefficientColor,
  timeRangeScheduleError as rendererScheduleError
} from '../src/renderer/src/utils/jdExpressTimeRange'

const require = createRequire(import.meta.url)
const {
  createFullTimeRangeSchedule,
  normalizeTimeRangeConfig,
  serializeTimeRangePriceCoef,
  timeRangeConfigError
} = require('../src/main/jd-express-time-range')

const view = readFileSync(new URL('../src/renderer/src/views/operations/JdExpress.vue', import.meta.url), 'utf8')

describe('京东快车投放时段与实时折扣', () => {
  it('全天投放沿用京东默认值，不发送冗余分时配置', () => {
    expect(serializeTimeRangePriceCoef({ timeRangeMode: 'all' })).toBe('')
    expect(normalizeTimeRangeConfig({})).toMatchObject({
      timeRangeMode: 'all',
      timeRangeSchedule: createFullTimeRangeSchedule(100)
    })
  })

  it('自定义配置按京东 0～6 日、每小时 24 格序列化并计算投放率', () => {
    const schedule = createFullTimeRangeSchedule(0)
    schedule[1] = Array(24).fill(80)
    const encoded = JSON.parse(serializeTimeRangePriceCoef({
      timeRangeMode: 'custom',
      timeRangeSchedule: schedule
    }))

    expect(Object.keys(encoded.detail)).toEqual(['0', '1', '2', '3', '4', '5', '6'])
    expect(encoded.detail['1'].price_coef).toEqual(Array(24).fill(80))
    expect(encoded.detail['0'].price_coef).toEqual(Array(24).fill(0))
    expect(encoded.per).toBe('14.29%')
  })

  it('只允许 0 或 30%～500% 的整数，且不能全部停投', () => {
    for (const invalid of [29, 501, 99.5, 'bad']) {
      const schedule = createFullTimeRangeSchedule(100)
      schedule[0][0] = invalid
      const config = { timeRangeMode: 'custom', timeRangeSchedule: schedule }
      expect(timeRangeConfigError(config)).toContain('30%～500%')
      expect(() => serializeTimeRangePriceCoef(config)).toThrow('30%～500%')
    }
    const stopped = createFullTimeRangeSchedule(0)
    expect(timeRangeConfigError({ timeRangeMode: 'custom', timeRangeSchedule: stopped })).toContain('至少保留 1 个')
  })

  it('渲染端恢复损坏配置时回退全天 100%，摘要准确', () => {
    expect(normalizeRendererSchedule([[100]])).toEqual(createRendererSchedule(100))
    const schedule = createRendererSchedule(0)
    schedule[0][8] = 60
    schedule[1][9] = 120
    expect(rendererScheduleError(schedule)).toBe('')
    expect(summarizeTimeRangeSchedule('custom', schedule)).toBe('每周 2/168 小时 · 60%～120%')
    expect(summarizeTimeRangeSchedule('all', schedule)).toBe('全天投放 · 100%')
  })

  it('同一折扣档内以连续色阶区分，停投时段保持白色', () => {
    expect(timeRangeCoefficientColor(30)).not.toBe(timeRangeCoefficientColor(60))
    expect(timeRangeCoefficientColor(60)).not.toBe(timeRangeCoefficientColor(100))
    expect(timeRangeCoefficientColor(100)).not.toBe(timeRangeCoefficientColor(101))
    expect(timeRangeCoefficientColor(0)).toBe('#fff')
  })

  it('页面使用紧凑入口和弹窗矩阵，并把设置排除在关键词准备签名之外', () => {
    expect(view).toContain('class="time-range-setting-row"')
    expect(view).toContain('title="投放时段与实时折扣系数"')
    expect(view).toContain("delete preparedConfig.timeRangeMode")
    expect(view).toContain("delete preparedConfig.timeRangeSchedule")
    expect(view).toContain('凌晨&nbsp; 00:00–06:00')
    expect(view).toContain('晚间&nbsp; 18:00–24:00')
    expect(view).toContain('class="time-range-selection-popover"')
  })

  it('从任意方向拖动都按矩形框选，松开先弹设置窗，确认后才应用整块系数', () => {
    const start = view.indexOf('function clearTimeRangeSelection(')
    const end = view.indexOf('\nfunction toggleTimeRangeDay(', start)
    const timeRangePainting = { value: false }
    const timeRangeSelectionPopupVisible = { value: false }
    const timeRangeApplyMode = { value: 'custom' }
    const timeRangeApplyCoefficient = { value: 80 }
    const timeRangeSelection = { startRow: -1, startHour: -1, endRow: -1, endHour: -1 }
    const timeRangeDraft = { value: createRendererSchedule(100) }
    const ElMessage = { warning: () => { throw new Error('不应触发校验错误') } }
    const functions = new Function(
      'timeRangePainting', 'timeRangeSelectionPopupVisible', 'timeRangeApplyMode', 'timeRangeApplyCoefficient',
      'timeRangeSelection', 'timeRangeDraft', 'JD_TIME_RANGE_DAYS', 'ElMessage',
      view.slice(start, end) + '\nreturn { beginTimeRangePaint, continueTimeRangePaint, isTimeRangeCellSelected, stopTimeRangePaint, confirmTimeRangeSelection }'
    )(
      timeRangePainting, timeRangeSelectionPopupVisible, timeRangeApplyMode, timeRangeApplyCoefficient,
      timeRangeSelection, timeRangeDraft, JD_TIME_RANGE_DAYS, ElMessage
    )

    functions.beginTimeRangePaint(3, 5)
    functions.continueTimeRangePaint(1, 3)
    expect(functions.isTimeRangeCellSelected(2, 4)).toBe(true)
    expect(functions.isTimeRangeCellSelected(0, 4)).toBe(false)
    functions.stopTimeRangePaint()
    expect(timeRangeSelectionPopupVisible.value).toBe(true)
    expect(timeRangeDraft.value[JD_TIME_RANGE_DAYS[2].apiIndex][4]).toBe(100)
    timeRangeApplyCoefficient.value = 80
    functions.confirmTimeRangeSelection()

    for (const row of [1, 2, 3]) {
      const apiDay = JD_TIME_RANGE_DAYS[row].apiIndex
      expect(timeRangeDraft.value[apiDay].slice(3, 6)).toEqual([80, 80, 80])
    }
    expect(timeRangeDraft.value[JD_TIME_RANGE_DAYS[0].apiIndex][4]).toBe(100)
    expect(timeRangePainting.value).toBe(false)
    expect(timeRangeSelectionPopupVisible.value).toBe(false)
  })
})
