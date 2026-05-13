/**
 * 采购订单同步 - 入口模块
 * 负责平台路由和 IPC 注册
 */

const { ipcMain } = require('./common')
const { httpPostJson, BUSINESS_SERVER, activeSyncs, mapOrderStatus, refineStatusByTracking, OVERALL_TIMEOUT } = require('./common')

const taobao = require('./taobao')
const alibaba = require('./alibaba')
const pinduoduo = require('./pinduoduo')

// ============ 平台模块映射 ============

const PLATFORM_MODULES = {
  taobao,
  '1688': alibaba,
  pinduoduo
}

// 需要逐个同步的订单状态（已下单、待发货、已发货、运输中）
const SYNC_STATUSES = ['ordered', 'pending', 'shipped', 'in_transit']

// IPC handler 超时（比平台模块的 OVERALL_TIMEOUT 多 30 秒）
const IPC_SYNC_TIMEOUT = (OVERALL_TIMEOUT || 90000) + 30000

// ============ 超时安全包装 ============

/**
 * 为 Promise 添加超时保护，防止 IPC "reply was never sent"
 * 如果 Promise 在 timeout 内未结算，返回 fallback 结果
 */
function withTimeout(promise, timeoutMs, fallbackMessage) {
  let timer = null
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.error(`[PurchaseSync IPC] ⚠️ 超时保护触发: ${fallbackMessage} (${timeoutMs}ms)`)
      resolve({ success: false, message: fallbackMessage })
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

// ============ 单个订单同步 + 数据库更新 ============

async function syncSingleAndUpdate(platformModule, accountId, platformOrderNo, platform) {
  const result = await platformModule.syncSingle(accountId, platformOrderNo)
  console.log(`[PurchaseSync IPC] 单个同步结果(${platformOrderNo}): ${result.success ? 'OK' : 'FAIL'}`)

  if (result.success && result.orderInfo) {
    try {
      const mappedOrderInfo = { ...result.orderInfo }
      if (mappedOrderInfo.status) {
        const originalStatus = mappedOrderInfo.status
        mappedOrderInfo.status = mapOrderStatus(originalStatus)
        if (originalStatus !== mappedOrderInfo.status) {
          console.log(`[PurchaseSync IPC] 状态映射: "${originalStatus}" → "${mappedOrderInfo.status}"`)
        }
      }

      // 根据物流轨迹修正状态：shipped/in_transit → received/rejected/in_transit
      if (['shipped', 'in_transit'].includes(mappedOrderInfo.status)) {
        const refined = refineStatusByTracking(
          mappedOrderInfo.status,
          mappedOrderInfo.logistics_tracking,
          mappedOrderInfo.logistics_status
        )
        if (refined !== mappedOrderInfo.status) {
          console.log(`[PurchaseSync IPC] 轨迹修正状态: "${mappedOrderInfo.status}" → "${refined}"`)
          mappedOrderInfo.status = refined
        }
      }

      const updateResult = await httpPostJson(`${BUSINESS_SERVER}/api/purchase-orders/browser-sync-update`, {
        account_id: accountId,
        platform,
        platform_order_no: platformOrderNo,
        order_info: mappedOrderInfo
      })
      if (updateResult && updateResult.code === 0) {
        console.log('[PurchaseSync IPC] 数据库更新成功:', JSON.stringify(updateResult.data))
        result.dbResult = updateResult.data
      } else {
        console.error('[PurchaseSync IPC] 数据库更新失败:', updateResult?.message)
        result.dbError = updateResult?.message || '数据库更新失败'
      }
    } catch (e) {
      console.error('[PurchaseSync IPC] 数据库更新异常:', e.message)
      result.dbError = e.message
    }
  }

  return result
}

// ============ IPC 注册 ============

function registerPurchaseOrderSyncIpc(mainWindow) {
  // 单个订单同步
  ipcMain.handle('sync-purchase-order-browser', async (event, { accountId, platformOrderNo, platform }) => {
    console.log(`[PurchaseSync IPC] 收到单个同步请求: accountId=${accountId}, orderNo=${platformOrderNo}, platform=${platform}`)

    if (!accountId || !platformOrderNo || !platform) {
      return { success: false, message: 'accountId、platformOrderNo 和 platform 不能为空' }
    }

    const platformModule = PLATFORM_MODULES[platform]
    if (!platformModule) {
      return { success: false, message: `不支持的平台: ${platform}` }
    }

    try {
      return await withTimeout(
        syncSingleAndUpdate(platformModule, accountId, platformOrderNo, platform),
        IPC_SYNC_TIMEOUT,
        `同步超时（${Math.round(IPC_SYNC_TIMEOUT / 1000)}秒无响应），请重试`
      )
    } catch (e) {
      console.error(`[PurchaseSync IPC] 单个同步异常:`, e.message)
      return { success: false, message: `同步失败: ${e.message}` }
    }
  })

  // 批量同步
  ipcMain.handle('sync-purchase-orders-browser', async (event, { accountId, platform }) => {
    console.log(`[PurchaseSync IPC] 收到批量同步请求: accountId=${accountId}, platform=${platform}`)

    if (!accountId || !platform) {
      return { success: false, message: 'accountId 和 platform 不能为空' }
    }

    const platformModule = PLATFORM_MODULES[platform]
    if (!platformModule) {
      return { success: false, message: `不支持的平台: ${platform}` }
    }

    // 所有平台：逐个同步模式
    try {
      const orderListResult = await httpPostJson(`${BUSINESS_SERVER}/api/purchase-orders/by-account-platform`, {
        account_id: accountId,
        platform
      })
      if (!orderListResult || orderListResult.code !== 0 || !orderListResult.data || orderListResult.data.length === 0) {
        console.log(`[PurchaseSync IPC] 该账号下无${platform}采购订单`)
        return { success: false, message: `该账号下暂无已绑定订单号的${platform}采购订单` }
      }

      // 过滤需要同步的订单状态
      const ordersToSync = orderListResult.data.filter(o => SYNC_STATUSES.includes(o.status))
      if (ordersToSync.length === 0) {
        console.log(`[PurchaseSync IPC] 没有需要同步的订单（已下单/待发货/已发货）`)
        return { success: true, orders: [], syncedCount: 0, totalOrders: orderListResult.data.length, message: '没有需要同步的订单（已下单/待发货/已发货）' }
      }

      console.log(`[PurchaseSync IPC] 找到 ${ordersToSync.length} 个需要同步的${platform}订单（共 ${orderListResult.data.length} 个）`)

      let syncedCount = 0
      let errorCount = 0
      const total = ordersToSync.length

      for (let i = 0; i < ordersToSync.length; i++) {
        const order = ordersToSync[i]
        const platformOrderNo = order.platform_order_no

        // 推送进度到前端：正在同步
        mainWindow?.webContents?.send('batch-sync-progress', {
          current: i + 1,
          total,
          orderNo: platformOrderNo,
          purchaseNo: order.purchase_no || '',
          status: 'syncing'
        })

        let syncSuccess = false
        try {
          const result = await withTimeout(
            syncSingleAndUpdate(platformModule, accountId, platformOrderNo, platform),
            IPC_SYNC_TIMEOUT,
            `订单 ${platformOrderNo} 同步超时`
          )
          syncSuccess = result.success
          if (syncSuccess) {
            syncedCount++
          } else {
            errorCount++
            console.log(`[PurchaseSync IPC] 订单 ${platformOrderNo} 同步失败: ${result.message}`)
          }
        } catch (e) {
          errorCount++
          console.error(`[PurchaseSync IPC] 订单 ${platformOrderNo} 同步异常: ${e.message}`)
        }

        // 推送进度到前端：完成
        mainWindow?.webContents?.send('batch-sync-progress', {
          current: i + 1,
          total,
          orderNo: platformOrderNo,
          purchaseNo: order.purchase_no || '',
          status: syncSuccess ? 'done' : 'error'
        })
      }

      console.log(`[PurchaseSync IPC] ${platform}批量同步完成: 成功 ${syncedCount}, 失败 ${errorCount}, 总计 ${total}`)
      return {
        success: true,
        syncedCount,
        errorCount,
        totalOrders: orderListResult.data.length,
        orders: []
      }
    } catch (e) {
      console.error(`[PurchaseSync IPC] ${platform}批量同步异常:`, e.message)
      return { success: false, message: `批量同步失败: ${e.message}` }
    }
  })
}

module.exports = { registerPurchaseOrderSyncIpc }
