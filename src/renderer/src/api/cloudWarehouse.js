import { get, post, put, del } from './request'

export function fetchCloudMachineBinding() {
  return get('/api/cloud-warehouse/machine-binding')
}

export function fetchWarehouseMachineStatus(warehouseId) {
  return get(`/api/cloud-warehouse/warehouses/${warehouseId}/machine-status`)
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

export function startCloudExceptionCheck(purchaseOrderId) {
  return post(`/api/cloud-warehouse/orders/${purchaseOrderId}/exception/check`, {})
}

export function startCloudExceptionResolve(purchaseOrderId) {
  return post(`/api/cloud-warehouse/orders/${purchaseOrderId}/exception/resolve`, {})
}

export function startCloudOrderPrint(purchaseOrderId) {
  return post(`/api/cloud-warehouse/orders/${purchaseOrderId}/print`, {})
}

export function startCloudOrderOutbound(purchaseOrderId) {
  return post(`/api/cloud-warehouse/orders/${purchaseOrderId}/outbound`, {})
}

export function startCloudOrderReprint(purchaseOrderId) {
  return post(`/api/cloud-warehouse/orders/${purchaseOrderId}/reprint`, {})
}

export function startCloudWarehouseOrderCheck(purchaseOrderIds = []) {
  return post('/api/cloud-warehouse/warehouse-orders/check', {
    purchase_order_ids: purchaseOrderIds
  }, 120000)
}

export function fetchCloudWarehouseOrderCheck(requestId) {
  return get(`/api/cloud-warehouse/warehouse-orders/check/${encodeURIComponent(requestId)}`)
}

export function recordCloudAutomaticRemark(purchaseOrderId, result) {
  return post(`/api/cloud-warehouse/orders/${purchaseOrderId}/process-logs/auto-remark`, {
    success: result?.success === true,
    message: String(result?.message || '')
  })
}
