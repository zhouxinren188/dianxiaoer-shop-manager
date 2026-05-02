import { get, post, put, del } from './request'

// 获取采购账号列表
export function fetchPurchaseAccounts(params) {
  return get('/api/purchase-accounts', params)
}

// 获取单个采购账号
export function fetchPurchaseAccount(id) {
  return get(`/api/purchase-accounts/${id}`)
}

// 创建采购账号
export function createPurchaseAccount(data) {
  return post('/api/purchase-accounts', data)
}

// 更新采购账号
export function updatePurchaseAccount(id, data) {
  return put(`/api/purchase-accounts/${id}`, data)
}

// 删除采购账号
export function deletePurchaseAccount(id) {
  return del(`/api/purchase-accounts/${id}`)
}

// 更新采购账号在线状态
export function updatePurchaseAccountStatus(id, online) {
  return put(`/api/purchase-accounts/${id}/status`, { online })
}

// 获取采购账号Cookie
export function fetchPurchaseAccountCookie(accountId) {
  return get(`/api/purchase-accounts/${accountId}/cookies`)
}

// 保存采购账号Cookie
export function savePurchaseAccountCookie(accountId, data) {
  return post(`/api/purchase-accounts/${accountId}/cookies`, data)
}
