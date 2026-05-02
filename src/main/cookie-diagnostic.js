// 店铺Cookie诊断工具
const { session, app } = require('electron')
const path = require('path')

async function diagnoseStoreCookie(storeId) {
  console.log('=== 店铺Cookie诊断开始 ===')
  console.log('店铺ID:', storeId)
  
  // 1. 检查session分区
  const partitionName = `persist:platform-${storeId}`
  const ses = session.fromPartition(partitionName)
  console.log('Session分区:', partitionName)
  
  // 2. 获取所有Cookie
  const allCookies = await ses.cookies.get({})
  console.log('总Cookie数:', allCookies.length)
  
  // 3. 筛选京东Cookie
  const jdCookies = allCookies.filter(c => c.domain && c.domain.includes('jd.com'))
  console.log('京东Cookie数:', jdCookies.length)
  
  if (jdCookies.length > 0) {
    console.log('京东Cookie详情:')
    jdCookies.forEach((cookie, index) => {
      console.log(`  ${index + 1}. ${cookie.name} = ${cookie.value.substring(0, 20)}... (domain: ${cookie.domain})`)
    })
  } else {
    console.log('没有找到京东Cookie！')
    
    // 4. 检查是否有其他平台的Cookie
    const otherCookies = allCookies.filter(c => !c.domain.includes('jd.com'))
    if (otherCookies.length > 0) {
      console.log('其他平台Cookie数:', otherCookies.length)
    }
  }
  
  // 5. 检查店铺状态
  try {
    const response = await fetch(`http://localhost:3002/api/stores/${storeId}`)
    const storeData = await response.json()
    if (storeData.success) {
      console.log('店铺状态:', storeData.data)
      console.log('在线状态:', storeData.data.online ? '在线' : '离线')
      console.log('店铺状态:', storeData.data.status)
    }
  } catch (e) {
    console.log('无法获取店铺状态:', e.message)
  }
  
  console.log('=== 诊断结束 ===')
  return {
    totalCookies: allCookies.length,
    jdCookies: jdCookies.length,
    hasValidCookie: jdCookies.length > 0
  }
}

module.exports = { diagnoseStoreCookie }