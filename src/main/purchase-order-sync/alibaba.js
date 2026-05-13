/**
 * 采购订单同步 - 1688平台
 * 使用隐藏 BrowserWindow + CDP 网络捕获方案
 */

const {
  BrowserWindow, session,
  OVERALL_TIMEOUT, POLL_INTERVAL, MAX_POLLS,
  BUSINESS_SERVER, activeSyncs,
  CDPNetworkCapture, httpPostJson, VISIBILITY_OVERRIDE,
  resolveLogisticsCompany, extractTrackingFromData, restoreCookiesFromServer, hasValidPlatformCookies
} = require('./common')

// ============ 平台配置 ============

const PLATFORM_CONFIG = {
  entryUrl: 'https://trade.1688.com/order/buyer_order_list.htm',
  loginCheck: (url) => {
    const lower = url.toLowerCase()
    return lower.includes('login.1688.com') || (lower.includes('login') && lower.includes('1688.com'))
  },
  // 匹配1688订单API：
  // - 订单详情: mtop.1688.MtopOrderService.queryOrder (data.model 结构)
  // - 物流包裹: mtop.1688.DeliveryOrderService.queryDeliveryOrderPackList (data.model 包裹数组+商品明细)
  // - 订单列表: mtop.1688.trade.faas.gateway (data.result.orderList 结构)
  // - 其他: mtop.1688.deliverylimittime
  // 避免用 'trade' 这种宽泛关键词（会匹配CSS/JS/跟踪像素等）
  apiKeywords: ['mtop.1688.mtoporderservice', 'mtop.1688.trade', 'mtop.1688.deliveryorderservice', 'mtop.1688.deliverylimittime'],
  orderPageKeyword: 'buyer_order_list'
}

// ============ 响应解析 ============

/**
 * 在 faas.gateway 的嵌套组件结构中深度搜索订单数组
 * faas.gateway 返回 model.data = [组件1, 组件2, ...]
 * 每个组件可能有不同的结构，订单数据在某个组件内部
 *
 * 搜索策略：递归遍历对象，找第一个包含 orderId/id 的对象数组
 * 优先匹配有明确订单字段（orderId, logisticsCompanyName, productName）的数组
 */
function findOrderListInObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null

  // 直接检查：当前对象是否是订单数组
  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj[0] && typeof obj[0] === 'object') {
      const first = obj[0]
      // 有订单标识字段的数组
      if (first.orderId || first.id || first.bizOrderId) {
        // 进一步验证：至少有一个订单字段
        if (first.productName || first.status || first.logisticsCompanyName
            || first.logistics || first.orderEntries || first.sellerCompanyName) {
          console.log(`[PurchaseSync-1688] 深度搜索找到订单数组[${obj.length}], 首项keys=[${Object.keys(first).slice(0, 15).join(',')}]`)
          return obj
        }
      }
    }
    // 数组中的每个元素递归搜索
    for (const item of obj) {
      if (item && typeof item === 'object') {
        const result = findOrderListInObject(item, depth + 1)
        if (result) return result
      }
    }
    return null
  }

  // 对象：检查常见路径后递归
  // 优先检查明确的订单列表路径
  if (obj.orderList && Array.isArray(obj.orderList)) {
    if (obj.orderList.length > 0 && obj.orderList[0] && (obj.orderList[0].orderId || obj.orderList[0].id)) {
      console.log(`[PurchaseSync-1688] 深度搜索在orderList找到[${obj.orderList.length}]个订单`)
      return obj.orderList
    }
  }
  if (obj.list && Array.isArray(obj.list)) {
    if (obj.list.length > 0 && obj.list[0] && (obj.list[0].orderId || obj.list[0].id)) {
      console.log(`[PurchaseSync-1688] 深度搜索在list找到[${obj.list.length}]个订单`)
      return obj.list
    }
  }

  // 遍历所有 key 递归搜索（跳过已检查的）
  for (const key of Object.keys(obj)) {
    if (key === 'orderList' || key === 'list') continue
    const val = obj[key]
    if (val && typeof val === 'object') {
      const result = findOrderListInObject(val, depth + 1)
      if (result) return result
    }
  }

  return null
}

/**
 * 解析1688订单API响应
 *
 * 支持 2 种 mtop API 格式：
 * 1. 订单详情 API (mtop.1688.MtopOrderService.queryOrder):
 *    { api, data: { model: { id, status, logistics, orderEntries, ... } }, ret }
 *    data.model 是单个订单对象
 *
 * 2. 订单列表 API (mtop.1688.trade.faas.gateway):
 *    { ret, data: { result: { orderList: [...] } } }
 *    data.result.orderList 是订单数组
 *
 * mtop 协议的 data 字段可能是 JSON 字符串，需要二次解析
 */
function parseResponse(responseText) {
  const orders = []
  try {
    let response = JSON.parse(responseText)

    // 处理 mtop 协议格式：{ ret: [...], data: "..." | {...} }
    // 1688 的 mtop API data 字段可能是 JSON 字符串，需要二次解析
    if (response.ret && response.data) {
      let data = response.data
      if (typeof data === 'string') {
        try { data = JSON.parse(data) } catch (e) { return orders }
      }
      response = { data }
    }

    let list = null

    // === 格式1: data.model ===
    // 订单详情 API (mtop.1688.MtopOrderService.queryOrder):
    //   data.model = { id, status, logistics, orderEntries, ... } 单个订单
    // 订单列表 API (mtop.1688.trade.faas.gateway):
    //   data.model = { data: [组件1, 组件2, ...], success: true }
    //   model.data 是UI组件数组（菜单、订单列表、分页等），订单数据在某个组件内部
    if (response.data && response.data.model && typeof response.data.model === 'object') {
      const model = response.data.model
      if (model.id || model.orderId) {
        // 详情 API：data.model 就是单个订单
        list = [model]
      } else {
        // 列表 API：深度搜索 model 找订单数组
        // model.data 是组件数组，需要遍历找包含订单的组件
        list = findOrderListInObject(model)
        if (!list) {
          console.log(`[PurchaseSync-1688] data.model存在但无订单, modelKeys=[${Object.keys(model).slice(0, 15).join(',')}]`)
        }
      }
    }

    // === 格式2: data.result.orderList ===
    if (!list && response.data && response.data.result && typeof response.data.result === 'object') {
      const result = response.data.result
      if (Array.isArray(result.orderList)) {
        list = result.orderList
      } else if (Array.isArray(result.list)) {
        list = result.list
      } else if (Array.isArray(result)) {
        list = result
      }
      if (!list && result.orderId) {
        list = [result]
      }
    }

    // 简单 JSON 格式兜底
    if (!list) {
      if (Array.isArray(response.data)) {
        list = response.data
      } else if (response.data && Array.isArray(response.data.orderList)) {
        list = response.data.orderList
      } else if (response.data && Array.isArray(response.data.list)) {
        list = response.data.list
      }
    }

    if (list && list.length > 0) {
      for (const raw of list) {
        // 从 orderEntries 提取第一个商品（详情 API 的结构）
        const firstEntry = (Array.isArray(raw.orderEntries) && raw.orderEntries.length > 0)
          ? raw.orderEntries[0]
          : null
        // 从 groupEntriesMap 提取（详情 API 也有此字段，key 是 sourceId）
        const groupEntries = raw.groupEntriesMap
        let groupFirstEntry = null
        if (groupEntries && typeof groupEntries === 'object') {
          const keys = Object.keys(groupEntries)
          if (keys.length > 0 && Array.isArray(groupEntries[keys[0]]) && groupEntries[keys[0]].length > 0) {
            groupFirstEntry = groupEntries[keys[0]][0]
          }
        }
        const entry = firstEntry || groupFirstEntry

        // 提取物流信息
        // 详情 API: raw.logistics = { billNo, logisticsCompanyName, logisticsCompanyNo }
        // 列表 API: raw.logisticsInfo / raw.logistics / 嵌套在 logInfo
        const logInfo = raw.logisticsInfo || raw.logisticsInfoView || raw.logistics || {}
        const logNo = raw.logisticsOrderNo || raw.expressNo || raw.logisticsNo
          || logInfo.billNo || logInfo.logisticsOrderNo || logInfo.expressNo || logInfo.mailNo || ''
        const logCpName = raw.logisticsCompanyName || raw.expressCompany
          || logInfo.logisticsCompanyName || logInfo.expressCompany || logInfo.cpName || logInfo.companyName || ''
        const logCpCode = raw.logisticsCompanyCode || logInfo.logisticsCompanyNo
          || logInfo.cpCode || logInfo.expressCode || ''
        const logStatus = raw.logisticsStatus || logInfo.logisticsStatus || logInfo.statusDesc || ''

        // 提取商品信息
        // 详情 API: entry.productName, entry.imageUrl, entry.specInfoModel.specItems, entry.quantity, entry.unitPrice
        // 列表 API: raw.productName, raw.goodsImage, raw.sku 等
        const productInfo = raw.productInfo || raw.product || {}
        const firstProduct = Array.isArray(raw.productInfos) && raw.productInfos.length > 0
          ? raw.productInfos[0]
          : (productInfo.productInfos && productInfo.productInfos[0]) || productInfo

        // SKU 提取：详情 API 在 entry.specInfoModel.specItems[0].specValue
        let skuText = raw.sku || raw.spec || raw.skuInfo || ''
        if (!skuText && entry && entry.specInfoModel && Array.isArray(entry.specInfoModel.specItems)) {
          skuText = entry.specInfoModel.specItems.map(s => s.specValue || s.specName).filter(Boolean).join(' / ')
        }

        // 商品图片：详情 API 在 entry.imageUrl (//cbu01.alicdn.com/... 需补 https:)
        let goodsImage = raw.goodsImage || raw.productImage || raw.picUrl || ''
        if (!goodsImage && entry && entry.imageUrl) {
          goodsImage = entry.imageUrl
        }
        if (goodsImage && goodsImage.startsWith('//')) {
          goodsImage = 'https:' + goodsImage
        }

        // 物流轨迹提取
        let logisticsTracking = null
        // 先从 withModules.logisticInfo 中提取轨迹
        if (raw.withModules && raw.withModules.logisticInfo) {
          logisticsTracking = extractTrackingFromData(raw.withModules.logisticInfo, 2)
        }
        if (!logisticsTracking && (logInfo.logisticsTrace || logInfo.traceList || logInfo.traces)) {
          logisticsTracking = extractTrackingFromData(logInfo, 2)
        }
        if (!logisticsTracking) {
          logisticsTracking = extractTrackingFromData(raw, 1)
        }

        orders.push({
          order_no: String(raw.orderId || raw.orderNo || raw.id || ''),
          status: raw.statusText || raw.orderStatusText || raw.status || raw.orderStatus || '',
          logistics_no: logNo,
          logistics_company: resolveLogisticsCompany(logCpName, logCpCode),
          logistics_company_code: logCpCode,
          logistics_status: logStatus,
          logistics_tracking: logisticsTracking,
          goods_name: raw.goodsName || raw.productName || raw.title
            || (entry && entry.productName) || firstProduct.goodsName || firstProduct.productName || firstProduct.title || '',
          goods_image: goodsImage || firstProduct.goodsImage || firstProduct.productImage || firstProduct.picUrl || firstProduct.imageUrl || '',
          sku: skuText || firstProduct.sku || firstProduct.spec || firstProduct.skuInfo || '',
          quantity: raw.quantity || raw.buyAmount || raw.buyNum
            || (entry && entry.quantity) || firstProduct.quantity || firstProduct.buyAmount || 0,
          purchase_price: raw.price || raw.orderPrice || raw.totalAmount || raw.payAmount
            || (entry && (entry.actualPaidUnitPrice || entry.unitPrice))
            || firstProduct.price || firstProduct.unitPrice || ''
        })
      }
      // 过滤掉没有订单号的项
      return orders.filter(o => o.order_no)
    }
  } catch (e) {
    console.error('[PurchaseSync-1688] parseResponse error:', e.message)
  }
  return orders
}

/**
 * 从1688物流API响应中提取物流轨迹和商品信息
 *
 * 物流包裹API (queryDeliveryOrderPackList):
 *   { api, data: { model: [ { logisticsTracePackDTOList, deliveryOrderItemPackDTOList, ... } ] }, ret }
 *   data.model 是包裹数组
 *   每个包裹: { logisticsTracePackDTOList: [{actionTime, remark, ...}],
 *               deliveryOrderItemPackDTOList: [{url, name, specInfoModel, ...}] }
 *
 * 返回: { tracking: [{time, context}], goods_image: string|null }
 * tracking 已按倒序排列（最新轨迹在前）
 */
function extractTrackingFromApiResponse(responseText) {
  try {
    let response = JSON.parse(responseText)

    // 处理 mtop 协议格式
    if (response.ret && response.data) {
      let data = response.data
      if (typeof data === 'string') {
        try { data = JSON.parse(data) } catch (e) { return null }
      }
      response = { data }
    }

    if (!response.data || !response.data.model) return null

    const model = response.data.model
    const packs = Array.isArray(model) ? model : [model]
    const allTracking = []
    let goodsImage = null

    for (const pack of packs) {
      if (!pack || typeof pack !== 'object') continue

      // 提取轨迹
      const traceList = pack.logisticsTracePackDTOList
      if (Array.isArray(traceList)) {
        for (const item of traceList) {
          if (!item || typeof item !== 'object') continue
          const time = item.actionTime || item.time || ''
          const context = item.remark || item.desc || item.simplifiedStatusDesc || ''
          if (time || context) {
            allTracking.push({ time, context })
          }
        }
      }

      // 提取商品图片（取第一个包裹的第一个商品图）
      if (!goodsImage && Array.isArray(pack.deliveryOrderItemPackDTOList)) {
        const firstItem = pack.deliveryOrderItemPackDTOList[0]
        if (firstItem && firstItem.url) {
          let img = firstItem.url
          if (img.startsWith('//')) img = 'https:' + img
          else if (img.startsWith('http://')) img = img.replace('http://', 'https://')
          goodsImage = img
        }
      }
    }

    // 倒序：最新轨迹在前
    allTracking.reverse()

    return allTracking.length > 0
      ? { tracking: allTracking, goods_image: goodsImage }
      : null
  } catch (e) {
    try {
      const tracking = extractTrackingFromData(JSON.parse(responseText), 3)
      return tracking ? { tracking: tracking.reverse(), goods_image: null } : null
    } catch (e2) {
      return null
    }
  }
}

// ============ 从捕获响应中查找订单 ============

/**
 * 快速判断响应体是否可能是 JSON（以 { 或 [ 开头）
 * 过滤掉 GIF 像素（"R0lGODlhAQ..."）、CSS、JS 等非 API 响应
 */
function looksLikeJson(body) {
  if (!body || body.length < 2) return false
  const first = body.charAt(0)
  return first === '{' || first === '['
}

function findOrderByOrderNo(platformOrderNo, allResponses) {
  for (const r of allResponses) {
    if (r.status !== 200 || !r.body) continue
    // 只处理 1688 API 域名的响应，过滤掉跟踪像素等
    if (!r.url.includes('h5api.m.1688.com')) continue
    // 跳过明显的非 JSON 响应（GIF像素、CSS、JS等）
    if (!looksLikeJson(r.body)) continue
    try {
      const orders = parseResponse(r.body)
      if (orders.length > 0) {
        console.log(`[PurchaseSync-1688] parseResponse提取到 ${orders.length} 个订单, orderNos: [${orders.map(o => o.order_no).join(',')}]`)
        const found = orders.find(o => o.order_no === platformOrderNo)
        if (found) return found
      } else {
        // JSON 解析成功但没提取到订单 - 输出数据结构帮助调试
        try {
          const parsed = JSON.parse(r.body)
          const data = parsed.data || {}
          const topKeys = Object.keys(parsed).slice(0, 5)
          const dataKeys = Object.keys(data).slice(0, 10)
          let modelInfo = ''
          if (data.model && typeof data.model === 'object') {
            const mk = Object.keys(data.model).slice(0, 15)
            modelInfo = ` modelKeys=[${mk.join(',')}]`
            // 深入探查 model 内每个 key 的类型和样本
            for (const k of mk) {
              const v = data.model[k]
              if (Array.isArray(v)) modelInfo += ` ${k}=Array[${v.length}]`
              else if (v && typeof v === 'object') modelInfo += ` ${k}=Object{${Object.keys(v).slice(0, 5).join(',')}}`
            }
          }
          console.log(`[PurchaseSync-1688] JSON响应无订单数据, topKeys=[${topKeys}] dataKeys=[${dataKeys}]${modelInfo} url=${r.url.substring(0, 100)}`)
        } catch (e2) { /* skip */ }
      }
    } catch (e) { /* skip */ }
  }
  return null
}

// ============ 单个订单同步 ============

function syncSingle(accountId, platformOrderNo) {
  return new Promise(async (resolve, reject) => {
    const syncKey = `${accountId}-1688`
    let resolved = false
    let win = null
  try {
    if (activeSyncs.has(syncKey)) {
      return resolve({ success: false, message: '该账号正在同步中，请等待完成' })
    }

    const partitionName = `persist:purchase-${accountId}`
    const ses = session.fromPartition(partitionName)
    let cookies = await ses.cookies.get({})

    console.log(`[PurchaseSync-1688] accountId:${accountId} orderNo:${platformOrderNo}`)
    console.log(`[PurchaseSync-1688] Cookies: ${cookies.length} 条`)

    // 始终从服务器恢复 cookie（合并模式：只补充缺失的，不覆盖已有的）
    console.log(`[PurchaseSync-1688] 从服务器恢复 cookie（合并模式）...`)
    const restoreResult = await restoreCookiesFromServer(accountId, '1688')
    if (restoreResult.restored) {
      cookies = await ses.cookies.get({})
      console.log(`[PurchaseSync-1688] cookie 恢复完成：${restoreResult.count} 条补充，${restoreResult.skipped} 条保留，当前 Cookies: ${cookies.length} 条`)
    }

    if (!hasValidPlatformCookies(cookies, '1688')) {
      return resolve({ success: false, message: '该采购账号未登录，请先点击"登录"按钮登录账号' })
    }

    let overallTimer = null
    let cdpCapture = null
    let allCapturedResponses = []

    function cleanup() {
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
      activeSyncs.delete(syncKey)
      try {
        ses.webRequest.onBeforeSendHeaders(null)
      } catch (e) {}
      if (cdpCapture) { cdpCapture.detach().catch(() => {}); cdpCapture = null }
      if (win && !win.isDestroyed()) {
        win.destroy()
      }
      win = null
    }

    function finish(result) {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(result)
    }

    overallTimer = setTimeout(() => {
      console.log(`[PurchaseSync-1688] 总超时，已捕获 ${allCapturedResponses.length} 个 API 响应`)
      if (allCapturedResponses.length > 0) {
        const orderInfo = findOrderByOrderNo(platformOrderNo, allCapturedResponses)
        if (orderInfo) {
          finish({ success: true, orderInfo })
          return
        }
      }
      finish({ success: false, message: '同步超时，请稍后重试' })
    }, OVERALL_TIMEOUT)

    try {
      win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 800,
        title: '[同步] 1688采购订单',
        webPreferences: {
          partition: partitionName,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })

      win.webContents.setBackgroundThrottling(false)
      activeSyncs.set(syncKey, win)

      // BrowserWindow 意外关闭时清理 activeSyncs，防止残留阻塞后续同步
      win.on('closed', () => {
        if (!resolved) {
          console.log('[PurchaseSync-1688] BrowserWindow 被意外关闭')
          activeSyncs.delete(syncKey)
          win = null
          finish({ success: false, message: '同步窗口意外关闭' })
        }
      })

      let cdpAttached = false

      win.webContents.on('did-navigate', async (event, url) => {
        console.log('[PurchaseSync-1688] navigate:', url.substring(0, 150))

        if (PLATFORM_CONFIG.loginCheck(url)) {
          finish({ success: false, message: '采购账号登录已过期，请重新登录该账号', needsRelogin: true })
          return
        }

        if (!cdpAttached && !resolved) {
          cdpCapture = new CDPNetworkCapture(win.webContents, PLATFORM_CONFIG.apiKeywords)
          try {
            cdpAttached = await cdpCapture.attach()
            console.log(`[PurchaseSync-1688] CDP attach after navigate: ${cdpAttached ? 'OK' : 'FAIL'}`)
          } catch (e) {
            console.warn('[PurchaseSync-1688] CDP attach error:', e.message)
          }
        }
      })

      win.webContents.on('dom-ready', () => {
        if (win.isDestroyed() || resolved) return
        win.webContents.executeJavaScript(VISIBILITY_OVERRIDE).catch(() => {})
        console.log('[PurchaseSync-1688] Visibility override injected')

        if (!cdpAttached && !resolved) {
          cdpCapture = new CDPNetworkCapture(win.webContents, PLATFORM_CONFIG.apiKeywords)
          cdpCapture.attach().then(ok => {
            cdpAttached = ok
            console.log(`[PurchaseSync-1688] CDP attach on dom-ready: ${ok ? 'OK' : 'FAIL'}`)
          }).catch(e => {
            console.warn('[PurchaseSync-1688] CDP attach on dom-ready failed:', e.message)
          })
        }
      })

      win.webContents.on('did-finish-load', () => {
        if (win.isDestroyed() || resolved) return
        const currentUrl = win.webContents.getURL()
        console.log('[PurchaseSync-1688] loaded:', currentUrl.substring(0, 150))

        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          pollForData()
        }, 3000)
      })

      let phase1Result = null // Phase 1 找到的订单信息，等待 Phase 2 补充物流轨迹
      let phase2PollCount = 0
      let logisticsTabClicked = false
      const PHASE2_MAX_POLLS = 8 // Phase 2 最多轮询8次等待物流API

      // 点击"物流信息"标签页，触发物流API调用
      function clickLogisticsTab() {
        if (logisticsTabClicked || win.isDestroyed() || resolved) return
        logisticsTabClicked = true
        const clickJs = `
          (function() {
            // 策略1: 查找包含"物流信息"文本的标签元素
            var all = document.querySelectorAll('[class*="tab"], [class*="Tab"], [role="tab"], [class*="nav-item"], [class*="menu-item"]');
            for (var i = 0; i < all.length; i++) {
              var el = all[i];
              if (el.textContent && el.textContent.trim().includes('物流信息')) {
                el.click();
                return 'clicked:tab-component';
              }
            }
            // 策略2: 查找叶子元素（直接文本节点）
            var leaves = document.querySelectorAll('span, a, div, li, button');
            for (var i = 0; i < leaves.length; i++) {
              var el = leaves[i];
              if (el.children.length === 0 && el.textContent.trim() === '物流信息') {
                el.click();
                return 'clicked:leaf-element';
              }
            }
            // 策略3: 点击父元素
            for (var i = 0; i < leaves.length; i++) {
              var el = leaves[i];
              if (el.textContent.trim() === '物流信息' && el.parentElement) {
                el.parentElement.click();
                return 'clicked:parent-element';
              }
            }
            return 'not-found';
          })()
        `
        win.webContents.executeJavaScript(clickJs).then(result => {
          console.log(`[PurchaseSync-1688] 点击物流标签页结果: ${result}`)
        }).catch(e => {
          console.warn('[PurchaseSync-1688] 点击物流标签页失败:', e.message)
        })
      }

      function pollForData() {
        let pollCount = 0
        let noNewDataCount = 0

        function poll() {
          if (win.isDestroyed() || resolved) return
          pollCount++

          const newResponses = cdpCapture ? cdpCapture.getCaptured() : []

          if (newResponses.length > 0) {
            allCapturedResponses.push(...newResponses)
            noNewDataCount = 0
            console.log(`[PurchaseSync-1688] poll #${pollCount}: +${newResponses.length} APIs (total: ${allCapturedResponses.length})`)

            for (const r of newResponses) {
              console.log(`  [CDP] ${r.url.substring(0, 120)} (${r.bodyLen}B, status: ${r.status})`)
            }

            // Phase 1: 查找订单基本信息
            if (!phase1Result) {
              const orderInfo = findOrderByOrderNo(platformOrderNo, allCapturedResponses)
              if (orderInfo) {
                console.log(`[PurchaseSync-1688] Phase1找到订单: orderNo=${orderInfo.order_no}, logistics_no=${orderInfo.logistics_no}, logistics_tracking=${orderInfo.logistics_tracking ? '有' : '无'}`)
                phase1Result = orderInfo

                // 如果已有物流轨迹，直接完成
                if (orderInfo.logistics_tracking) {
                  finish({ success: true, orderInfo: phase1Result })
                  return
                }

                // 有物流单号但无轨迹 → 点击物流标签触发API，等待（Phase 2）
                if (orderInfo.logistics_no) {
                  console.log(`[PurchaseSync-1688] 有物流单号但无轨迹，点击物流标签页触发API...`)
                  clickLogisticsTab()
                  // 不要 finish，继续轮询
                } else {
                  // 无物流单号（未发货），直接完成
                  finish({ success: true, orderInfo: phase1Result })
                  return
                }
              }
            }

            // Phase 2: 已有订单基本信息，从捕获的API中提取物流轨迹
            if (phase1Result && phase1Result.logistics_no && !phase1Result.logistics_tracking) {
              // 也检查 allCapturedResponses 中是否已有物流API响应（可能在 Phase 1 之前已捕获）
              const responsesToCheck = [...newResponses]
              for (const r of allCapturedResponses) {
                if (r.url.includes('deliveryorderservice') && !newResponses.includes(r)) {
                  responsesToCheck.push(r)
                }
              }
              for (const r of responsesToCheck) {
                if (r.status !== 200 || !r.body) continue
                if (!r.url.includes('h5api.m.1688.com')) continue
                if (!looksLikeJson(r.body)) continue
                try {
                  const result = extractTrackingFromApiResponse(r.body)
                  if (result && result.tracking && result.tracking.length > 0) {
                    console.log(`[PurchaseSync-1688] Phase2获取到${result.tracking.length}条物流轨迹`)
                    phase1Result.logistics_tracking = result.tracking
                    // 用物流API的SKU图覆盖订单详情API的SPU主图（SKU图更精确）
                    if (result.goods_image) {
                      console.log(`[PurchaseSync-1688] Phase2覆盖商品图片: ${result.goods_image.substring(0, 80)}`)
                      phase1Result.goods_image = result.goods_image
                    }
                    finish({ success: true, orderInfo: phase1Result })
                    return
                  }
                } catch (e) { /* skip */ }
              }
            }
          } else {
            noNewDataCount++
            if (phase1Result) {
              phase2PollCount++
              console.log(`[PurchaseSync-1688] Phase2等待物流API (${phase2PollCount}/${PHASE2_MAX_POLLS})`)
            } else {
              console.log(`[PurchaseSync-1688] poll #${pollCount}: 无新 API (total: ${allCapturedResponses.length}, noNew: ${noNewDataCount})`)
            }
          }

          // Phase 2 超时：有物流单号但等不到轨迹，返回已有结果
          if (phase1Result && phase2PollCount >= PHASE2_MAX_POLLS) {
            console.log(`[PurchaseSync-1688] Phase2等待物流API超时，返回Phase1结果(无轨迹)`)
            finish({ success: true, orderInfo: phase1Result })
            return
          }

          if (!phase1Result && noNewDataCount >= 5 && allCapturedResponses.length > 0) {
            finish({ success: false, message: `已获取 ${allCapturedResponses.length} 个API响应，但未找到订单 ${platformOrderNo}` })
            return
          }

          if (pollCount < MAX_POLLS) {
            setTimeout(poll, POLL_INTERVAL)
          } else {
            if (phase1Result) {
              finish({ success: true, orderInfo: phase1Result })
            } else if (allCapturedResponses.length > 0) {
              finish({ success: false, message: `已获取 ${allCapturedResponses.length} 个API响应，但未找到订单 ${platformOrderNo}` })
            } else {
              finish({ success: false, message: '未捕获到任何平台API响应，请稍后重试' })
            }
          }
        }

        poll()
      }

      // 直接导航到订单详情页，获取 MtopOrderService.queryOrder 的干净响应
      // 比从列表页的 faas.gateway 复杂组件结构中解析更可靠
      const detailUrl = `https://air.1688.com/app/ctf-page/trade-order-detail/index.html?orderId=${platformOrderNo}`
      console.log('[PurchaseSync-1688] Loading:', detailUrl)
      win.loadURL(detailUrl)

    } catch (err) {
      finish({ success: false, message: '同步失败: ' + err.message })
    }
  } catch (err) {
    if (!resolved) {
      resolved = true
      activeSyncs.delete(syncKey)
      if (win && !win.isDestroyed()) win.destroy()
      reject(err)
    }
  }
  })
}

module.exports = {
  PLATFORM_CONFIG,
  syncSingle
}
