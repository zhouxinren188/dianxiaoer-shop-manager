import { describe, expect, it } from 'vitest'
import { normalizeSalesSkuSpec } from '../src/renderer/src/utils/salesSkuSpec.js'

describe('销售订单规格显示', () => {
  it('修复历史数据中错误的问号属性分隔符', () => {
    expect(normalizeSalesSkuSpec('规格?套餐13号 / 尺码?不含盆'))
      .toBe('规格：套餐13号 / 尺码：不含盆')
  })

  it('统一中英文冒号并保留规格值中的其他符号', () => {
    expect(normalizeSalesSkuSpec('颜色:绿色 / 型号：A?款'))
      .toBe('颜色：绿色 / 型号：A?款')
  })
})
