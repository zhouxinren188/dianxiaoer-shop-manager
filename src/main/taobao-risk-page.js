'use strict'

const TAOBAO_RISK_MARKERS = [
  '访问异常提示',
  '当前访问存在异常',
  '恢复正常访问方式后',
  '商品详情页将在一段时间后自动恢复'
]

function findTaobaoRiskMarker(text) {
  const value = String(text || '').replace(/\s+/g, '')
  return TAOBAO_RISK_MARKERS.find(marker => value.includes(marker.replace(/\s+/g, ''))) || ''
}

const TAOBAO_RISK_PAGE_PROBE_SCRIPT = `(() => {
  const text = String((document.body && document.body.innerText) || '').replace(/\\s+/g, '');
  const markers = ${JSON.stringify(TAOBAO_RISK_MARKERS.map(marker => marker.replace(/\s+/g, '')))};
  const marker = markers.find(item => text.includes(item)) || '';
  return {
    detected: !!marker,
    marker,
    title: String(document.title || '').slice(0, 120),
    readyState: String(document.readyState || '')
  };
})()`

async function inspectTaobaoRiskPage(webContents) {
  if (!webContents || webContents.isDestroyed?.()) return { detected: false, reason: 'destroyed' }
  return webContents.executeJavaScript(TAOBAO_RISK_PAGE_PROBE_SCRIPT, true)
}

module.exports = {
  TAOBAO_RISK_MARKERS,
  TAOBAO_RISK_PAGE_PROBE_SCRIPT,
  findTaobaoRiskMarker,
  inspectTaobaoRiskPage
}
