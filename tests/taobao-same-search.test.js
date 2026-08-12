import { describe, expect, it } from 'vitest'
import taobaoSameSearch from '../src/main/taobao-same-search.js'

const {
  normalizeRemoteImageUrl,
  normalizeTaobaoPriceValue,
  firstTaobaoPrice,
  normalizeTaobaoSearchItems,
  summarizeTaobaoSearchResponse,
  isTaobaoProductPageUrl,
  detectTaobaoMarketplace,
  prepareTaobaoSameProductUrl,
  buildTaobaoSameSelection,
  buildTaobaoSameProductInjection,
  getTaobaoSamePartition,
  getTaobaoPurchasePartition,
  TB_SEARCH_LOGIN_URL,
  parseMtopJson,
  buildTaobaoImageSearchRequest,
  hasTaobaoLoginCookie,
  isTaobaoCookieDomain,
  isTaobaoIdentityCookie,
  buildTaobaoSessionIdentity,
  isTaobaoSearchCarrierUrl,
  isTaobaoRiskRet,
  isTaobaoBusyRet,
  isTaobaoVerificationRet,
  sanitizeTaobaoRetText,
  extractTaobaoRetMessage,
  isTaobaoTokenRet,
  extractTaobaoVerificationUrl,
  shouldRetryWithRefreshedToken,
  hasCoherentBixiTokens,
  summarizeBixiTokens,
  shouldRetryTaobaoBusyResponse,
  classifyTaobaoAuthenticationSnapshot,
  readTaobaoSearchAuthenticationPageState,
  TAOBAO_SEARCH_AUTH_TIMEOUT,
  TAOBAO_SEARCH_AUTH_STABLE_MS,
  TAOBAO_SEARCH_WARM_STABLE_MS,
  TAOBAO_SEARCH_RISK_COOLDOWN_MS,
  TAOBAO_SEARCH_WEB_SECURITY
} = taobaoSameSearch

describe('淘宝货源商品页 SKU 恢复', () => {
  it('从货源链接读取已保存规格并把 skuId 带入实际商品网址', () => {
    const selection = {
      skuId: '778899',
      options: [{ group: '颜色', text: '奶油白四层', valueId: '1627207:28320' }]
    }
    const sourceUrl = 'https://item.taobao.com/item.htm?id=123#dxeSku=' +
      encodeURIComponent(JSON.stringify(selection))
    const target = prepareTaobaoSameProductUrl(sourceUrl)

    expect(new URL(target.url).searchParams.get('skuId')).toBe('778899')
    expect(target.url).not.toContain('#dxeSku=')
    expect(target.selection.options[0].text).toBe('奶油白四层')
  })
})

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

  it('空结果诊断仅记录响应结构和列表路径', () => {
    const summary = JSON.parse(summarizeTaobaoSearchResponse({
      ret: ['SUCCESS::调用成功'],
      data: {
        itemsArray: '[]',
        result: { items: [{ itemId: '123', title: '不应写入日志的标题' }] }
      }
    }, '{"mock":"body"}'))

    expect(summary.ret).toEqual(['SUCCESS::调用成功'])
    expect(summary.dataKeys).toEqual(['itemsArray', 'result'])
    expect(summary.collectionPaths).toContain('data.itemsArray=json-array(0)')
    expect(summary.collectionPaths).toContain('data.result.items=array(1)')
    expect(summary.itemsArrayCount).toBe(0)
    expect(summary.objectShapes).toContain('data.result.items[0]={itemId,title}')
    expect(JSON.stringify(summary)).not.toContain('不应写入日志的标题')
    expect(summary.bodySha256).toHaveLength(16)
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

  it('淘宝同款专用账号与采购账号分区严格隔离', () => {
    expect(hasTaobaoLoginCookie([{ name: 'cookie2' }, { name: 'unb' }])).toBe(true)
    expect(hasTaobaoLoginCookie([{ name: 'cookie2' }])).toBe(false)
    expect(isTaobaoCookieDomain('.taobao.com')).toBe(true)
    expect(isTaobaoCookieDomain('h5api.m.taobao.com')).toBe(true)
    expect(isTaobaoCookieDomain('.tmall.hk')).toBe(true)
    expect(isTaobaoCookieDomain('.pinduoduo.com')).toBe(false)
    expect(getTaobaoSamePartition(7)).toBe('persist:dianxiaoer-taobao-same-search-v1')
    expect(getTaobaoSamePartition(73)).toBe(getTaobaoSamePartition(7))
    expect(getTaobaoPurchasePartition(7)).toBe('persist:purchase-7')
    expect(getTaobaoPurchasePartition(73)).toBe('persist:purchase-73')
    expect(getTaobaoSamePartition(7)).not.toBe(getTaobaoPurchasePartition(7))
  })

  it('专用账号登录成功后跳回固定搜索承载页', () => {
    const loginUrl = new URL(TB_SEARCH_LOGIN_URL)
    expect(loginUrl.hostname).toBe('login.taobao.com')
    expect(loginUrl.searchParams.get('redirectURL')).toBe(
      'https://h5.m.taobao.com/awp/core/detail.htm?id=620000000000000000'
    )
  })

  it('使用不可逆关键Cookie指纹识别搜索身份变化且不记录原值', () => {
    const cookies = [
      { name: 'cookie2', value: 'cookie-secret', domain: '.taobao.com', path: '/' },
      { name: 'unb', value: '123456789', domain: '.taobao.com', path: '/' },
      { name: '_m_h5_tk', value: 'token-raw', domain: '.taobao.com', path: '/' },
      { name: 'unrelated', value: 'ignored', domain: '.taobao.com', path: '/' }
    ]
    const identity = buildTaobaoSessionIdentity(cookies, 'token-one')
    const reordered = buildTaobaoSessionIdentity([...cookies].reverse(), 'token-one')
    const changedCookie = buildTaobaoSessionIdentity(
      cookies.map(cookie => cookie.name === 'cookie2' ? { ...cookie, value: 'cookie-new' } : cookie),
      'token-one'
    )
    const changedToken = buildTaobaoSessionIdentity(cookies, 'token-two')

    expect(identity.fingerprint).toBe(reordered.fingerprint)
    expect(changedCookie.fingerprint).not.toBe(identity.fingerprint)
    expect(changedToken.fingerprint).toBe(identity.fingerprint)
    expect(changedToken.tokenFingerprint).not.toBe(identity.tokenFingerprint)
    expect(identity.cookieNames).toEqual(['cookie2', 'unb'])
    expect(JSON.stringify(identity)).not.toContain('cookie-secret')
    expect(JSON.stringify(identity)).not.toContain('123456789')
    expect(isTaobaoIdentityCookie(cookies[0])).toBe(true)
    expect(isTaobaoIdentityCookie(cookies[2])).toBe(false)
  })

  it('冷搜索等待完整自动登录稳定，身份一致的热搜索仅做短健康检查', () => {
    expect(TAOBAO_SEARCH_AUTH_TIMEOUT).toBeGreaterThanOrEqual(20000)
    expect(TAOBAO_SEARCH_AUTH_STABLE_MS).toBeGreaterThanOrEqual(1200)
    expect(TAOBAO_SEARCH_WARM_STABLE_MS).toBeGreaterThan(0)
    expect(TAOBAO_SEARCH_WARM_STABLE_MS).toBeLessThan(TAOBAO_SEARCH_AUTH_STABLE_MS)
  })

  it('专用搜索窗口与已知成功环境保持相同的webSecurity设置', () => {
    expect(TAOBAO_SEARCH_WEB_SECURITY).toBe(false)
  })

  it('把淘宝过期占位商品识别为正常搜同款承载页', () => {
    expect(isTaobaoSearchCarrierUrl(
      'https://h5.m.taobao.com/awp/core/detail.htm?id=620000000000000000'
    )).toBe(true)
    expect(isTaobaoSearchCarrierUrl(
      'https://h5.m.taobao.com/detailplugin/expired.html?itemId=620000000000000000&'
    )).toBe(true)
    expect(isTaobaoSearchCarrierUrl(
      'https://h5.m.taobao.com/detailplugin/expired.html?itemId=123'
    )).toBe(false)
    expect(isTaobaoSearchCarrierUrl('https://sec.taobao.com/verify')).toBe(false)
  })

  it('识别淘宝风控并只接受淘宝验证地址', () => {
    expect(isTaobaoRiskRet('RGV587_ERROR::SM::被挤爆啦')).toBe(true)
    expect(isTaobaoRiskRet('FAIL_SYS_USER_VALIDATE::安全验证')).toBe(true)
    expect(isTaobaoBusyRet('RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!')).toBe(true)
    expect(isTaobaoBusyRet('FAIL_SYS_USER_VALIDATE::安全验证')).toBe(false)
    expect(isTaobaoVerificationRet('FAIL_SYS_USER_VALIDATE::安全验证')).toBe(true)
    expect(isTaobaoVerificationRet('RGV587_ERROR::SM::被挤爆啦')).toBe(false)
    expect(isTaobaoRiskRet('SUCCESS::调用成功')).toBe(false)
    expect(extractTaobaoVerificationUrl({
      data: { url: 'https://login.taobao.com/member/login.jhtml' }
    })).toBe('https://login.taobao.com/member/login.jhtml')
    expect(extractTaobaoVerificationUrl({
      data: { url: 'https://evil.example.com/steal' }
    })).toBe('')
    expect(TAOBAO_SEARCH_RISK_COOLDOWN_MS).toBeGreaterThanOrEqual(30 * 60 * 1000)
  })

  it('展示淘宝可读返回原因并隐藏返回内容中的链接', () => {
    const ret = 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!'
    expect(extractTaobaoRetMessage(ret)).toBe('哎哟喂,被挤爆啦,请稍后重试!')
    expect(sanitizeTaobaoRetText('RGV587::请访问 https://example.com/token?a=secret\n后重试'))
      .toBe('RGV587::请访问 [链接已隐藏] 后重试')
  })

  it('Token错误只有读到不同的新Token时才允许受控重试', () => {
    expect(isTaobaoTokenRet('TOKEN_EXPIRED::令牌过期')).toBe(true)
    expect(shouldRetryWithRefreshedToken('TOKEN_EXPIRED', 'old', 'new')).toBe(true)
    expect(shouldRetryWithRefreshedToken('TOKEN_EXPIRED', 'same', 'same')).toBe(false)
    expect(shouldRetryWithRefreshedToken('TOKEN_EXPIRED', 'old', '')).toBe(false)
    expect(shouldRetryWithRefreshedToken('RGV587_ERROR', 'old', 'new')).toBe(false)
  })

  it('Bixi诊断只记录不可逆摘要和资源时序，不泄露参数原值', () => {
    const tokens = {
      bxUa: 'secret-bx-ua',
      bxUmidToken: 'secret-umid',
      bxEt: 'secret-et'
    }
    const evidence = {
      resourceCount: 12,
      bixiResourceCount: 1,
      candidates: [{ host: 'h5api.m.taobao.com', bxUa: true, bxUmidToken: true, bxEt: true }]
    }
    const summary = summarizeBixiTokens(tokens, evidence)

    expect(hasCoherentBixiTokens(tokens)).toBe(true)
    expect(summary.coherent).toBe(true)
    expect(summary.evidence).toEqual(evidence)
    expect(summary.bxUa.length).toBe(tokens.bxUa.length)
    expect(JSON.stringify(summary)).not.toContain('secret-bx-ua')
    expect(JSON.stringify(summary)).not.toContain('secret-umid')
    expect(JSON.stringify(summary)).not.toContain('secret-et')
  })

  it('RGV587是否受控重试不依赖Bixi参数', () => {
    expect(shouldRetryTaobaoBusyResponse({ attempt: 0 })).toBe(true)
    expect(shouldRetryTaobaoBusyResponse({ attempt: 1, riskRetryUsed: true })).toBe(false)
    expect(shouldRetryTaobaoBusyResponse({ attempt: 2 })).toBe(false)
  })

  it('识别淘宝首次自动登录倒计时且不误判普通商品页', () => {
    expect(classifyTaobaoAuthenticationSnapshot({
      title: '淘宝登录',
      text: '是否继续使用上次登录的账号？8秒后将自动登录'
    }).automaticLoginPending).toBe(true)
    expect(classifyTaobaoAuthenticationSnapshot({
      title: '淘宝登录',
      text: '正在为您登录，请稍候'
    }).automaticLoginPending).toBe(true)
    expect(classifyTaobaoAuthenticationSnapshot({
      title: '淘宝商品详情',
      text: '店铺优惠后 ￥29.9 预计8小时内发货'
    }).automaticLoginPending).toBe(false)
    expect(classifyTaobaoAuthenticationSnapshot({
      title: '淘宝登录',
      text: '请输入账号和密码登录'
    }).automaticLoginPending).toBe(false)
  })

  it('检查全部frame的登录和验证URL而不只依赖页面文字', async () => {
    const mainFrame = {
      url: 'https://h5.m.taobao.com/awp/core/detail.htm?id=620000000000000000',
      framesInSubtree: [],
      executeJavaScript: async () => ({
        title: '淘宝商品页',
        text: '普通商品内容',
        readyState: 'complete'
      })
    }
    const loginFrame = {
      url: 'https://login.taobao.com/member/login.jhtml',
      executeJavaScript: async () => ({ title: '', text: '', readyState: 'complete' })
    }
    mainFrame.framesInSubtree = [loginFrame]
    const win = {
      isDestroyed: () => false,
      webContents: { mainFrame }
    }

    await expect(readTaobaoSearchAuthenticationPageState(win)).resolves.toMatchObject({
      needLogin: true,
      needVerification: false,
      frameHost: 'login.taobao.com'
    })

    loginFrame.url = 'https://sec.taobao.com/verify'
    await expect(readTaobaoSearchAuthenticationPageState(win)).resolves.toMatchObject({
      needLogin: false,
      needVerification: true,
      frameHost: 'sec.taobao.com'
    })
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

  it('优先沿用同款结果店铺名，商品页店铺名只作兜底，并准确区分淘宝与天猫链接', () => {
    const selection = buildTaobaoSameSelection({
      accountId: 7,
      sameItem: { itemId: '111', shop: '搜索接口旧店铺名' }
    }, 'https://detail.tmall.com/item.htm?id=222', {
      skuId: '333',
      shopName: '富光爱德家专卖店',
      shopCandidates: [{ name: '富光爱德家专卖店', source: 'shop-link', score: 190 }],
      price: 29.9
    })

    expect(selection.product.shop).toBe('搜索接口旧店铺名')
    expect(selection.product.shopSource).toBe('same-search-result')
    expect(selection.product.marketplace).toBe('tmall')
    expect(selection.product.shopCandidates[0].source).toBe('shop-link')
    expect(detectTaobaoMarketplace('https://item.taobao.com/item.htm?id=1')).toBe('taobao')
    expect(detectTaobaoMarketplace('https://detail.tmall.com/item.htm?id=1')).toBe('tmall')
    expect(detectTaobaoMarketplace('https://detail.tmall.hk/item.htm?id=1')).toBe('tmall')
    expect(detectTaobaoMarketplace('https://example.com/item.htm?id=1')).toBe('')

    const fallback = buildTaobaoSameSelection({
      accountId: 7,
      sameItem: { itemId: '111', shop: '' }
    }, 'https://item.taobao.com/item.htm?id=222', {
      shopName: '商品页兜底店铺',
      price: 19.9
    })
    expect(fallback.product.shop).toBe('商品页兜底店铺')
    expect(fallback.product.shopSource).toBe('product-page-fallback')
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

  it('生成可执行的淘宝商品页浮窗和工具条选货源注入脚本', () => {
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
    expect(script).toContain('position:fixed;z-index:2147483001')
    expect(script).toContain('position:fixed;right:530px;top:656px')
    expect(script).toContain(') - 510')
    expect(script).toContain(') + 510')
    expect(script).toContain('#J_Toolkit .tb-toolkit-list-new')
    expect(script).not.toContain('toolkitList.insertBefore')
    expect(script).toContain("styleSelectRow(row, 'floating-toolkit')")
    expect(script).toContain('dxe-floating-source-item')
    expect(script).toContain('position:fixed')
    expect(script).toContain("toolkitList.closest('#J_Toolkit')")
    expect(script).toContain('toolkit-label dxe-toolkit-source-label')
    expect(script).toContain("label.style.cssText = 'display:inline-block")
    expect(script).toContain('data-dxe-source-tooltip')
    expect(script).toContain('right:calc(100% + 9px)')
    expect(script).toContain('row.parentElement !== document.body')
    expect(script).toContain('document.body.appendChild(row)')
    expect(script).not.toContain("titleBlock.insertAdjacentElement('afterend', row)")
    expect(script).not.toContain("parent.style.flexWrap = 'wrap'")
    expect(script).not.toContain("row.style.gridColumn = '1 / -1'")
    expect(script).toContain('}, 100);')
    expect(script).toContain('dianxiaoer://select-taobao-same-source')
    expect(script).toContain('dianxiaoer://remove-taobao-same-source')
    expect(script).not.toContain('price-recovery-reload')
    expect(script).not.toContain('scheduleSkuPriceRecovery')
    expect(script).not.toContain('location.replace(')
    expect(script).toContain('clearSkuClickDiagnostics')
    expect(script).toContain("sku-click-stable-3500ms")
    expect(script).toContain('[DXE_SAME_PRODUCT] skipped-non-product')

    const boundScript = buildTaobaoSameProductInjection({}, '', 'diag-1', {
      isBound: true,
      sourceId: 12,
      itemId: '123'
    })
    expect(boundScript).toContain('"isBound":true')
    expect(boundScript).toContain('"sourceId":12')
    expect(boundScript).toContain('left:10px;top:190px')
  })
})
