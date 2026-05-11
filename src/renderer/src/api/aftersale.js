import { get } from './request'

// 获取所有店铺的售后纠纷指标
export function fetchAftersaleMetrics(params) {
  return get('/api/store-aftersale-metrics', params)
}