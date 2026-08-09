import { describe, expect, it } from 'vitest'
import taobaoSameSearch from '../src/main/taobao-same-search.js'

const {
  normalizeRemoteImageUrl,
  normalizeTaobaoPriceValue,
  firstTaobaoPrice,
  normalizeTaobaoSearchItems,
  isTaobaoProductPageUrl,
  buildTaobaoSameSelection,
  buildTaobaoSameProductInjection,
  getTaobaoSamePartition,
  getTaobaoPurchasePartition,
  parseMtopJson,
  buildTaobaoImageSearchRequest,
  hasTaobaoLoginCookie,
  isTaobaoCookieDomain
} = taobaoSameSearch

describe('淘宝按图搜同款', () => {
  it('规范化远程图片地址并拒绝无效协议', () => {
    expect(normalizeRemoteImageUrl('//img.alicdn.com/a.jpg')).toBe('https://img.alicdn.com/a.jpg')
    expect(normalizeRemoteImageUrl('https://img.alicdn.com/a.jpg')).toBe('https://img.alicdn.com/a.jpg')
    expect(() => normalizeRemoteImageUrl('file:///tmp/a.jpg')).toThrow('商品主图地址无效')
  })

  it('兼容对象、数组和带货币符号的价格', () => {
    expect(normalizeTaobaoPriceValue({ priceText: '¥19.90起' })).toBe(19.9)
    expect(normalizeTaobaoPriceValue([{ text: '' }, { value: '28.50' }])).toBe(28.5)
    expect(normalizeTaobaoPriceValue({ priceInfo: { priceText: '¥16.60' } })).toBe(16.6)
    expect(firstTaobaoPrice(null, '', { amount: '36.00' })).toBe(36)
  })

  it('按最终价优先级映射淘宝商品字段', () => {
    const products = normalizeTaobaoSearchItems([{
      item_id: 12345,
      title: '<span>测试商品</span>',
      priceInfo: {
        finalPrice: { priceText: '¥18.80' },
        originalPrice: '29.90'
      },
      pic_path: '//img.alicdn.com/test.jpg',
      auctionURL: '//item.taobao.com/item.htm?id=12345',
      salesInfo: { totalSale: '100+人付款' },
      shopInfo: { title: '测试店铺' }
    }], 8)

    expect(products).toEqual([{
      itemId: '12345',
      title: '测试商品',
      price: 18.8,
      originalPrice: 29.9,
      sales: '100+人付款',
      shop: '测试店铺',
      img: 'https://img.alicdn.com/test.jpg',
      link: 'https://item.taobao.com/item.htm?id=12345'
    }])
  })

  it('普通价格缺失时使用原价兜底', () => {
    const products = normalizeTaobaoSearchItems([{
      item_id: 67890,
      title: '仅返回原价的商品',
      priceInfo: { originalPrice: { priceText: '¥42.00' } }
    }], 8)

    expect(products[0].price).toBe(42)
    expect(products[0].originalPrice).toBeNull()
  })

  it('默认最多保留20条淘宝同款结果', () => {
    const products = normalizeTaobaoSearchItems(Array.from({ length: 25 }, (_, index) => ({
      item_id: String(index + 1),
      title: `同款商品${index + 1}`,
      price: index + 1
    })))

    expect(products).toHaveLength(20)
    expect(products.at(-1).itemId).toBe('20')
  })

  it('兼容JSON和JSONP响应', () => {
    expect(parseMtopJson('{"ret":["SUCCESS::调用成功"]}').ret[0]).toContain('SUCCESS')
    expect(parseMtopJson('mtopjsonp1({"ret":["SUCCESS"]})').ret[0]).toBe('SUCCESS')
  })

  it('生成appId 34850的MTOP图片搜索请求', () => {
    const request = buildTaobaoImageSearchRequest({
      token: 'test-token',
      imageBase64: 'base64-image',
      bixiTokens: {
        bxUa: 'ua-value',
        bxUmidToken: 'umid-value',
        bxEt: 'et-value'
      }
    })
    const url = new URL(request.url)
    const data = JSON.parse(decodeURIComponent(request.body.slice('data='.length)))
    const params = JSON.parse(data.params)

    expect(url.pathname).toContain('mtop.relationrecommend.wirelessrecommend.recommend/2.0')
    expect(url.searchParams.get('appKey')).toBe('12574478')
    expect(url.searchParams.get('api')).toBe('mtop.relationrecommend.wirelessRecommend.recommend')
    expect(url.searchParams.get('bx-ua')).toBe('ua-value')
    expect(url.searchParams.get('sign')).toMatch(/^[a-f0-9]{32}$/)
    expect(data.appId).toBe('34850')
    expect(params.strimg).toBe('base64-image')
    expect(params.pcGraphSearch).toBe(true)
  })

  it('只接受淘宝登录Cookie和淘宝系域名', () => {
    expect(hasTaobaoLoginCookie([{ name: 'cookie2' }, { name: 'unb' }])).toBe(true)
    expect(hasTaobaoLoginCookie([{ name: 'cookie2' }])).toBe(false)
    expect(isTaobaoCookieDomain('.taobao.com')).toBe(true)
    expect(isTaobaoCookieDomain('h5api.m.taobao.com')).toBe(true)
    expect(isTaobaoCookieDomain('.tmall.hk')).toBe(true)
    expect(isTaobaoCookieDomain('.pinduoduo.com')).toBe(false)
    expect(getTaobaoSamePartition(7)).toBe('persist:dianxiaoer-tb-account-7')
    expect(getTaobaoPurchasePartition(7)).toBe('persist:purchase-7')
  })

  it('商品页选择货源时使用当前页面的淘宝商品ID和链接', () => {
    const selection = buildTaobaoSameSelection({
      accountId: 7,
      sameItem: { itemId: '111', link: 'https://item.taobao.com/item.htm?id=111', price: 19.9 }
    }, 'https://item.taobao.com/item.htm?id=222&skuId=333', {
      skuId: '333',
      shipFrom: '河北邯郸',
      options: [{ group: '颜色', text: '白色', valueId: '1627207:28320' }],
      price: 17.8,
      shippingCandidates: [{ shipFrom: '河北邯郸', text: '快递 河北邯郸 至 江苏宿迁' }]
    })

    expect(selection.accountId).toBe(7)
    expect(selection.product.itemId).toBe('222')
    expect(selection.product.link).toContain('id=222')
    expect(selection.product.price).toBe(17.8)
    expect(selection.product.currentSkuPrice).toBe(17.8)
    expect(selection.product.skuPriceCaptured).toBe(true)
    expect(selection.product.skuSelection.skuId).toBe('333')
    expect(selection.product.skuSelection.options[0].text).toBe('白色')
    expect(selection.product.shipFrom).toBe('河北邯郸')
    expect(selection.product.shippingCandidates[0].shipFrom).toBe('河北邯郸')
    expect(isTaobaoProductPageUrl(selection.product.link)).toBe(true)
    expect(isTaobaoProductPageUrl('https://example.com/item.htm?id=222')).toBe(false)
  })

  it('商品页没有读到SKU价时必须标记失败，禁止静默使用搜索列表价', () => {
    const selection = buildTaobaoSameSelection({
      accountId: 7,
      sameItem: { itemId: '111', link: 'https://item.taobao.com/item.htm?id=111', price: 13.5 }
    }, 'https://item.taobao.com/item.htm?id=111&skuId=333', {
      skuId: '333',
      options: [{ text: '大号', valueId: 'large' }],
      price: null,
      priceSource: 'promotion-masked',
      promotionPriceMasked: true
    })

    expect(selection.product.price).toBe(13.5)
    expect(selection.product.skuCaptureAttempted).toBe(true)
    expect(selection.product.skuPriceCaptured).toBe(false)
    expect(selection.product.currentSkuPrice).toBeUndefined()
    expect(selection.product.promotionPriceMasked).toBe(true)
  })

  it('生成可执行的淘宝商品页浮窗和选货源注入脚本', () => {
    const script = buildTaobaoSameProductInjection({
      goodsName: '销售订单商品',
      skuSpec: '1300ml单壶',
      image: 'https://img.example.com/a.jpg',
      quantity: 2,
      price: 88
    }, 'data:image/png;base64,logo')

    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('__dxe_sales_product_overlay__')
    expect(script).toContain('__dxe_same_source_control__')
    expect(script).toContain('销售规格')
    expect(script).toContain('1300ml单壶')
    expect(script).not.toContain('-webkit-line-clamp:3')
    expect(script).toContain('position:fixed;left:20px;top:146px')
    expect(script).toContain('document.body.appendChild(row)')
    expect(script).not.toContain("titleBlock.insertAdjacentElement('afterend', row)")
    expect(script).not.toContain("parent.style.flexWrap = 'wrap'")
    expect(script).not.toContain("row.style.gridColumn = '1 / -1'")
    expect(script).toContain('}, 100);')
    expect(script).toContain('dianxiaoer://select-taobao-same-source')
  })
})
