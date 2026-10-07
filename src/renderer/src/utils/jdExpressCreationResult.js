function count(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

function formatCount(value) {
  return count(value).toLocaleString('zh-CN')
}

function formatBid(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  return number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function summarizeKeywords(result, failureCount) {
  const preparedValue = result?.keywordSummary?.actualKeywordCount
  const hasPreparedCount = Number.isFinite(Number(preparedValue))
  const prepared = count(preparedValue)
  const filtered = count(result?.skippedKeywordCount)
  const hasWrittenCount = Array.isArray(result?.units)
  // 续传结果中的已完成单元来自旧检查点，旧检查点没有保存过滤后的关键词数。
  // 此时不拼凑关键词总账，避免把准备数量误报成成功写入数量。
  if (hasWrittenCount && result.units.some(unit => unit?.resumed)) return null
  const written = hasWrittenCount
    ? result.units.reduce((total, unit) => total + count(unit?.keywordCount), 0)
    : 0

  if (!hasPreparedCount && !filtered && !hasWrittenCount) return null

  // “通过出价过滤”是准备总量扣除价格策略过滤后的数量。成功写入数只取
  // 京东明确返回成功的单元，二者的差额即随失败单元未写入的关键词。
  const eligible = hasPreparedCount ? Math.max(written, prepared - filtered) : null
  const notWritten = hasWrittenCount && eligible != null ? Math.max(0, eligible - written) : null
  const maxBid = formatBid(result?.creationConfigSnapshot?.config?.maxCustomKeywordBid)
  const steps = []
  if (hasPreparedCount) steps.push({ key: 'prepared', label: '实际准备', value: prepared, tone: 'neutral' })
  if (filtered || hasPreparedCount) steps.push({ key: 'filtered', label: '出价规则过滤', value: filtered, tone: 'warning' })
  if (eligible != null) steps.push({ key: 'eligible', label: '通过过滤', value: eligible, tone: 'neutral' })
  if (hasWrittenCount) steps.push({ key: 'written', label: '成功写入', value: written, tone: 'success' })
  if (notWritten) steps.push({ key: 'not-written', label: '随失败单元未写入', value: notWritten, tone: 'danger' })

  const filterReason = maxBid
    ? `京东最低出价超过您设置的最高 ¥${maxBid}，或京东未返回有效底价`
    : '京东最低出价超过设置上限，或京东未返回有效底价'
  const notes = []
  if (filtered) notes.push(`${formatCount(filtered)} 个关键词因${filterReason}而过滤，未提交到京东；这个数字不是创建成功数量。`)
  if (notWritten) {
    notes.push(failureCount
      ? `另有 ${formatCount(notWritten)} 个关键词已通过出价过滤，但因 ${formatCount(failureCount)} 个推广单元创建失败而未写入。`
      : `另有 ${formatCount(notWritten)} 个关键词未随成功单元写入，请结合失败或核验明细确认。`)
  }
  if (!notes.length && hasWrittenCount) notes.push(`本轮成功写入 ${formatCount(written)} 个关键词。`)

  return { prepared, filtered, eligible, written, notWritten, steps, note: notes.join('') }
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
  const timeRangeFailures = count(result.timeRangeFailureCount)
  const allSkipped = !units && !failures && skippedUnits > 0
  const partial = units > 0 && (failures > 0 || skippedUnits > 0 || skippedKeywords > 0 ||
    timeRangeFailures > 0 || units < unitTotal || campaigns < campaignTotal)
  const keywordBreakdown = summarizeKeywords(result, failures)
  const description = `计划：成功 ${campaigns}/${campaignTotal} 个。推广单元：成功 ${units}/${unitTotal} 个，失败 ${failures} 个` +
    (skippedUnits ? `，整单元跳过 ${skippedUnits} 个` : '') + '。' +
    (timeRangeFailures ? ` ${timeRangeFailures} 个计划的投放时段待重试。` : '')
  const toastMessage = keywordBreakdown && Array.isArray(result.units)
    ? `创建完成：${units}/${unitTotal} 个推广单元成功；关键词实际准备 ${formatCount(keywordBreakdown.prepared)} 个，出价规则过滤 ${formatCount(keywordBreakdown.filtered)} 个，成功写入 ${formatCount(keywordBreakdown.written)} 个${keywordBreakdown.notWritten ? `，随失败单元未写入 ${formatCount(keywordBreakdown.notWritten)} 个` : ''}。`
    : `创建完成：成功 ${campaigns}/${campaignTotal} 个计划、${units}/${unitTotal} 个单元；失败 ${failures} 个单元。`
  return {
    type: allSkipped ? 'info' : !units ? 'error' : partial ? 'warning' : 'success',
    title: `本轮任务已结束：${allSkipped ? '全部跳过，未创建计划' : !units ? '全部创建失败' : partial ? '部分成功' : '全部创建成功'}`,
    description,
    keywordBreakdown,
    toastMessage,
    safetyHint: timeRangeFailures && !failures
      ? '计划和推广单元已经创建成功，只需重试投放时段；系统不会重复创建计划或单元。'
      : campaigns || units
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
