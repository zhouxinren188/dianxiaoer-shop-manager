const BATCH_PAYMENT_NOTICE_ID = '__dxe_taobao_batch_payment_notice__'

function safeUrl(value) {
  try {
    return new URL(String(value || ''))
  } catch (_) {
    return null
  }
}

function isAlipayHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return host === 'alipay.com' || host.endsWith('.alipay.com') ||
    host === 'alipaydev.com' || host.endsWith('.alipaydev.com')
}

function isTaobaoBatchPaymentUrl(value) {
  const parsed = safeUrl(value)
  if (!parsed || !isAlipayHost(parsed.hostname)) return false

  const path = parsed.pathname.toLowerCase()
  if (path.includes('/trade/batch_payment')) return true

  const tradeNo = parsed.searchParams.get('tradeNo') || parsed.searchParams.get('trade_no') || ''
  const bizIdentity = parsed.searchParams.get('bizIdentity') || ''
  return tradeNo.includes(';') || /^merge/i.test(bizIdentity)
}

function extractTrustedTaobaoOrderNoFromUrl(value) {
  const parsed = safeUrl(value)
  if (!parsed) return ''

  const host = parsed.hostname.toLowerCase()
  const isTaobaoHost = host === 'taobao.com' || host.endsWith('.taobao.com') ||
    host === 'tmall.com' || host.endsWith('.tmall.com')
  if (!isTaobaoHost) return ''

  const path = parsed.pathname.toLowerCase()
  const isOrderPage = path.includes('/trade/detail') || path.includes('/order/detail') ||
    path.includes('order_detail') || path.includes('trade_item_detail') ||
    path.includes('trade_order_detail') ||
    path.includes('/app/tbpc-trade/tbpc-pay-success')
  if (!isOrderPage) return ''

  for (const name of ['bizOrderId', 'biz_order_id', 'mainOrderId', 'orderId', 'order_id', 'b2c_orid']) {
    const candidate = String(parsed.searchParams.get(name) || '').trim()
    if (/^\d{15,30}$/.test(candidate)) return candidate
  }
  return ''
}

function selectSingleTaobaoOrderCandidate(frameResults) {
  const allowedFields = new Set(['b2c_orid', 'bizorderid', 'biz_order_id', 'out_trade_no', 'outtradeno'])
  const strongFields = new Set(['b2c_orid', 'bizorderid', 'biz_order_id'])
  const evidence = []

  for (const result of Array.isArray(frameResults) ? frameResults : []) {
    for (const item of Array.isArray(result?.candidates) ? result.candidates : []) {
      const field = String(item?.field || '').toLowerCase()
      const value = String(item?.value || '').trim()
      if (!allowedFields.has(field) || !/^\d{15,30}$/.test(value)) continue
      evidence.push({ field, value, source: String(item?.source || ''), frameUrl: String(result?.url || '') })
    }
  }

  const uniqueValues = items => [...new Set(items.map(item => item.value))]
  const strongValues = uniqueValues(evidence.filter(item => strongFields.has(item.field)))
  if (strongValues.length === 1) {
    return { orderNo: strongValues[0], reason: 'single_strong_candidate', candidates: uniqueValues(evidence) }
  }
  if (strongValues.length > 1) {
    return { orderNo: '', reason: 'ambiguous_strong_candidates', candidates: strongValues }
  }

  const fallbackValues = uniqueValues(evidence)
  if (fallbackValues.length === 1) {
    return { orderNo: fallbackValues[0], reason: 'single_out_trade_no', candidates: fallbackValues }
  }
  return {
    orderNo: '',
    reason: fallbackValues.length > 1 ? 'ambiguous_out_trade_no_candidates' : 'no_candidate',
    candidates: fallbackValues
  }
}

const EXTRACT_ALIPAY_TAOBAO_ORDER_CANDIDATES = `
(function() {
  var candidates = [];
  var seen = Object.create(null);
  function add(field, value, source) {
    field = String(field || '').toLowerCase();
    value = String(value || '').trim();
    if (!/^(b2c_orid|bizorderid|biz_order_id|out_trade_no|outtradeno)$/.test(field)) return;
    if (!/^\\d{15,30}$/.test(value)) return;
    var key = field + ':' + value;
    if (seen[key]) return;
    seen[key] = true;
    candidates.push({ field: field, value: value, source: source || '' });
  }
  try {
    var params = new URLSearchParams(location.search || '');
    ['b2c_orid', 'bizOrderId', 'biz_order_id', 'out_trade_no', 'outTradeNo'].forEach(function(name) {
      add(name, params.get(name), 'url');
    });
  } catch (_) {}
  try {
    var elements = document.querySelectorAll('input,textarea,select,[data-out-trade-no],[data-biz-order-id]');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var names = [
        el.getAttribute('name'), el.getAttribute('id'),
        el.getAttribute('data-out-trade-no') ? 'out_trade_no' : '',
        el.getAttribute('data-biz-order-id') ? 'bizOrderId' : ''
      ];
      var values = [el.value, el.getAttribute('value'), el.getAttribute('data-out-trade-no'), el.getAttribute('data-biz-order-id')];
      for (var n = 0; n < names.length; n++) {
        for (var v = 0; v < values.length; v++) add(names[n], values[v], 'dom-attribute');
      }
    }
  } catch (_) {}
  try {
    var html = document.documentElement ? document.documentElement.innerHTML : '';
    var patterns = [
      { field: 'b2c_orid', re: /b2c_orid(?:%3D|[\\s"'=:])+([0-9]{15,30})/gi },
      { field: 'bizOrderId', re: /bizOrderId(?:%3D|[\\s"'=:])+([0-9]{15,30})/gi },
      { field: 'biz_order_id', re: /biz_order_id(?:%3D|[\\s"'=:])+([0-9]{15,30})/gi },
      { field: 'out_trade_no', re: /out_trade_no(?:%3D|[\\s"'=:])+([0-9]{15,30})/gi },
      { field: 'outTradeNo', re: /outTradeNo(?:%3D|[\\s"'=:])+([0-9]{15,30})/gi }
    ];
    for (var p = 0; p < patterns.length; p++) {
      var match;
      while ((match = patterns[p].re.exec(html)) && candidates.length < 20) {
        add(patterns[p].field, match[1], 'html');
      }
    }
  } catch (_) {}
  return { url: location.href, candidates: candidates };
})()
`

function buildBatchPaymentManualBindingNoticeScript(purchaseNo) {
  const safePurchaseNo = JSON.stringify(String(purchaseNo || ''))
  return `
(function() {
  var noticeId = ${JSON.stringify(BATCH_PAYMENT_NOTICE_ID)};
  if (document.getElementById(noticeId)) return 'already-visible';
  if (!document.body) return 'body-not-ready';
  var oldProduct = document.getElementById('jd-product-overlay');
  if (oldProduct) oldProduct.remove();
  var oldRefresh = document.getElementById('__dxe_purchase_refresh_row__');
  if (oldRefresh) oldRefresh.remove();

  var mask = document.createElement('div');
  mask.id = noticeId;
  mask.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32);font-family:"Microsoft YaHei",Arial,sans-serif;';
  var card = document.createElement('div');
  card.style.cssText = 'width:430px;max-width:calc(100vw - 48px);box-sizing:border-box;padding:24px;border-radius:10px;background:#fff;box-shadow:0 12px 38px rgba(0,0,0,.24);color:#303133;';
  var title = document.createElement('div');
  title.textContent = '重要提醒';
  title.style.cssText = 'font-size:18px;font-weight:600;margin-bottom:14px;';
  var text = document.createElement('div');
  text.textContent = '该商品使用淘宝合并支付，暂未自动取得淘宝订单号。您可以继续付款；付款成功后请点击页面上的“查看订单”，复制淘宝订单号，然后回到店小二采购订单手动绑定。';
  text.style.cssText = 'font-size:14px;line-height:1.8;color:#606266;';
  var number = document.createElement('div');
  number.textContent = '采购单：' + ${safePurchaseNo};
  number.style.cssText = 'margin-top:12px;padding:9px 12px;border-radius:6px;background:#f5f7fa;color:#409eff;font-size:13px;';
  var actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;margin-top:20px;';
  var ok = document.createElement('button');
  ok.type = 'button';
  ok.textContent = '我知道了';
  ok.style.cssText = 'border:0;border-radius:6px;padding:9px 22px;background:#409eff;color:#fff;font-size:14px;cursor:pointer;';
  ok.addEventListener('click', function() { if (mask.parentNode) mask.parentNode.removeChild(mask); });
  actions.appendChild(ok);
  card.appendChild(title);
  card.appendChild(text);
  card.appendChild(number);
  card.appendChild(actions);
  mask.appendChild(card);
  document.body.appendChild(mask);
  ok.focus();
  return 'shown';
})()
`
}

const REMOVE_BATCH_PAYMENT_NOTICE = `
(function() {
  var notice = document.getElementById(${JSON.stringify(BATCH_PAYMENT_NOTICE_ID)});
  if (notice) notice.remove();
  return !!notice;
})()
`

module.exports = {
  EXTRACT_ALIPAY_TAOBAO_ORDER_CANDIDATES,
  REMOVE_BATCH_PAYMENT_NOTICE,
  buildBatchPaymentManualBindingNoticeScript,
  extractTrustedTaobaoOrderNoFromUrl,
  isTaobaoBatchPaymentUrl,
  selectSingleTaobaoOrderCandidate
}
