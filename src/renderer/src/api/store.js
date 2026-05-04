import { get, post, put, del } from './request'

export function fetchStores(params) {
  return get('/api/stores', params)
}

export function fetchStore(id) {
  return get(`/api/stores/${id}`)
}

export function createStore(data) {
  return post('/api/stores', data)
}

export function updateStore(id, data) {
  return put(`/api/stores/${id}`, data)
}

export function deleteStore(id) {
  return del(`/api/stores/${id}`)
}

export function updateStoreOnline(id, online) {
  return put(`/api/stores/${id}/status`, { online })
}

export function toggleStoreStatus(id, status) {
  return put(`/api/stores/${id}/toggle`, { status })
}

export function fetchStoreCookie(storeId) {
  return get(`/api/cookies/${storeId}`)
}

export function updateStoreSyncTime(storeId) {
  return put(`/api/stores/${storeId}/sync-time`)
}
