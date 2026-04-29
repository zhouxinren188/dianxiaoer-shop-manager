import { get, post, put, del } from './request'

export function fetchWarehouses() {
  return get('/api/warehouses')
}

export function fetchWarehouse(id) {
  return get(`/api/warehouses/${id}`)
}

export function createWarehouse(data) {
  return post('/api/warehouses', data)
}

export function updateWarehouse(id, data) {
  return put(`/api/warehouses/${id}`, data)
}

export function deleteWarehouse(id) {
  return del(`/api/warehouses/${id}`)
}
