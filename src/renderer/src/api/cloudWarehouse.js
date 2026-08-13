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

export function createCloudExecutorEnrollment() {
  return post('/api/cloud-warehouse/machine-binding/enrollment', {})
}

export function fetchCloudOrderConfiguration(purchaseOrderId) {
  return get(`/api/cloud-warehouse/orders/${purchaseOrderId}/configuration`)
}

export function prepareCloudOrderRef(purchaseOrderId) {
  return post(`/api/cloud-warehouse/orders/${purchaseOrderId}/order-ref`, {})
}

export function startCloudExceptionCheck(purchaseOrderId) {
  return post(`/api/cloud-warehouse/orders/${purchaseOrderId}/exception/check`, {})
}

export function startCloudExceptionResolve(purchaseOrderId, exceptionSnapshotRef) {
  return post(`/api/cloud-warehouse/orders/${purchaseOrderId}/exception/resolve`, {
    exception_snapshot_ref: exceptionSnapshotRef,
    confirmed: true
  })
}
