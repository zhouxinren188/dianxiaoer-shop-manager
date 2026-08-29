import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import complianceExtension from '../src/main/store-backend-compliance-extension.js'

const {
  EXTENSION_NAME,
  resolveComplianceExtensionPath,
  isStoreBackendComplianceUrl
} = complianceExtension

describe('店铺后台违规商品清理内置模块', () => {
  const extensionRoot = path.resolve('resources/dxe-compliance-extension')
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'))
  const cleaner = fs.readFileSync(path.join(extensionRoot, 'compliance-product-cleaner.js'), 'utf8')
  const bridge = fs.readFileSync(path.join(extensionRoot, 'compliance-product-bridge.js'), 'utf8')
  const background = fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8')

  it('只打包违规清理所需页面和脚本，不带入插件其他模块', () => {
    const contentScriptFiles = manifest.content_scripts.flatMap((entry) => entry.js || [])
    expect(manifest.name).toBe(EXTENSION_NAME)
    expect(manifest.manifest_version).toBe(2)
    expect(manifest.background).toEqual({scripts: ['background.js'], persistent: false})
    expect(manifest.content_scripts).toHaveLength(2)
    expect(contentScriptFiles).toEqual([
      'product-host-content.js',
      'compliance-product-cleaner.js'
    ])
  })

  it('保留 SKU/SPU 查询、下架、删除、回收站复核和失败熔断', () => {
    expect(bridge).toContain('queryValidProductList')
    expect(bridge).toContain('queryRecycleProductList')
    expect(bridge).toContain('updateProductStatus')
    expect(cleaner).toContain('operation: "down"')
    expect(cleaner).toContain('operation: "del"')
    expect(cleaner).toContain('45 天内可恢复')
    expect(cleaner).toContain('本批商品全部失败，已停止后续批次')
    expect(background).toContain('TOOLBOX_PRODUCT_API_REQUEST')
    expect(background).not.toContain('TOOLBOX_CAPTURE_VISIBLE')
    expect(background).not.toContain('chrome.tabs.create')
    expect(background).not.toContain('chrome.tabs.get')
    expect(background).not.toContain('chrome.tabs.remove')
    expect(background).not.toContain('chrome.tabs.onRemoved')
  })

  it('信息违规删除确认框转交顶层页面并固定在整个店铺后台视口中央', () => {
    expect(background).toContain('TOOLBOX_INFORMATION_CONFIRM_REQUEST')
    expect(background).toContain('TOOLBOX_SHOW_INFORMATION_CONFIRM')
    expect(background).toContain('{frameId: 0}')
    expect(cleaner).toContain('if (IS_TOP_FRAME)')
    expect(cleaner).toContain('information_confirm_relay')
    expect(cleaner).toContain('payload.productId, payload.skuId, payload.count, false')
    expect(cleaner).not.toContain('payload.productId, payload.skuId, payload.count, !IS_TOP_FRAME')
    expect(cleaner).toContain('inset:0!important;margin:auto!important;')
  })

  it('京东 AI 自动弹出开关可按店铺持久切换，并且不影响手动打开', () => {
    expect(cleaner).toContain('const JD_AI_AUTO_POPUP_STORAGE_KEY = "ecommerceToolboxJdAiAutoPopupV2"')
    expect(cleaner).toContain('function findJdAiAutoPopupSwitch(panel)')
    expect(cleaner).toContain('function jdAiSwitchEnabled(control)')
    expect(cleaner).toContain('saveJdAiAutoPopupPreference(enabled, "switch_interaction")')
    expect(cleaner).not.toContain('saveJdAiAutoPopupPreference(current, "visible_switch")')
    expect(cleaner).toContain('for (const delay of [80, 320])')
    expect(cleaner).toContain('[JD_AI_AUTO_POPUP_STORAGE_KEY]: {enabled, updatedAt: Date.now()}')
    expect(cleaner).not.toContain('enabled === jdAiAutoPopupEnabled) return')
    expect(cleaner).toContain('function suppressInitialJdAiPanel(complianceSection)')
    expect(cleaner).toContain('if (jdAiAutoPopupEnabled)')
    expect(cleaner).toContain('if (panel) jdAiAutoCloseDone = true')
    expect(cleaner).toContain('if (jdAiAutoCloseDone || jdAiAutoClosePending || !panel) return')
    expect(cleaner).toContain('autoPopupSwitch.click()')
    expect(cleaner).toContain('saveJdAiAutoPopupPreference(false, "site_preference_restore")')
    expect(cleaner).toContain('jd_ai_site_preference_restored')
    expect(cleaner).toContain('jdAiAutoCloseDone = true')
    expect(cleaner).toContain('closeButton.click()')
    expect(cleaner).toContain('jd_ai_initial_panel_closed')
    expect(cleaner).toContain('suppressInitialJdAiPanel(complianceSection)')
  })

  it('SKU 状态缓存保留七天，到期清理并且当前页优先使用本地记录', () => {
    expect(cleaner).toContain('const SKU_STATUS_STORAGE_KEY = "ecommerceToolboxComplianceSkuStatusCacheV1"')
    expect(cleaner).toContain('const SKU_STATUS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000')
    expect(cleaner).toContain('checkedAt < cutoff')
    expect(cleaner).toContain('await chrome.storage.local.set({[SKU_STATUS_STORAGE_KEY]: skuStatusRecords})')

    const lazyStart = cleaner.indexOf('async function refreshVisibleSkuStatuses()')
    const lazyEnd = cleaner.indexOf('function statusLabel()', lazyStart)
    const lazyQuery = cleaner.slice(lazyStart, lazyEnd)
    expect(lazyQuery).toContain('const visibleSkuIds = extractSkuIdsFromRows()')
    expect(lazyQuery).toContain('!processedSkuRecords[skuId]')
    expect(lazyQuery).toContain('!skuStatusRecords[skuId]')
    expect(lazyQuery).toContain('mapSkuIdsToProducts(querySkuIds, token, {quiet: true})')
    expect(cleaner).toContain('badge.textContent = "查询中"')
    expect(lazyQuery).toContain('querySkuIds.forEach((skuId) => visibleSkuStatusPending.add(skuId))')
    expect(lazyQuery).toContain('annotateProcessedRows()')
    expect(lazyQuery).toContain('onResolved: async ({kind, skuId, record})')
    expect(lazyQuery).toContain('await refreshSkuStatusRecords([], [skuId])')
    expect(lazyQuery).not.toContain('collectAllSkuIds')

    const annotationStart = cleaner.indexOf('function annotateProcessedRows()')
    const annotationEnd = cleaner.indexOf('function ensureSubjectColumnWidth()', annotationStart)
    const annotationFlow = cleaner.slice(annotationStart, annotationEnd)
    expect(annotationFlow).toContain('new Set(["onsale", "offsale"]).has(statusRecord?.kind)')
    expect(annotationFlow).toContain('className = "el-button el-button--text et-c-status-delete"')
    expect(annotationFlow).toContain('void deleteInformationProduct(productId, event.currentTarget, skuId)')
    expect(annotationFlow).toContain('deleteButton?.remove()')
    expect(annotationFlow).toContain('controls.className = "et-c-status-actions"')
    expect(annotationFlow).toContain('controls.appendChild(deleteButton)')
    expect(cleaner).toContain('function findRowOperationCell(row)')
    expect(cleaner).toContain('function findOperationActionsContainer(operationCell)')
    expect(cleaner).toContain("trim() === '操作'")
    expect(cleaner).toContain("'.ag-pinned-right-cols-container, [class*=\"pinned-right-cols\"]'")
    expect(cleaner).toContain("['row-id', 'row-index', 'aria-rowindex', 'data-row-key', 'data-key']")
    expect(cleaner).toContain("cell.getAttribute('col-id') === columnId")
    expect(annotationFlow).toContain('const operationCell = findRowOperationCell(row)')
    expect(annotationFlow).toContain("operationCell.classList.add('et-c-operation-cell')")
    expect(cleaner).toContain('function findSkuTextContainer(row, skuId)')
    expect(annotationFlow).toContain('const skuTextContainer = findSkuTextContainer(row, skuId)')
    expect(annotationFlow).toContain('skuTextContainer.appendChild(badge)')
    expect(annotationFlow).toContain('if (!canDelete || !operationCell || !actionContainer)')
    expect(annotationFlow).toContain('actionContainer.appendChild(controls)')
    expect(annotationFlow).toContain("actionContainer.classList.add('et-c-operation-actions-container')")
    expect(cleaner).toContain('.et-c-operation-actions-container{display:flex!important;align-items:center!important;flex-wrap:wrap!important')
    expect(cleaner).toContain('.et-c-status-delete{display:inline-flex!important')
    expect(cleaner).toContain('color:#f5222d!important')

    expect(cleaner).toContain('function knownSkuIdsForProduct(product)')
    expect(cleaner).toContain('String(status?.productId || "") === productId')
    expect(cleaner).toContain('knownSkuIdsForProduct(product).map((skuId)')
    const processStart = cleaner.indexOf('async function processBatch(batch, token)')
    const processEnd = cleaner.indexOf('function informationProductCodeEntries()', processStart)
    const processFlow = cleaner.slice(processStart, processEnd)
    expect(cleaner).toContain('async function findProductInRecycle(product, token)')
    expect(cleaner).toContain('bridgeRequest("QUERY_RECYCLE_PRODUCTS", {skuIds}, 35000)')
    expect(processFlow).toContain('const recycled = await findProductInRecycle(product, token)')
    expect(processFlow).toContain('if (recycled) acceptDeleted(recycled)')
    expect(cleaner).toContain('diagnosticLog("product_already_deleted_confirmed"')

    const fullScanStart = cleaner.indexOf('async function scanProducts()')
    const fullScanEnd = cleaner.indexOf('function operationResultMap', fullScanStart)
    expect(cleaner.slice(fullScanStart, fullScanEnd)).toContain('collectAllSkuIds(token)')
  })

  it('违约单详情实时查询并按商品状态控制删除按钮', () => {
    const detailStart = cleaner.indexOf('function legalDetailSkuStatus(detail, deletedRecord)')
    const detailEnd = cleaner.indexOf('function looksLikeVerification', detailStart)
    const detailFlow = cleaner.slice(detailStart, detailEnd)

    expect(detailFlow).toContain('bridgeRequest("QUERY_PRODUCTS", {skuIds: batch}')
    expect(detailFlow).toContain('bridgeRequest("QUERY_RECYCLE_PRODUCTS", {skuIds: [skuId]}')
    expect(detailFlow).not.toContain('skuStatusRecords[skuId]')
    expect(detailFlow).toContain('label: "查无商品"')
    expect(detailFlow).toContain('label: "售卖中"')
    expect(detailFlow).toContain('label: "已下架"')
    expect(detailFlow).toContain('detail?.nonexistent')
    expect(detailFlow).toContain('button.hidden = !canDelete')
  })

  it('从开发目录或打包解包目录定位内置扩展', () => {
    expect(resolveComplianceExtensionPath(path.resolve('.'))).toBe(extensionRoot)
    expect(isStoreBackendComplianceUrl('https://illegal-jdm.shop.jd.com/legal?tabsActiveName=8')).toBe(true)
    expect(isStoreBackendComplianceUrl('https://keeper-jdm.jd.com/illegal/detail')).toBe(true)
    expect(isStoreBackendComplianceUrl('https://shop.jd.com/jdm/home')).toBe(false)
    const packageJson = fs.readFileSync(path.resolve('package.json'), 'utf8')
    expect(packageJson).toContain('resources/dxe-compliance-extension/**/*')
  })
})
