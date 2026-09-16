function count(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

export function summarizeCreationResult(result) {
  if (!result) return null
  const campaigns = count(result.successCampaignCount)
  const campaignTotal = count(result.campaignCount)
  const units = count(result.successUnitCount)
  const unitTotal = count(result.unitCount)
  const failures = count(result.failureCount)
  const skippedUnits = count(result.skippedUnitCount)
  const skippedKeywords = count(result.skippedKeywordCount)
  const allSkipped = !units && !failures && skippedUnits > 0
  const partial = units > 0 && (failures > 0 || skippedUnits > 0 || skippedKeywords > 0 ||
    units < unitTotal || campaigns < campaignTotal)
  return {
    type: allSkipped ? 'info' : !units ? 'error' : partial ? 'warning' : 'success',
    title: `本轮任务已结束：${allSkipped ? '全部跳过，未创建计划' : !units ? '全部创建失败' : partial ? '部分成功' : '全部创建成功'}`,
    description: `成功 ${campaigns}/${campaignTotal} 个计划、${units}/${unitTotal} 个单元；失败 ${failures} 个单元` +
      (skippedUnits || skippedKeywords ? `；跳过 ${skippedUnits} 个单元、${skippedKeywords} 个关键词` : ''),
    safetyHint: campaigns || units
      ? '已成功的计划无需重建。请先查看失败明细并到京准通核对，勿将原商品整批再次创建。'
      : '本轮没有创建成功的计划。请查看失败或跳过明细，调整后重新选品；不会自动重跑。'
  }
}

export function creationVerificationHint(result = {}) {
  if (result.status === 'checking') return '后台核验进行中，不影响本轮已返回的创建结果'
  if (result.status === 'matched') return '计划、单元、创意和关键词核验通过'
  if (result.status === 'unavailable') return '后台核验暂未完成，不代表创建失败，请到京准通核对'
  if (result.status !== 'mismatch') return ''
  const labels = { campaign: '计划', adgroup: '单元', ad: '创意', keyword: '关键词' }
  const missing = Object.entries(result.missing || {})
    .filter(([key, value]) => labels[key] && count(value) > 0)
    .map(([key, value]) => `${labels[key]}少 ${count(value)} 个`).join('、')
  return `后台核验${missing ? `发现：${missing}` : '数据暂不一致'}；这是核验提示，不会自动补建或重发整批`
}
