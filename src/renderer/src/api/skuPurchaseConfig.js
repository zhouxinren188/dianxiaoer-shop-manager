import { get, post, del } from './request'

// 获取SKU采购配置列表
export function fetchSkuPurchaseConfigList(skuId) {
  const params = skuId ? { sku_id: skuId } : {}
  return get('/api/sku-purchase-config', params)
}

// 保存/更新SKU采购配置
export function saveSkuPurchaseConfig(data) {
  return post('/api/sku-purchase-config', data)
}

// 删除SKU采购配置
export function deleteSkuPurchaseConfig(id) {
  return del(`/api/sku-purchase-config/${id}`)
}

// 从链接识别平台
export function detectPlatformFromUrl(url) {
  if (!url) return ''
  const lower = url.toLowerCase()
  if (lower.includes('taobao.com') || lower.includes('tmall.com') || lower.includes('tb.cn')) return 'taobao'
  if (lower.includes('pinduoduo.com') || lower.includes('yangkeduo.com') || lower.includes('pdd.com')) return 'pinduoduo'
  if (lower.includes('1688.com')) return '1688'
  return ''
}
