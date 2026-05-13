/**
 * 采购订单同步 - 入口模块
 * 负责平台路由和 IPC 注册
 */

const { ipcMain } = require('./common')
const { httpPostJson, BUSINESS_SERVER, activeSyncs, mapOrderStatus, refineStatusByTracking } = require('./common')

const taobao = require('./taobao')
const alibaba = require('./alibaba')
const pinduoduo = require('./pinduoduo')

// ============ 平台模块映射 ============

const PLATFORM_MODULES = {
  taobao,
  '1688': alibaba,
  pinduoduo
}

// 需要逐个同步的订单状态（已下单、待发货、已发货）
const SYNC_STATUSES = ['ordered', 'pending', 'shipped']

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

      // 根据物流轨迹修正状态：有真实揽收/已取件时 shipped → in_transit
      if (mappedOrderInfo.status === 'shipped' && mappedOrderInfo.logistics_tracking) {
        const refined = refineStatusByTracking(mappedOrderInfo.status, mappedOrderInfo.logistics_tracking)
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

    return await syncSingleAndUpdate(platformModule, accountId, platformOrderNo, platform)
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
    // 1. 从后端获取该账号下已绑定订单号的采购单
    // 2. 过滤出"已下单/待发货/已发货"状态的订单
    // 3. 逐个调用 syncSingle 同步并更新数据库
    // 4. 实时推送进度到前端
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
          const result = await syncSingleAndUpdate(platformModule, accountId, platformOrderNo, platform)
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
