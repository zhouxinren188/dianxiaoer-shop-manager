/**
 * 从 server/index.js 提取的纯函数，用于单元测试
 * 这些函数不依赖 Express/MySQL 等运行时依赖
 */

// ============ CP_CODE_MAP & resolveLogisticsCompany ============

const CP_CODE_MAP = {
  'YUNDA': '韵达快递', 'ZTO': '中通快递', 'STO': '申通快递', 'SF': '顺丰速运',
  'YTO': '圆通速递', 'HTKY': '百世快递', 'JD': '京东物流', 'EMS': 'EMS',
  'DBL': '德邦快递', 'YZPY': '邮政快递包裹', 'JD_VD': '京东快运',
  'ANE': '安能物流', 'XBWL': '新邦物流', 'FAST': '快捷快递',
  'QFKD': '全峰快递', 'DB': '德邦物流', 'RDB': '德邦快运',
  'ZJS': '宅急送', 'TTKDY': '天天快递', 'UC': '优速快递',
  'SNWL': '苏宁物流', 'PFCNE': '品骏快递', 'JDWL': '京东快递',
  'HHT': '天天快递', 'GZL': '广州物流', 'CNPL': '菜鸟直送',
  'CAINIAO': '菜鸟裹裹', 'BNQD': '百世快运', 'YZSAM': '邮政标准快递'
}

/**
 * 根据 cpCode 获取物流公司名称
 * 优先使用 API 返回的 cpName，为空时用 cpCode 映射兜底
 */
function resolveLogisticsCompany(cpName, cpCode) {
  if (cpName && cpName.trim()) return cpName.trim()
  if (cpCode && CP_CODE_MAP[cpCode.toUpperCase()]) return CP_CODE_MAP[cpCode.toUpperCase()]
  return cpName || ''
}

// ============ parseTaobaoH5Response ============

/**
 * 解析淘宝H5 API响应（组件化布局格式）
 * 支持 data.data 嵌套结构
 */
function parseTaobaoH5Response(responseText) {
  const orders = []
  try {
    const response = JSON.parse(responseText)

    if (response.ret && response.ret[0] !== 'SUCCESS::调用成功') {
      return orders
    }

    if (!response.data) {
      return orders
    }

    let data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    // 处理嵌套 data.data 结构（部分API响应格式: { data: { data: { shopInfo_...: ... }, ret: [...] } }）
    // 检查 data 中是否有任何以 shopInfo_ 或 orderStatus_ 开头的键（使用前缀匹配而非精确匹配）
    const hasShopInfoKey = Object.keys(data).some(k => k.startsWith('shopInfo_'))
    const hasOrderStatusKey = Object.keys(data).some(k => k.startsWith('orderStatus_'))
    if (data && data.data && typeof data.data === 'object' && !hasShopInfoKey && !hasOrderStatusKey) {
      data = data.data
    }

    // 组件化布局：遍历所有组件，按订单ID聚合信息
    const orderMap = {}

    for (const [key, component] of Object.entries(data)) {
      if (!component || typeof component !== 'object') continue

      // shopInfo_* 组件
      if (key.startsWith('shopInfo_')) {
        const orderId = component.id
        if (!orderId) continue

        if (!orderMap[orderId]) {
          orderMap[orderId] = { order_no: orderId }
        }

        if (component.fields && component.fields.tradeTitle) {
          orderMap[orderId].status = component.fields.tradeTitle
        }
      }

      // orderStatus_* 组件
      if (key.startsWith('orderStatus_')) {
        const orderId = component.id
        if (!orderId) continue

        if (!orderMap[orderId]) {
          orderMap[orderId] = { order_no: orderId }
        }

        const fields = component.fields || {}

        if (fields.mailNo) {
          orderMap[orderId].logistics_no = fields.mailNo
        }

        if (fields.cpCode) {
          orderMap[orderId].logistics_company_code = fields.cpCode
        }

        if (fields.title) {
          orderMap[orderId].logistics_status = fields.title
        }
      }

      // orderLogistics_* 组件
      if (key.startsWith('orderLogistics_')) {
        const orderId = component.id
        if (!orderId) continue

        if (!orderMap[orderId]) {
          orderMap[orderId] = { order_no: orderId }
        }

        const fields = component.fields || {}
        if (fields.packagePreview && fields.packagePreview.packageViewList && fields.packagePreview.packageViewList.length > 0) {
          orderMap[orderId].logistics_company = fields.packagePreview.packageViewList[0].cpName
        }
      }
    }

    // 转换为数组，用 cpCode 兜底 logistics_company
    for (const orderId of Object.keys(orderMap)) {
      const order = orderMap[orderId]
      if (order.order_no) {
        orders.push({
          order_no: order.order_no,
          status: order.status || '',
          logistics_no: order.logistics_no || '',
          logistics_company: resolveLogisticsCompany(order.logistics_company || '', order.logistics_company_code || ''),
          logistics_company_code: order.logistics_company_code || '',
          logistics_status: order.logistics_status || ''
        })
      }
    }

  } catch (e) {
    // parse error
  }

  return orders
}

// ============ updateCookiesWithNewToken ============

/**
 * 更新 cookie 数组中的 _m_h5_tk 和 _m_h5_tk_enc
 */
function updateCookiesWithNewToken(cookies, newTk, newTkEnc) {
  const updated = cookies.map(c => ({ ...c }))
  const tkIdx = updated.findIndex(c => c.name === '_m_h5_tk')
  if (tkIdx >= 0) {
    updated[tkIdx] = { ...updated[tkIdx], value: newTk }
  } else {
    updated.push({ name: '_m_h5_tk', value: newTk })
  }
  if (newTkEnc) {
    const tkEncIdx = updated.findIndex(c => c.name === '_m_h5_tk_enc')
    if (tkEncIdx >= 0) {
      updated[tkEncIdx] = { ...updated[tkEncIdx], value: newTkEnc }
    } else {
      updated.push({ name: '_m_h5_tk_enc', value: newTkEnc })
    }
  }
  return updated
}

// ============ buildCookieString ============

/**
 * 构建 cookie 字符串
 */
function buildCookieString(cookies) {
  if (Array.isArray(cookies)) {
    return cookies.map(c => `${c.name}=${c.value}`).join('; ')
  }
  if (typeof cookies === 'string') {
    return cookies
  }
  return ''
}

module.exports = {
  CP_CODE_MAP,
  resolveLogisticsCompany,
  parseTaobaoH5Response,
  updateCookiesWithNewToken,
  buildCookieString
}
