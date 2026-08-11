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

  const normalized = {
    v: 1,
    skuId: cleanString(source.skuId, 120),
    options
  }
  const shipFrom = cleanString(source.shipFrom, 80)
  if (shipFrom) normalized.shipFrom = shipFrom
  return normalized
}

function encodeTaobaoSkuSourceUrl(rawUrl, selection) {
  const normalized = normalizeTaobaoSkuSelection(selection)
  if (!normalized.skuId && normalized.options.length === 0 && !normalized.shipFrom) return String(rawUrl || '')
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
      selection: selection.skuId || selection.options.length > 0 || selection.shipFrom ? selection : null
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

  function normalizeShopName(value) {
    var text = clean(value, 100)
      .replace(/^(?:店铺名称|店铺|商家)[:：\\s]*/, '')
      .replace(/[›>]+$/, '')
      .trim();
    // 新版商品页的父容器会把“店名 + 评分 + 发货时效”拼成一段文本。
    // 评分信息不是店铺名称；遇到这些稳定指标时只保留前面的真实店名。
    var metricIndex = text.search(/(?:累计\\s*)?\\d+(?:\\.\\d+)?\\s*(?:88VIP)?好评率|(?:88VIP)?好评率|平均\\s*\\d+\\s*(?:小时|天|秒)|客服(?:满意度|平均)|平均\\s*\\d+\\s*小时退款/);
    if (metricIndex >= 0) text = text.slice(0, metricIndex).trim();
    if (!text || text.length < 2 || text.length > 60) return '';
    if (/^(?:淘宝|淘宝网|淘宝网首页|天猫|天猫首页|我的淘宝|购物车|收藏夹|免费开店|客服|联系客服|进店|进入店铺|店铺|商家)$/.test(text)) return '';
    if (/[¥￥]/.test(text) || /(?:已售|销量|评价|优惠前|优惠后)/.test(text)) return '';
    return text;
  }
  var shopCandidates = [];
  function registerShopCandidate(name, score, source) {
    var normalized = normalizeShopName(name);
    if (!normalized) return;
    if (/(?:旗舰店|专卖店|专营店|企业店|官方店|工厂店|品牌店|淘宝店|店)$/.test(normalized)) score += 45;
    var existing = shopCandidates.find(function(item) { return item.name === normalized; });
    if (existing) {
      if (score > existing.score) {
        existing.score = score;
        existing.source = source;
      }
      return;
    }
    shopCandidates.push({ name: normalized, score: score, source: source });
  }
  // 2026版详情页真实店名是 shopName 叶子span，title与文本都只包含店名。
  // 必须先于同名父容器读取，否则父容器会混入评分和发货说明。
  var preciseShopSelectors = [
    'span[class*="shopName"][title]', 'span[class*="ShopName"][title]',
    '[class*="shopNameWrap"] > span[class*="shopName"]',
    '[class*="ShopNameWrap"] > span[class*="ShopName"]'
  ];
  preciseShopSelectors.forEach(function(selector, selectorIndex) {
    Array.from(document.querySelectorAll(selector)).slice(0, 20).forEach(function(element) {
      if (!visible(element) || element.closest('#__dxe_sales_product_overlay__')) return;
      var title = element.getAttribute && element.getAttribute('title');
      registerShopCandidate(title || element.textContent || element.innerText, 260 - selectorIndex * 3, 'shop-name-leaf');
    });
  });
  var shopSelectors = [
    '[class*="shopName"]', '[class*="ShopName"]',
    '[class*="storeName"]', '[class*="StoreName"]',
    '[class*="sellerName"]', '[class*="SellerName"]',
    '.shop-name', '.slogo-shopname', '#J_ShopInfo .shop-name', '#shopExtra .shop-name'
  ];
  shopSelectors.forEach(function(selector, selectorIndex) {
    Array.from(document.querySelectorAll(selector)).slice(0, 80).forEach(function(element) {
      if (!visible(element) || element.closest('#__dxe_sales_product_overlay__')) return;
      var rect = element.getBoundingClientRect();
      var score = 150 - selectorIndex * 2;
      if (rect.top >= 0 && rect.top < 380) score += 25;
      registerShopCandidate(element.textContent || element.innerText, score, selector);
    });
  });
  Array.from(document.querySelectorAll('a[href]')).slice(0, 1800).forEach(function(element) {
    if (!visible(element) || element.closest('#__dxe_sales_product_overlay__')) return;
    var rawHref = element.getAttribute('href') || '';
    var shopLink = false;
    try {
      var hrefUrl = new URL(rawHref, location.href);
      var hrefHost = hrefUrl.hostname.toLowerCase();
      var hrefPath = hrefUrl.pathname.toLowerCase();
      shopLink = /(?:^|\\.)(?:shop|store)\\.(?:taobao|tmall)\\.com$/.test(hrefHost) ||
        /\\/(?:shop|store)(?:\\/|_|\\.|$)|view_shop/.test(hrefPath) ||
        ((hrefHost.endsWith('.tmall.com') || hrefHost.endsWith('.tmall.hk')) && !/(?:item\\.htm|detail|item\\/)/.test(hrefPath));
    } catch (_) {}
    if (!shopLink) return;
    var rect = element.getBoundingClientRect();
    var score = 120;
    if (rect.top >= 0 && rect.top < 380) score += 30;
    registerShopCandidate(element.textContent || element.innerText || element.getAttribute('title'), score, 'shop-link');
  });
  function collectStateShopNames(root, depth, seen) {
    if (!root || typeof root !== 'object' || depth > 7 || seen.has(root)) return;
    seen.add(root);
    var nameKeys = ['shopName', 'shopTitle', 'storeName', 'sellerName', 'sellerNick'];
    for (var nameIndex = 0; nameIndex < nameKeys.length; nameIndex++) {
      var nameKey = nameKeys[nameIndex];
      if (typeof root[nameKey] === 'string') {
        registerShopCandidate(root[nameKey], 135 - nameIndex * 6 - depth * 2, 'state.' + nameKey);
      }
    }
    if (root.shopInfo && typeof root.shopInfo === 'object' && typeof root.shopInfo.title === 'string') {
      registerShopCandidate(root.shopInfo.title, 145 - depth * 2, 'state.shopInfo.title');
    }
    if (root.sellerInfo && typeof root.sellerInfo === 'object' && typeof root.sellerInfo.shopTitle === 'string') {
      registerShopCandidate(root.sellerInfo.shopTitle, 145 - depth * 2, 'state.sellerInfo.shopTitle');
    }
    var containerKeys = ['data','props','pageProps','pageData','detail','item','shop','shopInfo','seller','sellerInfo','componentsVO','global','model'];
    for (var containerIndex = 0; containerIndex < containerKeys.length; containerIndex++) {
      try { collectStateShopNames(root[containerKeys[containerIndex]], depth + 1, seen); } catch (_) {}
    }
  }
  var shopStateRoots = [
    window.__INITIAL_STATE__, window.__INIT_DATA__, window.__INITIAL_DATA__,
    window.__GLOBAL_DATA__, window.__NEXT_DATA__, window.__ICE_DATA__, window.g_config
  ];
  for (var shopStateIndex = 0; shopStateIndex < shopStateRoots.length; shopStateIndex++) {
    try { collectStateShopNames(shopStateRoots[shopStateIndex], 0, new WeakSet()); } catch (_) {}
  }
  shopCandidates.sort(function(a, b) { return b.score - a.score; });
  var shopName = shopCandidates.length > 0 ? shopCandidates[0].name : '';

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

  function parseShipFrom(text) {
    var normalized = clean(text, 160);
    if (normalized.indexOf('至') < 0) return '';
    var left = normalized.split('至')[0].trim();
    var provinceMatch = left.match(/(内蒙古|黑龙江|北京|天津|上海|重庆|河北|山西|辽宁|吉林|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆|台湾|香港|澳门)(?:省|市|自治区|壮族自治区|回族自治区|维吾尔自治区)?\\s*([\\u4e00-\\u9fff]{1,8})?$/);
    if (!provinceMatch) return '';
    return clean((provinceMatch[1] || '') + (provinceMatch[2] || ''), 80).replace(/\\s+/g, '');
  }
  var shippingCandidates = [];
  var shippingNodes = document.querySelectorAll('span,div,p,li');
  for (var shippingIndex = 0; shippingIndex < shippingNodes.length && shippingIndex < 7000; shippingIndex++) {
    var shippingElement = shippingNodes[shippingIndex];
    if (!visible(shippingElement)) continue;
    var shippingText = clean(shippingElement.textContent, 160);
    if (!shippingText || shippingText.indexOf('至') < 0 || shippingText.length > 150) continue;
    var origin = parseShipFrom(shippingText);
    if (!origin) continue;
    var shippingRect = shippingElement.getBoundingClientRect();
    var shippingScore = 220 - shippingText.length;
    if (/快递|发货|运费|包邮/.test(shippingText)) shippingScore += 35;
    if (shippingRect.left > window.innerWidth * 0.35) shippingScore += 20;
    if (shippingRect.top > 80 && shippingRect.top < 850) shippingScore += 15;
    shippingCandidates.push({
      shipFrom: origin,
      text: shippingText.slice(0, 100),
      score: shippingScore,
      top: Math.round(shippingRect.top),
      left: Math.round(shippingRect.left)
    });
  }
  shippingCandidates.sort(function(a, b) { return b.score - a.score; });
  var shipFrom = shippingCandidates.length > 0 ? shippingCandidates[0].shipFrom : '';

  function parsePrice(text) {
    var normalized = clean(text, 120).replace(/,/g, '');
    var matches = normalized.match(/\\d+(?:\\.\\d{1,2})?/g) || [];
    for (var i = 0; i < matches.length; i++) {
      var value = Number(matches[i]);
      if (Number.isFinite(value) && value > 0 && value < 100000000) return value;
    }
    return null;
  }
  var promotionPriceLabelPattern = /(?:秒杀价|活动价|券后价|到手价|店铺优惠后|平台优惠后|平台加补后|会员价|促销价|特惠价|折后价|优惠价)/;
  var currentPriceLabelPattern = /(?:秒杀价|活动价|券后价|到手价|店铺优惠后|平台优惠后|平台加补后|会员价|促销价|特惠价|折后价|优惠价|现价)/;
  var originalPriceMarkerPattern = /优惠前|原价|市场价|日常价/;
  function currentPricePart(text) {
    var normalized = clean(text, 180).replace(/,/g, '');
    var originalMarkerIndex = normalized.search(originalPriceMarkerPattern);
    return originalMarkerIndex >= 0 ? normalized.slice(0, originalMarkerIndex) : normalized;
  }
  function parseCurrentPrice(text) {
    var currentText = currentPricePart(text);
    if (!currentText) return null;
    var labeled = currentText.match(/(?:秒杀价|活动价|券后价|到手价|店铺优惠后|平台优惠后|平台加补后|会员价|促销价|特惠价|折后价|优惠价|现价)\\s*[¥￥]?\\s*(\\d+(?:\\.\\d{1,2})?)/);
    if (labeled) return Number(labeled[1]);
    // 已出现优惠价标签却没有紧随其后的数值时，不能退化为读取标题中的“9包/15包”等数字。
    if (currentPriceLabelPattern.test(currentText)) return null;
    var currency = currentText.match(/[¥￥]\\s*(\\d+(?:\\.\\d{1,2})?)/);
    if (currency) return Number(currency[1]);
    return parsePrice(currentText);
  }
  // 淘宝新版详情数据通常在 skuCore.sku2info[skuId] 中，优先使用SKU专属价格。
  function priceFromSkuInfo(value, depth) {
    if (value == null || depth > 5) return null;
    if (typeof value === 'string' || typeof value === 'number') return parsePrice(value);
    if (typeof value !== 'object') return null;
    var keys = ['finalPrice','promotionPrice','activityPrice','couponPrice','salePrice','discountPrice','priceText','price'];
    for (var i = 0; i < keys.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, keys[i])) continue;
      var found = priceFromSkuInfo(value[keys[i]], depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  function findSkuPrice(root, depth, visited) {
    if (!root || typeof root !== 'object' || depth > 9 || visited.has(root)) return null;
    visited.add(root);
    var maps = [root.sku2info, root.sku2Info, root.skuMap, root.skuPriceMap];
    for (var i = 0; i < maps.length; i++) {
      var map = maps[i];
      if (!map || typeof map !== 'object') continue;
      var skuInfo = map[skuId];
      if (skuInfo) {
        var directPrice = priceFromSkuInfo(skuInfo, 0);
        if (directPrice != null) return directPrice;
      }
    }
    var containerKeys = ['data','props','pageProps','pageData','detail','item','global','componentsVO','skuCore','skuBase','model'];
    for (var k = 0; k < containerKeys.length; k++) {
      var nestedPrice = findSkuPrice(root[containerKeys[k]], depth + 1, visited);
      if (nestedPrice != null) return nestedPrice;
    }
    return null;
  }
  var skuDataPrice = null;
  if (skuId) {
    var stateRoots = [
      window.__INITIAL_STATE__, window.__INIT_DATA__, window.__INITIAL_DATA__,
      window.__GLOBAL_DATA__, window.__NEXT_DATA__, window.__ICE_DATA__, window.g_config
    ];
    for (var stateIndex = 0; stateIndex < stateRoots.length && skuDataPrice == null; stateIndex++) {
      try { skuDataPrice = findSkuPrice(stateRoots[stateIndex], 0, new WeakSet()); } catch (_) {}
    }
    if (skuDataPrice == null) {
      var scripts = Array.from(document.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__')).slice(0, 80);
      for (var scriptIndex = 0; scriptIndex < scripts.length && skuDataPrice == null; scriptIndex++) {
        var scriptText = String(scripts[scriptIndex].textContent || '').trim();
        if (!scriptText || scriptText.indexOf(skuId) < 0 || !/sku2info|sku2Info|skuCore/.test(scriptText)) continue;
        try { skuDataPrice = findSkuPrice(JSON.parse(scriptText), 0, new WeakSet()); } catch (_) {}
      }
    }
  }
  var promotionPriceMasked = false;
  var promotionVisited = new Set();
  function inspectPromotionElement(promotionElement) {
    if (promotionPriceMasked || !promotionElement || promotionVisited.has(promotionElement)) return;
    promotionVisited.add(promotionElement);
    if (!visible(promotionElement) || promotionElement.closest('#__dxe_sales_product_overlay__')) return;
    var promotionText = clean(promotionElement.textContent, 180);
    if (!currentPriceLabelPattern.test(promotionText)) return;
    // 当前优惠价显示为圆点、或只剩“￥”而原价仍存在时，必须等待淘宝返回真实价格。
    var visiblyMasked = /[•·]{2,}|\\.{3,}/.test(currentPricePart(promotionText));
    if (visiblyMasked || (originalPriceMarkerPattern.test(promotionText) && parseCurrentPrice(promotionText) == null)) {
      promotionPriceMasked = true;
    }
  }
  var promotionNodes = document.querySelectorAll('[class*="Price"],[class*="price"],[class*="Belt"],[class*="belt"]');
  for (var promotionIndex = 0; promotionIndex < promotionNodes.length && promotionIndex < 800; promotionIndex++) {
    inspectPromotionElement(promotionNodes[promotionIndex]);
  }
  // 淘宝部分新版活动组件使用完全哈希化类名，不能再依赖类名中包含 price。
  if (!promotionPriceMasked) {
    var genericPromotionNodes = document.querySelectorAll('span,div,p,strong,em,b');
    for (var genericPromotionIndex = 0; genericPromotionIndex < genericPromotionNodes.length && genericPromotionIndex < 7000; genericPromotionIndex++) {
      var genericPromotionElement = genericPromotionNodes[genericPromotionIndex];
      var genericPromotionText = clean(genericPromotionElement && genericPromotionElement.textContent, 180);
      if (!genericPromotionText || genericPromotionText.length > 160 || !currentPriceLabelPattern.test(genericPromotionText)) continue;
      inspectPromotionElement(genericPromotionElement);
      if (promotionPriceMasked) break;
    }
  }
  var priceSelectors = [
    '#tbpcDetail_SkuPanelBody [class*="beltPrice"] [class*="highlightPrice"]',
    '#tbpcDetail_SkuPanelBody [class*="normalPrice"] [class*="highlightPrice"]',
    '#tbpcDetail_SkuPanelBody [class*="priceWrap"] [class*="highlightPrice"]',
    '[class*="Price--"] [class*="priceText--"]',
    '[class*="priceWrap--"] [class*="priceText--"]',
    '[class*="priceText--"]', '[class*="PriceText--"]',
    '[class*="priceText"]', '[class*="PriceText"]',
    '[class*="highlightPrice"]', '[class*="HighlightPrice"]',
    '[class*="promotionPrice"]', '[class*="PromotionPrice"]',
    '[class*="salePrice"]', '[class*="SalePrice"]',
    '#J_PromoPrice .tm-price', '.tm-promo-price .tm-price',
    '.tm-price', '.tb-rmb-num', '[itemprop="price"]', '[data-price]',
    '[class*="price"]', '[class*="Price"]'
  ];
  var bestPrice = null;
  var bestScore = -Infinity;
  var bestPriceKind = '';
  var bestPriceLabel = '';
  var bestPromotionPrice = null;
  var bestPromotionScore = -Infinity;
  var bestPromotionLabel = '';
  var priceCandidates = [];
  var visitedPriceElements = new Set();
  var skuRect = roots.length > 0 ? roots[0].getBoundingClientRect() : null;
  function findPromotionPriceLabel(element, text) {
      var directMatch = currentPricePart(text).match(promotionPriceLabelPattern);
      if (directMatch) return directMatch[0];
      var current = element;
      for (var depth = 0; current && depth < 5; depth++) {
        if (typeof current.querySelector === 'function') {
          var titleElement = current.querySelector('[class*="title"],[class*="Title"]');
          var titleText = clean(titleElement && titleElement.textContent, 80);
          var titleMatch = titleText.match(promotionPriceLabelPattern);
          if (titleMatch) return titleMatch[0];
        }
        var contextText = clean(current.textContent, 240);
        var contextMatch = contextText.match(promotionPriceLabelPattern);
        if (contextMatch) return contextMatch[0];
        if (current.id === 'tbpcDetail_SkuPanelBody') break;
        current = current.parentElement;
      }
      return '';
  }
  function registerPriceCandidate(element, selector, selectorIndex, fallback) {
      if (!element || visitedPriceElements.has(element)) return;
      visitedPriceElements.add(element);
      if (!visible(element) || element.closest('#__dxe_sales_product_overlay__')) return;
      var cls = String(element.className || '') + ' ' + String(element.parentElement && element.parentElement.className || '');
      var style = getComputedStyle(element);
      if (/line-through/.test(style.textDecorationLine || '') || /(?:origin|original|market|delete|delPrice|linePrice|subPrice)/i.test(cls)) return;
      var text = clean(element.textContent, 180);
      var attributePrice = element.getAttribute('data-price') || element.getAttribute('content') || '';
      var originalMarkerIndex = text.search(originalPriceMarkerPattern);
      var textPrice = parseCurrentPrice(text);
      // 活动区域只剩“优惠前/原价”数字时，不能把划线价当成当前SKU成交价。
      if (originalMarkerIndex >= 0 && textPrice == null) return;
      var value = textPrice != null ? textPrice : parsePrice(attributePrice);
      if (value == null || !Number.isFinite(value) || value <= 0) return;
      var priceLabel = findPromotionPriceLabel(element, text);
      var priceKind = priceLabel ? 'promotion' : 'base';
      var rect = element.getBoundingClientRect();
      var numericParts = currentPricePart(text).match(/\\d+(?:\\.\\d{1,2})?/g) || [];
      if (fallback && (!/[¥￥]/.test(text) && !currentPriceLabelPattern.test(text))) return;
      if (fallback && (text.length > 120 || numericParts.length > 3 || rect.width > 620 || rect.height > 120)) return;
      var isGeneric = fallback || selectorIndex >= priceSelectors.length - 2;
      if (isGeneric && (text.length > 120 || numericParts.length > 3 || rect.height > 120)) return;
      var score = fallback
        ? 80 + Math.min(parseFloat(style.fontSize || '0'), 42) * 2
        : (priceSelectors.length - selectorIndex) * 18 + Math.min(parseFloat(style.fontSize || '0'), 42) * 2;
      if (/priceText|highlightPrice|promotionPrice|salePrice/i.test(cls)) score += 45;
      if (priceKind === 'promotion') score += 75;
      else if (currentPriceLabelPattern.test(text)) score += 55;
      if (/[¥￥]/.test(text)) score += 20;
      if (rect.top > 50 && rect.top < 800) score += 15;
      if (rect.left > window.innerWidth * 0.25) score += 10;
      if (rect.width < 320 && rect.height < 80) score += 15;
      if (skuRect && rect.bottom <= skuRect.top + 100 && rect.top >= skuRect.top - 650) {
        score += Math.max(20, 90 - Math.abs(skuRect.top - rect.bottom) / 8);
        if (Math.abs(rect.left - skuRect.left) < 420) score += 25;
      }
      priceCandidates.push({
        value: value, text: text.slice(0, 60), className: cls.slice(0, 90),
        selector: selector, score: Math.round(score), kind: priceKind, label: priceLabel,
        top: Math.round(rect.top), left: Math.round(rect.left)
      });
      if (score > bestScore) {
        bestScore = score;
        bestPrice = value;
        bestPriceKind = priceKind;
        bestPriceLabel = priceLabel;
      }
      if (priceKind === 'promotion' && score > bestPromotionScore) {
        bestPromotionScore = score;
        bestPromotionPrice = value;
        bestPromotionLabel = priceLabel;
      }
  }
  priceSelectors.forEach(function(selector, selectorIndex) {
    Array.from(document.querySelectorAll(selector)).forEach(function(element) {
      registerPriceCandidate(element, selector, selectorIndex, false);
    });
  });
  if (priceCandidates.length === 0 && !promotionPriceMasked) {
    var genericPriceNodes = document.querySelectorAll('span,div,p,strong,em,b');
    for (var genericPriceIndex = 0; genericPriceIndex < genericPriceNodes.length && genericPriceIndex < 7000; genericPriceIndex++) {
      var genericPriceElement = genericPriceNodes[genericPriceIndex];
      var genericPriceText = clean(genericPriceElement && genericPriceElement.textContent, 180);
      if (!genericPriceText || (!/[¥￥]/.test(genericPriceText) && !currentPriceLabelPattern.test(genericPriceText))) continue;
      registerPriceCandidate(genericPriceElement, 'visible-text-fallback', priceSelectors.length, true);
    }
  }
  priceCandidates.sort(function(a, b) { return b.score - a.score; });

  // 页面明确标注的“平台加补后/店铺优惠后”等价格，比 sku2info 内可能仍是原价的字段更可靠。
  var resolvedPrice = promotionPriceMasked
    ? null
    : (bestPromotionPrice != null ? bestPromotionPrice : (skuDataPrice != null ? skuDataPrice : bestPrice));
  var resolvedPriceSource = promotionPriceMasked
    ? 'promotion-masked'
    : (bestPromotionPrice != null ? 'visible-dom' : (skuDataPrice != null ? 'sku-data' : (bestPrice != null ? 'visible-dom' : '')));
  var resolvedPriceKind = promotionPriceMasked
    ? 'promotion-masked'
    : (bestPromotionPrice != null ? 'promotion' : (skuDataPrice != null ? 'sku-data' : bestPriceKind));
  var resolvedPriceLabel = bestPromotionPrice != null ? bestPromotionLabel : bestPriceLabel;

  return {
    skuId: skuId,
    options: options.slice(0, 12),
    shopName: shopName,
    shopCandidates: shopCandidates.slice(0, 4),
    shipFrom: shipFrom,
    shippingCandidates: shippingCandidates.slice(0, 4),
    price: resolvedPrice,
    priceSource: resolvedPriceSource,
    priceKind: resolvedPriceKind,
    priceLabel: resolvedPriceLabel,
    promotionPriceMasked: promotionPriceMasked,
    priceCandidates: priceCandidates.slice(0, 6)
  };
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
