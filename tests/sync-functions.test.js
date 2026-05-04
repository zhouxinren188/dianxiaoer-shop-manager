import { describe, it, expect } from 'vitest'
import {
  parseTaobaoH5Response,
  resolveLogisticsCompany,
  updateCookiesWithNewToken,
  buildCookieString,
  CP_CODE_MAP
} from './helpers.js'

// ============ 模拟数据 ============

/**
 * 扁平结构（标准 API 响应格式）:
 * { ret: [...], data: { shopInfo_xxx: {...}, orderStatus_xxx: {...} } }
 */
function makeFlatResponse(overrides = {}) {
  return JSON.stringify({
    ret: ['SUCCESS::调用成功'],
    data: {
      shopInfo_12345: {
        id: '12345678901234567',
        fields: {
          tradeTitle: '卖家已发货'
        }
      },
      orderStatus_12345: {
        id: '12345678901234567',
        fields: {
          mailNo: 'YT1234567890',
          cpCode: 'YTO',
          title: '运输中'
        }
      },
      orderLogistics_12345: {
        id: '12345678901234567',
        fields: {
          packagePreview: {
            packageViewList: [{
              cpName: '圆通速递'
            }]
          }
        }
      },
      ...overrides
    }
  })
}

/**
 * 嵌套 data.data 结构（部分 API 响应格式）:
 * { ret: [...], data: { data: { shopInfo_xxx: {...}, orderStatus_xxx: {...} }, ret: [...] } }
 */
function makeNestedResponse(overrides = {}) {
  return JSON.stringify({
    ret: ['SUCCESS::调用成功'],
    data: {
      data: {
        shopInfo_12345: {
          id: '12345678901234567',
          fields: {
            tradeTitle: '卖家已发货'
          }
        },
        orderStatus_12345: {
          id: '12345678901234567',
          fields: {
            mailNo: 'YT1234567890',
            cpCode: 'YTO',
            title: '运输中'
          }
        },
        orderLogistics_12345: {
          id: '12345678901234567',
          fields: {
            packagePreview: {
              packageViewList: [{
                cpName: '圆通速递'
              }]
            }
          }
        },
        ...overrides
      },
      ret: ['SUCCESS::调用成功']
    }
  })
}

/**
 * data 为 JSON 字符串的结构:
 * { ret: [...], data: '{"shopInfo_xxx": {...}}' }
 */
function makeStringDataResponse(overrides = {}) {
  const innerData = {
    shopInfo_12345: {
      id: '12345678901234567',
      fields: {
        tradeTitle: '买家已付款'
      }
    },
    orderStatus_12345: {
      id: '12345678901234567',
      fields: {
        mailNo: 'SF1234567890',
        cpCode: 'SF',
        title: '已揽收'
      }
    },
    ...overrides
  }
  return JSON.stringify({
    ret: ['SUCCESS::调用成功'],
    data: JSON.stringify(innerData)
  })
}

// ============ parseTaobaoH5Response 测试 ============

describe('parseTaobaoH5Response', () => {
  describe('data.data 嵌套结构修复', () => {
    it('应正确解析嵌套 data.data 结构', () => {
      const response = makeNestedResponse()
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(1)
      expect(orders[0].order_no).toBe('12345678901234567')
      expect(orders[0].status).toBe('卖家已发货')
      expect(orders[0].logistics_no).toBe('YT1234567890')
      expect(orders[0].logistics_company).toBe('圆通速递')
      expect(orders[0].logistics_status).toBe('运输中')
    })

    it('嵌套结构中包含多个订单时应全部解析', () => {
      const response = makeNestedResponse({
        shopInfo_67890: {
          id: '98765432109876543',
          fields: {
            tradeTitle: '交易成功'
          }
        },
        orderStatus_67890: {
          id: '98765432109876543',
          fields: {
            mailNo: 'ZT9876543210',
            cpCode: 'ZTO',
            title: '已签收'
          }
        }
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(2)
      const order2 = orders.find(o => o.order_no === '98765432109876543')
      expect(order2).toBeDefined()
      expect(order2.status).toBe('交易成功')
      expect(order2.logistics_no).toBe('ZT9876543210')
      expect(order2.logistics_status).toBe('已签收')
    })

    it('嵌套 data.data 中 data 本身含 shopInfo_ 键时不应解包', () => {
      // 如果外层 data 已经有 shopInfo_ 键，说明不是嵌套结构，不应解包
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          shopInfo_12345: {
            id: '11111111111111111',
            fields: { tradeTitle: '待发货' }
          },
          data: {
            someOtherKey: 'shouldNotBeUsed'
          }
        }
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(1)
      expect(orders[0].order_no).toBe('11111111111111111')
      expect(orders[0].status).toBe('待发货')
    })

    it('嵌套 data.data 中 data 本身含 orderStatus_ 键时不应解包', () => {
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          orderStatus_12345: {
            id: '22222222222222222',
            fields: { mailNo: 'EMS999888777' }
          },
          data: { irrelevant: true }
        }
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(1)
      expect(orders[0].order_no).toBe('22222222222222222')
      expect(orders[0].logistics_no).toBe('EMS999888777')
    })
  })

  describe('扁平结构（标准格式）', () => {
    it('应正确解析扁平结构', () => {
      const response = makeFlatResponse()
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(1)
      expect(orders[0].order_no).toBe('12345678901234567')
      expect(orders[0].status).toBe('卖家已发货')
      expect(orders[0].logistics_no).toBe('YT1234567890')
      expect(orders[0].logistics_company).toBe('圆通速递')
    })
  })

  describe('data 为 JSON 字符串', () => {
    it('应正确解析 data 为字符串的结构', () => {
      const response = makeStringDataResponse()
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(1)
      expect(orders[0].order_no).toBe('12345678901234567')
      expect(orders[0].status).toBe('买家已付款')
      expect(orders[0].logistics_no).toBe('SF1234567890')
    })
  })

  describe('错误和边界情况', () => {
    it('API 返回错误时应返回空数组', () => {
      const response = JSON.stringify({
        ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'],
        data: {}
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(0)
    })

    it('没有 data 字段时应返回空数组', () => {
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功']
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(0)
    })

    it('无效 JSON 应返回空数组而不抛异常', () => {
      const orders = parseTaobaoH5Response('not valid json{{{')

      expect(orders).toHaveLength(0)
    })

    it('空字符串应返回空数组', () => {
      const orders = parseTaobaoH5Response('')

      expect(orders).toHaveLength(0)
    })

    it('data 中没有订单组件时应返回空数组', () => {
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          someOtherComponent: { id: '123', fields: {} }
        }
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(0)
    })

    it('shopInfo 有 id 但没有 fields 时仍应创建订单', () => {
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          shopInfo_12345: {
            id: '33333333333333333'
          }
        }
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(1)
      expect(orders[0].order_no).toBe('33333333333333333')
      expect(orders[0].status).toBe('')
    })

    it('嵌套结构中 data.data 为 null 时应正确处理', () => {
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          data: null,
          ret: ['SUCCESS::调用成功']
        }
      })
      const orders = parseTaobaoH5Response(response)

      // data.data is null, so the unwrap condition `data.data && typeof data.data === 'object'` is false
      // data stays as the outer data object, which has no shopInfo_ keys -> empty
      expect(orders).toHaveLength(0)
    })

    it('嵌套结构中 data.data 为非对象时应跳过解包', () => {
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          data: 'not_an_object',
          ret: ['SUCCESS::调用成功']
        }
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(0)
    })
  })

  describe('物流信息 cpCode 兜底', () => {
    it('有 cpName 时应优先使用 cpName', () => {
      const response = makeFlatResponse()
      const orders = parseTaobaoH5Response(response)

      expect(orders[0].logistics_company).toBe('圆通速递')
    })

    it('没有 cpName 但有 cpCode 时应用 CP_CODE_MAP 兜底', () => {
      const response = makeFlatResponse()
      // 移除 orderLogistics 组件（cpName 来源），保留 orderStatus 的 cpCode
      const parsed = JSON.parse(response)
      delete parsed.data.orderLogistics_12345
      const orders = parseTaobaoH5Response(JSON.stringify(parsed))

      expect(orders[0].logistics_company).toBe('圆通速递') // YTO -> 圆通速递 via CP_CODE_MAP
      expect(orders[0].logistics_company_code).toBe('YTO')
    })

    it('cpName 和 cpCode 都没有时 logistics_company 应为空', () => {
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          shopInfo_12345: {
            id: '44444444444444444',
            fields: { tradeTitle: '待发货' }
          },
          orderStatus_12345: {
            id: '44444444444444444',
            fields: {}
          }
        }
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders[0].logistics_company).toBe('')
      expect(orders[0].logistics_company_code).toBe('')
    })

    it('cpCode 在 CP_CODE_MAP 中不存在时应使用原始 cpName（空）', () => {
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          shopInfo_12345: {
            id: '55555555555555555',
            fields: { tradeTitle: '已发货' }
          },
          orderStatus_12345: {
            id: '55555555555555555',
            fields: { cpCode: 'UNKNOWN_CARRIER' }
          }
        }
      })
      const orders = parseTaobaoH5Response(response)

      // cpName is empty, cpCode not in map -> returns empty string
      expect(orders[0].logistics_company).toBe('')
      expect(orders[0].logistics_company_code).toBe('UNKNOWN_CARRIER')
    })
  })

  describe('多组件聚合', () => {
    it('shopInfo 和 orderStatus 指向同一订单ID时应正确聚合', () => {
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          shopInfo_abc: {
            id: '11111111111111111',
            fields: { tradeTitle: '已签收' }
          },
          orderStatus_abc: {
            id: '11111111111111111',
            fields: {
              mailNo: 'SF999888777666',
              cpCode: 'SF',
              title: '已签收'
            }
          },
          orderLogistics_abc: {
            id: '11111111111111111',
            fields: {
              packagePreview: {
                packageViewList: [{ cpName: '顺丰速运' }]
              }
            }
          }
        }
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(1)
      expect(orders[0].order_no).toBe('11111111111111111')
      expect(orders[0].status).toBe('已签收')
      expect(orders[0].logistics_no).toBe('SF999888777666')
      expect(orders[0].logistics_company).toBe('顺丰速运')
    })

    it('只有 shopInfo 组件时订单仍应被创建', () => {
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          shopInfo_only: {
            id: '66666666666666666',
            fields: { tradeTitle: '买家已付款' }
          }
        }
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(1)
      expect(orders[0].status).toBe('买家已付款')
      expect(orders[0].logistics_no).toBe('')
    })

    it('只有 orderStatus 组件时订单仍应被创建', () => {
      const response = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          orderStatus_only: {
            id: '77777777777777777',
            fields: { mailNo: 'ZT111222333', cpCode: 'ZTO' }
          }
        }
      })
      const orders = parseTaobaoH5Response(response)

      expect(orders).toHaveLength(1)
      expect(orders[0].logistics_no).toBe('ZT111222333')
      expect(orders[0].status).toBe('') // no shopInfo -> no status
    })
  })
})

// ============ updateCookiesWithNewToken 测试 ============

describe('updateCookiesWithNewToken', () => {
  const baseCookies = [
    { name: 'cookie2', value: 'abc123', domain: '.taobao.com' },
    { name: '_m_h5_tk', value: 'old_token_value', domain: '.taobao.com' },
    { name: '_m_h5_tk_enc', value: 'old_enc_value', domain: '.taobao.com' },
    { name: 'sgcookie', value: 'sg123', domain: '.taobao.com' }
  ]

  it('应更新已有的 _m_h5_tk 和 _m_h5_tk_enc', () => {
    const result = updateCookiesWithNewToken(baseCookies, 'new_token_value', 'new_enc_value')

    const tk = result.find(c => c.name === '_m_h5_tk')
    const tkEnc = result.find(c => c.name === '_m_h5_tk_enc')

    expect(tk.value).toBe('new_token_value')
    expect(tkEnc.value).toBe('new_enc_value')
  })

  it('不应修改其他 cookies', () => {
    const result = updateCookiesWithNewToken(baseCookies, 'new_token', 'new_enc')

    const cookie2 = result.find(c => c.name === 'cookie2')
    const sgcookie = result.find(c => c.name === 'sgcookie')

    expect(cookie2.value).toBe('abc123')
    expect(sgcookie.value).toBe('sg123')
  })

  it('不应修改原始数组（不可变性）', () => {
    const original = JSON.parse(JSON.stringify(baseCookies))
    updateCookiesWithNewToken(baseCookies, 'new_token', 'new_enc')

    // 原始数组应保持不变
    expect(baseCookies.find(c => c.name === '_m_h5_tk').value).toBe(original.find(c => c.name === '_m_h5_tk').value)
  })

  it('当 _m_h5_tk 不存在时应追加新条目', () => {
    const cookiesWithoutTk = [
      { name: 'cookie2', value: 'abc123' },
      { name: 'sgcookie', value: 'sg123' }
    ]

    const result = updateCookiesWithNewToken(cookiesWithoutTk, 'brand_new_token', 'brand_new_enc')

    const tk = result.find(c => c.name === '_m_h5_tk')
    const tkEnc = result.find(c => c.name === '_m_h5_tk_enc')

    expect(tk).toBeDefined()
    expect(tk.value).toBe('brand_new_token')
    expect(tkEnc).toBeDefined()
    expect(tkEnc.value).toBe('brand_new_enc')
    expect(result).toHaveLength(4) // original 2 + 2 new
  })

  it('newTkEnc 为空时不应添加 _m_h5_tk_enc', () => {
    const result = updateCookiesWithNewToken(baseCookies, 'new_token_only', '')

    const tk = result.find(c => c.name === '_m_h5_tk')
    const tkEnc = result.find(c => c.name === '_m_h5_tk_enc')

    expect(tk.value).toBe('new_token_only')
    // _m_h5_tk_enc already exists in baseCookies, so it stays with old value
    expect(tkEnc.value).toBe('old_enc_value')
  })

  it('newTkEnc 为 undefined 时不应添加或修改 _m_h5_tk_enc', () => {
    const result = updateCookiesWithNewToken(baseCookies, 'new_token_only', undefined)

    const tkEnc = result.find(c => c.name === '_m_h5_tk_enc')
    // original _m_h5_tk_enc stays unchanged since newTkEnc is falsy
    expect(tkEnc.value).toBe('old_enc_value')
  })

  it('空 cookies 数组时应创建新条目', () => {
    const result = updateCookiesWithNewToken([], 'fresh_token', 'fresh_enc')

    expect(result).toHaveLength(2)
    expect(result.find(c => c.name === '_m_h5_tk').value).toBe('fresh_token')
    expect(result.find(c => c.name === '_m_h5_tk_enc').value).toBe('fresh_enc')
  })

  it('应保留 cookie 的其他属性（domain, path 等）', () => {
    const cookiesWithMeta = [
      { name: '_m_h5_tk', value: 'old', domain: '.taobao.com', path: '/', httpOnly: false, secure: true }
    ]

    const result = updateCookiesWithNewToken(cookiesWithMeta, 'new_value', '')

    const tk = result.find(c => c.name === '_m_h5_tk')
    expect(tk.value).toBe('new_value')
    expect(tk.domain).toBe('.taobao.com')
    expect(tk.path).toBe('/')
    expect(tk.secure).toBe(true)
  })
})

// ============ buildCookieString 测试 ============

describe('buildCookieString', () => {
  it('应从 cookie 数组构建字符串', () => {
    const cookies = [
      { name: 'cookie2', value: 'abc' },
      { name: '_m_h5_tk', value: 'token123' }
    ]

    expect(buildCookieString(cookies)).toBe('cookie2=abc; _m_h5_tk=token123')
  })

  it('传入字符串时应直接返回', () => {
    expect(buildCookieString('cookie2=abc; _m_h5_tk=token')).toBe('cookie2=abc; _m_h5_tk=token')
  })

  it('空数组应返回空字符串', () => {
    expect(buildCookieString([])).toBe('')
  })

  it('null 应返回空字符串', () => {
    expect(buildCookieString(null)).toBe('')
  })

  it('undefined 应返回空字符串', () => {
    expect(buildCookieString(undefined)).toBe('')
  })
})

// ============ resolveLogisticsCompany 测试 ============

describe('resolveLogisticsCompany', () => {
  it('cpName 非空时应直接返回 cpName', () => {
    expect(resolveLogisticsCompany('顺丰速运', 'SF')).toBe('顺丰速运')
  })

  it('cpName 有空格时应 trim', () => {
    expect(resolveLogisticsCompany('  圆通速递  ', 'YTO')).toBe('圆通速递')
  })

  it('cpName 为空但 cpCode 在映射表中时应返回映射值', () => {
    expect(resolveLogisticsCompany('', 'ZTO')).toBe('中通快递')
  })

  it('cpName 为 null 但 cpCode 在映射表中时应返回映射值', () => {
    expect(resolveLogisticsCompany(null, 'YUNDA')).toBe('韵达快递')
  })

  it('cpCode 大小写不敏感', () => {
    expect(resolveLogisticsCompany('', 'sf')).toBe('顺丰速运')
    expect(resolveLogisticsCompany('', 'Sf')).toBe('顺丰速运')
  })

  it('cpName 和 cpCode 都为空时应返回空字符串', () => {
    expect(resolveLogisticsCompany('', '')).toBe('')
  })

  it('cpName 为空且 cpCode 不在映射表中时应返回空字符串', () => {
    expect(resolveLogisticsCompany('', 'UNKNOWN')).toBe('')
  })

  it('cpName 非空时即使 cpCode 不在映射表中也应返回 cpName', () => {
    expect(resolveLogisticsCompany('某某快递', 'UNKNOWN')).toBe('某某快递')
  })
})

// ============ CP_CODE_MAP 完整性测试 ============

describe('CP_CODE_MAP', () => {
  it('应包含主要物流公司代码', () => {
    const essentialCodes = ['SF', 'YTO', 'ZTO', 'STO', 'YUNDA', 'EMS', 'JD', 'DBL']
    for (const code of essentialCodes) {
      expect(CP_CODE_MAP[code]).toBeDefined()
    }
  })

  it('所有值应为非空字符串', () => {
    for (const [code, name] of Object.entries(CP_CODE_MAP)) {
      expect(name).toBeTruthy()
      expect(typeof name).toBe('string')
    }
  })
})
