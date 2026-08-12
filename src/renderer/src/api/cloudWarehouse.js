import { get, post, put, del } from './request'

export function fetchCloudMachineBinding() {
  return get('/api/cloud-warehouse/machine-binding')
}

export function bindCloudMachine(machineCode) {
  return put('/api/cloud-warehouse/machine-binding', { machine_code: machineCode })
}

export function unbindCloudMachine() {
  return del('/api/cloud-warehouse/machine-binding')
}

export function fetchCloudOrderConfiguration(purchaseOrderId) {
  return get(`/api/cloud-warehouse/orders/${purchaseOrderId}/configuration`)
}

export function confirmCloudOrderYear(purchaseOrderId, orderYear) {
  return put(`/api/cloud-warehouse/orders/${purchaseOrderId}/order-year`, {
    order_year: orderYear,
    confirmed: true
  })
}

export function prepareCloudOrderRef(purchaseOrderId) {
  return post(`/api/cloud-warehouse/orders/${purchaseOrderId}/order-ref`, {})
}
