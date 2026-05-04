/**
 * 测试淘宝订单解析逻辑
 * 使用真实的API响应数据验证解析是否正确
 */

// 模拟真实的API响应数据（从之前的测试结果中提取）
const MOCK_RESPONSE = {
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
          "highlight": "false",
          "mailNo": "435156419889626",
          "pic": "//gw.alicdn.com/imgextra/i1/O1CN01kP3lWb1lnIirKZtfO_!!6000000004863-2-tps-30-30.png",
          "showArrow": "false",
          "subTitle": "预计今天送达",
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
                "mailNo": "435156419889626",
                "showTaoXiaoBao": false,
                "subOrderList": ["5113222887354003142"]
              }
            ],
            "showTaoXiaoBao": false
          }
        }
      },
      "orderItemInfo_5113222887354003142_5113222887354003142": {
        "tag": "orderItemInfo",
        "id": "5113222887354003142_5113222887354003142",
        "type": "native$tbpc_order_item_info",
        "fields": {
          "item": {
            "itemId": "537010847544",
            "title": "公牛旗舰店自动防过充USB手机充电器苹充满断电带智能小插座插头",
            "priceInfo": {
              "actualTotalFee": "￥49.90",
              "promotion": "￥49.90"
            },
            "quantity": "2"
          },
          "orderId": "5113222887354003142"
        }
      },
      "orderPayment_5113222887354003142": {
        "tag": "orderPayment",
        "id": "5113222887354003142",
        "type": "native$tbpc_bought_list_order_payment",
        "fields": {
          "actualFee": {
            "prefix": "实付款",
            "value": "￥99.80"
          },
          "totalFee": {
            "prefix": "总价",
            "value": "￥99.80"
          }
        }
      }
    },
    "ret": ["SUCCESS::调用成功"]
  },
  "v": "1.0"
}

/**
 * 解析淘宝H5 API响应（修复后的版本）
 */
function parseTaobaoH5Response(responseText) {
  const orders = []
  try {
    const response = typeof responseText === 'string' ? JSON.parse(responseText) : responseText
    console.log('[Parse] H5 API response structure:', Object.keys(response))
    
    if (response.ret && response.ret[0] !== 'SUCCESS::调用成功') {
      console.error('[Parse] H5 API error:', response.ret)
      return orders
    }
    
    if (!response.data) {
      console.log('[Parse] No data in H5 API response')
      return orders
    }
    
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data.data || response.data
    console.log('[Parse] Data keys:', Object.keys(data))
    
    // 组件化布局：遍历所有组件，按订单ID聚合信息
    const orderMap = {}
    
    for (const [key, component] of Object.entries(data)) {
      if (!component || typeof component !== 'object') continue
      
      // shopInfo_* 组件：提取订单ID和订单状态
      if (key.startsWith('shopInfo_')) {
        const orderId = component.id
        if (!orderId) continue
        
        if (!orderMap[orderId]) {
          orderMap[orderId] = { order_no: orderId }
        }
        
        // 提取订单状态（tradeTitle字段，如"卖家已发货"）
        if (component.fields && component.fields.tradeTitle) {
          orderMap[orderId].status = component.fields.tradeTitle
          console.log(`[Parse] Order ${orderId} status: ${component.fields.tradeTitle}`)
        }
      }
      
      // orderStatus_* 组件：提取物流单号和物流状态
      if (key.startsWith('orderStatus_')) {
        const orderId = component.id
        if (!orderId) continue
        
        if (!orderMap[orderId]) {
          orderMap[orderId] = { order_no: orderId }
        }
        
        const fields = component.fields || {}
        
        // 物流单号（在 fields 里面）
        if (fields.mailNo) {
          orderMap[orderId].logistics_no = fields.mailNo
          console.log(`[Parse] Order ${orderId} logistics_no: ${fields.mailNo}`)
        }
        
        // 物流公司代码
        if (fields.cpCode) {
          orderMap[orderId].logistics_company_code = fields.cpCode
          console.log(`[Parse] Order ${orderId} cpCode: ${fields.cpCode}`)
        }
        
        // 物流状态标题（如"运输中"）
        if (fields.title) {
          orderMap[orderId].logistics_status = fields.title
          console.log(`[Parse] Order ${orderId} logistics_status: ${fields.title}`)
        }
      }
      
      // orderLogistics_* 组件：提取物流公司名称
      if (key.startsWith('orderLogistics_')) {
        const orderId = component.id
        if (!orderId) continue
        
        if (!orderMap[orderId]) {
          orderMap[orderId] = { order_no: orderId }
        }
        
        // 物流公司名称：从packagePreview.packageViewList[0].cpName提取
        if (component.fields && component.fields.packagePreview && 
            component.fields.packagePreview.packageViewList && 
            component.fields.packagePreview.packageViewList.length > 0) {
          orderMap[orderId].logistics_company = component.fields.packagePreview.packageViewList[0].cpName
          console.log(`[Parse] Order ${orderId} logistics_company: ${orderMap[orderId].logistics_company}`)
        }
      }
    }
    
    // 转换为数组
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
    
    console.log('[Parse] Total parsed orders:', orders.length)
    if (orders.length > 0) {
      console.log('[Parse] Sample order:', JSON.stringify(orders[0], null, 2))
    }
    
  } catch (e) {
    console.error('[Parse] H5 API parse error:', e.message)
    console.error('[Parse] Stack:', e.stack)
  }
  
  return orders
}

// 执行测试
console.log('========================================')
console.log('淘宝订单解析逻辑测试')
console.log('========================================')
console.log()

const orders = parseTaobaoH5Response(MOCK_RESPONSE)

console.log()
console.log('========================================')
console.log('测试结果验证')
console.log('========================================')
console.log()

if (orders.length === 0) {
  console.log('❌ 测试失败：没有解析到订单')
  process.exit(1)
}

const order = orders[0]

console.log('订单号:', order.order_no)
console.log('预期:    5113222887354003142')
console.log('匹配:', order.order_no === '5113222887354003142' ? '✅' : '❌')
console.log()

console.log('订单状态:', order.status)
console.log('预期:     卖家已发货')
console.log('匹配:', order.status === '卖家已发货' ? '✅' : '❌')
console.log()

console.log('物流单号:', order.logistics_no)
console.log('预期:     435156419889626')
console.log('匹配:', order.logistics_no === '435156419889626' ? '✅' : '❌')
console.log()

console.log('物流公司:', order.logistics_company)
console.log('预期:     韵达快递')
console.log('匹配:', order.logistics_company === '韵达快递' ? '✅' : '❌')
console.log()

console.log('物流代码:', order.logistics_company_code)
console.log('预期:     YUNDA')
console.log('匹配:', order.logistics_company_code === 'YUNDA' ? '✅' : '❌')
console.log()

console.log('物流状态:', order.logistics_status)
console.log('预期:     运输中')
console.log('匹配:', order.logistics_status === '运输中' ? '✅' : '❌')
console.log()

// 最终判断
const allPassed = 
  order.order_no === '5113222887354003142' &&
  order.status === '卖家已发货' &&
  order.logistics_no === '435156419889626' &&
  order.logistics_company === '韵达快递' &&
  order.logistics_company_code === 'YUNDA' &&
  order.logistics_status === '运输中'

console.log('========================================')
if (allPassed) {
  console.log('✅ 所有测试通过！解析逻辑正确')
} else {
  console.log('❌ 部分测试失败，需要修复')
}
console.log('========================================')

process.exit(allPassed ? 0 : 1)
