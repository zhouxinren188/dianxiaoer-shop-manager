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

describe('淘宝货源SKU记录与回选', () => {
  const selection = {
    skuId: '589999001',
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
    expect(extractionScript).toContain('aria-checked="true"')
    expect(autoSelectScript).toContain('[DXE_SKU_AUTO] success')
    expect(autoSelectScript).toContain("element.click()")
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
