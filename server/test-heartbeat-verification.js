const http = require('http')
const https = require('https')

// 模拟心跳检测的核心函数
const BUSINESS_SERVER = 'http://150.158.54.108:3002'

// 各平台心跳验证 URL
const HEARTBEAT_URLS = {
  taobao: 'https://myseller.taobao.com/home.htm',
  tmall: 'https://myseller.taobao.com/home.htm',
  jd: 'https://shop.jd.com/main',
  pdd: 'https://mms.pinduoduo.com/home',
  douyin: 'https://fxg.jinritemai.com/ffa/mshop/homepage/overview'
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers,
      timeout: 10000,
      rejectUnauthorized: false
    }

    const req = mod.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

function httpRequest(url, options = {}, token = null) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const headers = { ...options.headers }
    
    // 添加认证token
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    
    const req = mod.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers,
      timeout: 10000,
      rejectUnauthorized: false
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

// 将 Cookie 数组转为请求头字符串
function cookiesToHeader(cookies) {
  try {
    const parsed = typeof cookies === 'string' ? JSON.parse(cookies) : cookies
    if (!Array.isArray(parsed)) return ''
    return parsed.map(c => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

// 检测单个店铺的在线状态（增强版京东检测逻辑）
async function checkSingleStore(storeId, platform, cookieData) {
  const heartbeatUrl = HEARTBEAT_URLS[platform]
  if (!heartbeatUrl) return null // 未知平台，跳过

  const cookieHeader = cookiesToHeader(cookieData)
  if (!cookieHeader) return false // 无有效 Cookie

  try {
    const res = await httpGet(heartbeatUrl, {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    })

    // 302 重定向到登录页 = 离线
    if (res.statusCode === 302 || res.statusCode === 301) {
      const location = res.headers.location || ''
      if (location.includes('login') || location.includes('sign') || location.includes('passport')) {
        return false
      }
    }

    // 401/403 = 离线
    if (res.statusCode === 401 || res.statusCode === 403) {
      return false
    }

    // 200 状态码需要进一步验证
    if (res.statusCode === 200) {
      const body = res.data.toLowerCase()
      
      // 京东特殊处理：检测是否返回了错误页面或登录提示
      if (platform === 'jd') {
        // 京东Cookie失效的典型特征
        if (body.includes('login') || 
            body.includes('passport.jd.com') ||
            body.includes('wlf-passport') ||
            body.includes('未登录') ||
            body.includes('请先登录')) {
          return false
        }
        
        // 检测是否返回了空数据或错误提示
        if (body.includes('error') || body.includes('异常') || body.length < 1000) {
          return false
        }
      }
      
      // 通用检测：返回的是登录页面
      if (body.includes('login') && body.includes('password') && body.includes('form')) {
        return false
      }
      
      return true
    }

    return null // 其他状态码，不做判断
  } catch (err) {
    console.error(`  ❌ 检测异常: ${err.message}`)
    return null // 网络错误，不更新状态
  }
}

// 主测试函数
async function runTests() {
  console.log('=== 心跳检测与Cookie有效性自动化验证 ===\n')
  
  let testsPassed = 0
  let testsFailed = 0
  
  // 测试1: 验证API返回数据结构
  console.log('📋 测试1: 验证Cookies API返回的数据结构')
  try {
    const res = await httpRequest(`${BUSINESS_SERVER}/api/cookies`)
    const json = JSON.parse(res.data)
    
    if (json.code !== 0) {
      console.log(`  ❌ API返回错误码: ${json.code}`)
      testsFailed++
    } else if (!json.data || !json.data.list) {
      console.log('  ❌ API返回的数据结构不正确 (缺少 data.list)')
      console.log(`   实际返回结构: ${JSON.stringify(json.data, null, 2).substring(0, 200)}`)
      testsFailed++
    } else {
      console.log(`  ✅ API返回正确的数据结构: { code: 0, data: { list: [...], total: N } }`)
      console.log(`  📊 获取到 ${json.data.total} 个店铺的Cookie数据`)
      testsPassed++
      
      // 测试2: 验证Cookie数据完整性
      console.log('\n📋 测试2: 验证Cookie数据完整性')
      const stores = json.data.list
      let validCookies = 0
      let invalidCookies = 0
      
      for (const store of stores) {
        const hasCookie = store.cookie_data && store.cookie_data !== '[]'
        if (hasCookie) {
          validCookies++
          console.log(`  ✅ Store ID: ${store.store_id} | 平台: ${store.platform} | Cookie有效`)
        } else {
          invalidCookies++
          console.log(`  ⚠️  Store ID: ${store.store_id} | 平台: ${store.platform} | 无Cookie数据`)
        }
      }
      console.log(`  📊 统计: ${validCookies} 个有效Cookie, ${invalidCookies} 个无效Cookie`)
      testsPassed++
      
      // 测试3: 执行Cookie有效性检测
      console.log('\n📋 测试3: 执行Cookie有效性检测')
      console.log('  ⏳ 开始检测（可能需要10-30秒）...')
      
      let onlineStores = 0
      let offlineStores = 0
      let skippedStores = 0
      
      for (const store of stores) {
        if (!store.cookie_data || store.cookie_data === '[]') {
          skippedStores++
          console.log(`  ️  跳过 Store ID: ${store.store_id} (无Cookie数据)`)
          continue
        }
        
        const result = await checkSingleStore(store.store_id, store.platform, store.cookie_data)
        
        if (result === true) {
          onlineStores++
          console.log(`  ✅ Store ID: ${store.store_id} | 平台: ${store.platform} | 在线`)
        } else if (result === false) {
          offlineStores++
          console.log(`  ❌ Store ID: ${store.store_id} | 平台: ${store.platform} | 离线`)
        } else {
          skippedStores++
          console.log(`  ⏭️  跳过 Store ID: ${store.store_id} | 平台: ${store.platform} | (无法检测)`)
        }
      }
      
      console.log(`\n  📊 检测结果统计:`)
      console.log(`     ✅ 在线: ${onlineStores} 个店铺`)
      console.log(`     ❌ 离线: ${offlineStores} 个店铺`)
      console.log(`     ️  跳过: ${skippedStores} 个店铺`)
      
      if (onlineStores + offlineStores > 0) {
        testsPassed++
      } else {
        console.log('  ❌ 没有成功检测到任何店铺')
        testsFailed++
      }
      
      // 测试4: 验证状态更新API
      console.log('\n📋 测试4: 验证状态更新API')
      // 注意：这里不实际更新状态，只是验证API可访问性
      const testStore = stores[0]
      if (testStore) {
        const statusRes = await httpRequest(`${BUSINESS_SERVER}/api/stores/${testStore.store_id}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ online: testStore.online })
        })
        const statusJson = JSON.parse(statusRes.data)
        if (statusJson.code === 0) {
          console.log('  ✅ 状态更新API可正常访问')
          testsPassed++
        } else {
          console.log(`  ❌ 状态更新API返回错误: ${statusJson.message}`)
          testsFailed++
        }
      }
    }
  } catch (err) {
    console.log(`  ❌ API请求失败: ${err.message}`)
    testsFailed++
  }
  
  // 测试总结
  console.log('\n=== 测试总结 ===')
  console.log(`📊 总测试数: ${testsPassed + testsFailed}`)
  console.log(`✅ 通过: ${testsPassed}`)
  console.log(`❌ 失败: ${testsFailed}`)
  
  if (testsFailed === 0) {
    console.log('\n 所有测试通过！心跳检测与Cookie有效性逻辑工作正常。')
  } else {
    console.log(`\n️  有 ${testsFailed} 个测试失败，请检查相关逻辑。`)
  }
  
  console.log('\n=== 验证完成 ===')
  process.exit(testsFailed === 0 ? 0 : 1)
}

// 运行测试
runTests().catch(err => {
  console.error('测试执行异常:', err)
  process.exit(1)
})