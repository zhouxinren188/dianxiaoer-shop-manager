/**
 * 测试淘宝API获取订单状态和物流单号
 * 使用订单号: 5113222887354003142
 */

const https = require('https')
const crypto = require('crypto')

// Cookie (从用户提供的数据中提取)
const COOKIE = 'thw=cn; useNativeIM=false; _hvn_lgc_=0; cnaui=2208045741511; aui=2208045741511; t=979f9fb4e64eecdac40702ffd13d222b; cookie2=123c041c246ce162688c5f61f832b120; _tb_token_=533588883dee8; xlly_s=1; 3PcFlag=1777570244085; wk_cookie2=1e388abe092637be6a5b753fef37c8c0; wk_unb=UUphwocc72R2QNj8%2Bg%3D%3D; sgcookie=E100EATwr543xmWmq%2FmwkphwsH4HEGyFsMWHxNjM3Bpt7zWRUW%2FCCspeGXS7t4%2BAMT9nBJvJgfvIY3iWCNGoJ96t0GcA6hxL3HAMzh7AuoMUsW4%3D; havana_lgc2_0=eyJoaWQiOjIyMDgwNDU3NDE1MTEsInNnIjoiYTc0MzEzMjExNDJmOGQwYjI0MDMxODhlNzcyZDVlNzgiLCJzaXRlIjowLCJ0b2tlbiI6IjFLcy01aWRLWUplMDdnVFJJd3N1d2lnIn0; unb=2208045741511; csg=a57d28ed; lgc=%5Cu6DD8_%5Cu5929%5Cu4E0B%5Cu7269%5Cu54C1; cancelledSubSites=empty; cookie17=UUphwocc72R2QNj8%2Bg%3D%3D; dnk=%5Cu6DD8_%5Cu5929%5Cu4E0B%5Cu7269%5Cu54C1; skt=45c7241c31332b87; tracknick=%5Cu6DD8_%5Cu5929%5Cu4E0B%5Cu7269%5Cu54C1; _l_g_=Ug%3D%3D; sg=%E5%93%8118; _nk_=%5Cu6DD8_%5Cu5929%5Cu4E0B%5Cu7269%5Cu54C1; cookie1=UoSK2tZhF8SnSnVgHyt%2FWpPhMOeukprpkNwonLCy8Mc%3D; sn=; uc3=vt3=F8dD1NBsx4uLlZmR%2BcM%3D&lg2=U%2BGCWk%2F75gdr5Q%3D%3D&id2=UUphwocc72R2QNj8%2Bg%3D%3D&nk2=r4Fu%2FjXfPX4403o%3D; existShop=MTc3NzU3MDI1NA%3D%3D; uc4=nk4=0%40rWOq%2B%2Fm%2BBhqYc8%2BSAiyS3o5TBYn3Vg%3D%3D&id4=0%40U2grGR8cv7XAV23zonQACEKp4Ylyodg9; _cc_=UtASsssmfA%3D%3D; cna=BuZ6Iq%2BjKgsCAXVf0bPp%2FkCT; _samesite_flag_=true; mtop_partitioned_detect=1; _m_h5_tk=3f2510a8885b0fe343162293372ad9b7_1777765207180; _m_h5_tk_enc=278a9b0de11fa64881f4693a274b5139; sca=cea40c5b; havana_sdkSilent=1777786808671; isg=BAcHdZUWImhKf6e65YjQw-wblrvDANvu7yjAKNn0Yxa9SCYK4djPPlUL7ggWoLNm; havana_lgc_exp=1808862180316; sdkSilent=1777786980315; tfstk=gKz-PMsOztXoQdQfBUj0-TBQzI5cJiVzg8P6-vDkA-eYp5duqDDnA2eaBDTh44mKJ-M0rYVoPXiQKRZoFuDHJye4eUYnPJbKd5rVTYcurBhQc8L3q7DuDB3zouYnETuLOR0dIObGS7PrL26GITrFrTus6LMBK0_jc2cLm7tk17Pr8IRDdGqbawdTs5TSOv1xlXhHF2GIFn1x9fHIRYiBhnGshvgQdY_XlXhJVXtSRq1xTxTIR2wIlshnhvgIRJNj9B6KhQMHJo6NqkAvmh5COrh-2vLnLeeu4FmECwkX5FM-w0KuNxLBRrrpctVEFGRmL4DzsbeF7UuSvlPn98QJPJFau-hbCwLiFSPgj0z57HotPYnLP7BJHAazGPujmN1TGryuarFHOwG0IxNzP2Q1_43SFqh4-t8SpoZQr0ueFOmzOoexwVszPP4O9w9Gg9-5MsKeY0G2QKD3FUHJIGcxI_QpYHoVgjHGMH-eYDcqMAfmcH-E0s5..'

// 测试订单号
const TEST_ORDER_NO = '5113222887354003142'

/**
 * 生成md5签名
 */
function generateSign(data, token, timestamp) {
  const tokenStr = token || ''
  const signStr = `${tokenStr}&${timestamp}&12574478&${data}`
  return crypto.createHash('md5').update(signStr).digest('hex')
}

/**
 * 调用淘宝订单查询API
 */
function queryTaobaoOrder(orderNo) {
  const timestamp = Date.now()
  
  // 构建查询条件 - 使用订单号搜索
  const condition = {
    directRouteToTm2Scene: "1",
    wordType: "3",  // 3表示搜索
    wordTerm: orderNo,
    showText: orderNo,
    itemTitle: orderNo,
    orderFilterExtParam: "{}"
  }

  const dataObj = {
    tabCode: "all",
    page: 1,
    OrderType: "OrderSearch",
    appName: "tborder",
    appVersion: "3.0",
    condition: JSON.stringify(condition),
    __needlessClearProtocol__: true
  }

  const dataStr = JSON.stringify(dataObj)
  
  // 从Cookie中提取token (_m_h5_tk)
  const tokenMatch = COOKIE.match(/_m_h5_tk=([^;]+)/)
  const token = tokenMatch ? tokenMatch[1].split('_')[0] : ''
  
  // 生成签名
  const sign = generateSign(dataStr, token, timestamp)
  
  console.log('=== 请求参数 ===')
  console.log(`订单号: ${orderNo}`)
  console.log(`时间戳: ${timestamp}`)
  console.log(`Token: ${token.substring(0, 20)}...`)
  console.log(`签名: ${sign}`)
  console.log()

  const params = new URLSearchParams({
    jsv: '2.7.2',
    appKey: '12574478',
    t: timestamp.toString(),
    sign: sign,
    v: '1.0',
    ecode: '1',
    timeout: '8000',
    dataType: 'json',
    valueType: 'original',
    ttid: '1@tbwang_windows_1.0.0#pc',
    needLogin: 'true',
    type: 'originaljson',
    isHttps: '1',
    needRetry: 'true',
    api: 'mtop.taobao.order.queryboughtlistV2',
    __customTag__: 'boughtList_all_OrderSearch',
    preventFallback: 'true'
  })

  const postData = `data=${encodeURIComponent(dataStr)}`

  const options = {
    hostname: 'h5api.m.taobao.com',
    path: `/h5/mtop.taobao.order.queryboughtlistv2/1.0/?${params.toString()}`,
    method: 'POST',
    headers: {
      'Cookie': COOKIE,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) dianxiaoer-shop-manager/1.2.11 Chrome/146.0.7680.188 Electron/41.3.0 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Referer': 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
      'Content-Length': Buffer.byteLength(postData)
    }
  }

  return new Promise((resolve, reject) => {
    console.log('发送请求...')
    console.log(`URL: https://${options.hostname}${options.path}`)
    console.log()

    const req = https.request(options, (res) => {
      console.log('=== 响应信息 ===')
      console.log(`状态码: ${res.statusCode}`)
      console.log(`响应头: ${JSON.stringify(res.headers)}`)
      console.log()

      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        console.log('=== 响应内容 ===')
        console.log(data)
        console.log()

        try {
          const result = JSON.parse(data)
          analyzeResponse(result, orderNo)
          resolve(result)
        } catch (e) {
          console.error('JSON解析失败:', e.message)
          reject(new Error(`JSON解析失败: ${e.message}`))
        }
      })
    })

    req.on('error', (e) => {
      console.error('请求错误:', e.message)
      reject(e)
    })

    req.setTimeout(15000, () => {
      req.destroy()
      console.error('请求超时')
      reject(new Error('请求超时'))
    })

    req.write(postData)
    req.end()
  })
}

/**
 * 分析响应数据，提取订单状态和物流信息
 */
function analyzeResponse(result, orderNo) {
  console.log('=== 数据分析 ===')
  
  // 检查返回状态
  if (result.ret && result.ret.length > 0) {
    console.log(`返回状态: ${result.ret.join(', ')}`)
    
    // 检查是否成功
    const success = result.ret[0] && result.ret[0].includes('SUCCESS')
    if (!success) {
      console.log('❌ API调用失败')
      return
    }
  }

  if (!result.data) {
    console.log('❌ 没有data字段')
    return
  }

  const data = typeof result.data === 'string' ? JSON.parse(result.data) : result.data
  
  console.log('data字段:', Object.keys(data).join(', '))
  console.log()

  // 尝试解析订单数据
  if (data.dataList && data.dataList.length > 0) {
    console.log(`✅ 找到 ${data.dataList.length} 个订单`)
    console.log()
    
    for (const order of data.dataList) {
      console.log('--- 订单详情 ---')
      console.log(`订单号: ${order.id || order.bid || order.orderId || 'N/A'}`)
      console.log(`订单状态: ${order.statusInfo?.statusTitle || order.status || 'N/A'}`)
      console.log(`店铺名称: ${order.sellerName || order.shopInfo?.shopName || 'N/A'}`)
      console.log(`商品名称: ${order.itemTitle || order.items?.[0]?.title || 'N/A'}`)
      
      // 物流信息
      if (order.logistics) {
        console.log(`物流状态: ${order.logistics.status || 'N/A'}`)
        console.log(`物流单号: ${order.logistics.mailNo || '未发货'}`)
        console.log(`物流公司: ${order.logistics.companyName || order.logistics.logisticsCompany || 'N/A'}`)
      } else {
        console.log('物流信息: 未找到物流字段')
      }
      
      // 其他信息
      if (order.tradeTitle) {
        console.log(`交易标题: ${order.tradeTitle}`)
      }
      
      console.log()
    }
  } else if (data.mainOrders) {
    console.log(`✅ 找到 ${data.mainOrders.length} 个主订单`)
    analyzeMainOrders(data.mainOrders)
  } else if (data.orderList) {
    console.log(`✅ 找到 ${data.orderList.length} 个订单`)
    analyzeOrderList(data.orderList)
  } else {
    console.log('未找到预期的订单列表字段')
    console.log('完整data结构:', JSON.stringify(data, null, 2).substring(0, 2000))
  }
}

/**
 * 分析mainOrders格式的订单
 */
function analyzeMainOrders(orders) {
  for (const order of orders) {
    console.log('--- 订单详情 ---')
    console.log(`订单号: ${order.id || order.bid || 'N/A'}`)
    console.log(`状态: ${order.status || 'N/A'}`)
    
    if (order.logisticsInfo) {
      console.log(`物流单号: ${order.logisticsInfo.mailNo || '未发货'}`)
      console.log(`物流公司: ${order.logisticsInfo.companyName || 'N/A'}`)
    }
    console.log()
  }
}

/**
 * 分析orderList格式的订单
 */
function analyzeOrderList(orders) {
  for (const order of orders) {
    console.log('--- 订单详情 ---')
    console.log(`订单号: ${order.id || 'N/A'}`)
    console.log(`状态: ${order.status || 'N/A'}`)
    
    if (order.logistics) {
      console.log(`物流单号: ${order.logistics.mailNo || '未发货'}`)
    }
    console.log()
  }
}

// 执行测试
console.log('========================================')
console.log('淘宝API订单状态和物流单号测试')
console.log('========================================')
console.log()

queryTaobaoOrder(TEST_ORDER_NO)
  .then(() => {
    console.log('\n========================================')
    console.log('测试完成')
    console.log('========================================')
    process.exit(0)
  })
  .catch(err => {
    console.error('\n测试失败:', err)
    process.exit(1)
  })
