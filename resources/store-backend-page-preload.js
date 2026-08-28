'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const ORDER_PURCHASE_ACTION_CHANNEL = 'store-backend-order-purchase-action'
const PENDING_METRIC_CHANNEL = 'store-backend-pending-metric-observed'
const PENDING_METRIC_MESSAGE_SOURCE = 'DXE_PENDING_METRIC_CAPTURE_V1'
const AFTERSALE_ORDER_MESSAGE_SOURCE = 'DXE_AFTERSALE_ORDER_CAPTURE_V1'
const AFTERSALE_ORDER_CAPTURE_NONCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

// 售后详情 URL 只有 afsServiceId。这里在 document_start 观察京东自己的详情接口响应，
// 只把响应中明确命名的销售订单号回传给主进程，不读取或传递 Cookie、请求头和售后内容。
try {
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return
    const message = event.data
    if (!message || message.source !== AFTERSALE_ORDER_MESSAGE_SOURCE || message.nonce !== AFTERSALE_ORDER_CAPTURE_NONCE) return
    const observation = message.observation || {}
    ipcRenderer.invoke(ORDER_PURCHASE_ACTION_CHANNEL, {
      action: 'resolve-aftersale-order',
      afsServiceId: String(observation.afsServiceId || ''),
      orderId: String(observation.orderId || ''),
      evidence: String(observation.evidence || 'network_response').slice(0, 80)
    }).catch(() => {})
  })

  contextBridge.executeInMainWorld({
    func: (messageSource, captureNonce) => {
      if (location.hostname.toLowerCase() !== 'shop.jd.com'
        || !location.pathname.startsWith('/jdm/trade/after-sale/independent-after-sale/detail')
        || window.__DXE_AFTERSALE_ORDER_CAPTURE_INSTALLED__) {
        return false
      }
      const afsServiceId = String(new URL(location.href).searchParams.get('afsServiceId') || '').trim()
      if (!/^\d{6,30}$/.test(afsServiceId)) return false
      window.__DXE_AFTERSALE_ORDER_CAPTURE_INSTALLED__ = true

      const orderKeys = new Set([
        'orderid', 'orderno', 'orderidstr', 'ordernumber',
        'jdorderid', 'mainorderid', 'parentorderid', 'ordercode'
      ])
      let publishedOrderId = ''

      function normalizeOrderId(value) {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) return ''
        const text = String(value == null ? '' : value).trim()
        return /^\d{10,30}$/.test(text) && text !== afsServiceId ? text : ''
      }

      function findOrderId(value, visited = new WeakSet(), depth = 0) {
        if (!value || typeof value !== 'object' || depth > 8 || visited.has(value)) return ''
        visited.add(value)
        for (const [key, child] of Object.entries(value)) {
          const normalizedKey = String(key).replace(/[_-]/g, '').toLowerCase()
          if (!orderKeys.has(normalizedKey)) continue
          const orderId = normalizeOrderId(child)
          if (orderId) return orderId
        }
        for (const child of Object.values(value)) {
          const orderId = findOrderId(child, visited, depth + 1)
          if (orderId) return orderId
        }
        return ''
      }

      function publish(orderId, evidence) {
        const normalized = normalizeOrderId(orderId)
        if (!normalized || normalized === publishedOrderId) return
        publishedOrderId = normalized
        window.postMessage({
          source: messageSource,
          nonce: captureNonce,
          observation: { afsServiceId, orderId: normalized, evidence }
        }, location.origin)
      }

      function inspectResponse(value, evidence) {
        const orderId = findOrderId(value)
        if (orderId) publish(orderId, evidence)
      }

      const originalFetch = window.fetch
      if (typeof originalFetch === 'function') {
        window.fetch = function(input) {
          const responseUrl = typeof input === 'string' ? input : input?.url || ''
          return originalFetch.apply(this, arguments).then(response => {
            response.clone().json().then(data => inspectResponse(data, `fetch:${new URL(responseUrl || response.url, location.href).hostname}`)).catch(() => {})
            return response
          })
        }
      }

      const originalOpen = XMLHttpRequest.prototype.open
      const originalSend = XMLHttpRequest.prototype.send
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__dxeAfterSaleResponseUrl = String(url || '')
        return originalOpen.apply(this, arguments)
      }
      XMLHttpRequest.prototype.send = function() {
        const xhr = this
        xhr.addEventListener('load', () => {
          try {
            const data = xhr.responseType === 'json'
              ? xhr.response
              : (!xhr.responseType || xhr.responseType === 'text' ? JSON.parse(xhr.responseText || 'null') : null)
            inspectResponse(data, `xhr:${new URL(xhr.__dxeAfterSaleResponseUrl || '', location.href).hostname}`)
          } catch (_) {}
        })
        return originalSend.apply(this, arguments)
      }
      return true
    },
    args: [AFTERSALE_ORDER_MESSAGE_SOURCE, AFTERSALE_ORDER_CAPTURE_NONCE]
  })
} catch (error) {
  console.error('[DXE_AFTERSALE_ORDER_PRELOAD] ' + String(error?.message || error))
}

// After a JD compliance business request completes, query the exact "pending
// violation orders" endpoint and report only its total. No page text, cookies,
// headers, violation details, or request bodies are forwarded to the main process.
try {
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return
    const message = event.data
    if (!message || message.source !== PENDING_METRIC_MESSAGE_SOURCE) return
    ipcRenderer.send(PENDING_METRIC_CHANNEL, message.observation || {})
  })

  contextBridge.executeInMainWorld({
    func: messageSource => {
      if (location.hostname.toLowerCase() !== 'illegal-jdm.shop.jd.com'
        || !/^\/legal(?:\/|$)/i.test(location.pathname)
        || window.__DXE_PENDING_METRIC_CAPTURE_INSTALLED__) {
        return false
      }
      window.__DXE_PENDING_METRIC_CAPTURE_INSTALLED__ = true

      const targetApi = 'dsm.pop.legal.shop.api.dsm.VednerPenaltyApiService.queryManualVenderPenaltyList'
      const targetUrl = `https://sff.jd.com/api?v=1.0&appId=SZKUFJRU4J5UGWSVLVUZ&api=${targetApi}`
      const pendingQueryBody = {
        param: {
          actionId: null,
          checkStatus: null,
          checkStatusSet: [6],
          createdBegin: null,
          createdEnd: null,
          examCheckStatus: null,
          illegalLevel: null,
          pageNum: 1,
          pageSize: 10,
          payCheckStatus: null,
          penaltyId: null,
          penaltyType: 1,
          category1Id: null,
          category2IdSet: null,
          radio1: '待处理',
          orderId: null,
          targetType: null,
          target: null,
          fhcsQueryType: null,
          reformStatus: null,
          appealStatus: null,
          category3IdSet: []
        }
      }
      const normalizedPendingQuery = {checkStatusSet: [6], penaltyType: 1, radio1: '待处理'}
      let freshQueryTimer = null
      let freshQuerySequence = 0

      function readApi(urlValue) {
        try {
          return new URL(String(urlValue || ''), location.href).searchParams.get('api') || ''
        } catch (_error) {
          return ''
        }
      }

      function isViolationBusinessRequest(urlValue) {
        try {
          const target = new URL(String(urlValue || ''), location.href)
          const api = target.searchParams.get('api') || ''
          return target.hostname.toLowerCase() === 'sff.jd.com'
            && api.startsWith('dsm.pop.legal.shop.api.')
        } catch (_error) {
          return false
        }
      }

      function parsePendingQuery(bodyValue) {
        try {
          const parsed = typeof bodyValue === 'string' ? JSON.parse(bodyValue) : bodyValue
          const param = parsed && typeof parsed === 'object' ? parsed.param : null
          const statuses = Array.isArray(param?.checkStatusSet) ? param.checkStatusSet.map(Number) : []
          const radio1 = String(param?.radio1 || '').trim()
          if (!statuses.includes(6) || Number(param?.penaltyType) !== 1 || radio1 !== '待处理') return null
          return {checkStatusSet: statuses, penaltyType: Number(param.penaltyType), radio1}
        } catch (_error) {
          return null
        }
      }

      function postObservation(value, query, evidence) {
        window.postMessage({
          source: messageSource,
          observation: {
            metric: 'pending_violations',
            value,
            api: targetApi,
            query,
            evidence,
            observedAt: Date.now()
          }
        }, location.origin)
      }

      function parsePendingResponseValue(responseText) {
        try {
          const response = JSON.parse(String(responseText || ''))
          const value = Number(response?.data?.totalCount)
          if (String(response?.code) !== '200'
            || !Number.isSafeInteger(value)
            || value < 0
            || value > 1000000) {
            return null
          }
          return value
        } catch (_error) {
          return null
        }
      }

      function scheduleFreshPendingQuery(delayMs = 100) {
        clearTimeout(freshQueryTimer)
        const sequence = ++freshQuerySequence
        freshQueryTimer = setTimeout(async () => {
          try {
            const response = await originalFetch(targetUrl, {
              method: 'POST',
              credentials: 'include',
              headers: {
                accept: 'application/json, text/plain, */*',
                'content-type': 'application/json;charset=UTF-8',
                'dsm-lang': 'undefined',
                'dsm-platform': 'pc',
                'dsm-site': 'undefined',
                'dsm-trace-id': `dxe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                'x-referer-page': 'https://illegal-jdm.shop.jd.com/legal',
                'x-requested-with': 'XMLHttpRequest',
                'x-rp-client': 'h5_2.4.0'
              },
              body: JSON.stringify(pendingQueryBody)
            })
            const text = await response.text()
            if (sequence !== freshQuerySequence) return
            const value = parsePendingResponseValue(text)
            if (!response.ok || value === null) throw new Error(`status=${response.status}`)
            postObservation(value, normalizedPendingQuery, 'active_query')
          } catch (error) {
            if (sequence !== freshQuerySequence) return
            console.warn('[DXE_PENDING_METRIC] active query failed: ' + String(error?.message || error))
          }
        }, delayMs)
      }

      function publishResponse(urlValue, requestBody, responseText) {
        if (readApi(urlValue) !== targetApi) return
        const query = parsePendingQuery(requestBody)
        if (!query) return
        const value = parsePendingResponseValue(responseText)
        if (value === null) return
        // Always replace the page-owned response with one fresh strict query.
        scheduleFreshPendingQuery(100)
      }

      const originalFetch = window.fetch
      window.fetch = function(input, init) {
        const urlValue = typeof input === 'string' ? input : input?.url || ''
        const requestBody = init?.body
        return originalFetch.apply(this, arguments).then(response => {
          if (readApi(urlValue) === targetApi) {
            response.clone().text()
              .then(text => publishResponse(urlValue, requestBody, text))
              .catch(() => {})
          } else if (isViolationBusinessRequest(urlValue)) {
            // Processing requests use the same legal API family. Once any of
            // them completes, query the strict pending list again instead of
            // trusting the page label or a particular action API name.
            scheduleFreshPendingQuery(50)
          }
          return response
        })
      }

      const originalOpen = XMLHttpRequest.prototype.open
      const originalSend = XMLHttpRequest.prototype.send
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__dxePendingMetricUrl = String(url || '')
        return originalOpen.apply(this, arguments)
      }
      XMLHttpRequest.prototype.send = function(body) {
        const xhr = this
        const urlValue = xhr.__dxePendingMetricUrl || ''
        if (isViolationBusinessRequest(urlValue)) {
          xhr.addEventListener('load', () => {
            if (readApi(urlValue) === targetApi) {
              try {
                const responseText = xhr.responseType === 'json'
                  ? JSON.stringify(xhr.response)
                  : (!xhr.responseType || xhr.responseType === 'text' ? xhr.responseText || '' : '')
                if (responseText) publishResponse(urlValue, body, responseText)
              } catch (_error) {
                // Ignore unsupported XHR response types.
              }
            } else {
              scheduleFreshPendingQuery(50)
            }
          })
        }
        return originalSend.apply(this, arguments)
      }

      return true
    },
    args: [PENDING_METRIC_MESSAGE_SOURCE]
  })
} catch (error) {
  console.error('[DXE_PENDING_METRIC_PRELOAD] ' + String(error?.message || error))
}

// The warning center's default list uses handlingState=-1 (all reminders).
// Query handlingState=0 directly so the dashboard stores only reminders that
// still require a reply. Only the resulting count is sent to the main process.
try {
  contextBridge.executeInMainWorld({
    func: messageSource => {
      if (location.hostname.toLowerCase() !== 'shop.jd.com'
        || !/^\/jdm\/trade\/risk\/warning-center(?:\/|$)/i.test(location.pathname)
        || window.__DXE_PENDING_FOLLOW_UP_CAPTURE_INSTALLED__) {
        return false
      }
      window.__DXE_PENDING_FOLLOW_UP_CAPTURE_INSTALLED__ = true

      const queryApi = 'dsm.seller.around.center.soa.service.dsm.OrderDeliveryCuidanDsmService.queryCuiDanListByPage'
      const replyApi = 'dsm.seller.around.center.soa.service.dsm.OrderDeliveryCuidanDsmService.singleDanHuiFu'
      const requestAppId = 'J6SM1KFJ6ZK4OHOXRKO2'
      const defaultBusinessId = '0248a'
      const apiVersion = '1.0'
      const pendingQuery = {handlingState: 0}
      const pendingQueryBody = {
        cuiDanQuery: {
          orderId: null,
          orderCreateDateRange: null,
          handlingState: 0,
          page: 1,
          pageSize: 10
        },
        accessContext: {source: 'web'}
      }
      const originalFetch = window.fetch
      let queryTimer = null
      let querySequence = 0

      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

      function readApi(urlValue) {
        try {
          return new URL(String(urlValue || ''), location.href).searchParams.get('api') || ''
        } catch (_error) {
          return ''
        }
      }

      function parseBody(value) {
        try {
          return typeof value === 'string' ? JSON.parse(value) : value
        } catch (_error) {
          return null
        }
      }

      function isPendingQueryBody(value) {
        const body = parseBody(value)
        return Number(body?.cuiDanQuery?.handlingState) === 0
      }

      function parseResponse(value) {
        try {
          return typeof value === 'string' ? JSON.parse(value) : value
        } catch (_error) {
          return null
        }
      }

      function readPendingCount(value) {
        const response = parseResponse(value)
        const count = Number(response?.data?.totalCount)
        if (String(response?.code) !== '200'
          || !Number.isSafeInteger(count)
          || count < 0
          || count > 1000000) {
          return null
        }
        return count
      }

      function postObservation(value, evidence) {
        window.postMessage({
          source: messageSource,
          observation: {
            metric: 'pending_follow_ups',
            value,
            api: queryApi,
            query: pendingQuery,
            evidence,
            observedAt: Date.now()
          }
        }, location.origin)
      }

      async function waitForSecuritySdk(timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const config = window.__DSM_SECURITY_CONFIG || {}
          if (config.securitySdkReady) {
            try {
              await config.securitySdkReady
            } catch (_error) {
              // Continue with the concrete readiness checks below.
            }
          }
          if (typeof window.ParamsSign === 'function' && window.CryptoJS?.SHA256) {
            return config
          }
          await sleep(150)
        }
        throw new Error('security sdk not ready')
      }

      function readJsTokenOnce(timeoutMs = 3000) {
        if (typeof window.getJsToken !== 'function') return Promise.resolve('')
        return new Promise(resolve => {
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            resolve('')
          }, timeoutMs + 500)
          try {
            window.getJsToken(result => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve(result?.jsToken || '')
            }, timeoutMs)
          } catch (_error) {
            clearTimeout(timer)
            resolve('')
          }
        })
      }

      async function getRequiredJsToken(timeoutMs = 12000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const remaining = Math.max(800, deadline - Date.now())
          const token = await readJsTokenOnce(Math.min(3000, remaining))
          if (token) return token
          await sleep(300)
        }
        throw new Error('device token not ready')
      }

      async function queryPendingFollowUps(evidence = 'active_query') {
        const bodyText = JSON.stringify(pendingQueryBody)
        const [config, eid] = await Promise.all([
          waitForSecuritySdk(),
          getRequiredJsToken()
        ])
        const businessId = config.securityWhiteList?.[queryApi]
          || config.defaultBusinessId
          || defaultBusinessId
        const signer = new window.ParamsSign({
          appId: businessId,
          preRequest: false,
          debug: false,
          onSign() {}
        })
        const bodyHash = window.CryptoJS.SHA256(bodyText).toString().toUpperCase()
        const signed = await signer.sign({
          body: bodyHash,
          appId: requestAppId,
          api: queryApi,
          v: apiVersion
        })
        if (!signed?.h5st) throw new Error('request signature unavailable')

        const endpoint = `https://sff.jd.com/api?v=${apiVersion}&appId=${requestAppId}&api=${encodeURIComponent(queryApi)}`
        const response = await originalFetch(endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json;charset=UTF-8',
            'dsm-eid': eid,
            'dsm-file-path': 'lineation-price',
            'dsm-platform': 'pc',
            'dsm-trace-id': `${Math.floor(4000000 + Math.random() * 7200000)}.41661.${Date.now()}`,
            h5st: encodeURI(signed.h5st),
            'x-referer-page': location.href,
            'x-requested-with': 'XMLHttpRequest',
            'x-rp-client': 'h5_2.4.0'
          },
          body: bodyText
        })
        const result = await response.json()
        const count = readPendingCount(result)
        if (!response.ok || count === null) {
          throw new Error(`query failed status=${response.status} code=${result?.code ?? 'unknown'}`)
        }
        postObservation(count, evidence)
      }

      function schedulePendingQuery(delayMs = 200) {
        clearTimeout(queryTimer)
        const sequence = ++querySequence
        queryTimer = setTimeout(() => {
          queryPendingFollowUps('active_query').catch(error => {
            if (sequence !== querySequence) return
            console.warn('[DXE_PENDING_FOLLOW_UP] ' + String(error?.message || error))
          })
        }, delayMs)
      }

      function scheduleAfterReply() {
        schedulePendingQuery(350)
        setTimeout(() => schedulePendingQuery(0), 1800)
      }

      window.fetch = function(input, init) {
        const urlValue = typeof input === 'string' ? input : input?.url || ''
        const api = readApi(urlValue)
        const requestBody = init?.body
        return originalFetch.apply(this, arguments).then(response => {
          if (api === queryApi && isPendingQueryBody(requestBody)) {
            response.clone().json().then(result => {
              const count = readPendingCount(result)
              if (count !== null) postObservation(count, 'response_capture')
            }).catch(() => {})
          } else if (api === replyApi) {
            response.clone().json().then(result => {
              if (String(result?.code) === '200') scheduleAfterReply()
            }).catch(() => {})
          }
          return response
        })
      }

      const originalOpen = XMLHttpRequest.prototype.open
      const originalSend = XMLHttpRequest.prototype.send
      XMLHttpRequest.prototype.open = function(method, url) {
        this.__dxePendingFollowUpUrl = String(url || '')
        return originalOpen.apply(this, arguments)
      }
      XMLHttpRequest.prototype.send = function(body) {
        const xhr = this
        const api = readApi(xhr.__dxePendingFollowUpUrl || '')
        if ((api === queryApi && isPendingQueryBody(body)) || api === replyApi) {
          xhr.addEventListener('load', () => {
            try {
              const result = xhr.responseType === 'json'
                ? xhr.response
                : (!xhr.responseType || xhr.responseType === 'text' ? parseResponse(xhr.responseText || '') : null)
              if (api === queryApi) {
                const count = readPendingCount(result)
                if (count !== null) postObservation(count, 'response_capture')
              } else if (String(result?.code) === '200') {
                scheduleAfterReply()
              }
            } catch (_error) {
              // Ignore unsupported XHR response types.
            }
          })
        }
        return originalSend.apply(this, arguments)
      }

      schedulePendingQuery(800)
      return true
    },
    args: [PENDING_METRIC_MESSAGE_SOURCE]
  })
} catch (error) {
  console.error('[DXE_PENDING_FOLLOW_UP_PRELOAD] ' + String(error?.message || error))
}

try {
  contextBridge.exposeInMainWorld('dxeStoreBackendBridge', {
    requestOrderPurchaseAction(payload = {}) {
      return ipcRenderer.invoke(ORDER_PURCHASE_ACTION_CHANNEL, {
        nonce: String(payload.nonce || ''),
        action: String(payload.action || ''),
        orderId: String(payload.orderId || ''),
        pageKey: String(payload.pageKey || ''),
        purchaseId: Number(payload.purchaseId) || 0,
        aftersaleStatus: String(payload.aftersaleStatus || ''),
        aftersaleRemark: String(payload.aftersaleRemark || '').slice(0, 2000)
      })
    }
  })
} catch (error) {
  console.error('[DXE_STORE_BACKEND_PRELOAD] ' + String(error?.message || error))
}

// 与原扩展的 document_start + world: MAIN 保持一致。仓库接口签名依赖
// 京麦页面主世界中的 ParamsSign、CryptoJS 与 getJsToken，不能等页面加载
// 完成后再把桥接和 UI 一起注入。
try {
  const smokeTestMode = process.argv.includes('--dxe-warehouse-preload-smoke')
  contextBridge.executeInMainWorld({
    func: testMode => {
      if (!testMode && (location.hostname !== 'shop.jd.com' ||
          !location.pathname.startsWith('/jdm/trade/warehousing/warehouse-manage'))) {
        return false
      }
      if (window.__ECOMMERCE_TOOLBOX_WAREHOUSE_BRIDGE__) return true
      window.__ECOMMERCE_TOOLBOX_WAREHOUSE_BRIDGE__ = true

      const REQUEST_SOURCE = 'ECOMMERCE_TOOLBOX_WAREHOUSE_EXTENSION_V1'
      const RESPONSE_SOURCE = 'ECOMMERCE_TOOLBOX_WAREHOUSE_PAGE_V1'
      const DIAGNOSTIC_PREFIX = '[DXE_WAREHOUSE_DIAG]'
      const REQUEST_APP_ID = 'KZFBL0OIH93MGTTRPGQK'
      const DEFAULT_SECURITY_BUSINESS_ID = '0248a'
      const API_VERSION = '1.0'
      const API = {
        regions: 'dsm.order.bff.PartitionWarehousePriorityService.getRegionHierarchyWithPriorityCounts',
        warehouses: 'dsm.order.bff.PartitionWarehousePriorityService.getConfigurableWarehousesByRegion',
        priorities: 'dsm.order.bff.PartitionWarehousePriorityService.getWarehousePrioritiesByRegion',
        save: 'dsm.order.bff.PartitionWarehousePriorityService.saveWarehousePriorityByRegionId'
      }
      const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

      function diagnostic(payload) {
        try {
          console.info(DIAGNOSTIC_PREFIX + JSON.stringify({
            time: new Date().toISOString(),
            ...payload
          }))
        } catch (_error) {
          // 诊断信息不能影响业务请求。
        }
      }

      async function waitForSecuritySdk(timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const config = window.__DSM_SECURITY_CONFIG || {}
          if (config.securitySdkReady) {
            try {
              await config.securitySdkReady
            } catch (_error) {
              // 继续使用下方具体就绪条件判断。
            }
          }
          if (typeof window.ParamsSign === 'function' && window.CryptoJS?.SHA256) {
            return { config }
          }
          await sleep(150)
        }
        throw new Error('京麦页面签名组件未就绪，请刷新仓库管理页面后重试')
      }

      function readJsTokenOnce(callbackTimeoutMs = 3000) {
        if (typeof window.getJsToken !== 'function') return Promise.resolve('')
        return new Promise(resolve => {
          let settled = false
          const timer = setTimeout(() => {
            if (settled) return
            settled = true
            resolve('')
          }, callbackTimeoutMs + 500)
          try {
            window.getJsToken(result => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve(result?.jsToken || '')
            }, callbackTimeoutMs)
          } catch (_error) {
            clearTimeout(timer)
            resolve('')
          }
        })
      }

      async function getRequiredJsToken(timeoutMs = 12000) {
        const deadline = Date.now() + timeoutMs
        let attempts = 0
        while (Date.now() < deadline) {
          attempts += 1
          const remaining = Math.max(800, deadline - Date.now())
          const token = await readJsTokenOnce(Math.min(3000, remaining))
          if (token) return { token, attempts }
          await sleep(300)
        }
        throw new Error('京麦设备凭证未就绪，请等待页面加载完成后重试')
      }

      function traceId() {
        const first = Math.floor(4000000 + Math.random() * 7200000)
        const suffix = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
        return `${first}.41661.${Date.now()}${suffix}`
      }

      function withPageContext(body) {
        const sourceBody = body && typeof body === 'object' ? body : {}
        const subScene = new URL(location.href).searchParams.get('subScene') || ''
        const request = {
          ...(sourceBody.request && typeof sourceBody.request === 'object' ? sourceBody.request : {}),
          source: '2000'
        }
        if (subScene) {
          request.dsmContext = {
            ...(request.dsmContext || {}),
            extensions: {
              ...(request.dsmContext?.extensions || {}),
              subScene
            }
          }
        }
        return { ...sourceBody, request }
      }

      async function signBody(api, body) {
        const { config } = await waitForSecuritySdk()
        const businessId = config.securityWhiteList?.[api] ||
          config.defaultBusinessId ||
          DEFAULT_SECURITY_BUSINESS_ID
        const signer = new window.ParamsSign({
          appId: businessId,
          preRequest: false,
          debug: false,
          onSign() {}
        })
        const bodyHash = window.CryptoJS.SHA256(JSON.stringify(body)).toString().toUpperCase()
        const signed = await signer.sign({
          body: bodyHash,
          appId: REQUEST_APP_ID,
          api,
          v: API_VERSION
        })
        if (!signed?.h5st) throw new Error('京麦未能生成仓库接口签名')
        return {
          h5st: encodeURI(signed.h5st),
          businessId
        }
      }

      function requestSummary(api, body) {
        const data = body?.request?.data || {}
        return {
          api: String(api).split('.').pop(),
          regionId: Number.isFinite(Number(data.regionId)) ? Number(data.regionId) : null,
          level: Number.isFinite(Number(data.level)) ? Number(data.level) : null,
          detailCount: Array.isArray(data.details) ? data.details.length : 0,
          warehouseCodes: Array.isArray(data.details)
            ? data.details.map(item => String(item?.seqNum ?? '')).filter(Boolean).slice(0, 20)
            : []
        }
      }

      async function callApi(api, rawBody = {}) {
        const body = withPageContext(rawBody)
        const bodyText = JSON.stringify(body)
        const trace = traceId()
        let summary = requestSummary(api, body)
        try {
          const [signed, eidResult] = await Promise.all([
            signBody(api, body),
            getRequiredJsToken()
          ])
          const headers = {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json;charset=UTF-8',
            'dsm-eid': eidResult.token,
            'dsm-file-path': 'lineation-price',
            'dsm-platform': 'pc',
            'dsm-trace-id': trace,
            h5st: signed.h5st,
            'x-referer-page': location.href,
            'x-requested-with': 'XMLHttpRequest',
            'x-rp-client': 'h5_2.4.0'
          }
          diagnostic({
            phase: 'request',
            ...summary,
            eidPresent: true,
            eidLength: eidResult.token.length,
            eidAttempts: eidResult.attempts,
            businessId: signed.businessId,
            rpClient: 'h5_2.4.0',
            traceFormat: 'jd'
          })

          const endpoint = `https://sff.jd.com/api?v=${API_VERSION}&appId=${REQUEST_APP_ID}&api=${encodeURIComponent(api)}`
          const response = await fetch(endpoint, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: bodyText
          })

          let result
          try {
            result = await response.json()
          } catch (_error) {
            throw new Error(`接口返回无法解析（HTTP ${response.status}）`)
          }
          diagnostic({
            phase: 'response',
            ...summary,
            httpStatus: response.status,
            code: result?.code ?? null,
            message: String(result?.msg || '').slice(0, 120),
            hasData: Object.prototype.hasOwnProperty.call(result || {}, 'data'),
            dataType: result?.data == null ? String(result?.data) : Array.isArray(result.data) ? 'array' : typeof result.data,
            responseTraceId: String(result?.['dsm-trace-id'] || '').slice(0, 80)
          })
          if (!response.ok) throw new Error(result?.msg || `接口请求失败（HTTP ${response.status}）`)
          if (String(result?.code) !== '200') {
            const code = result?.bCode || result?.code || '未知代码'
            throw new Error(`${result?.msg || '仓库接口调用失败'}（${code}）`)
          }
          return result.data
        } catch (error) {
          diagnostic({
            phase: 'error',
            ...summary,
            error: String(error?.message || error).slice(0, 300)
          })
          throw error
        }
      }

      async function handle(message) {
        if (message.type === 'PING') {
          await waitForSecuritySdk()
          await getRequiredJsToken()
          return { ready: true }
        }
        if (message.type === 'LOAD_REGIONS') return callApi(API.regions, {})
        if (message.type === 'LOAD_WAREHOUSES') {
          return callApi(API.warehouses, {
            request: { data: { regionId: Number(message.regionId), level: Number(message.level) } }
          })
        }
        if (message.type === 'LOAD_PRIORITIES') {
          return callApi(API.priorities, {
            request: { data: { regionId: Number(message.regionId), level: Number(message.level) } }
          })
        }
        if (message.type === 'SAVE_PRIORITIES') {
          const details = Array.isArray(message.details)
            ? message.details.map(item => ({
              priority: Number(item.priority),
              seqNum: item.seqNum,
              type: item.type,
              warehouseId: item.warehouseId
            }))
            : null
          return callApi(API.save, {
            request: {
              data: {
                regionId: Number(message.regionId),
                level: Number(message.level),
                details: details?.length ? details : null
              }
            }
          })
        }
        throw new Error('不支持的仓库页面桥接操作')
      }

      window.addEventListener('message', async event => {
        if (event.source !== window || event.origin !== location.origin) return
        const message = event.data
        if (!message || message.source !== REQUEST_SOURCE || !message.requestId) return
        try {
          const result = await handle(message)
          window.postMessage({
            source: RESPONSE_SOURCE,
            requestId: message.requestId,
            ok: true,
            result
          }, location.origin)
        } catch (error) {
          window.postMessage({
            source: RESPONSE_SOURCE,
            requestId: message.requestId,
            ok: false,
            error: error?.message || String(error)
          }, location.origin)
        }
      })

      diagnostic({ phase: 'bridge_ready', injection: 'document_start_main_world' })
      return true
    },
    args: [smokeTestMode]
  })
} catch (error) {
  console.error('[DXE_WAREHOUSE_PRELOAD] ' + String(error?.message || error))
}
