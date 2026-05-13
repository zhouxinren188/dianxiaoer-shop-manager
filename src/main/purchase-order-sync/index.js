/**
 * 采购订单同步 - 入口模块
 * 负责平台路由和 IPC 注册
 */

const { ipcMain, BrowserWindow, session, VISIBILITY_OVERRIDE, hasValidPlatformCookies, restoreCookiesFromServer, resolveAppPath } = require('./common')
const { httpPostJson, BUSINESS_SERVER, activeSyncs, mapOrderStatus, refineStatusByTracking, OVERALL_TIMEOUT, TMD_BLOCKED_BODY_LEN_THRESHOLD } = require('./common')

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

// ============ 批量同步配置 ============
const BATCH_CHUNK_SIZE = 3            // 每窗口处理订单数，更小的分块减少行为模式暴露
const INTER_ORDER_DELAY_MIN = 5000    // 订单间最小延时 5s
const INTER_ORDER_DELAY_MAX = 8000    // 订单间最大延时 8s
const INTER_CHUNK_COOLDOWN_MS = 20000 // 窗口切换间冷却 20s

// ============ 工具函数 ============

function randomDelay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)))
}

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

async function syncSingleAndUpdate(platformModule, accountId, platformOrderNo, platform, options = {}) {
  const result = await platformModule.syncSingle(accountId, platformOrderNo, options)
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

      // ===== 批量同步窗口复用（仅淘宝支持，PDD/1688暂不支持） =====
      const syncKey = `${accountId}-${platform}`
      const canReuseWindow = platform === 'taobao'
      let sharedWin = null
      let batchLoginExpired = false
      const partitionName = `persist:purchase-${accountId}`

      // 窗口创建函数（提取为独立函数，便于分块时重建窗口）
      function createSharedWindow() {
        const ses = session.fromPartition(partitionName)
        const win = new BrowserWindow({
          show: false,
          width: 1200,
          height: 800,
          title: `[批量同步] ${platform} 采购订单`,
          webPreferences: {
            partition: partitionName,
            contextIsolation: false,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
            preload: resolveAppPath('out/main/purchase-preload.js')
          }
        })

        // 反检测：伪装 UA 和 Client Hints（与 pinduoduo.js 一致）
        const chromeVersion = process.versions.chrome || '134.0.0.0'
        const cleanUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
        win.webContents.setUserAgent(cleanUA)
        const secChUa = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not-A.Brand";v="99"`
        ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.taobao.com/*', '*://*.tmall.com/*'] }, (details, callback) => {
          if (details.requestHeaders) {
            details.requestHeaders['Sec-CH-UA'] = secChUa
            details.requestHeaders['Sec-CH-UA-Platform'] = '"Windows"'
            details.requestHeaders['User-Agent'] = cleanUA
          }
          callback({ requestHeaders: details.requestHeaders })
        })

        win.webContents.setBackgroundThrottling(false)
        activeSyncs.set(syncKey, win)

        // 登录检测（持久处理器）
        win.webContents.on('did-navigate', (event, url) => {
          if (platform === 'taobao' && (url.includes('login.taobao.com') || url.includes('login.tmall.com'))) {
            console.log(`[PurchaseSync IPC] 批量窗口检测到登录重定向，标记中止`)
            batchLoginExpired = true
          }
        })
        // VISIBILITY_OVERRIDE 已由 preload 在页面 JS 前注入，无需 dom-ready 再执行

        console.log(`[PurchaseSync IPC] 批量模式: 共享窗口已创建`)
        return win
      }

      // 窗口销毁函数
      function destroySharedWindow() {
        if (sharedWin) {
          // 清理 onBeforeSendHeaders 监听器，防止泄漏
          try {
            const ses = session.fromPartition(partitionName)
            ses.webRequest.onBeforeSendHeaders(null)
          } catch (e) {}
          activeSyncs.delete(syncKey)
          if (!sharedWin.isDestroyed()) sharedWin.destroy()
          sharedWin = null
          console.log(`[PurchaseSync IPC] 批量模式: 共享窗口已销毁`)
        }
      }

      if (canReuseWindow) {
        // 创建共享窗口，所有订单复用（CDP 由各 syncSingle 自行管理 attach/detach）
        const ses = session.fromPartition(partitionName)
        let cookies = await ses.cookies.get({})

        console.log(`[PurchaseSync IPC] 批量模式: 检查 cookies (${cookies.length} 条)...`)

        // Cookie 检查与恢复
        if (!hasValidPlatformCookies(cookies, platform)) {
          console.log(`[PurchaseSync IPC] 批量模式: partition 缺少有效 cookies，从服务器恢复...`)
          const restoreResult = await restoreCookiesFromServer(accountId, platform)
          if (restoreResult.restored) {
            cookies = await ses.cookies.get({})
            console.log(`[PurchaseSync IPC] cookie 恢复完成：${restoreResult.count} 条补充`)
          }
        }

        if (!hasValidPlatformCookies(cookies, platform)) {
          return { success: false, message: '该采购账号未登录，请先点击"登录"按钮登录账号' }
        }

        console.log(`[PurchaseSync IPC] 批量模式: cookies 有效，创建共享窗口...`)

        try {
          sharedWin = createSharedWindow()
        } catch (winErr) {
          console.error(`[PurchaseSync IPC] 批量窗口创建失败:`, winErr.message)
          if (sharedWin && !sharedWin.isDestroyed()) sharedWin.destroy()
          sharedWin = null
        }
      }

      // TMD 反爬状态追踪
      let chunkOrderCount = 0       // 当前窗口已处理订单数

      for (let i = 0; i < ordersToSync.length; i++) {
        const order = ordersToSync[i]
        const platformOrderNo = order.platform_order_no

        // 批量模式下登录过期检测：一旦检测到登录重定向，中止后续同步
        if (batchLoginExpired) {
          errorCount += (total - i)
          console.log(`[PurchaseSync IPC] 登录已过期，跳过剩余 ${total - i} 个订单`)
          break
        }

        // 分块边界：每 BATCH_CHUNK_SIZE 个订单重建窗口，重置 TMD 指纹
        if (canReuseWindow && chunkOrderCount >= BATCH_CHUNK_SIZE && sharedWin) {
          console.log(`[PurchaseSync IPC] 分块边界: 已处理 ${chunkOrderCount} 个订单，重建窗口重置 TMD 状态`)
          destroySharedWindow()
          await randomDelay(INTER_CHUNK_COOLDOWN_MS, INTER_CHUNK_COOLDOWN_MS + 2000)
          batchLoginExpired = false
          sharedWin = createSharedWindow()
          chunkOrderCount = 0
          tmdConsecutiveCount = 0
        }

        // 订单间随机延时（非首订单），降低请求频率避免触发 TMD
        if (i > 0 && canReuseWindow) {
          await randomDelay(INTER_ORDER_DELAY_MIN, INTER_ORDER_DELAY_MAX)
        }

        // 批量同步优化：淘宝统一 startPhase=2（经过详情页，不再直接跳物流页，避免 TMD 检测）
        // 仅淘宝支持 startPhase（其他平台忽略该选项）
        let startPhase = 1
        if (platform === 'taobao') {
          startPhase = 2
        }
        const syncOptions = { startPhase }

        // 标记分块首单（预热导航用）
        if (chunkOrderCount === 0) {
          syncOptions.firstInChunk = true
        }

        // 窗口复用：传递共享窗口和 CDP
        if (sharedWin && !sharedWin.isDestroyed()) {
          syncOptions.sharedWindow = sharedWin
        }

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
            syncSingleAndUpdate(platformModule, accountId, platformOrderNo, platform, syncOptions),
            IPC_SYNC_TIMEOUT,
            `订单 ${platformOrderNo} 同步超时`
          )
          syncSuccess = result.success

          // TMD 反爬检测 — 仅记录日志，不再重试（预防为主，见 Layer 1-4）
          if (result.tmdBlocked) {
            console.warn(`[PurchaseSync IPC] 订单 ${platformOrderNo} 物流页遭 TMD 拦截（详情页数据已获取，同步${syncSuccess ? '成功' : '可能不完整'}）`)
          }

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

        chunkOrderCount++
      }

      // 清理共享窗口
      destroySharedWindow()

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
