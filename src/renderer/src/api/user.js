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
