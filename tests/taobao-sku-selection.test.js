import { describe, expect, it } from 'vitest'
import taobaoSkuSelection from '../src/main/taobao-sku-selection.js'

const {
  normalizeTaobaoSkuSelection,
  encodeTaobaoSkuSourceUrl,
  decodeTaobaoSkuSourceUrl,
  addTaobaoSkuIdToUrl,
  buildTaobaoSelectedSkuExtractionScript,
  buildTaobaoSkuAutoSelectScript
} = taobaoSkuSelection

function runPriceExtraction(priceText, options = {}) {
  const selectedOption = {
    className: 'valueItem--hash selected--hash',
    parentElement: null,
    isConnected: true,
    innerText: '测试规格',
    textContent: '测试规格',
    getBoundingClientRect: () => ({ width: 120, height: 36, top: 520, left: 700, bottom: 556 }),
    getAttribute: () => null,
    querySelector: () => null,
    closest: () => null,
    matches: () => false
  }
  const priceElement = {
    className: options.className || 'x7aQp--hash',
    parentElement: { className: 'm2RtL--hash', parentElement: null },
    isConnected: true,
    textContent: priceText,
    getBoundingClientRect: () => ({ width: 290, height: 62, top: 220, left: 700, bottom: 282 }),
    getAttribute: () => null,
    closest: () => null
  }
  const document = {
    querySelectorAll(selector) {
      if (selector.includes('[aria-checked="true"]')) return [selectedOption]
      if (options.directSelector && selector.includes('[class*="highlightPrice"]')) return [priceElement]
      if (selector === 'span,div,p,strong,em,b') return [priceElement]
      return []
    }
  }
  const script = buildTaobaoSelectedSkuExtractionScript()
  const run = new Function(
    'location', 'window', 'document', 'URL', 'getComputedStyle',
    `return ${script.trim()}`
  )
  return run(
    { href: 'https://item.taobao.com/item.htm?id=1&skuId=sku-1' },
    {
      innerWidth: 1200,
      __INITIAL_STATE__: options.skuDataPrice == null ? undefined : {
        skuCore: { sku2info: { 'sku-1': { price: options.skuDataPrice } } }
      }
    },
    document,
    URL,
    () => ({ display: 'block', visibility: 'visible', fontSize: '28px', textDecorationLine: 'none' })
  )
}

describe('淘宝货源SKU记录与回选', () => {
  const selection = {
    skuId: '589999001',
    shipFrom: '河北邯郸',
    options: [
      { group: '颜色分类', text: '象牙白', valueId: '1627207:28320' },
      { group: '容量', text: '1300ml', valueId: '122216547:10122' }
    ]
  }

  it('把SKU元数据写入内部hash并可无损解析', () => {
    const sourceUrl = encodeTaobaoSkuSourceUrl(
      'https://item.taobao.com/item.htm?id=123&spm=test#old',
      selection
    )
    expect(sourceUrl).toContain('#dxeSku=')

    const decoded = decodeTaobaoSkuSourceUrl(sourceUrl)
    expect(decoded.url).toBe('https://item.taobao.com/item.htm?id=123&spm=test')
    expect(decoded.selection).toEqual({ v: 1, ...selection })
  })

  it('普通链接保持不变，SKU ID可写入淘宝商品链接查询参数', () => {
    const plain = 'https://item.taobao.com/item.htm?id=123'
    expect(decodeTaobaoSkuSourceUrl(plain)).toEqual({ url: plain, selection: null })
    const withSku = addTaobaoSkuIdToUrl(plain, selection)
    expect(new URL(withSku).searchParams.get('skuId')).toBe('589999001')
    expect(addTaobaoSkuIdToUrl('https://example.com/item?id=1', selection)).toBe('https://example.com/item?id=1')
  })

  it('清洗重复和超量规格，避免把异常页面文本写入货源链接', () => {
    const normalized = normalizeTaobaoSkuSelection({
      skuId: '  99  ',
      options: [
        { text: '  红   色  ', valueId: 'red' },
        { text: '红 色', valueId: 'red' },
        null,
        { text: '', valueId: '' }
      ]
    })
    expect(normalized.skuId).toBe('99')
    expect(normalized.options).toEqual([{ text: '红 色', valueId: 'red', group: '' }])
  })

  it('生成可执行的页面提取和自动回选脚本', () => {
    const extractionScript = buildTaobaoSelectedSkuExtractionScript()
    const autoSelectScript = buildTaobaoSkuAutoSelectScript(selection)
    expect(() => new Function(extractionScript)).not.toThrow()
    expect(() => new Function(autoSelectScript)).not.toThrow()
    expect(extractionScript).toContain('priceText--')
    expect(extractionScript).toContain('sku2info')
    expect(extractionScript).toContain('priceCandidates')
    expect(extractionScript).toContain('shippingCandidates')
    expect(extractionScript).toContain('parseShipFrom')
    expect(extractionScript).toContain("split('至')[0].trim()")
    expect(extractionScript).toContain('promotionPriceMasked')
    expect(extractionScript).toContain('优惠前')
    expect(extractionScript).toContain('店铺优惠后')
    expect(extractionScript).toContain('平台加补后')
    expect(extractionScript).toContain('visible-text-fallback')
    expect(extractionScript).toContain('genericPriceNodes')
    expect(extractionScript).toContain('currentPriceLabelPattern')
    expect(extractionScript).toContain('aria-checked="true"')
    expect(autoSelectScript).toContain('[DXE_SKU_AUTO] success')
    expect(autoSelectScript).toContain("element.click()")
  })

  it('价格组件类名完全哈希化时仍能按可见优惠价提取', () => {
    const result = runPriceExtraction('店铺优惠后￥37.60 优惠前￥42.80')
    expect(result.price).toBe(37.6)
    expect(result.priceSource).toBe('visible-dom')
    expect(result.promotionPriceMasked).toBe(false)
    expect(result.priceCandidates[0].selector).toBe('visible-text-fallback')
    expect(result.priceKind).toBe('promotion')
    expect(result.priceLabel).toBe('店铺优惠后')
  })

  it('新版店铺优惠价优先于 sku2info 中仍未更新的优惠前价格', () => {
    const result = runPriceExtraction('店铺优惠后￥28.9', {
      directSelector: true,
      className: 'highlightPrice--LW1W1Xs',
      skuDataPrice: 33.9
    })
    expect(result.price).toBe(28.9)
    expect(result.priceSource).toBe('visible-dom')
    expect(result.priceKind).toBe('promotion')
    expect(result.priceLabel).toBe('店铺优惠后')
  })

  it('新版平台加补价按 highlightPrice 提取并排除优惠前价格', () => {
    const result = runPriceExtraction('平台加补后￥219 优惠前￥249', {
      directSelector: true,
      className: 'highlightPrice--astw5V1e'
    })
    expect(result.price).toBe(219)
    expect(result.priceKind).toBe('promotion')
    expect(result.priceLabel).toBe('平台加补后')
  })

  it('没有优惠标题的 highlightPrice 只标记为普通价', () => {
    const result = runPriceExtraction('￥258', {
      directSelector: true,
      className: 'highlightPrice--LW1W1Xs'
    })
    expect(result.price).toBe(258)
    expect(result.priceKind).toBe('base')
    expect(result.priceLabel).toBe('')
  })

  it('哈希价格组件显示圆点时拒绝把标题数字或优惠前价格当成交价', () => {
    const result = runPriceExtraction('9包千人加购 店铺优惠后￥••• 优惠前￥48.90')
    expect(result.price).toBeNull()
    expect(result.priceSource).toBe('promotion-masked')
    expect(result.promotionPriceMasked).toBe(true)
    expect(result.priceCandidates).toEqual([])
  })

  it('链接中的SKU ID已命中时不再点击规格', () => {
    const script = buildTaobaoSkuAutoSelectScript(selection)
    const pageWindow = {}
    const run = new Function(
      'location', 'window', 'document', 'URL', 'console', 'getComputedStyle', 'MouseEvent',
      `return ${script.trim()}`
    )
    const result = run(
      { hostname: 'detail.tmall.com', href: 'https://detail.tmall.com/item.htm?id=1&skuId=589999001' },
      pageWindow,
      {},
      URL,
      { info() {}, warn() {} },
      () => ({}),
      class MouseEvent {}
    )
    expect(result).toContain('matched-skuId=589999001')
    expect(pageWindow.__dxeSkuAutoSelectDone).toBeTruthy()

    const repeated = run(
      { hostname: 'detail.tmall.com', href: 'https://detail.tmall.com/item.htm?id=1&skuId=589999001' },
      pageWindow,
      {},
      URL,
      { info() {}, warn() {} },
      () => ({}),
      class MouseEvent {}
    )
    expect(repeated).toContain('already-completed')
  })

  it('没有SKU ID时同一个规格最多点击一次', () => {
    const script = buildTaobaoSkuAutoSelectScript({
      options: [{ text: '红色', valueId: 'red' }]
    })
    let clickCount = 0
    const candidate = {
      className: 'valueItem--test',
      isConnected: true,
      innerText: '红色',
      textContent: '红色',
      getBoundingClientRect: () => ({ width: 80, height: 30 }),
      getAttribute: name => name === 'data-value' ? 'red' : null,
      querySelector: () => null,
      closest: () => null,
      matches: selector => selector.includes('disabled') ? false : false,
      scrollIntoView() {},
      dispatchEvent() {},
      click() { clickCount++ }
    }
    const pageWindow = {}
    const run = new Function(
      'location', 'window', 'document', 'URL', 'console', 'getComputedStyle', 'MouseEvent', 'setTimeout', 'clearTimeout',
      `return ${script.trim()}`
    )
    run(
      { hostname: 'item.taobao.com', href: 'https://item.taobao.com/item.htm?id=1' },
      pageWindow,
      { querySelectorAll: () => [candidate] },
      URL,
      { info() {}, warn() {} },
      () => ({ display: 'block', visibility: 'visible' }),
      class MouseEvent {},
      callback => { callback(); return 1 },
      () => {}
    )
    expect(clickCount).toBe(1)
    expect(pageWindow.__dxeSkuAutoSelectDone).toBeTruthy()
  })
})
