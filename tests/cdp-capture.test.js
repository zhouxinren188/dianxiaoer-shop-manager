/**
 * CDP (Chrome DevTools Protocol) 网络捕获器测试
 * 使用 mock webContents.debugger 模拟 CDP 事件流
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CDPNetworkCapture } from './browser-sync-helpers.js'

// ============ Mock 工厂 ============

function createMockWebContents() {
  const messageListeners = []
  const commands = { enableCalled: false, getResponseBodyCalls: [] }

  const mockDebugger = {
    attach: vi.fn(),
    detach: vi.fn(),
    on: vi.fn((event, callback) => {
      if (event === 'message') messageListeners.push(callback)
    }),
    off: vi.fn(),
    sendCommand: vi.fn(async (method, params) => {
      if (method === 'Network.enable') {
        commands.enableCalled = true
        return {}
      }
      if (method === 'Network.getResponseBody') {
        commands.getResponseBodyCalls.push(params)
        // 返回预置的响应体
        const body = mockResponses[params.requestId] || ''
        return { body, base64Encoded: false }
      }
      return {}
    })
  }

  let destroyed = false

  const webContents = {
    debugger: mockDebugger,
    isDestroyed: vi.fn(() => destroyed),
    _setDestroyed: (v) => { destroyed = v },
    _messageListeners: messageListeners,
    _commands: commands,
    _emitMessage(event, method, params) {
      for (const cb of messageListeners) {
        cb(event, method, params)
      }
    }
  }

  return webContents
}

// 预置的 mock 响应体
let mockResponses = {}

// ============ CDPNetworkCapture 测试 ============

describe('CDPNetworkCapture', () => {
  let webContents
  const apiKeywords = ['mtop.taobao.order', 'queryboughtlist']

  beforeEach(() => {
    webContents = createMockWebContents()
    mockResponses = {}
  })

  describe('attach()', () => {
    it('应成功 attach 并启用 Network 域', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      const result = await capture.attach()
      expect(result).toBe(true)
      expect(capture.attached).toBe(true)
      expect(webContents._commands.enableCalled).toBe(true)
    })

    it('应在 webContents 已销毁时返回 false', async () => {
      webContents._setDestroyed(true)
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      const result = await capture.attach()
      expect(result).toBe(false)
      expect(capture.attached).toBe(false)
    })

    it('应在 debugger.attach 失败时返回 false', async () => {
      webContents.debugger.attach.mockImplementation(() => {
        throw new Error('target closed')
      })
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      const result = await capture.attach()
      expect(result).toBe(false)
      expect(capture.attached).toBe(false)
    })
  })

  describe('_handleCDPEvent - Network.responseReceived', () => {
    it('应将匹配 apiKeywords 的请求加入 pendingRequests', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      webContents._emitMessage('event', 'Network.responseReceived', {
        requestId: 'req-001',
        response: {
          url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/',
          status: 200,
          mimeType: 'application/json'
        }
      })

      expect(capture.pendingRequests.has('req-001')).toBe(true)
      expect(capture.pendingRequests.get('req-001').url).toContain('mtop.taobao.order')
    })

    it('应忽略不匹配 apiKeywords 的请求', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      webContents._emitMessage('event', 'Network.responseReceived', {
        requestId: 'req-002',
        response: {
          url: 'https://img.alicdn.com/imgextra/i3/O1CN01.png',
          status: 200
        }
      })

      expect(capture.pendingRequests.has('req-002')).toBe(false)
    })

    it('应支持多个 apiKeywords 匹配', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      webContents._emitMessage('event', 'Network.responseReceived', {
        requestId: 'req-003',
        response: {
          url: 'https://h5api.m.taobao.com/h5/queryboughtlist/v1/',
          status: 200
        }
      })

      expect(capture.pendingRequests.has('req-003')).toBe(true)
    })

    it('应大小写不敏感匹配', async () => {
      const capture = new CDPNetworkCapture(webContents, ['orderList'])
      await capture.attach()

      webContents._emitMessage('event', 'Network.responseReceived', {
        requestId: 'req-004',
        response: {
          url: 'https://trade.1688.com/API/ORDERLIST',
          status: 200
        }
      })

      expect(capture.pendingRequests.has('req-004')).toBe(true)
    })
  })

  describe('_handleCDPEvent - Network.loadingFinished', () => {
    it('应在 loading finished 时获取响应体', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      // 先触发 responseReceived
      webContents._emitMessage('event', 'Network.responseReceived', {
        requestId: 'req-100',
        response: {
          url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/',
          status: 200
        }
      })

      // 设置 mock 响应体
      mockResponses['req-100'] = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: { shopInfo_1: { id: 'ORDER-001', fields: { tradeTitle: '已发货' } } }
      })

      // 触发 loadingFinished
      webContents._emitMessage('event', 'Network.loadingFinished', {
        requestId: 'req-100'
      })

      // 等待异步 _fetchResponseBody
      await new Promise(resolve => setTimeout(resolve, 50))

      const captured = capture.getCaptured()
      expect(captured).toHaveLength(1)
      expect(captured[0].url).toContain('mtop.taobao.order')
      expect(captured[0].status).toBe(200)
      expect(captured[0].bodyLen).toBeGreaterThan(50)
    })

    it('应忽略小于 50 字节的响应体', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      webContents._emitMessage('event', 'Network.responseReceived', {
        requestId: 'req-tiny',
        response: {
          url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order/1.0/',
          status: 200
        }
      })

      mockResponses['req-tiny'] = '{"ret":["FAIL"]}'

      webContents._emitMessage('event', 'Network.loadingFinished', {
        requestId: 'req-tiny'
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      expect(capture.getCaptured()).toHaveLength(0)
    })

    it('应跳过未在 pendingRequests 中的 requestId', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      webContents._emitMessage('event', 'Network.loadingFinished', {
        requestId: 'nonexistent'
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      expect(capture.getCaptured()).toHaveLength(0)
    })

    it('应处理 GetResponseBody 失败', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      webContents._emitMessage('event', 'Network.responseReceived', {
        requestId: 'req-fail',
        response: {
          url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order/1.0/',
          status: 200
        }
      })

      // 让 sendCommand 在 GetResponseBody 时抛异常
      webContents.debugger.sendCommand.mockImplementation(async (method, params) => {
        if (method === 'Network.getResponseBody') throw new Error('no body')
        if (method === 'Network.enable') return {}
        return {}
      })

      webContents._emitMessage('event', 'Network.loadingFinished', {
        requestId: 'req-fail'
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      // 不应崩溃，且不应有捕获结果
      expect(capture.getCaptured()).toHaveLength(0)
    })
  })

  describe('_handleCDPEvent - Network.loadingFailed', () => {
    it('应从 pendingRequests 中移除失败的请求', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      webContents._emitMessage('event', 'Network.responseReceived', {
        requestId: 'req-fail-load',
        response: {
          url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order/1.0/',
          status: 200
        }
      })

      expect(capture.pendingRequests.has('req-fail-load')).toBe(true)

      webContents._emitMessage('event', 'Network.loadingFailed', {
        requestId: 'req-fail-load'
      })

      expect(capture.pendingRequests.has('req-fail-load')).toBe(false)
    })
  })

  describe('getCaptured()', () => {
    it('应返回已捕获的响应并清空列表', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      // 模拟两个 API 响应
      mockResponses['req-a'] = '{"ret":["SUCCESS::调用成功"],"data":{"shopInfo_1":{"id":"A","fields":{"tradeTitle":"已发货"}}}}'
      mockResponses['req-b'] = '{"ret":["SUCCESS::调用成功"],"data":{"shopInfo_2":{"id":"B","fields":{"tradeTitle":"待发货"}}}}'

      for (const reqId of ['req-a', 'req-b']) {
        webContents._emitMessage('event', 'Network.responseReceived', {
          requestId: reqId,
          response: {
            url: `https://h5api.m.taobao.com/h5/mtop.taobao.order/1.0/?req=${reqId}`,
            status: 200
          }
        })
        webContents._emitMessage('event', 'Network.loadingFinished', {
          requestId: reqId
        })
      }

      await new Promise(resolve => setTimeout(resolve, 100))

      const first = capture.getCaptured()
      expect(first).toHaveLength(2)

      // 第二次调用应返回空（已清空）
      const second = capture.getCaptured()
      expect(second).toHaveLength(0)
    })
  })

  describe('getAllCaptured()', () => {
    it('应返回所有已捕获的响应但不清空列表', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      mockResponses['req-c'] = '{"ret":["SUCCESS::调用成功"],"data":{"shopInfo_3":{"id":"C","fields":{"tradeTitle":"已签收"}}}}'

      webContents._emitMessage('event', 'Network.responseReceived', {
        requestId: 'req-c',
        response: {
          url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order/1.0/',
          status: 200
        }
      })
      webContents._emitMessage('event', 'Network.loadingFinished', {
        requestId: 'req-c'
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      const all = capture.getAllCaptured()
      expect(all).toHaveLength(1)

      // 再次调用仍能获取
      const allAgain = capture.getAllCaptured()
      expect(allAgain).toHaveLength(1)
    })
  })

  describe('detach()', () => {
    it('应成功 detach 并清理状态', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()
      expect(capture.attached).toBe(true)

      await capture.detach()
      expect(capture.attached).toBe(false)
      expect(webContents.debugger.detach).toHaveBeenCalled()
    })

    it('应处理 detach 时 webContents 已销毁的情况', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()
      webContents._setDestroyed(true)

      // 不应抛出异常
      await capture.detach()
      expect(capture.attached).toBe(false)
    })

    it('应处理 detach 失败的情况', async () => {
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()
      webContents.debugger.detach.mockImplementation(() => {
        throw new Error('already detached')
      })

      await capture.detach()
      expect(capture.attached).toBe(false)
    })
  })
})

// ============ CDP 端到端流程测试 ============

describe('CDP 端到端同步流程', () => {
  it('模拟完整的淘宝 mtop API 捕获流程', async () => {
    const webContents = createMockWebContents()
    const apiKeywords = ['mtop.taobao.order']
    const capture = new CDPNetworkCapture(webContents, apiKeywords)

    // 1. Attach
    const attached = await capture.attach()
    expect(attached).toBe(true)

    // 2. 模拟页面加载，触发 mtop API 请求
    const mtopResponseBody = JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: {
        shopInfo_380847555: {
          id: '380847555123456',
          fields: { tradeTitle: '卖家已发货' }
        },
        orderStatus_380847555: {
          id: '380847555123456',
          fields: {
            mailNo: 'YT9388278500899',
            cpCode: 'YTO',
            title: '运输中'
          }
        },
        orderLogistics_380847555: {
          id: '380847555123456',
          fields: {
            packagePreview: {
              packageViewList: [{ cpName: '圆通速递' }]
            }
          }
        }
      }
    })

    mockResponses['req-mtop-1'] = mtopResponseBody

    // 3. 模拟 CDP 事件流：responseReceived → loadingFinished
    webContents._emitMessage('event', 'Network.responseReceived', {
      requestId: 'req-mtop-1',
      response: {
        url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/?data=...',
        status: 200,
        mimeType: 'application/json'
      }
    })

    webContents._emitMessage('event', 'Network.loadingFinished', {
      requestId: 'req-mtop-1'
    })

    await new Promise(resolve => setTimeout(resolve, 100))

    // 4. 获取捕获结果
    const captured = capture.getCaptured()
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toContain('mtop.taobao.order')
    expect(captured[0].status).toBe(200)

    // 5. 用解析函数验证捕获的数据可正确解析
    const { parseTaobaoH5Response, findOrderByPlatformOrderNo } = await import('./browser-sync-helpers.js')
    const orders = parseTaobaoH5Response(captured[0].body)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('380847555123456')
    expect(orders[0].logistics_company).toBe('圆通速递')

    // 6. 验证查找功能
    const found = findOrderByPlatformOrderNo('taobao', '380847555123456', captured)
    expect(found).not.toBeNull()
    expect(found.order_no).toBe('380847555123456')

    // 7. Detach
    await capture.detach()
    expect(capture.attached).toBe(false)
  })

  it('模拟多个 API 响应的捕获（含无关请求过滤）', async () => {
    const webContents = createMockWebContents()
    const capture = new CDPNetworkCapture(webContents, ['mtop.taobao.order'])

    await capture.attach()

    // 模拟多个并发请求（只有 mtop 匹配）
    const requests = [
      { id: 'img-1', url: 'https://img.alicdn.com/style.css', status: 200, body: 'body { color: red; }' },
      { id: 'mtop-1', url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/', status: 200, body: '{"ret":["SUCCESS::调用成功"],"data":{"shopInfo_1":{"id":"ORD-1","fields":{"tradeTitle":"已发货"}}}}' },
      { id: 'js-1', url: 'https://g.alicdn.com/mtb/lib-app.js', status: 200, body: 'var a=1;function b(){return 2}' },
      { id: 'mtop-2', url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order.detail/1.0/', status: 200, body: '{"ret":["SUCCESS::调用成功"],"data":{"shopInfo_2":{"id":"ORD-2","fields":{"tradeTitle":"待发货"}}}}' },
    ]

    for (const req of requests) {
      mockResponses[req.id] = req.body
      webContents._emitMessage('event', 'Network.responseReceived', {
        requestId: req.id,
        response: { url: req.url, status: req.status, mimeType: 'text/plain' }
      })
      webContents._emitMessage('event', 'Network.loadingFinished', {
        requestId: req.id
      })
    }

    await new Promise(resolve => setTimeout(resolve, 100))

    // 只应捕获 mtop 请求
    const captured = capture.getCaptured()
    expect(captured).toHaveLength(2)
    expect(captured.every(r => r.url.includes('mtop.taobao.order'))).toBe(true)
  })

  it('模拟 1688 平台 API 捕获', async () => {
    const webContents = createMockWebContents()
    const capture = new CDPNetworkCapture(webContents, ['orderList', 'trade'])

    await capture.attach()

    mockResponses['ali-1'] = JSON.stringify({
      data: [{ orderId: '1688-001', statusText: '已发货', logisticsOrderNo: 'ZTO123' }]
    })

    webContents._emitMessage('event', 'Network.responseReceived', {
      requestId: 'ali-1',
      response: { url: 'https://trade.1688.com/order/orderList.htm', status: 200 }
    })
    webContents._emitMessage('event', 'Network.loadingFinished', {
      requestId: 'ali-1'
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    const captured = capture.getCaptured()
    expect(captured).toHaveLength(1)

    const { parse1688OrderResponse } = await import('./browser-sync-helpers.js')
    const orders = parse1688OrderResponse(captured[0].body)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('1688-001')
    expect(orders[0].logistics_no).toBe('ZTO123')
  })

  it('模拟拼多平台 API 捕获', async () => {
    const webContents = createMockWebContents()
    const capture = new CDPNetworkCapture(webContents, ['orderList', 'orders'])

    await capture.attach()

    mockResponses['pdd-1'] = JSON.stringify({
      data: { list: [{ order_sn: 'PDD-001', order_status_text: '已发货', shipping_no: 'SF456' }] }
    })

    webContents._emitMessage('event', 'Network.responseReceived', {
      requestId: 'pdd-1',
      response: { url: 'https://mobile.yangkeduo.com/proxy/api/orders/list', status: 200 }
    })
    webContents._emitMessage('event', 'Network.loadingFinished', {
      requestId: 'pdd-1'
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    const captured = capture.getCaptured()
    expect(captured).toHaveLength(1)

    const { parsePddOrderResponse } = await import('./browser-sync-helpers.js')
    const orders = parsePddOrderResponse(captured[0].body)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('PDD-001')
    expect(orders[0].logistics_no).toBe('SF456')
  })

  it('模拟 CDP attach 失败后重试成功', async () => {
    let attachCallCount = 0
    const webContents = createMockWebContents()

    // 第一次 attach 失败，第二次成功
    const origAttach = webContents.debugger.attach
    webContents.debugger.attach = vi.fn(() => {
      attachCallCount++
      if (attachCallCount === 1) throw new Error('target not ready')
      // 第二次成功
    })

    const capture1 = new CDPNetworkCapture(webContents, ['mtop.taobao.order'])
    const result1 = await capture1.attach()
    expect(result1).toBe(false)

    // 重试
    const capture2 = new CDPNetworkCapture(webContents, ['mtop.taobao.order'])
    const result2 = await capture2.attach()
    expect(result2).toBe(true)
  })

  it('模拟 JSONP 请求（script 标签加载）也能被 CDP 捕获', async () => {
    const webContents = createMockWebContents()
    const capture = new CDPNetworkCapture(webContents, ['mtop.taobao.order'])

    await capture.attach()

    // JSONP 响应：callback 包裹的 JSON
    const jsonpBody = 'mtopjsonp1({"ret":["SUCCESS::调用成功"],"data":{"shopInfo_99":{"id":"JSONP-ORDER","fields":{"tradeTitle":"已发货"}}}})'

    mockResponses['req-jsonp'] = jsonpBody

    webContents._emitMessage('event', 'Network.responseReceived', {
      requestId: 'req-jsonp',
      response: {
        url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/?callback=mtopjsonp1',
        status: 200,
        mimeType: 'application/x-javascript'
      }
    })
    webContents._emitMessage('event', 'Network.loadingFinished', {
      requestId: 'req-jsonp'
    })

    await new Promise(resolve => setTimeout(resolve, 50))

    const captured = capture.getCaptured()
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toContain('mtop.taobao.order')
    // CDP 能捕获 JSONP，但解析需要去掉 callback 包裹
    // 这是 CDP 方案相比 JS 注入方案的关键优势
    expect(captured[0].body).toContain('mtopjsonp1')
  })
})
