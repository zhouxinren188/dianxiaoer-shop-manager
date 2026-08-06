'use strict'

const INTERNAL_SKU_HASH_PREFIX = '#dxeSku='

function cleanString(value, maxLength = 100) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function normalizeTaobaoSkuSelection(value) {
  const source = value && typeof value === 'object' ? value : {}
  const seen = new Set()
  const options = []

  for (const item of Array.isArray(source.options) ? source.options : []) {
    if (!item || typeof item !== 'object') continue
    const option = {
      text: cleanString(item.text, 100),
      valueId: cleanString(item.valueId, 120),
      group: cleanString(item.group, 80)
    }
    if (!option.text && !option.valueId) continue
    const key = `${option.valueId}\u0000${option.text}`
    if (seen.has(key)) continue
    seen.add(key)
    options.push(option)
    if (options.length >= 12) break
  }

  return {
    v: 1,
    skuId: cleanString(source.skuId, 120),
    options
  }
}

function encodeTaobaoSkuSourceUrl(rawUrl, selection) {
  const normalized = normalizeTaobaoSkuSelection(selection)
  if (!normalized.skuId && normalized.options.length === 0) return String(rawUrl || '')
  try {
    const parsed = new URL(String(rawUrl || ''))
    parsed.hash = ''
    return parsed.toString() + INTERNAL_SKU_HASH_PREFIX + encodeURIComponent(JSON.stringify(normalized))
  } catch (_) {
    return String(rawUrl || '')
  }
}

function decodeTaobaoSkuSourceUrl(rawUrl) {
  const originalUrl = String(rawUrl || '')
  try {
    const parsed = new URL(originalUrl)
    if (!parsed.hash.startsWith(INTERNAL_SKU_HASH_PREFIX)) {
      return { url: originalUrl, selection: null }
    }
    const encoded = parsed.hash.slice(INTERNAL_SKU_HASH_PREFIX.length)
    parsed.hash = ''
    const selection = normalizeTaobaoSkuSelection(JSON.parse(decodeURIComponent(encoded)))
    return {
      url: parsed.toString(),
      selection: selection.skuId || selection.options.length > 0 ? selection : null
    }
  } catch (_) {
    return { url: originalUrl, selection: null }
  }
}

function addTaobaoSkuIdToUrl(rawUrl, selection) {
  const normalized = normalizeTaobaoSkuSelection(selection)
  if (!normalized.skuId) return String(rawUrl || '')
  try {
    const parsed = new URL(String(rawUrl || ''))
    const host = parsed.hostname.toLowerCase()
    if (!host.endsWith('taobao.com') && !host.endsWith('tmall.com') && !host.endsWith('tmall.hk')) {
      return String(rawUrl || '')
    }
    parsed.searchParams.set('skuId', normalized.skuId)
    return parsed.toString()
  } catch (_) {
    return String(rawUrl || '')
  }
}

function buildTaobaoSelectedSkuExtractionScript() {
  return `
(function() {
  function clean(value, max) {
    return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim().slice(0, max || 100);
  }
  function visible(element) {
    if (!element || !element.isConnected) return false;
    var rect = element.getBoundingClientRect();
    var style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }
  function isChoiceLike(element) {
    if (!element || element === document.body) return false;
    var cls = String(element.className || '');
    var role = String(element.getAttribute && element.getAttribute('role') || '');
    return /(?:valueItem|skuValue|skuItemValue|propValue|optionItem)/i.test(cls) ||
      role === 'radio' || role === 'option' ||
      element.matches('.J_TSaleProp li,.tb-sku li,.tm-sale-prop li,[data-value],[data-prop-value],[data-property-value]');
  }
  function choiceRoot(element) {
    var current = element;
    for (var depth = 0; current && depth < 4; depth++, current = current.parentElement) {
      if (isChoiceLike(current)) return current;
    }
    return element;
  }
  function readAttribute(element, names) {
    var current = element;
    for (var depth = 0; current && depth < 3; depth++, current = current.parentElement) {
      for (var i = 0; i < names.length; i++) {
        var value = current.getAttribute && current.getAttribute(names[i]);
        if (value) return clean(value, 120);
      }
    }
    return '';
  }
  function choiceText(element) {
    var values = [
      element.getAttribute && element.getAttribute('aria-label'),
      element.getAttribute && element.getAttribute('title'),
      element.getAttribute && element.getAttribute('data-name'),
      element.getAttribute && element.getAttribute('data-value-name')
    ];
    var image = element.querySelector && element.querySelector('img[alt],img[title]');
    if (image) values.push(image.getAttribute('alt'), image.getAttribute('title'));
    values.push(element.innerText, element.textContent);
    for (var i = 0; i < values.length; i++) {
      var text = clean(values[i], 100).replace(/^(?:已选择|已选|选择)[:：\\s]*/, '');
      if (text && text.length <= 100) return text;
    }
    return '';
  }
  function groupText(element) {
    var group = element.closest && element.closest('[class*="skuItem--"],[class*="SkuItem--"],.tb-prop,.tm-sale-prop');
    if (!group) return '';
    var label = group.querySelector('[class*="skuItemName"],[class*="SkuItemName"],.tb-property-type,.tb-metatit');
    return label ? clean(label.textContent, 80).replace(/[：:]$/, '') : '';
  }

  var selectedSelectors = [
    '[aria-checked="true"]', '[aria-selected="true"]', '.tb-selected',
    '[class*="valueItem"][class*="selected"]', '[class*="valueItem"][class*="Selected"]',
    '[class*="ValueItem"][class*="selected"]', '[class*="ValueItem"][class*="Selected"]',
    '[class*="skuItem"][class*="selected"]', '[class*="skuItem"][class*="Selected"]',
    '[class*="SkuItem"][class*="selected"]', '[class*="SkuItem"][class*="Selected"]',
    '[class*="valueItem"][class*="active"]', '[class*="ValueItem"][class*="Active"]',
    '.J_TSaleProp li.tb-selected', '.tm-sale-prop li.tb-selected'
  ];
  var rawSelected = Array.from(document.querySelectorAll(selectedSelectors.join(',')));
  var roots = [];
  rawSelected.forEach(function(element) {
    var root = choiceRoot(element);
    if (visible(root) && !roots.includes(root)) roots.push(root);
  });

  var options = [];
  var seen = {};
  roots.forEach(function(element) {
    var text = choiceText(element);
    var valueId = readAttribute(element, ['data-value','data-id','data-sku-id','data-prop-value','data-property-value','data-value-id']);
    if (!text && !valueId) return;
    var key = valueId + '\\u0000' + text;
    if (seen[key]) return;
    seen[key] = true;
    options.push({ text: text, valueId: valueId, group: groupText(element) });
  });

  var skuId = '';
  try {
    var pageUrl = new URL(location.href);
    skuId = clean(pageUrl.searchParams.get('skuId') || pageUrl.searchParams.get('sku_id'), 120);
  } catch (_) {}
  if (!skuId) {
    for (var r = 0; r < roots.length; r++) {
      skuId = readAttribute(roots[r], ['data-sku-id','data-skuid']);
      if (skuId) break;
    }
  }

  function parsePrice(text) {
    var normalized = clean(text, 120).replace(/,/g, '');
    var matches = normalized.match(/\\d+(?:\\.\\d{1,2})?/g) || [];
    for (var i = 0; i < matches.length; i++) {
      var value = Number(matches[i]);
      if (Number.isFinite(value) && value > 0 && value < 100000000) return value;
    }
    return null;
  }
  var priceSelectors = [
    '[class*="Price--"] [class*="priceText--"]',
    '[class*="priceWrap--"] [class*="priceText--"]',
    '[class*="priceText--"]', '[class*="PriceText--"]',
    '[class*="priceText"]', '[class*="PriceText"]',
    '#J_PromoPrice .tm-price', '.tm-promo-price .tm-price',
    '.tm-price', '.tb-rmb-num'
  ];
  var bestPrice = null;
  var bestScore = -Infinity;
  priceSelectors.forEach(function(selector, selectorIndex) {
    Array.from(document.querySelectorAll(selector)).forEach(function(element) {
      if (!visible(element) || element.closest('#__dxe_sales_product_overlay__')) return;
      var cls = String(element.className || '') + ' ' + String(element.parentElement && element.parentElement.className || '');
      var style = getComputedStyle(element);
      if (/line-through/.test(style.textDecorationLine || '') || /(?:origin|original|market|delete|delPrice|linePrice)/i.test(cls)) return;
      var text = clean(element.textContent, 120);
      var value = parsePrice(text);
      if (value == null) return;
      var rect = element.getBoundingClientRect();
      var score = (priceSelectors.length - selectorIndex) * 20 + Math.min(parseFloat(style.fontSize || '0'), 40);
      if (/[¥￥]/.test(text)) score += 20;
      if (rect.top > 50 && rect.top < 800) score += 15;
      if (rect.left > window.innerWidth * 0.25) score += 10;
      if (score > bestScore) { bestScore = score; bestPrice = value; }
    });
  });

  return { skuId: skuId, options: options.slice(0, 12), price: bestPrice };
})()
`
}

function buildTaobaoSkuAutoSelectScript(selection) {
  const normalized = normalizeTaobaoSkuSelection(selection)
  if (!normalized.skuId && normalized.options.length === 0) return ''

  return `
(function() {
  var target = ${JSON.stringify(normalized)};
  var signature = ${JSON.stringify(JSON.stringify(normalized))};
  var host = String(location.hostname || '').toLowerCase();
  if (!/(?:^|\\.)(?:taobao\\.com|tmall\\.com|tmall\\.hk)$/.test(host)) return '[DXE_SKU_AUTO] skipped-host';
  if (!/(?:item\\.htm|detail|item\\/)/i.test(location.href)) return '[DXE_SKU_AUTO] skipped-page';

  function clean(value, max) {
    return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim().slice(0, max || 100);
  }
  function visible(element) {
    if (!element || !element.isConnected) return false;
    var rect = element.getBoundingClientRect();
    var style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }
  function valueId(element) {
    var names = ['data-value','data-id','data-sku-id','data-prop-value','data-property-value','data-value-id'];
    for (var i = 0; i < names.length; i++) {
      var value = element.getAttribute && element.getAttribute(names[i]);
      if (value) return clean(value, 120);
    }
    return '';
  }
  function optionText(element) {
    var values = [
      element.getAttribute && element.getAttribute('aria-label'),
      element.getAttribute && element.getAttribute('title'),
      element.getAttribute && element.getAttribute('data-name'),
      element.getAttribute && element.getAttribute('data-value-name')
    ];
    var image = element.querySelector && element.querySelector('img[alt],img[title]');
    if (image) values.push(image.getAttribute('alt'), image.getAttribute('title'));
    values.push(element.innerText, element.textContent);
    for (var i = 0; i < values.length; i++) {
      var text = clean(values[i], 100).replace(/^(?:已选择|已选|选择)[:：\\s]*/, '');
      if (text) return text;
    }
    return '';
  }
  function selected(element) {
    var cls = String(element.className || '');
    return element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-selected') === 'true' ||
      /(?:^|[-_\\s])(?:selected|checked|active)(?:$|[-_\\s])/i.test(cls) ||
      /(?:(?:Item|Value|Option)(?:Selected|Checked|Active)|tb-selected)/i.test(cls);
  }
  function matches(saved, element) {
    var savedValue = clean(saved.valueId, 120);
    var currentValue = valueId(element);
    if (savedValue && currentValue && savedValue === currentValue) return true;
    var savedText = clean(saved.text, 100);
    var currentText = optionText(element);
    if (!savedText || !currentText) return false;
    return savedText === currentText ||
      (savedText.length >= 2 && currentText.length <= savedText.length + 12 && currentText.indexOf(savedText) >= 0) ||
      (currentText.length >= 2 && savedText.length <= currentText.length + 12 && savedText.indexOf(currentText) >= 0);
  }

  var choiceSelector = [
    '[class*="valueItem--"]', '[class*="ValueItem--"]',
    '[class*="skuValue--"]', '[class*="SkuValue--"]',
    '[class*="skuItemValue"]', '[class*="SkuItemValue"]',
    '.J_TSaleProp li', '.tb-sku li', '.tm-sale-prop li',
    '[role="radio"]', '[role="option"]',
    '[data-value]', '[data-prop-value]', '[data-property-value]'
  ].join(',');
  function choices() {
    return Array.from(document.querySelectorAll(choiceSelector)).filter(function(element) {
      return visible(element) && !element.closest('#__dxe_sales_product_overlay__') &&
        !element.matches('[disabled],[aria-disabled="true"]');
    });
  }
  function clickChoice(element) {
    try { element.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
    try { element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    try { element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })); } catch (_) {}
    element.click();
  }

  if (window.__dxeSkuAutoSelectDone === signature) return '[DXE_SKU_AUTO] already-completed';
  if (window.__dxeSkuAutoSelectRunning === signature) return '[DXE_SKU_AUTO] already-running';

  var currentSkuId = '';
  try {
    var currentUrl = new URL(location.href);
    currentSkuId = clean(currentUrl.searchParams.get('skuId') || currentUrl.searchParams.get('sku_id'), 120);
  } catch (_) {}
  if (target.skuId && currentSkuId === target.skuId) {
    window.__dxeSkuAutoSelectDone = signature;
    console.info('[DXE_SKU_AUTO] success by skuId=' + target.skuId);
    return '[DXE_SKU_AUTO] matched-skuId=' + target.skuId;
  }

  if (window.__dxeSkuAutoSelectTimer) clearTimeout(window.__dxeSkuAutoSelectTimer);
  window.__dxeSkuAutoSelectSignature = signature;
  window.__dxeSkuAutoSelectRunning = signature;
  window.__dxeSkuAutoSelectClicked = {};
  var attempt = 0;
  function run() {
    if (window.__dxeSkuAutoSelectSignature !== signature) return;
    attempt++;
    var allChoices = choices();
    var completed = 0;
    var clicked = false;
    for (var i = 0; i < target.options.length; i++) {
      var saved = target.options[i];
      var already = allChoices.find(function(element) { return selected(element) && matches(saved, element); });
      if (already || window.__dxeSkuAutoSelectClicked[i]) { completed++; continue; }
      var candidate = allChoices.find(function(element) { return matches(saved, element); });
      if (candidate) {
        // 每个规格最多点击一次。淘宝点击规格会触发页内导航，重复点击会造成规格来回切换。
        window.__dxeSkuAutoSelectClicked[i] = true;
        clickChoice(candidate);
        clicked = true;
        console.info('[DXE_SKU_AUTO] clicked option ' + (i + 1) + '/' + target.options.length);
        break;
      }
    }
    if (target.options.length > 0 && completed === target.options.length) {
      window.__dxeSkuAutoSelectTimer = null;
      window.__dxeSkuAutoSelectRunning = null;
      window.__dxeSkuAutoSelectDone = signature;
      console.info('[DXE_SKU_AUTO] success options=' + completed + ', skuId=' + (target.skuId || ''));
      return;
    }
    if (target.options.length === 0 && target.skuId) {
      window.__dxeSkuAutoSelectTimer = null;
      window.__dxeSkuAutoSelectRunning = null;
      window.__dxeSkuAutoSelectDone = signature;
      console.info('[DXE_SKU_AUTO] skuId applied by URL: ' + target.skuId);
      return;
    }
    if (attempt >= 50) {
      window.__dxeSkuAutoSelectTimer = null;
      window.__dxeSkuAutoSelectRunning = null;
      console.warn('[DXE_SKU_AUTO] timeout selected=' + completed + '/' + target.options.length + ', clicked=' + clicked);
      return;
    }
    window.__dxeSkuAutoSelectTimer = setTimeout(run, clicked ? 450 : 600);
  }
  window.__dxeSkuAutoSelectTimer = setTimeout(run, 250);
  return '[DXE_SKU_AUTO] scheduled options=' + target.options.length + ', skuId=' + (target.skuId || '');
})()
`
}

module.exports = {
  INTERNAL_SKU_HASH_PREFIX,
  normalizeTaobaoSkuSelection,
  encodeTaobaoSkuSourceUrl,
  decodeTaobaoSkuSourceUrl,
  addTaobaoSkuIdToUrl,
  buildTaobaoSelectedSkuExtractionScript,
  buildTaobaoSkuAutoSelectScript
}
