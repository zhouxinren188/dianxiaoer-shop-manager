import { get, put, del } from './request'

export function fetchCloudMachineBinding() {
  return get('/api/cloud-warehouse/machine-binding')
}

export function bindCloudMachine(machineCode) {
  return put('/api/cloud-warehouse/machine-binding', { machine_code: machineCode })
}

export function unbindCloudMachine() {
  return del('/api/cloud-warehouse/machine-binding')
}

