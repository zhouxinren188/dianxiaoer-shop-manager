import { get, post, put, del } from './request'

export function fetchUsers(params) {
  return get('/api/users', params)
}

export function fetchUser(id) {
  return get(`/api/users/${id}`)
}

export function createUser(data) {
  return post('/api/users', data)
}

export function updateUser(id, data) {
  return put(`/api/users/${id}`, data)
}

export function deleteUser(id) {
  return del(`/api/users/${id}`)
}

export function toggleUserStatus(id, status) {
  return put(`/api/users/${id}/toggle`, { status })
}

// 分配店铺
export function assignUserStores(userId, storeIds) {
  return put(`/api/users/${userId}/stores`, { storeIds })
}

// 分配仓库
export function assignUserWarehouses(userId, warehouseIds) {
  return put(`/api/users/${userId}/warehouses`, { warehouseIds })
}

// 获取用户已分配的店铺
export function fetchUserStores(userId) {
  return get(`/api/users/${userId}/stores`)
}

// 获取用户已分配的仓库
export function fetchUserWarehouses(userId) {
  return get(`/api/users/${userId}/warehouses`)
}

// 分配采购账号
export function assignUserPurchaseAccounts(userId, accountIds) {
  return put(`/api/users/${userId}/purchase-accounts`, { accountIds })
}

// 获取用户已分配的采购账号
export function fetchUserPurchaseAccounts(userId) {
  return get(`/api/users/${userId}/purchase-accounts`)
}

// 退出登录（通知服务端删除 token，清除本地状态）
export async function logout() {
  // 先通知两个服务端删除 token（踢掉当前会话）
  try {
    await post('/api/auth/logout')
  } catch (e) {}
  try {
    await fetch('http://150.158.54.108:3001/api/logout', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${localStorage.getItem('accessToken')}`, 'Content-Type': 'application/json' }
    })
  } catch (e) {}
  localStorage.removeItem('accessToken')
  localStorage.removeItem('currentUser')
  localStorage.removeItem('userInfo')
  // 保留 rememberedUser 和 rememberedPassword，方便下次登录
  // 清除主进程 token
  if (window.electronAPI) {
    window.electronAPI.invoke('set-auth-token', null).catch(() => {})
  }
}
