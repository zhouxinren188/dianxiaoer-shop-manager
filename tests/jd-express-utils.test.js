import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  JD_EXPRESS_READ_POLICY,
  adjustRoiBid,
  assembleUnitKeywords,
  buildTitleKeywordResult,
  buildProductQuery,
  buildRoiPlanStructure,
  buildScopedRoiPlanStructure,
  collectExistingPromotionIds,
  extractBusinessWisdomKeywords,
  extractSpuList,
  extractTotal,
  filterExistingPromotionProducts,
  mergeProductKeywordRows,
  normalizeAreaTree,
  normalizeImageUrl,
  normalizeRoiConfig,
  normalizeSkuDetails,
  normalizeStoreId,
  selectProductKeywordSkuIds,
  selectLowestPricedSkuIds
} = require('../src/main/jd-express-utils')

describe('京东快车商品读取参数', () => {
  it('对齐原软件的串行读取和限流保护参数', () => {
    expect(JD_EXPRESS_READ_POLICY).toEqual({
      pageSize: 100,
      initialDelayMs: 1000,
      batchIntervalMs: 4000,
      rateLimitWaitMs: 60000,
      rateLimitRetries: 1
    })
  })

  it('限制分页大小并保留京东需要的查询字段', () => {
    const query = buildProductQuery({
      keyword: '测试商品',
      minPrice: 12.5,
      maxPrice: 30,
      pageNo: 2,
      pageSize: 500,
      startOnlineTime: '2026-09-01 00:00:00'
    })

    expect(query).toMatchObject({
      name: '测试商品',
      minJdPrice: '12.5',
      maxJdPrice: '30',
      pageNo: 2,
      pageSize: 100,
      status: 1,
      startOnlineTime: '2026-09-01 00:00:00'
    })
  })

  it('拒绝反向价格区间和无效店铺 ID', () => {
    expect(() => buildProductQuery({ minPrice: 20, maxPrice: 10 })).toThrow('最低价格不能大于最高价格')
    expect(() => normalizeStoreId('')).toThrow('请选择有效的京东店铺')
    expect(normalizeStoreId('18')).toBe(18)
  })

  it('读取 querySpu 的真实 dataList 和 total 字段', () => {
    const payload = { code: 200, success: true, data: { total: 2, dataList: [{ spuId: 1 }, { spuId: 2 }] } }
    expect(extractSpuList(payload)).toEqual([{ spuId: 1 }, { spuId: 2 }])
    expect(extractTotal(payload)).toBe(2)
  })
})

describe('京东快车 SKU 选择和详情', () => {
  it('从按 SPU 分组的对象里选择最低价 SKU', () => {
    const result = selectLowestPricedSkuIds({
      1001: [
        { skuId: 11, jdPrice: 19.9 },
        { skuId: 12, jdPrice: 9.9 }
      ],
      1002: [],
      1003: [{ skuId: 13, jdPrice: 15 }]
    })

    expect(result.skuIds).toEqual(['12', '13'])
    expect(result.selectedSkus).toEqual([
      { skuId: '12', spuId: '1001', jdPrice: 9.9 },
      { skuId: '13', spuId: '1003', jdPrice: 15 }
    ])
    expect(result.skuSpuMappings).toEqual([
      { skuId: '11', spuId: '1001' },
      { skuId: '12', spuId: '1001' },
      { skuId: '13', spuId: '1003' }
    ])
    expect(result.invalidSpuIds).toEqual(['1002'])
  })

  it('规范化 skuDetails 并补全京东图片协议', () => {
    const products = normalizeSkuDetails({
      skuDetails: [{
        skuId: 10213170934617,
        spuId: 9001,
        skuName: '16cm粘毛器+5卷纸',
        imgUrl: '//img20.360buyimg.com/n1/test.jpg',
        jdPrice: 60.8,
        stockNum: 9,
        categoryId: 123
      }]
    })

    expect(products[0]).toMatchObject({
      skuId: '10213170934617',
      name: '16cm粘毛器+5卷纸',
      image: 'https://img20.360buyimg.com/n1/test.jpg',
      price: 60.8,
      stock: 9,
      categoryId: '123'
    })
    expect(normalizeImageUrl('jfs/test.jpg')).toBe('https://img10.360buyimg.com/n1/jfs/test.jpg')
  })

  it('把最低价 SKU 响应中的价格库存合并到 sku/info 详情', () => {
    const products = normalizeSkuDetails({
      skuDetails: [{ skuId: 12, skuName: '测试商品', categoryId: 301 }]
    }, [{ skuId: 12, jdPrice: 19.9, stockNum: 8, spuId: 1001 }])

    expect(products[0]).toMatchObject({
      skuId: '12',
      spuId: '1001',
      price: 19.9,
      stock: 8
    })
  })

  it('接口没有返回价格库存时保留为未知而不是伪造为零', () => {
    const products = normalizeSkuDetails({ skuDetails: [{ skuId: 12, skuName: '测试商品' }] })
    expect(products[0].price).toBeNull()
    expect(products[0].stock).toBeNull()
  })
})

describe('京东快车已有推广商品过滤', () => {
  it('从推广创意列表去重收集 SKU 和 SPU', () => {
    expect(collectExistingPromotionIds([
      { skuId: 11, spuId: 101 },
      { skuId: '11', wareId: 101 },
      { sku: { id: 12 }, productId: 102 },
      null
    ])).toEqual({
      skuIds: ['11', '12'],
      spuIds: ['101', '102']
    })
  })

  it('按 SKU 只过滤已经推广的具体规格', () => {
    const result = filterExistingPromotionProducts([
      { skuId: '11', spuId: '101' },
      { skuId: '12', spuId: '101' },
      { skuId: '13', spuId: '102' }
    ], { skuIds: ['11'], spuIds: ['101'] }, 'sku')

    expect(result.products.map((item) => item.skuId)).toEqual(['12', '13'])
    expect(result.filteredIds).toEqual(['11'])
  })

  it('按 SPU 过滤同一商品下的全部规格，并能由已有 SKU 补出 SPU', () => {
    const result = filterExistingPromotionProducts([
      { skuId: '11', spuId: '101' },
      { skuId: '12', spuId: '101' },
      { skuId: '13', spuId: '102' }
    ], { skuIds: ['11'], spuIds: [] }, 'spu')

    expect(result.products.map((item) => item.skuId)).toEqual(['13'])
    expect(result.filteredIds).toEqual(['11', '12'])
  })
})

describe('京东快车投产比计划预览', () => {
  const products = [
    { skuId: '1', categoryId: '301', categoryName: '水杯', cid2Id: '30', cid2Name: '饮具' },
    { skuId: '2', categoryId: '301', categoryName: '水杯', cid2Id: '30', cid2Name: '饮具' },
    { skuId: '3', categoryId: '302', categoryName: '餐盒', cid2Id: '30', cid2Name: '饮具' },
    { skuId: '4', categoryId: '401', categoryName: '拖把', cid2Id: '40', cid2Name: '清洁工具' }
  ]

  it('按三级类目拆单元，再按二级类目拆计划', () => {
    const result = buildRoiPlanStructure(products, {
      namePrefix: '0905',
      skuPerUnit: 1,
      unitsPerCampaign: 2,
      keywordsPerUnit: 10,
      planGroupMode: 'category'
    })

    expect(result.summary).toEqual({
      productCount: 4,
      campaignCount: 3,
      unitCount: 4,
      creativeCount: 4,
      keywordPerUnit: 10,
      keywordCount: 40
    })
    expect(result.campaigns[0].units).toHaveLength(2)
    expect(result.campaigns.map((item) => item.categoryName)).toEqual(['饮具', '饮具', '清洁工具'])
  })

  it('按数量模式不按类目拆计划，并去重 SKU', () => {
    const result = buildRoiPlanStructure([...products, products[0]], {
      skuPerUnit: 2,
      unitsPerCampaign: 2,
      planGroupMode: 'quantity'
    })

    expect(result.summary.productCount).toBe(4)
    expect(result.summary.unitCount).toBe(3)
    expect(result.summary.campaignCount).toBe(2)
  })

  it('按关键词总用量平均分配到单元且每单元不超过 200 个', () => {
    const limited = buildRoiPlanStructure(products, {
      skuPerUnit: 1,
      keywordTotalUsage: 9,
      planGroupMode: 'quantity'
    })
    expect(limited.summary.keywordPerUnit).toBe(2)
    expect(limited.summary.keywordCount).toBe(8)

    const capped = buildRoiPlanStructure(products, {
      skuPerUnit: 1,
      keywordTotalUsage: 5000,
      planGroupMode: 'quantity'
    })
    expect(capped.summary.keywordPerUnit).toBe(200)
    expect(capped.summary.keywordCount).toBe(800)
  })

  it('单商品测试沿用完整预览的每单元关键词数', () => {
    const result = buildScopedRoiPlanStructure(products, {
      skuPerUnit: 1,
      keywordTotalUsage: 600,
      planGroupMode: 'quantity'
    }, 'single_product_test')

    expect(result.summary.productCount).toBe(1)
    expect(result.summary.unitCount).toBe(1)
    expect(result.summary.keywordPerUnit).toBe(150)
    expect(result.summary.keywordCount).toBe(150)
  })

  it('规范化关键词来源依赖和特定地域配置', () => {
    const config = normalizeRoiConfig({
      keywordSources: [1, 2, 4, 4],
      areaType: 2,
      areaIds: [1, '2', 1]
    })
    expect(config.keywordSources).toEqual([1, 2])
    expect(config.areaIds).toEqual(['1', '2'])
  })

  it('规范化一键自定义时使用原工具默认投放参数且不强制勾选人群', () => {
    const config = normalizeRoiConfig({
      createMode: 'custom',
      automatedBiddingType: 32768,
      premiumType: 1,
      orientationRangeOption: [1, 2]
    })
    expect(config).toMatchObject({
      createMode: 'custom',
      biddingTarget: 1,
      automatedBiddingType: 32768,
      orientationRangeOption: [1, 2],
      premiumType: 2,
      premiumCoef: 30,
      inSearchFee: 0.1,
      useMinKeywordBid: true,
      customKeywordBid: 0.1,
      keywordMatchType: 8
    })
    expect(config.dmpCrowdSettings).toEqual([])
  })

  it('规范化一键自定义选中的实时人群并限制人群数与溢价', () => {
    const config = normalizeRoiConfig({
      createMode: 'custom',
      dmpCrowdSettings: [
        { crowdId: 100, crowdName: '默认购买人群', adGroupPrice: 8, source: 'recommended' },
        { crowdId: 100, crowdName: '重复人群', adGroupPrice: 30 },
        { crowdId: 90210, crowdName: '店铺高价值人群', adGroupPrice: 500, editing: true }
      ]
    })
    expect(config.dmpCrowdSettings).toEqual([
      { crowdId: 100, crowdName: '默认购买人群', adGroupPrice: 10, isUsed: 1 },
      { crowdId: 90210, crowdName: '店铺高价值人群', adGroupPrice: 300, isUsed: 1 }
    ])
  })

  it('规范化一键自定义的固定关键词出价', () => {
    expect(normalizeRoiConfig({
      createMode: 'custom',
      useMinKeywordBid: false,
      customKeywordBid: 0.3
    })).toMatchObject({
      useMinKeywordBid: false,
      customKeywordBid: 0.3
    })
  })

  it('支持精确、短语、切词匹配，无效值回退切词', () => {
    expect(normalizeRoiConfig({ keywordMatchType: 1 }).keywordMatchType).toBe(1)
    expect(normalizeRoiConfig({ keywordMatchType: 4 }).keywordMatchType).toBe(4)
    expect(normalizeRoiConfig({ keywordMatchType: 8 }).keywordMatchType).toBe(8)
    expect(normalizeRoiConfig({ keywordMatchType: 99 }).keywordMatchType).toBe(8)
  })

  it('为京东无 ID 的地域根节点补充稳定 ID 并保留叶子 ID', () => {
    const areas = normalizeAreaTree([{ name: '华北地区', children: [{ id: 1, name: '北京市' }] }])
    expect(areas[0].id).toBe('0-0')
    expect(areas[0].children[0]).toMatchObject({ id: '1', name: '北京市', children: null })
  })

  it('按原工具规则调整建议 ROI 并限制上下界', () => {
    expect(adjustRoiBid(5, 10, 1, 3, 10)).toBe(5.5)
    expect(adjustRoiBid(5, 20, -1, 4.5, 10)).toBe(4.5)
    expect(adjustRoiBid(12, 0, 0, 3, 10)).toBe(10)
  })
})

describe('京东快车关键词处理', () => {
  it('按原工具词性规则组合标题关键词并选出标签代表词', () => {
    const result = buildTitleKeywordResult([
      { word: '保温杯', tag: '品类' },
      { word: '保温杯', tag: '品类' },
      { word: '不锈钢', tag: '品类修饰词' },
      { word: '家用', tag: '修饰' },
      { word: 'X1', tag: '型号' },
      { word: '杯', tag: '品类' }
    ])

    expect(result.keywords).toEqual(['不锈钢保温杯'])
    expect(result.tagKeywords).toEqual(['保温杯', '不锈钢', 'X1', '家用'])
  })

  it('按商智排序字段过滤平台词并去重', () => {
    const result = extractBusinessWisdomKeywords([
      { keyword: '保温杯', gmvCj: 8 },
      { keyword: '京东保温杯', gmvCj: 99 },
      { keyword: '水杯', gmvCj: 10 },
      { keyword: '保温杯', gmvCj: 7 }
    ], 4)
    expect(result).toEqual(['水杯', '保温杯'])
  })

  it('商品推词优先 sourceType 4/64，其余按人气排序', () => {
    expect(mergeProductKeywordRows([
      { keyWord: '普通词', sourceType: 1, pv: 100 },
      { keyWord: '优先词', sourceType: 4, pv: 1 },
      { keyWord: '自营商品', sourceType: 64, pv: 999 }
    ])).toEqual(['优先词', '普通词'])
  })

  it('标题代表词优先选择匹配最多的商品用于推词', () => {
    const ids = selectProductKeywordSkuIds([
      { skuId: 1, name: '不锈钢家用保温杯' },
      { skuId: 2, name: '玻璃水杯' },
      { skuId: 3, name: '家用水杯' }
    ], ['保温杯', '不锈钢', '家用'])
    expect(ids).toEqual(['1', '3'])
  })

  it('按来源占比装配关键词并按原顺序补齐', () => {
    const result = assembleUnitKeywords({
      businessWisdomKws: ['商智1', '重复词', '商智2'],
      productKws: ['商品1', '重复词', '商品2'],
      titleKws: ['标题1'],
      pullDownKws: ['下拉1']
    }, {
      keywordSources: [1, 2, 3, 4],
      businessWisdomPercent: 20,
      productPercent: 50,
      titlePercent: 20,
      pullDownPercent: 10,
      supplementKeywords: true
    }, 6)

    expect(result).toEqual(['商智1', '商品1', '重复词', '商品2', '标题1', '商智2'])
  })
})
