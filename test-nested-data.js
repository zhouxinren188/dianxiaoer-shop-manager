/**
 * 测试当前服务器代码中的 parseTaobaoH5Response 对嵌套 data.data 结构的处理
 */

// 模拟真实的API响应（带嵌套 data.data 结构）
const MOCK_RESPONSE_NESTED = {
  "api": "mtop.taobao.order.queryboughtlistv2",
  "data": {
    "data": {
      "shopInfo_5113222887354003142": {
        "tag": "shopInfo",
        "id": "5113222887354003142",
        "type": "native$tbpc_bought_list_order_shop_info",
        "fields": {
          "createDay": "2026-05-02",
          "createTime": "2026-05-02 16:31:54",
          "orderId": "5113222887354003142",
          "sellerName": "公牛赞牛专卖店",
          "shopName": "公牛赞牛专卖店",
          "tradeTitle": "卖家已发货"
        }
      },
      "orderStatus_5113222887354003142": {
        "tag": "orderStatus",
        "id": "5113222887354003142",
        "type": "native$tbpc_bought_list_order_status",
        "fields": {
          "cpCode": "YUNDA",
          "mailNo": "435156419889626",
          "title": "运输中"
        }
      },
      "orderLogistics_5113222887354003142": {
        "tag": "orderLogistics",
        "id": "5113222887354003142",
        "type": "native$tbpc_bought_list_order_logistics",
        "fields": {
          "packagePreview": {
            "mainOrderId": "5113222887354003142",
            "packageViewList": [
              {
                "cpCode": "YUNDA",
                "cpName": "韵达快递",
                "mailNo": "435156419889626"
              }
            ]
          }
        }
      }
    },
    "ret": ["SUCCESS::调用成功"]
  },
  "v": "1.0"
}

// 也测试扁平结构
const MOCK_RESPONSE_FLAT = {
  "ret": ["SUCCESS::调用成功"],
  "data": {
    "shopInfo_5113222887354003142": {
      "tag": "shopInfo",
      "id": "5113222887354003142",
      "fields": {
        "tradeTitle": "卖家已发货"
      }
    },
    "orderStatus_5113222887354003142": {
      "tag": "orderStatus",
      "id": "5113222887354003142",
      "fields": {
        "cpCode": "YUNDA",
        "mailNo": "435156419889626",
        "title": "运输中"
      }
    },
    "orderLogistics_5113222887354003142": {
      "tag": "orderLogistics",
      "id": "5113222887354003142",
      "fields": {
        "packagePreview": {
          "packageViewList": [
            { "cpName": "韵达快递", "mailNo": "435156419889626" }
          ]
        }
      }
    }
  }
}

// 服务器当前版本的 parseTaobaoH5Response
function parseCurrentServer(responseText) {
  const orders = []
  try {
    const response = typeof responseText === 'string' ? JSON.parse(responseText) : responseText
    
    if (response.ret && response.ret[0] !== 'SUCCESS::调用成功') {
      return orders
    }
    
    if (!response.data) {
      return orders
    }
    
    // 服务器当前代码: 没有 .data.data || response.data 的处理
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    console.log('  Data keys:', Object.keys(data))
    
    const orderMap = {}
    for (const [key, component] of Object.entries(data)) {
      if (!component || typeof component !== 'object') continue
      
      if (key.startsWith('shopInfo_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        if (component.fields && component.fields.tradeTitle) {
          orderMap[orderId].status = component.fields.tradeTitle
        }
      }
      
      if (key.startsWith('orderStatus_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        const fields = component.fields || {}
        if (fields.mailNo) orderMap[orderId].logistics_no = fields.mailNo
        if (fields.cpCode) orderMap[orderId].logistics_company_code = fields.cpCode
        if (fields.title) orderMap[orderId].logistics_status = fields.title
      }
      
      if (key.startsWith('orderLogistics_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        if (component.fields && component.fields.packagePreview && 
            component.fields.packagePreview.packageViewList && 
            component.fields.packagePreview.packageViewList.length > 0) {
          orderMap[orderId].logistics_company = component.fields.packagePreview.packageViewList[0].cpName
        }
      }
    }
    
    for (const orderId of Object.keys(orderMap)) {
      const order = orderMap[orderId]
      if (order.order_no) {
        orders.push({
          order_no: order.order_no,
          status: order.status || '',
          logistics_no: order.logistics_no || '',
          logistics_company: order.logistics_company || '',
          logistics_company_code: order.logistics_company_code || '',
          logistics_status: order.logistics_status || ''
        })
      }
    }
  } catch (e) {
    console.error('Parse error:', e.message)
  }
  return orders
}

// 修复后版本
function parseFixed(responseText) {
  const orders = []
  try {
    const response = typeof responseText === 'string' ? JSON.parse(responseText) : responseText
    
    if (response.ret && response.ret[0] !== 'SUCCESS::调用成功') {
      return orders
    }
    
    if (!response.data) {
      return orders
    }
    
    // 修复: 处理嵌套 data.data 结构
    let data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    if (data.data && typeof data.data === 'object') {
      data = data.data
    }
    console.log('  Data keys:', Object.keys(data))
    
    const orderMap = {}
    for (const [key, component] of Object.entries(data)) {
      if (!component || typeof component !== 'object') continue
      
      if (key.startsWith('shopInfo_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        if (component.fields && component.fields.tradeTitle) {
          orderMap[orderId].status = component.fields.tradeTitle
        }
      }
      
      if (key.startsWith('orderStatus_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        const fields = component.fields || {}
        if (fields.mailNo) orderMap[orderId].logistics_no = fields.mailNo
        if (fields.cpCode) orderMap[orderId].logistics_company_code = fields.cpCode
        if (fields.title) orderMap[orderId].logistics_status = fields.title
      }
      
      if (key.startsWith('orderLogistics_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        if (component.fields && component.fields.packagePreview && 
            component.fields.packagePreview.packageViewList && 
            component.fields.packagePreview.packageViewList.length > 0) {
          orderMap[orderId].logistics_company = component.fields.packagePreview.packageViewList[0].cpName
        }
      }
    }
    
    for (const orderId of Object.keys(orderMap)) {
      const order = orderMap[orderId]
      if (order.order_no) {
        orders.push({
          order_no: order.order_no,
          status: order.status || '',
          logistics_no: order.logistics_no || '',
          logistics_company: order.logistics_company || '',
          logistics_company_code: order.logistics_company_code || '',
          logistics_status: order.logistics_status || ''
        })
      }
    }
  } catch (e) {
    console.error('Parse error:', e.message)
  }
  return orders
}

console.log('=== 测试1: 嵌套 data.data 结构 (当前服务器代码) ===')
const result1a = parseCurrentServer(MOCK_RESPONSE_NESTED)
console.log('  解析结果:', result1a.length, '个订单')
if (result1a.length > 0) console.log('  订单:', JSON.stringify(result1a[0]))

console.log()
console.log('=== 测试2: 嵌套 data.data 结构 (修复后代码) ===')
const result1b = parseFixed(MOCK_RESPONSE_NESTED)
console.log('  解析结果:', result1b.length, '个订单')
if (result1b.length > 0) console.log('  订单:', JSON.stringify(result1b[0]))

console.log()
console.log('=== 测试3: 扁平结构 (当前服务器代码) ===')
const result2a = parseCurrentServer(MOCK_RESPONSE_FLAT)
console.log('  解析结果:', result2a.length, '个订单')
if (result2a.length > 0) console.log('  订单:', JSON.stringify(result2a[0]))

console.log()
console.log('=== 测试4: 扁平结构 (修复后代码) ===')
const result2b = parseFixed(MOCK_RESPONSE_FLAT)
console.log('  解析结果:', result2b.length, '个订单')
if (result2b.length > 0) console.log('  订单:', JSON.stringify(result2b[0]))

console.log()
console.log('========================================')
if (result1a.length === 0 && result1b.length > 0) {
  console.log('BUG确认: 当前代码无法解析嵌套 data.data 结构，修复后可以')
}
if (result2a.length > 0 && result2b.length > 0) {
  console.log('两种代码都能解析扁平结构')
}
