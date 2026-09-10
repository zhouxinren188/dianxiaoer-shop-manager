'use strict'

// 采购页与“搜同款”页都展示同一份销售订单商品信息。
// 这里输出可直接注入 BrowserWindow 页面的静态函数源码，避免两个窗口各维护一套卡片。
// 注意：主进程正式包会编译为 bytenode 字节码，运行时 Function#toString() 只能得到
// "[native code]"，因此注入页面的源码必须直接保存为字符串，不能在运行时序列化函数。
const SALES_PRODUCT_CARD_RENDERER_SOURCE = String.raw`(function renderSalesProductCard(options) {
  var info = options && options.info ? options.info : {}
  var overlay = options && options.overlay
  var body = options && options.body
  var imageTransformOrigin = options && options.imageTransformOrigin
    ? options.imageTransformOrigin
    : 'left center'

  if (!overlay || !body) return

  function appendText(parent, tag, text, css) {
    var element = document.createElement(tag)
    element.textContent = text
    if (css) element.style.cssText = css
    parent.appendChild(element)
    return element
  }

  function normalizeSkuSpec(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/(^|\s*\/\s*)(规格|尺码|颜色|型号|款式|尺寸|容量|口味|香型|数量|包装|版本|套餐|净含量)[?:：](?=\S)/g, function(_match, prefix, name) {
        return prefix + name + '：'
      })
  }

  if (info.image) {
    var imageWrap = document.createElement('div')
    imageWrap.style.cssText = 'position:relative;margin-bottom:0;'
    var image = document.createElement('img')
    image.src = info.image
    image.alt = ''
    image.title = '鼠标悬停查看大图'
    image.style.cssText = 'position:relative;z-index:1;display:block;width:100%;aspect-ratio:1/1;border-radius:6px;background:#fff;object-fit:contain;cursor:zoom-in;transform-origin:' + imageTransformOrigin + ';transition:transform .16s ease,box-shadow .16s ease;will-change:transform;'

    function showImagePreview() {
      overlay.style.overflow = 'visible'
      body.style.overflow = 'visible'
      imageWrap.style.zIndex = '2147483647'
      image.style.zIndex = '2147483647'
      image.style.transform = 'scale(2.45)'
      image.style.boxShadow = '0 10px 32px rgba(0,0,0,.32)'
    }

    function hideImagePreview() {
      image.style.transform = 'scale(1)'
      image.style.boxShadow = 'none'
      image.style.zIndex = '1'
      imageWrap.style.zIndex = 'auto'
      body.style.overflow = ''
      body.style.overflowY = 'auto'
      overlay.style.overflow = 'hidden'
    }

    image.addEventListener('mouseenter', showImagePreview)
    image.addEventListener('mouseleave', hideImagePreview)
    image.onerror = function() {
      hideImagePreview()
      imageWrap.style.display = 'none'
    }
    imageWrap.appendChild(image)
    body.appendChild(imageWrap)
  }

  appendText(
    body,
    'div',
    info.goodsName || '未获取到订单商品标题',
    'margin-top:10px;color:#303133;font-size:13px;font-weight:600;line-height:1.5;white-space:normal;word-break:break-all;'
  )

  var skuSpec = normalizeSkuSpec(info.skuSpec)
  if (skuSpec) {
    appendText(
      body,
      'div',
      '销售规格：' + skuSpec,
      'margin-top:7px;padding:6px 8px;border:1px solid #ffd7ba;border-radius:5px;background:#fff7e8;color:#fa541c;font-size:12px;font-weight:700;line-height:1.5;word-break:break-all;'
    )
  }

  if (info.sku) {
    var skuText = String(info.sku)
    if (!/^\s*sku\s*[:：]/i.test(skuText)) skuText = 'SKU: ' + skuText
    appendText(body, 'div', skuText, 'margin-top:5px;color:#909399;word-break:break-all;')
  }

  var priceRow = document.createElement('div')
  priceRow.style.cssText = 'display:flex;justify-content:space-between;gap:8px;margin-top:9px;'
  appendText(priceRow, 'span', '数量: ' + Number(info.quantity || 0), 'color:#606266;')
  appendText(priceRow, 'span', '单价: ¥' + Number(info.price || 0).toFixed(2), 'color:#e6a23c;font-weight:600;')
  body.appendChild(priceRow)
  appendText(body, 'div', '采购价: ¥' + Number(info.purchasePrice || 0).toFixed(2), 'margin-top:5px;color:#67c23a;')

  if (info.shippingName || info.shippingPhone || info.shippingAddress) {
    var contact = document.createElement('div')
    contact.style.cssText = 'margin-top:9px;padding-top:9px;border-top:1px solid #f0f0f0;'
    var contactRow = document.createElement('div')
    contactRow.style.cssText = 'display:flex;justify-content:space-between;gap:8px;color:#606266;'
    if (info.shippingName) appendText(contactRow, 'span', info.shippingName, 'min-width:0;word-break:break-all;')
    if (info.shippingPhone) appendText(contactRow, 'span', info.shippingPhone, 'flex:0 0 auto;')
    contact.appendChild(contactRow)
    if (info.shippingAddress) {
      appendText(contact, 'div', info.shippingAddress, 'margin-top:6px;color:#909399;font-size:11px;line-height:1.45;word-break:break-all;')
    }
    body.appendChild(contact)
  }
})`

module.exports = {
  SALES_PRODUCT_CARD_RENDERER_SOURCE
}
