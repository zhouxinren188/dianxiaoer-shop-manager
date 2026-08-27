'use strict'

const { contextBridge } = require('electron')

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
