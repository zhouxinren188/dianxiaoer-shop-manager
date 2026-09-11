import { get } from './request'

export function fetchSettlementOverview(params = {}) {
  return get('/api/settlement-overview', params)
}
