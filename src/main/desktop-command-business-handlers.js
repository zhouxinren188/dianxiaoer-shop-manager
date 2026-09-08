const BUSINESS_PROXY_BASE_URL = 'https://150.158.54.108/api/desktop-channel/business'
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 150000

function businessError(code, message, extras = {}) {
  return Object.assign(new Error(message), { code, ...extras })
}

function safeMessage(value, maxLength = 500) {
  return String(value || '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|cookie|token|password|api[_ -]?key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maxLength)
}

function normalizePurchaseOrderId(value) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw businessError('purchase_order_id_invalid', '采购订单 ID 无效')
  }
  return id
}

function delay(ms, setTimeoutFn = setTimeout) {
  return new Promise(resolve => setTimeoutFn(resolve, ms))
}

async function pollOrderConfiguration({
  requestApi,
  purchaseOrderId,
  context,
  phase,
  now,
  sleep,
  pollIntervalMs,
  pollTimeoutMs
}) {
  const startedAt = now()
  let lastConfiguration = null
  while (now() - startedAt <= pollTimeoutMs) {
    context.assertActive()
    lastConfiguration = await requestApi({
      method: 'GET',
      endpoint: '/purchase-orders/' + purchaseOrderId + '/cloud-configuration'
    })
    const currentTask = lastConfiguration?.workflow?.currentTask
    if (!currentTask) return lastConfiguration
    await context.reportProgress({
      phase,
      remote_command: String(currentTask.command || '').slice(0, 80),
      remote_status: String(currentTask.transportStatus || currentTask.executionStatus || 'processing').slice(0, 80),
      elapsed_seconds: Math.floor((now() - startedAt) / 1000)
    })
    await sleep(pollIntervalMs)
  }
  throw businessError('cloud_workflow_timeout', '云仓助手在限定时间内没有返回明确结果，请稍后人工核验')
}

function summarizeExceptionCheck(configuration, purchaseOrderId, now) {
  const exception = configuration?.exception
  if (!exception?.resultShapeValid || exception.status !== 'succeeded') {
    throw businessError(
      'exception_check_unconfirmed',
      safeMessage(exception?.message || '云仓助手未确认异常查询结果')
    )
  }
  const exceptionCount = Number(exception.exceptionCount)
  if (!Number.isInteger(exceptionCount) || exceptionCount < 0 || exceptionCount > 100) {
    throw businessError('exception_result_invalid', '异常查询数量无效')
  }
  return {
    purchase_order_id: purchaseOrderId,
    state: exceptionCount > 0 ? 'exception_found' : 'exception_clear',
    exception_count: exceptionCount,
    message: safeMessage(
      exception.message || (exceptionCount > 0
        ? '查询到 ' + exceptionCount + ' 条待处理异常'
        : '当前订单没有待处理异常')
    ),
    checked_at: new Date(now()).toISOString()
  }
}

function createDesktopCommandBusinessHandlers({
  requestApi,
  submitVendorRemark,
  now = () => Date.now(),
  sleep = ms => delay(ms),
  pollIntervalMs = POLL_INTERVAL_MS,
  pollTimeoutMs = POLL_TIMEOUT_MS
} = {}) {
  if (typeof requestApi !== 'function' || typeof submitVendorRemark !== 'function') {
    throw new TypeError('requestApi and submitVendorRemark are required')
  }

  const poll = (purchaseOrderId, context, phase) => pollOrderConfiguration({
    requestApi,
    purchaseOrderId,
    context,
    phase,
    now,
    sleep,
    pollIntervalMs,
    pollTimeoutMs
  })

  async function checkException(payload, context) {
    const purchaseOrderId = normalizePurchaseOrderId(payload?.purchase_order_id)
    context.assertActive()
    await context.reportProgress({ phase: 'submitting_exception_check' })
    await requestApi({
      method: 'POST',
      endpoint: '/purchase-orders/' + purchaseOrderId + '/exception/check',
      body: {}
    })
    const configuration = await poll(purchaseOrderId, context, 'checking_exception')
    return summarizeExceptionCheck(configuration, purchaseOrderId, now)
  }

  async function submitPurchaseRemark(payload, context) {
    const purchaseOrderId = normalizePurchaseOrderId(payload?.purchase_order_id)
    if (payload?.confirmed !== true) {
      throw businessError('confirmation_required', '处理异常前必须由用户明确确认')
    }
    context.assertActive()
    await context.reportProgress({ phase: 'loading_order_context' })
    const [purchaseOrder, relatedSales] = await Promise.all([
      requestApi({ method: 'GET', endpoint: '/purchase-orders/' + purchaseOrderId }),
      requestApi({ method: 'GET', endpoint: '/purchase-orders/' + purchaseOrderId + '/related-sales' })
    ])
    const purchaseNo = String(purchaseOrder?.purchase_no || '').trim()
    if (!purchaseNo) throw businessError('purchase_no_missing', '当前采购单缺少采购编号')
    if (!relatedSales?.storeId || !relatedSales?.orderId) {
      throw businessError('sales_order_not_linked', '当前采购单缺少关联销售订单或店铺信息')
    }
    if (String(relatedSales.storePlatform || '').toLowerCase() !== 'jd') {
      throw businessError('sales_order_platform_invalid', '关联销售订单不是京东订单')
    }

    context.assertActive()
    await context.reportProgress({ phase: 'submitting_jd_remark' })
    let remarkResult
    try {
      remarkResult = await submitVendorRemark({
        storeId: relatedSales.storeId,
        orderId: relatedSales.orderId,
        remark: purchaseNo
      })
    } catch (error) {
      remarkResult = { success: false, message: safeMessage(error.message || '京东备注请求异常') }
    }
    remarkResult = {
      success: remarkResult?.success === true,
      message: safeMessage(remarkResult?.message || (
        remarkResult?.success ? '采购编号已自动备注到京东订单' : '京东自动备注未成功'
      ))
    }

    try {
      await requestApi({
        method: 'POST',
        endpoint: '/purchase-orders/' + purchaseOrderId + '/auto-remark-log',
        body: remarkResult
      })
    } catch {
      // 自动备注日志是过程审计，保存失败不能改变京东操作结果或阻断异常处理。
    }
    if (remarkResult.success) {
      const salesOrderId = Number(purchaseOrder?.sales_order_id)
      if (Number.isSafeInteger(salesOrderId) && salesOrderId > 0) {
        try {
          await requestApi({
            method: 'PUT',
            endpoint: '/sales-orders/' + salesOrderId + '/order-remark',
            body: { order_remark: purchaseNo }
          })
        } catch {
          // 京东已成功时，本地备注同步仅作尽力更新。
        }
      }
    }

    return {
      purchase_order_id: purchaseOrderId,
      remark_succeeded: remarkResult.success,
      remark_message: remarkResult.message,
      remarked_at: new Date(now()).toISOString()
    }
  }

  async function resolveException(payload, context) {
    const purchaseOrderId = normalizePurchaseOrderId(payload?.purchase_order_id)
    if (payload?.confirmed !== true) {
      throw businessError('confirmation_required', '处理异常前必须由用户明确确认')
    }
    const remarkResult = await submitPurchaseRemark(payload, context)

    context.assertActive()
    await context.reportProgress({
      phase: 'submitting_exception_resolve',
      remark_succeeded: remarkResult.remark_succeeded
    })
    await requestApi({
      method: 'POST',
      endpoint: '/purchase-orders/' + purchaseOrderId + '/exception/resolve',
      body: {}
    })
    const resolvedConfiguration = await poll(purchaseOrderId, context, 'resolving_exception')
    const resolution = resolvedConfiguration?.exceptionResolution
    if (resolution?.transportStatus !== 'completed' || resolution.status !== 'succeeded') {
      throw businessError(
        'exception_resolve_unconfirmed',
        safeMessage(resolution?.message || '云仓助手未确认异常处理成功')
      )
    }

    context.assertActive()
    await context.reportProgress({ phase: 'submitting_verification_check' })
    await requestApi({
      method: 'POST',
      endpoint: '/purchase-orders/' + purchaseOrderId + '/exception/check',
      body: {}
    })
    const verifiedConfiguration = await poll(purchaseOrderId, context, 'verifying_exception')
    const verification = summarizeExceptionCheck(verifiedConfiguration, purchaseOrderId, now)
    return {
      purchase_order_id: purchaseOrderId,
      remark_succeeded: remarkResult.remark_succeeded,
      remark_message: remarkResult.remark_message,
      resolve_state: 'succeeded',
      verification_state: verification.state,
      remaining_exception_count: verification.exception_count,
      message: verification.state === 'exception_clear'
        ? '异常处理成功，再次核验已无异常'
        : '异常处理已返回成功，但再次核验仍发现异常',
      verified_at: verification.checked_at
    }
  }

  return {
    'purchase.jd.remark': submitPurchaseRemark,
    'purchase.exception.check': checkException,
    'purchase.exception.resolve': resolveException
  }
}

module.exports = {
  BUSINESS_PROXY_BASE_URL,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  businessError,
  createDesktopCommandBusinessHandlers,
  normalizePurchaseOrderId,
  pollOrderConfiguration,
  safeMessage,
  summarizeExceptionCheck
}
