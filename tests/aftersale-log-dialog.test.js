import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/renderer/src/views/aftersale/PurchaseRefund.vue', import.meta.url), 'utf8')

describe('售后处理日志弹窗', () => {
  it('提交成功后立即关闭弹窗并保留成功提示', () => {
    const submitStart = source.indexOf('async function submitLog()')
    const submitEnd = source.indexOf('async function handleViewOrder', submitStart)
    const submitSource = source.slice(submitStart, submitEnd)
    const updateIndex = submitSource.indexOf('await updatePurchaseStatus')
    const closeIndex = submitSource.indexOf('logDialogVisible.value = false')
    const successIndex = submitSource.indexOf("ElMessage.success('日志已添加')")

    expect(updateIndex).toBeGreaterThan(-1)
    expect(closeIndex).toBeGreaterThan(updateIndex)
    expect(successIndex).toBeGreaterThan(closeIndex)
  })
})
