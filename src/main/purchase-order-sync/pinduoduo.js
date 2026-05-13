/**
 * 采购订单同步 - 拼多多平台
 * 使用搜索API方案：导航到订单搜索页面，提取 window.rawData 中的订单详情
 * Phase 1: 搜索页提取订单基础信息
 * Phase 2: 物流页提取快递公司名称和物流轨迹（从 store.traceData.shipping）
 */

const {
  BrowserWindow, session, path,
  BUSINESS_SERVER, activeSyncs,
  httpPostJson, restoreCookiesFromServer, hasValidPlatformCookies,
  resolveAppPath
} = require('./common')

// ============ 平台配置 ============

const PLATFORM_CONFIG = {
  entryUrl: 'https://mobile.yangkeduo.com/orders.html',
  loginCheck: (url) => {
    const lower = url.toLowerCase()
    return lower.includes('login.yangkeduo.com') || (lower.includes('login') && lower.includes('yangkeduo'))
  },
  apiKeywords: ['orderList', 'orders'],
  orderPageKeyword: 'orders'
}

// ============ PDD 状态映射 ============

const PDD_STATUS_MAP = {
  0: 'ordered',    // 待确认
  1: 'ordered',    // 待支付
  2: 'pending',    // 待发货
  3: 'shipped',    // 待收货
  4: 'shipped',    // 已签收，待确认收货
  5: 'received',   // 已完成
  6: 'cancelled',  // 交易已取消
  7: 'refunded',   // 退款中
  8: 'refunded'    // 退款成功
}

// ============ 单个订单同步 ============

/**
 * 通过 PDD 订单搜索 API 同步单个采购订单
 * Phase 1: 搜索页提取订单基础信息 + shippingId/goods_id
 * Phase 2: 已发货订单导航到物流页，从 store.traceData.shipping 提取快递公司名称和物流轨迹
 */
function syncSingle(accountId, platformOrderNo) {
  return new Promise(async (resolve) => {
    const syncKey = `${accountId}-pinduoduo`
    if (activeSyncs.has(syncKey)) {
      return resolve({ success: false, message: '该账号正在同步中，请等待完成' })
    }

    const partitionName = `persist:purchase-${accountId}`
    const ses = session.fromPartition(partitionName)
    let cookies = await ses.cookies.get({})

    console.log(`[PDD-SearchSync] accountId:${accountId} orderNo:${platformOrderNo} cookies:${cookies.length}`)

    // 同步前始终尝试从服务器恢复 cookie
    // 服务器 cookie 来自最近一次验证登录，优先于 partition 中可能过期的旧 cookie
    // 解决：partition 有结构性有效但实际已过期的 cookie 时，hasValidPlatformCookies 返回 true
    //       导致跳过服务器恢复，使用过期 cookie 被 PDD 拒绝（"采购账号登录已过期"）
    const restoreResult = await restoreCookiesFromServer(accountId, 'pinduoduo')
    if (restoreResult.restored) {
      cookies = await ses.cookies.get({})
      console.log(`[PDD-SearchSync] cookie 从服务器恢复成功，当前 cookies:${cookies.length}`)
    } else if (!hasValidPlatformCookies(cookies, 'pinduoduo')) {
      console.log(`[PDD-SearchSync] partition 无有效 PDD cookie 且服务器无数据`)
    }

    if (!hasValidPlatformCookies(cookies, 'pinduoduo')) {
      return resolve({ success: false, message: '该采购账号未登录，请先点击"登录"按钮登录账号' })
    }

    let win = null
    let resolved = false
    let overallTimer = null
    let phase = 1
    let phase1Result = null // Phase 1 的部分结果，等 Phase 2 补充

    function cleanup() {
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
      try {
        ses.webRequest.onBeforeSendHeaders(null)
      } catch (e) {}
      activeSyncs.delete(syncKey)
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }

    function finish(result) {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(result)
    }

    overallTimer = setTimeout(() => {
      // 如果 Phase 1 有结果但 Phase 2 超时，返回 Phase 1 的结果
      if (phase1Result) {
        console.log('[PDD-SearchSync] Phase 2 超时，返回 Phase 1 结果')
        finish({ success: true, orderInfo: phase1Result })
      } else {
        finish({ success: false, message: '同步超时，请稍后重试' })
      }
    }, 45000)

    try {
      win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        title: '[同步-PDD] 采购订单',
        webPreferences: {
          partition: partitionName,
          contextIsolation: false,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          preload: resolveAppPath('out/main/purchase-preload.js')
        }
      })

      // 反检测：伪装 UA 和 Client Hints（和采购窗口一致）
      const chromeVersion = process.versions.chrome || '134.0.0.0'
      const cleanUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
      win.webContents.setUserAgent(cleanUA)
      const secChUa = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not-A.Brand";v="99"`
      ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.yangkeduo.com/*', '*://*.pinduoduo.com/*', '*://*.pdd.net/*'] }, (details, callback) => {
        if (details.requestHeaders) {
          details.requestHeaders['Sec-CH-UA'] = secChUa
          details.requestHeaders['Sec-CH-UA-Platform'] = '"Windows"'
          details.requestHeaders['User-Agent'] = cleanUA
        }
        callback({ requestHeaders: details.requestHeaders })
      })

      win.webContents.setBackgroundThrottling(false)
      activeSyncs.set(syncKey, win)

      // 检测登录重定向
      win.webContents.on('did-navigate', (event, url) => {
        console.log('[PDD-SearchSync] navigate:', url.substring(0, 150))
        if (url.includes('login.yangkeduo.com') || (url.includes('login') && url.includes('yangkeduo'))) {
          finish({ success: false, message: '采购账号登录已过期，请重新登录该账号', needsRelogin: true })
        }
      })

      // 页面加载完成后提取数据
      win.webContents.on('did-finish-load', async () => {
        if (!win || win.isDestroyed() || resolved) return
        const currentUrl = win.webContents.getURL()
        console.log(`[PDD-SearchSync] loaded (phase ${phase}):`, currentUrl.substring(0, 150))

        // 等待 SSR 数据就绪
        await new Promise(r => setTimeout(r, 2000))
        if (!win || win.isDestroyed() || resolved) return

        try {
          if (phase === 1) {
            await handlePhase1(currentUrl)
          } else if (phase === 2) {
            await handlePhase2()
          }
        } catch (e) {
          console.error('[PDD-SearchSync] 提取失败:', e.message)
          if (phase1Result) {
            finish({ success: true, orderInfo: phase1Result })
          } else {
            finish({ success: false, message: 'PDD搜索结果提取失败: ' + e.message })
          }
        }
      })

      // ============ Phase 1: 搜索页提取订单基础信息 ============
      async function handlePhase1(currentUrl) {
        const searchResult = await win.webContents.executeJavaScript(`
          (function() {
            try {
              if (!window.rawData || !window.rawData.resultStore || !window.rawData.resultStore.orders) {
                return JSON.stringify({error: 'no_rawData'});
              }
              var orders = window.rawData.resultStore.orders;
              if (orders.length === 0) return JSON.stringify({error: 'no_orders'});
              var order = orders[0];
              var goods = order.orderGoods && order.orderGoods[0];
              return JSON.stringify({
                order_no: order.orderSn || '',
                goods_name: goods ? (goods.goodsName || '') : '',
                goods_image: goods ? (goods.thumbUrl || goods.goodsImage || goods.imageUrl || '') : '',
                sku: goods ? (goods.spec || '') : '',
                quantity: goods ? (goods.goodsNumber || 1) : 0,
                purchase_price: goods ? (goods.goodsPrice || '') : '',
                logistics_no: order.trackingNumber || '',
                logistics_company: order.shippingCompany || order.shipping_company || order.logisticsCompany || order.carrierName || order.expressCompany || '',
                combined_status: order.combinedOrderStatus || 0,
                shipping_id: order.shippingId || 0,
                goods_id: goods ? (goods.goodsId || 0) : 0,
                shipping_time: order.shippingTime || 0,
                receive_time: order.receiveTime || 0,
                order_amount: order.orderAmount || ''
              });
            } catch(e) {
              return JSON.stringify({error: 'js_error', msg: e.message});
            }
          })()
        `)

        if (searchResult) {
          console.log(`[PDD-SearchSync] Phase1 API结果: ${searchResult.substring(0, 300)}`)
          const info = JSON.parse(searchResult)

          if (info.error) {
            console.warn(`[PDD-SearchSync] 搜索API错误: ${info.error}`, info.msg || '')
            finish({ success: false, message: `PDD订单搜索未找到结果: ${info.error}` })
            return
          }

          const status = PDD_STATUS_MAP[info.combined_status] || ''
          const mappedStatus = status

          const orderInfo = {
            order_no: info.order_no || platformOrderNo,
            status,
            logistics_no: info.logistics_no || '',
            logistics_company: info.logistics_company || '',
            logistics_company_code: '',
            logistics_status: '',
            goods_name: info.goods_name || '',
            goods_image: info.goods_image || '',
            sku: info.sku || '',
            quantity: info.quantity || 0,
            purchase_price: info.purchase_price || '',
            shipping_time: info.shipping_time || 0,
            receive_time: info.receive_time || 0
          }

          // 已发货/已签收 且有物流单号 → 需要 Phase 2 获取快递公司名称和物流轨迹
          const needPhase2 = (mappedStatus === 'shipped' || mappedStatus === 'received')
            && info.logistics_no
            && info.shipping_id

          if (needPhase2) {
            console.log(`[PDD-SearchSync] Phase1结果: 状态=${status}, 物流=${info.logistics_no}, shippingId=${info.shipping_id}, 需要Phase2获取物流详情`)
            phase1Result = orderInfo
            phase1Result._shipping_id = info.shipping_id
            phase1Result._goods_id = info.goods_id
            navigateToLogisticsPage(info)
          } else {
            console.log(`[PDD-SearchSync] Phase1完成: 订单=${info.order_no}, 状态=${status}, 物流=${info.logistics_no || '无'}, 快递公司=${info.logistics_company || '无'}`)
            clearTimeout(overallTimer)
            finish({ success: true, orderInfo })
          }
        } else {
          finish({ success: false, message: 'PDD搜索结果为空' })
        }
      }

      // 导航到物流页面（Phase 2）
      function navigateToLogisticsPage(info) {
        phase = 2
        const logisticsUrl = `https://mobile.yangkeduo.com/goods_express.html?order_sn=${encodeURIComponent(info.order_no || platformOrderNo)}&goods_id=${info.goods_id || ''}&shipping_name=&tracking_number=${encodeURIComponent(info.logistics_no)}&shipping_id=${info.shipping_id}&hide_address=1`
        console.log(`[PDD-SearchSync] 导航到物流页面: ${logisticsUrl.substring(0, 200)}`)
        win.loadURL(logisticsUrl)
      }

      // ============ Phase 2: 物流页提取快递公司名称和物流轨迹 ============
      async function handlePhase2() {
        let logisticsResult = null

        // 从 store.traceData.shipping 提取物流数据
        const storeDataResult = await win.webContents.executeJavaScript(`
          (function() {
            try {
              var store = window.rawData && window.rawData.store;
              if (!store || !store.traceData) return JSON.stringify({error: 'no_traceData'});

              var td = store.traceData;
              if (typeof td === 'object' && td.shipping) {
                var shipping = td.shipping;
                var result = {
                  shippingName: shipping.shippingName || '',
                  trackingNumber: shipping.trackingNumber || '',
                  shippingStatus: shipping.shippingStatus || 0,
                  statusDesc: (shipping.timeForecast && shipping.timeForecast.traceStatusDesc) || '',
                  traces: []
                };
                if (shipping.traces && Array.isArray(shipping.traces)) {
                  for (var i = 0; i < shipping.traces.length; i++) {
                    var t = shipping.traces[i];
                    result.traces.push({
                      time: t.displayTime || t.time || '',
                      context: t.info || '',
                      status_tag: t.statusTag || ''
                    });
                  }
                }
                return JSON.stringify(result);
              }
              return JSON.stringify({error: 'no_shipping_in_traceData'});
            } catch(e) {
              return JSON.stringify({error: 'js_error', msg: e.message});
            }
          })()
        `)

        if (storeDataResult) {
          try {
            const parsed = JSON.parse(storeDataResult)
            if (parsed.shippingName || (parsed.traces && parsed.traces.length > 0)) {
              logisticsResult = {
                shipping_name: parsed.shippingName || '',
                status_desc: parsed.statusDesc || '',
                traces: parsed.traces || []
              }
              console.log(`[PDD-SearchSync] Phase2 从traceData提取: 快递公司=${logisticsResult.shipping_name}, 轨迹=${logisticsResult.traces.length}条`)
            } else {
              console.warn(`[PDD-SearchSync] Phase2 traceData无物流数据: ${storeDataResult.substring(0, 200)}`)
            }
          } catch (e) {
            console.error('[PDD-SearchSync] Phase2 traceData解析失败:', e.message)
          }
        }

        // 处理最终结果
        if (logisticsResult && phase1Result) {
          if (logisticsResult.shipping_name) {
            phase1Result.logistics_company = logisticsResult.shipping_name
            console.log(`[PDD-SearchSync] 从物流页补充快递公司: ${logisticsResult.shipping_name}`)
          }
          if (logisticsResult.status_desc) {
            phase1Result.logistics_status = logisticsResult.status_desc
          }
          if (logisticsResult.traces && logisticsResult.traces.length > 0) {
            phase1Result.logistics_tracking = logisticsResult.traces
            console.log(`[PDD-SearchSync] 从物流页获取 ${logisticsResult.traces.length} 条轨迹`)
          }

          delete phase1Result._shipping_id
          delete phase1Result._goods_id

          console.log(`[PDD-SearchSync] 最终结果: 快递公司=${phase1Result.logistics_company}, 物流状态=${phase1Result.logistics_status}, 轨迹=${phase1Result.logistics_tracking?.length || 0}条`)
          clearTimeout(overallTimer)
          finish({ success: true, orderInfo: phase1Result })
        } else {
          console.warn('[PDD-SearchSync] Phase2 物流页提取失败，返回Phase1结果')
          if (phase1Result) {
            delete phase1Result._shipping_id
            delete phase1Result._goods_id
            clearTimeout(overallTimer)
            finish({ success: true, orderInfo: phase1Result })
          } else {
            finish({ success: false, message: 'PDD物流页提取失败' })
          }
        }
      }

      // 直接导航到搜索结果页（Phase 1）
      const searchUrl = `https://mobile.yangkeduo.com/transac_orders_search_results.html?keyWord=${encodeURIComponent(platformOrderNo)}&type=1&refer_page_name=transac_orders_search_results`
      console.log(`[PDD-SearchSync] Loading: ${searchUrl}`)
      win.loadURL(searchUrl)

    } catch (err) {
      finish({ success: false, message: '同步失败: ' + err.message })
    }
  })
}

module.exports = {
  PLATFORM_CONFIG,
  PDD_STATUS_MAP,
  syncSingle
}
