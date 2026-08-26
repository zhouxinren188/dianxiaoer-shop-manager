import { describe, expect, it } from 'vitest'
import { normalizeBuyerAddress } from '../src/renderer/src/utils/buyerAddress.js'

describe('买家真实地址清洗', () => {
  it('移除真实地址末尾多余的英文或中文句点', () => {
    expect(normalizeBuyerAddress('江苏省宿迁市沭阳县仓库路1号.')).toBe('江苏省宿迁市沭阳县仓库路1号')
    expect(normalizeBuyerAddress('江苏省宿迁市沭阳县仓库路1号。。  ')).toBe('江苏省宿迁市沭阳县仓库路1号')
    expect(normalizeBuyerAddress('江苏省宿迁市沭阳县仓库路1号．')).toBe('江苏省宿迁市沭阳县仓库路1号')
  })

  it('保留地址中间的点号和采购编号', () => {
    expect(normalizeBuyerAddress('江苏省宿迁市1.5公里处【A9006】')).toBe('江苏省宿迁市1.5公里处【A9006】')
    expect(normalizeBuyerAddress('')).toBe('')
  })
})
