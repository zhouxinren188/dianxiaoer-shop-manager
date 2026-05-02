#!/usr/bin/env node
/**
 * 测试店铺新增和列表查询功能
 */

const BASE_URL = 'http://150.158.54.108:3002'
const API_URL = 'http://150.158.54.108:3001'

async function test() {
  console.log('=== 测试店小二店铺功能 ===\n')

  // 1. 先登录获取 token
  console.log('1. 登录获取 token...')
  const loginRes = await fetch(`${API_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'testuser',  // 需要用户提供实际账号
      password: 'test123'
    })
  })
  
  const loginData = await loginRes.json()
  console.log('登录结果:', JSON.stringify(loginData, null, 2))
  
  if (!loginData.accessToken) {
    console.log('❌ 登录失败，无法继续测试')
    return
  }

  const token = loginData.accessToken
  const authHeader = `Bearer ${token}`

  // 2. 获取当前用户信息
  console.log('\n2. 获取当前用户信息...')
  const meRes = await fetch(`${API_URL}/api/me`, {
    headers: { 'Authorization': authHeader }
  })
  const meData = await meRes.json()
  console.log('用户信息:', JSON.stringify(meData, null, 2))

  // 3. 查询店铺列表
  console.log('\n3. 查询店铺列表...')
  const storesRes = await fetch(`${BASE_URL}/api/stores?page=1&pageSize=10`, {
    headers: { 'Authorization': authHeader }
  })
  const storesData = await storesRes.json()
  console.log('店铺列表:', JSON.stringify(storesData, null, 2))

  // 4. 新增店铺
  console.log('\n4. 新增店铺...')
  const now = new Date()
  const timeStr = now.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).replace(/[\/\s:]/g, '')
  
  const newStoreRes = await fetch(`${BASE_URL}/api/stores`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: `测试店铺${timeStr}`,
      platform: 'jd'
    })
  })
  const newStoreData = await newStoreRes.json()
  console.log('新增店铺结果:', JSON.stringify(newStoreData, null, 2))

  // 5. 再次查询店铺列表
  console.log('\n5. 再次查询店铺列表...')
  const storesRes2 = await fetch(`${BASE_URL}/api/stores?page=1&pageSize=10`, {
    headers: { 'Authorization': authHeader }
  })
  const storesData2 = await storesRes2.json()
  console.log('店铺列表:', JSON.stringify(storesData2, null, 2))

  console.log('\n=== 测试完成 ===')
}

test().catch(err => {
  console.error('测试出错:', err.message)
})
