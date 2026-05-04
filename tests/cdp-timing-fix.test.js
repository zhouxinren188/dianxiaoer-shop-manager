/**
 * CDP Attach 时序修复专项测试
 * 验证：CDP debugger.attach 必须在 did-navigate 事件后执行，
 * 不能在 loadURL 之前执行（否则会报 "target closed while handling command" 错误）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CDPNetworkCapture } from './browser-sync-helpers.js'

// ============ 模拟窗口生命周期 ============

/**
 * 创建模拟的 Electron 窗口生命周期
 * 模拟事件流: new BrowserWindow → loadURL → did-navigate → dom-ready → did-finish-load
 */
function createWindowLifecycle() {
  const eventHandlers = {
    'did-navigate': [],
    'dom-ready': [],
    'did-finish-load': []
  }

  const messageListeners = []
  let destroyed = false
  let targetReady = false // 模拟 Chromium target 是否 ready
  let attachCallCount = 0
  const responseBodyMap = {}

  const mockDebugger = {
    attach: vi.fn((protocolVersion) => {
      attachCallCount++
      // 关键模拟：如果 target 还没 ready（即还没 did-navigate），
      // debugger.attach 会抛出 "target closed" 错误
      if (!targetReady) {
        throw new Error('target closed while handling command')
      }
    }),
    detach: vi.fn(),
    on: vi.fn((event, callback) => {
      if (event === 'message') messageListeners.push(callback)
    }),
    off: vi.fn(),
    sendCommand: vi.fn(async (method, params) => {
      if (method === 'Network.enable') return {}
      if (method === 'Network.getResponseBody') {
        return { body: responseBodyMap[params.requestId] || '', base64Encoded: false }
      }
      return {}
    })
  }

  const webContents = {
    debugger: mockDebugger,
    isDestroyed: vi.fn(() => destroyed),
    on: vi.fn((event, handler) => {
      if (eventHandlers[event]) {
        eventHandlers[event].push(handler)
      }
    }),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    getURL: vi.fn(() => 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'),
    setBackgroundThrottling: vi.fn(),
    // 以下为测试辅助方法
    _emitEvent(event, ...args) {
      for (const handler of eventHandlers[event] || []) {
        handler(...args)
      }
    },
    _emitCDPMessage(method, params) {
      for (const cb of messageListeners) {
        cb('event', method, params)
      }
    },
    _setTargetReady(v) { targetReady = v },
    _setDestroyed(v) { destroyed = v },
    _setResponseBody(requestId, body) { responseBodyMap[requestId] = body },
    _getAttachCallCount: () => attachCallCount,
    _resetAttachCount: () => { attachCallCount = 0 }
  }

  return webContents
}

// ============ 测试用例 ============

describe('CDP Attach 时序修复', () => {
  let webContents
  const apiKeywords = ['mtop.taobao.order']

  beforeEach(() => {
    webContents = createWindowLifecycle()
  })

  describe('Bug 复现：在 loadURL 前 attach 会失败', () => {
    it('应该在 target 未 ready 时（loadURL 前）attach 失败', async () => {
      // 模拟 Bug 场景：在 loadURL 之前就调用 debugger.attach
      // 此时 Chromium 的 target 尚未准备好
      webContents._setTargetReady(false) // target 未 ready

      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      const result = await capture.attach()

      expect(result).toBe(false)
      expect(capture.attached).toBe(false)
      expect(webContents.debugger.attach).toHaveBeenCalled()
    })

    it('应该在 "target closed" 错误后不崩溃', async () => {
      webContents._setTargetReady(false)

      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      const result = await capture.attach()

      // 不应抛出异常，而是返回 false
      expect(result).toBe(false)
      // 不应影响后续重试
      expect(capture.capturedResponses).toEqual([])
    })
  })

  describe('修复验证：在 did-navigate 后 attach 成功', () => {
    it('应该在 did-navigate 事件后成功 attach', async () => {
      // 模拟修复后的流程：
      // 1. 创建窗口（target 未 ready）
      // 2. loadURL
      // 3. did-navigate 事件触发（target 变为 ready）
      // 4. 在 did-navigate 回调中 attach CDP

      const capture = new CDPNetworkCapture(webContents, apiKeywords)

      // 模拟 loadURL 前 attach失败
      webContents._setTargetReady(false)
      const beforeResult = await capture.attach()
      expect(beforeResult).toBe(false)

      // 模拟 did-navigate 事件（target 变为 ready）
      webContents._setTargetReady(true)
      const afterResult = await capture.attach()
      expect(afterResult).toBe(true)
      expect(capture.attached).toBe(true)
    })

    it('应该在 did-navigate 后立即开始捕获 API 响应', async () => {
      webContents._setTargetReady(true)
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      // 模拟 mtop API 响应
      const mtopBody = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: { shopInfo_1: { id: 'ORDER-001', fields: { tradeTitle: '已发货' } } }
      })
      webContents._setResponseBody('req-1', mtopBody)

      // 发送 CDP 事件
      webContents._emitCDPMessage('Network.responseReceived', {
        requestId: 'req-1',
        response: {
          url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/',
          status: 200
        }
      })
      webContents._emitCDPMessage('Network.loadingFinished', {
        requestId: 'req-1'
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      const captured = capture.getCaptured()
      expect(captured).toHaveLength(1)
      expect(captured[0].url).toContain('mtop.taobao.order')
    })
  })

  describe('完整窗口生命周期模拟', () => {
    it('模拟完整的单订单同步流程事件序列', async () => {
      let cdpAttached = false
      let cdpCapture = null

      // === 模拟 syncSingleOrderByBrowser 的核心流程 ===

      // Step 1: 创建 BrowserWindow（注册事件回调，不 attach CDP）
      // （不再在 loadURL 前调用 cdpCapture.attach()）

      webContents.on('did-navigate', async (event, url) => {
        // Step 2: did-navigate 后 attach CDP
        if (!cdpAttached) {
          webContents._setTargetReady(true) // target 现在已 ready
          cdpCapture = new CDPNetworkCapture(webContents, apiKeywords)
          cdpAttached = await cdpCapture.attach()
        }
      })

      webContents.on('dom-ready', () => {
        // Step 3: dom-ready 时注入可见性覆盖
        // 如果 CDP 尚未 attach，在此重试
        if (!cdpAttached) {
          webContents._setTargetReady(true)
          cdpCapture = new CDPNetworkCapture(webContents, apiKeywords)
          cdpCapture.attach().then(ok => { cdpAttached = ok })
        }
      })

      // 模拟 loadURL
      // → 触发 did-navigate
      webContents._emitEvent('did-navigate', {}, 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm')

      // 等待异步 attach
      await new Promise(resolve => setTimeout(resolve, 50))

      // CDP 应成功 attach
      expect(cdpAttached).toBe(true)
      expect(cdpCapture).not.toBeNull()
      expect(cdpCapture.attached).toBe(true)

      // → 触发 dom-ready
      webContents._emitEvent('dom-ready')

      // → 触发 did-finish-load
      webContents._emitEvent('did-finish-load')

      // 模拟 mtop API 请求被 CDP 捕获
      const mtopBody = JSON.stringify({
        ret: ['SUCCESS::调用成功'],
        data: {
          shopInfo_5113: { id: '5113222887354003142', fields: { tradeTitle: '卖家已发货' } },
          orderStatus_5113: {
            id: '5113222887354003142',
            fields: { mailNo: '435156419889626', cpCode: 'YUNDA', title: '派送中' }
          },
          orderLogistics_5113: {
            id: '5113222887354003142',
            fields: { packagePreview: { packageViewList: [{ cpName: '韵达快递' }] } }
          }
        }
      })
      webContents._setResponseBody('req-mtop', mtopBody)

      webContents._emitCDPMessage('Network.responseReceived', {
        requestId: 'req-mtop',
        response: {
          url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/',
          status: 200
        }
      })
      webContents._emitCDPMessage('Network.loadingFinished', {
        requestId: 'req-mtop'
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      // 轮询读取捕获结果
      const captured = cdpCapture.getCaptured()
      expect(captured).toHaveLength(1)

      // 解析并查找目标订单
      const { findOrderByPlatformOrderNo } = await import('./browser-sync-helpers.js')
      const orderInfo = findOrderByPlatformOrderNo('taobao', '5113222887354003142', captured)
      expect(orderInfo).not.toBeNull()
      expect(orderInfo.order_no).toBe('5113222887354003142')
      expect(orderInfo.status).toBe('卖家已发货')
      expect(orderInfo.logistics_no).toBe('435156419889626')
      expect(orderInfo.logistics_company).toBe('韵达快递')
      expect(orderInfo.logistics_status).toBe('派送中')
    })

    it('模拟 dom-ready 兜底 attach 场景', async () => {
      let cdpAttached = false
      let cdpCapture = null

      webContents.on('did-navigate', async (event, url) => {
        // did-navigate 时 attach 失败（模拟极端情况）
        // 不设置 targetReady
        if (!cdpAttached) {
          cdpCapture = new CDPNetworkCapture(webContents, apiKeywords)
          cdpAttached = await cdpCapture.attach()
        }
      })

      webContents.on('dom-ready', async () => {
        // dom-ready 时 target 一定已 ready
        if (!cdpAttached) {
          webContents._setTargetReady(true)
          cdpCapture = new CDPNetworkCapture(webContents, apiKeywords)
          cdpAttached = await cdpCapture.attach()
        }
      })

      // did-navigate 时 target 未 ready → attach 失败
      webContents._emitEvent('did-navigate', {}, 'https://buyertrade.taobao.com/...')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(cdpAttached).toBe(false)

      // dom-ready 时 target 已 ready → attach 成功
      webContents._emitEvent('dom-ready')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(cdpAttached).toBe(true)
      expect(cdpCapture.attached).toBe(true)
    })
  })

  describe('登录检测与 CDP attach 交互', () => {
    it('应在登录页面上不 attach CDP（直接返回 needsRelogin）', async () => {
      const loginUrl = 'https://login.taobao.com/newlogin/login.htm'
      let cdpAttached = false

      webContents.on('did-navigate', async (event, url) => {
        // 登录页面不应 attach CDP
        const isLoginPage = url.toLowerCase().includes('login.taobao.com')
        if (isLoginPage) return // 不 attach

        if (!cdpAttached) {
          webContents._setTargetReady(true)
          const capture = new CDPNetworkCapture(webContents, apiKeywords)
          cdpAttached = await capture.attach()
        }
      })

      // 导航到登录页
      webContents._emitEvent('did-navigate', {}, loginUrl)
      await new Promise(resolve => setTimeout(resolve, 50))

      // CDP 不应 attach
      expect(cdpAttached).toBe(false)
    })
  })

  describe('CDP attach 只执行一次', () => {
    it('应在多次 did-navigate 中只 attach 一次', async () => {
      let cdpAttached = false
      let attachAttempts = 0

      webContents.on('did-navigate', async (event, url) => {
        if (!cdpAttached) {
          attachAttempts++
          webContents._setTargetReady(true)
          const capture = new CDPNetworkCapture(webContents, apiKeywords)
          cdpAttached = await capture.attach()
        }
      })

      // 第一次导航
      webContents._emitEvent('did-navigate', {}, 'https://buyertrade.taobao.com/...')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(cdpAttached).toBe(true)
      expect(attachAttempts).toBe(1)

      // 第二次导航（SPA 内部跳转）
      webContents._emitEvent('did-navigate', {}, 'https://buyertrade.taobao.com/other')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(attachAttempts).toBe(1) // 不应重复 attach
    })
  })

  describe('window 销毁时 CDP 清理', () => {
    it('应在窗口销毁时安全 detach CDP', async () => {
      webContents._setTargetReady(true)
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()
      expect(capture.attached).toBe(true)

      // 模拟窗口销毁
      webContents._setDestroyed(true)
      await capture.detach()

      expect(capture.attached).toBe(false)
    })

    it('应在窗口已销毁时不再尝试 fetchResponseBody', async () => {
      webContents._setTargetReady(true)
      const capture = new CDPNetworkCapture(webContents, apiKeywords)
      await capture.attach()

      // 先接收 responseReceived
      webContents._emitCDPMessage('Network.responseReceived', {
        requestId: 'req-dying',
        response: {
          url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order/1.0/',
          status: 200
        }
      })

      // 然后窗口销毁
      webContents._setDestroyed(true)

      // loadingFinished 事件到来，但窗口已销毁
      webContents._emitCDPMessage('Network.loadingFinished', {
        requestId: 'req-dying'
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      // 不应崩溃，且不应有捕获结果（因为 getResponseBody 会被跳过）
      const captured = capture.getCaptured()
      expect(captured).toHaveLength(0)
    })
  })

  describe('对比：旧方案 vs 新方案', () => {
    it('旧方案（loadURL 前 attach）会失败，新方案（did-navigate 后 attach）成功', async () => {
      // === 旧方案（Bug）：在 loadURL 前 attach ===
      webContents._setTargetReady(false) // loadURL 前没 target
      const oldCapture = new CDPNetworkCapture(webContents, apiKeywords)
      const oldResult = await oldCapture.attach()
      expect(oldResult).toBe(false) // "target closed" 错误

      // === 新方案（修复）：在 did-navigate 后 attach ===
      // 模拟 did-navigate 事件（表示页面开始导航，target 已 ready）
      webContents._setTargetReady(true)
      const newCapture = new CDPNetworkCapture(webContents, apiKeywords)
      const newResult = await newCapture.attach()
      expect(newResult).toBe(true) // 成功！
    })
  })
})
