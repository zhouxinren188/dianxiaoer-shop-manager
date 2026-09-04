import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildCampaignListBody,
  buildDeleteCampaignBody,
  normalizeCampaignIds,
  normalizeCampaignList
} = require('../src/main/jd-express-delete')

describe('京东快车计划删除参数', () => {
  it('与原工具的有效计划查询参数一致', () => {
    expect(buildCampaignListBody()).toEqual({
      businessType: 2,
      yn: 1,
      campaignTypes: [2, 18, 41],
      billingType: null,
      level: '',
      requestFrom: 0
    })
  })

  it('与原工具的批量删除参数一致', () => {
    expect(buildDeleteCampaignBody([101, 102, 101])).toEqual({
      operateType: 3,
      ids: [101, 102],
      requestFrom: 0
    })
  })

  it('兼容列表直接位于 data 或 data.list', () => {
    expect(normalizeCampaignList({ data: [{ id: 1, name: '计划一', campaignType: 2 }] })).toEqual([
      { id: 1, name: '计划一', campaignType: 2, status: null }
    ])
    expect(normalizeCampaignList({ data: { list: [{ campaignId: '2', campaignName: '计划二' }] } })).toEqual([
      { id: '2', name: '计划二', campaignType: null, status: null }
    ])
  })

  it('清理空计划 ID 并保持数值类型', () => {
    expect(normalizeCampaignIds([1, '', null, '2', 1])).toEqual([1, '2'])
    expect(() => buildDeleteCampaignBody([])).toThrow('没有可删除的京东快车计划')
  })
})
