const fs = require('fs')
const os = require('os')
const path = require('path')
const { app, BrowserWindow, WebContentsView, session, webContents } = require('electron')

const TEST_SKU_ID = '10213098975565'
const TEST_SIBLING_SKU_ID = '10213098975566'
const TEST_PRODUCT_ID = '123456789'
const SKU_STATUS_STORAGE_KEY = 'ecommerceToolboxComplianceSkuStatusCacheV1'
const PROCESSED_SKU_STORAGE_KEY = 'ecommerceToolboxComplianceProcessedSkus'
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function waitFor(check, errorMessage, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await wait(100)
  }
  throw new Error(errorMessage)
}

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dxe-compliance-extension-'))
app.setPath('userData', userDataPath)
process.once('exit', () => {
  const tempRoot = path.resolve(os.tmpdir())
  const resolvedUserData = path.resolve(userDataPath)
  const isOwnedTestProfile = resolvedUserData.startsWith(`${tempRoot}${path.sep}`)
    && path.basename(resolvedUserData).startsWith('dxe-compliance-extension-')
  if (!isOwnedTestProfile) return
  try {
    fs.rmSync(resolvedUserData, {recursive: true, force: true})
  } catch (_error) {
    // Windows may keep a Chromium file handle briefly after Electron exits.
  }
})

app.whenReady().then(async () => {
  try {
    const extensionPath = path.resolve(__dirname, '..', 'resources', 'dxe-compliance-extension')
    const storeSession = session.fromPartition('persist:platform-compliance-smoke')
    let productApiRequestCount = 0
    let productState = 4
    let productDeleted = false
    let includeSiblingRow = false
    const intercepted = storeSession.protocol.interceptBufferProtocol('https', (request, callback) => {
      const target = new URL(request.url)
      if (target.hostname === 'sff.jd.com') {
        productApiRequestCount += 1
        const api = target.searchParams.get('api') || ''
        let list = []
        if (api.includes('queryValidProductList') && !productDeleted) {
          list = [{
              productId: Number(TEST_PRODUCT_ID),
              productState,
              skuInfoVOList: [
                {skuId: Number(TEST_SKU_ID)},
                ...(includeSiblingRow ? [{skuId: Number(TEST_SIBLING_SKU_ID)}] : [])
              ]
            }]
        } else if (api.includes('queryRecycleProductList') && productDeleted) {
          list = [{
            productId: Number(TEST_PRODUCT_ID),
            productState: 1,
            skuInfoVOList: [
              {skuId: Number(TEST_SKU_ID)},
              {skuId: Number(TEST_SIBLING_SKU_ID)}
            ]
          }]
        } else if (api.includes('updateProductStatus')) {
          const bodyText = (request.uploadData || [])
            .map(part => part.bytes ? Buffer.from(part.bytes).toString('utf8') : '')
            .join('')
          let operation = ''
          try {
            operation = JSON.parse(bodyText)?.productStatusReq?.operation || ''
          } catch (_error) {}
          if (operation === 'down' || (!operation && productState === 4)) productState = 1
          if (operation === 'del' || (!operation && productState !== 4)) productDeleted = true
          list = [{data: Number(TEST_PRODUCT_ID), success: true}]
        }
        callback({
          mimeType: 'application/json',
          charset: 'utf-8',
          data: Buffer.from(JSON.stringify({code: '200', data: {list}}))
        })
        return
      }
      const body = target.hostname === 'wares-jdm.jd.com'
        ? `<!doctype html><html><head><title>京麦商品接口测试页</title><script>
            window.ParamsSign = function () { this.sign = async () => ({h5st: 'smoke-signature'}); };
            window.CryptoJS = {SHA256: () => ({toString: () => 'SMOKE-HASH'})};
          </script></head><body>ready</body></html>`
        : `<!doctype html><html><head><title>违规状态测试页</title></head><body>
            <div role="tab" aria-selected="true" style="width:80px;height:30px">预警单</div>
            <aside id="jd-ai-auto-panel" style="position:fixed;right:0;top:0;width:320px;height:600px;background:white">
              <strong>AI超级助手</strong><button type="button" aria-label="关闭" style="position:absolute;right:10px;top:10px" onclick="this.parentElement.remove()">×</button>
              <label style="position:absolute;right:10px;top:70px">允许本页面自动弹出<button type="button" role="switch" aria-checked="true" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true')">切换</button></label>
            </aside>
            <div role="grid" class="ag-root-wrapper">
              <div class="ag-header">
                <div role="columnheader" class="ag-header-cell" col-id="recordId">处置记录编号</div>
                <div role="columnheader" class="ag-header-cell" col-id="subject">处置主体</div>
                <div class="ag-pinned-right-header"><div role="columnheader" class="ag-header-cell" col-id="custom">操作</div></div>
              </div>
              <div class="ag-center-cols-container">
                <div role="row" row-id="0" row-index="0" aria-rowindex="2" class="ag-row">
                  <div role="gridcell" class="ag-cell" col-id="recordId">TEST-1</div>
                  <div role="gridcell" class="ag-cell subject-cell" col-id="subject">预警主体 SKU：${TEST_SKU_ID}</div>
                </div>
                ${includeSiblingRow ? `<div role="row" row-id="1" row-index="1" aria-rowindex="3" class="ag-row">
                  <div role="gridcell" class="ag-cell" col-id="recordId">TEST-2</div>
                  <div role="gridcell" class="ag-cell sibling-subject-cell" col-id="subject">预警主体 SKU：${TEST_SIBLING_SKU_ID}</div>
                </div>` : ''}
              </div>
              <div class="ag-pinned-right-cols-container">
                <div role="row" row-id="0" row-index="0" aria-rowindex="2" class="ag-row">
                  <div role="gridcell" class="ag-cell operation-cell" col-id="custom" style="width:115px;height:70px">
                    <span class="ag-cell-wrapper"><span class="ag-cell-value">
                      <div style="width:80px"><button type="button" class="el-button el-button--text original-detail-action"><span>查看详情</span></button></div>
                      <div style="width:80px;display:none"><button type="button" class="el-button el-button--text"><span>查看违约单</span></button></div>
                    </span></span>
                  </div>
                </div>
                ${includeSiblingRow ? `<div role="row" row-id="1" row-index="1" aria-rowindex="3" class="ag-row">
                  <div role="gridcell" class="ag-cell sibling-operation-cell" col-id="custom" style="width:115px;height:70px">
                    <span class="ag-cell-wrapper"><span class="ag-cell-value">
                      <div style="width:80px"><button type="button" class="el-button el-button--text sibling-detail-action"><span>查看详情</span></button></div>
                    </span></span>
                  </div>
                </div>` : ''}
              </div>
            </div>
          </body></html>`
      callback({
        mimeType: 'text/html',
        charset: 'utf-8',
        data: Buffer.from(body)
      })
    })
    if (!intercepted) throw new Error('无法注册受控的 HTTPS 测试响应')
    let readyExtension = null
    const readyPromise = new Promise(resolve => {
      storeSession.extensions.once('extension-ready', (_event, item) => {
        readyExtension = item
        resolve(item)
      })
    })
    const extension = await storeSession.extensions.loadExtension(extensionPath)
    await Promise.race([
      readyPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('后台页初始化超时')), 5000))
    ])
    const loaded = storeSession.extensions.getAllExtensions().find((item) => item.id === extension.id)
    if (!loaded) throw new Error('扩展加载后未出现在店铺独立会话中')
    if (readyExtension?.id !== extension.id) throw new Error('后台页初始化的扩展与目标扩展不一致')

    const owner = new BrowserWindow({show: false})
    const {
      createStoreBackendComplianceProductHost
    } = require('../src/main/store-backend-compliance-extension')
    const productHost = createStoreBackendComplianceProductHost(storeSession, {
      partitionName: 'persist:platform-compliance-smoke',
      resourceRoot: path.resolve(__dirname, '..')
    })
    owner.contentView.addChildView(productHost.view)
    productHost.view.setBounds({x: -100, y: -100, width: 1, height: 1})
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('受控商品页加载超时')), 5000)
      productHost.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        setTimeout(resolve, 200)
      })
    })
    let extensionPage = null
    let backgroundPage = webContents.getAllWebContents().find(item =>
      item.getURL().startsWith(extension.url) && item.getType() === 'backgroundPage'
    )
    if (!backgroundPage) {
      extensionPage = new BrowserWindow({show: false, webPreferences: {session: storeSession}})
      await extensionPage.loadURL(`${extension.url}_generated_background_page.html`)
      backgroundPage = extensionPage.webContents
    }
    const channelResult = await backgroundPage.executeJavaScript(`(async () => {
      const tabs = await chrome.tabs.query({url: "https://wares-jdm.jd.com/ware/wareList*"});
      const target = tabs.find((tab) => tab.id);
      if (!target) return {ok: false, error: "未发现隐藏商品页", tabs};
      try {
        const response = await chrome.tabs.sendMessage(target.id, {type: "TOOLBOX_PRODUCT_HOST_PROBE"}, {frameId: 0});
        return {ok: Boolean(response && response.ok), tabId: target.id};
      } catch (error) {
        return {ok: false, error: error && error.message ? error.message : String(error)};
      }
    })()`)
    if (!channelResult?.ok) throw new Error(`商品页消息通道验证失败：${channelResult?.error || '未知错误'}`)

    const complianceView = new WebContentsView({
      webPreferences: {
        session: storeSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    owner.contentView.addChildView(complianceView)
    complianceView.setBounds({x: 0, y: 0, width: 900, height: 700})
    const complianceUrl = 'https://illegal-jdm.shop.jd.com/legal?tabsActiveName=2'
    await complianceView.webContents.loadURL(complianceUrl)
    await waitFor(async () => complianceView.webContents.executeJavaScript(
      '!document.querySelector("#jd-ai-auto-panel")'
    ), '进入合规页面后没有关闭首次自动弹出的京东 AI')
    const manualJdAiPanelStayedOpen = await complianceView.webContents.executeJavaScript(`(async () => {
      const panel = document.createElement("aside");
      panel.id = "jd-ai-manual-panel";
      panel.style.cssText = "position:fixed;right:0;top:0;width:320px;height:600px;background:white";
      panel.innerHTML = '<strong>AI超级助手</strong><button type="button" aria-label="关闭" style="position:absolute;right:10px;top:10px" onclick="this.parentElement.remove()">×</button><label style="position:absolute;right:10px;top:70px">允许本页面自动弹出<button id="jd-ai-manual-switch" type="button" role="switch" aria-checked="false" onclick="this.setAttribute(\"aria-checked\", this.getAttribute(\"aria-checked\") === \"true\" ? \"false\" : \"true\")">切换</button></label>';
      document.body.appendChild(panel);
      await new Promise((resolve) => setTimeout(resolve, 800));
      return Boolean(document.querySelector("#jd-ai-manual-panel"));
    })()`)
    if (!manualJdAiPanelStayedOpen) throw new Error('首次自动关闭后，用户手动打开的京东 AI 仍被错误关闭')
    await complianceView.webContents.executeJavaScript(`(() => {
      const control = document.querySelector("#jd-ai-manual-switch");
      control.setAttribute("aria-checked", "true");
      control.dispatchEvent(new Event("change", {bubbles: true}));
    })()`)
    await waitFor(async () => {
      const stored = await backgroundPage.executeJavaScript(
        'chrome.storage.local.get("ecommerceToolboxJdAiAutoPopupV2")'
      )
      return stored?.ecommerceToolboxJdAiAutoPopupV2?.enabled === true
    }, '开启京东 AI 自动弹出后没有保存店铺独立配置')
    const enabledAutoPanelStayedOpen = await complianceView.webContents.executeJavaScript(`(async () => {
      document.querySelector("#jd-ai-manual-panel")?.remove();
      history.pushState({}, "", "/legal?tabsActiveName=6");
      const panel = document.createElement("aside");
      panel.id = "jd-ai-enabled-panel";
      panel.style.cssText = "position:fixed;right:0;top:0;width:320px;height:600px;background:white";
      panel.innerHTML = '<strong>AI超级助手</strong><button type="button" aria-label="关闭" style="position:absolute;right:10px;top:10px" onclick="this.parentElement.remove()">×</button><label style="position:absolute;right:10px;top:70px">允许本页面自动弹出<button id="jd-ai-enabled-switch" type="button" role="switch" aria-checked="true" onclick="this.setAttribute(\"aria-checked\", this.getAttribute(\"aria-checked\") === \"true\" ? \"false\" : \"true\")">切换</button></label>';
      document.body.appendChild(panel);
      dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((resolve) => setTimeout(resolve, 800));
      return Boolean(document.querySelector("#jd-ai-enabled-panel"));
    })()`)
    if (!enabledAutoPanelStayedOpen) throw new Error('开启自动弹出后，新的合规页面仍错误关闭了京东 AI')
    await complianceView.webContents.executeJavaScript(`(() => {
      const control = document.querySelector("#jd-ai-enabled-switch");
      control.setAttribute("aria-checked", "false");
      control.dispatchEvent(new Event("change", {bubbles: true}));
    })()`)
    await waitFor(async () => {
      const stored = await backgroundPage.executeJavaScript(
        'chrome.storage.local.get("ecommerceToolboxJdAiAutoPopupV2")'
      )
      return stored?.ecommerceToolboxJdAiAutoPopupV2?.enabled === false
    }, '关闭京东 AI 自动弹出后没有保存店铺独立配置')
    const disabledNextAutoPanelClosed = await complianceView.webContents.executeJavaScript(`(async () => {
      document.querySelector("#jd-ai-enabled-panel")?.remove();
      history.pushState({}, "", "/legal?tabsActiveName=2&aiToggleTest=1");
      const panel = document.createElement("aside");
      panel.id = "jd-ai-disabled-panel";
      panel.style.cssText = "position:fixed;right:0;top:0;width:320px;height:600px;background:white";
      panel.innerHTML = '<strong>AI超级助手</strong><button type="button" aria-label="关闭" style="position:absolute;right:10px;top:10px" onclick="this.parentElement.remove()">×</button><label style="position:absolute;right:10px;top:70px">允许本页面自动弹出<button type="button" role="switch" aria-checked="false">切换</button></label>';
      document.body.appendChild(panel);
      dispatchEvent(new PopStateEvent("popstate"));
      await new Promise((resolve) => setTimeout(resolve, 800));
      return !document.querySelector("#jd-ai-disabled-panel");
    })()`)
    if (!disabledNextAutoPanelClosed) throw new Error('关闭自动弹出后，新的合规页面仍自动展开了京东 AI')
    await waitFor(async () => complianceView.webContents.executeJavaScript(
      'document.querySelector(".et-c-processed-badge")?.textContent === "售卖中"'
    ), '当前页首次查询后没有显示“售卖中”状态')
    await waitFor(async () => complianceView.webContents.executeJavaScript(
      'document.querySelector(".et-c-status-delete")?.textContent === "删除商品"'
    ), '在售商品状态后没有显示删除按钮')
    const statusBesideSkuAndDeleteInOperationColumn = await complianceView.webContents.executeJavaScript(`(() => {
      const controls = document.querySelector(".et-c-status-actions");
      const badge = document.querySelector(".et-c-processed-badge");
      const button = controls?.querySelector(".et-c-status-delete");
      const subjectCell = document.querySelector(".subject-cell");
      const operationCell = document.querySelector(".operation-cell");
      const actionContainer = operationCell?.querySelector(".ag-cell-value");
      const originalAction = actionContainer?.querySelector(".original-detail-action");
      const buttonStyle = button ? getComputedStyle(button) : null;
      return Boolean(
        controls && badge && button
        && badge.parentElement === subjectCell
        && !controls.contains(badge)
        && getComputedStyle(controls).display === "flex"
        && getComputedStyle(actionContainer).display === "flex"
        && getComputedStyle(actionContainer).flexWrap === "wrap"
        && controls.parentElement === actionContainer
        && originalAction?.textContent.trim() === "查看详情"
        && actionContainer.contains(originalAction)
        && buttonStyle?.color === "rgb(245, 34, 45)"
        && buttonStyle?.borderTopStyle === "none"
        && buttonStyle?.backgroundColor === "rgba(0, 0, 0, 0)"
      );
    })()`)
    if (!statusBesideSkuAndDeleteInOperationColumn) throw new Error('SKU 状态没有紧跟编号，或删除按钮没有移动到操作列')
    const firstRequestCount = productApiRequestCount
    const firstCache = await backgroundPage.executeJavaScript(
      `chrome.storage.local.get(${JSON.stringify(SKU_STATUS_STORAGE_KEY)})`
    )
    const firstRecord = firstCache?.[SKU_STATUS_STORAGE_KEY]?.[TEST_SKU_ID]
    if (firstRecord?.kind !== 'onsale' || !Number.isFinite(Number(firstRecord.checkedAt))) {
      throw new Error(`首次状态没有正确写入本地缓存：${JSON.stringify(firstRecord)}`)
    }

    await complianceView.webContents.reload()
    await waitFor(async () => complianceView.webContents.executeJavaScript(
      'document.querySelector(".et-c-processed-badge")?.textContent === "售卖中"'
    ), '刷新后没有从本地缓存恢复“售卖中”状态')
    await wait(1200)
    if (productApiRequestCount !== firstRequestCount) {
      throw new Error(`本地缓存命中后仍调用商品接口：${firstRequestCount} -> ${productApiRequestCount}`)
    }

    await backgroundPage.executeJavaScript(`(async () => {
      const key = ${JSON.stringify(SKU_STATUS_STORAGE_KEY)};
      const stored = await chrome.storage.local.get(key);
      stored[key][${JSON.stringify(TEST_SKU_ID)}] = {
        kind: "nonexistent",
        label: "查无商品",
        title: "测试商品不存在",
        productId: "",
        checkedAt: Date.now()
      };
      await chrome.storage.local.set(stored);
    })()`)
    await complianceView.webContents.reload()
    await waitFor(async () => complianceView.webContents.executeJavaScript(
      'document.querySelector(".et-c-processed-badge")?.textContent === "查无商品"'
    ), '查无商品状态没有正确恢复')
    const nonexistentHasDeleteButton = await complianceView.webContents.executeJavaScript(
      'Boolean(document.querySelector(".et-c-status-delete"))'
    )
    if (nonexistentHasDeleteButton) throw new Error('查无商品时仍显示删除按钮')
    await wait(1200)
    if (productApiRequestCount !== firstRequestCount) {
      throw new Error(`查无商品缓存命中后仍调用商品接口：${firstRequestCount} -> ${productApiRequestCount}`)
    }

    await backgroundPage.executeJavaScript(`(async () => {
      const key = ${JSON.stringify(SKU_STATUS_STORAGE_KEY)};
      const stored = await chrome.storage.local.get(key);
      stored[key][${JSON.stringify(TEST_SKU_ID)}].checkedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
      await chrome.storage.local.set(stored);
    })()`)
    await complianceView.webContents.reload()
    await waitFor(() => productApiRequestCount > firstRequestCount, '七天过期缓存没有触发重新查询')
    const refreshedCache = await waitFor(async () => {
      const stored = await backgroundPage.executeJavaScript(
        `chrome.storage.local.get(${JSON.stringify(SKU_STATUS_STORAGE_KEY)})`
      )
      const record = stored?.[SKU_STATUS_STORAGE_KEY]?.[TEST_SKU_ID]
      return Number(record?.checkedAt) > Date.now() - 60_000 ? record : null
    }, '过期缓存重新查询后没有写入新时间')
    await waitFor(async () => complianceView.webContents.executeJavaScript(
      'document.querySelector(".et-c-status-delete")?.textContent === "删除商品"'
    ), '过期缓存实时刷新为售卖中后没有恢复删除按钮')
    await backgroundPage.executeJavaScript(`(async () => {
      const key = ${JSON.stringify(SKU_STATUS_STORAGE_KEY)};
      const stored = await chrome.storage.local.get(key);
      stored[key][${JSON.stringify(TEST_SIBLING_SKU_ID)}] = {
        kind: "onsale",
        label: "售卖中",
        title: "同一 SPU 的另一个 SKU",
        productId: ${JSON.stringify(TEST_PRODUCT_ID)},
        checkedAt: Date.now()
      };
      await chrome.storage.local.set(stored);
    })()`)
    includeSiblingRow = true
    await complianceView.webContents.reload()
    await waitFor(async () => complianceView.webContents.executeJavaScript(
      'document.querySelectorAll(".et-c-status-delete").length === 2'
    ), '同一 SPU 的两个 SKU 没有同时显示删除操作')
    await complianceView.webContents.executeJavaScript(`(() => {
      document.querySelector('.operation-cell .et-c-status-delete')?.click();
      return true;
    })()`)
    await waitFor(async () => complianceView.webContents.executeJavaScript(
      'Boolean(document.querySelector("#et-c-info-confirm-host")?.open)'
    ), '删除商品确认框没有出现')
    await complianceView.webContents.executeJavaScript(`(() => {
      const host = document.querySelector('#et-c-info-confirm-host');
      host?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      return true;
    })()`)
    let linkedSkuDeletePropagation
    try {
      linkedSkuDeletePropagation = await waitFor(async () => complianceView.webContents.executeJavaScript(`(() => {
        const labels = [...document.querySelectorAll('.subject-cell .et-c-processed-badge, .sibling-subject-cell .et-c-processed-badge')]
          .map((badge) => badge.textContent.trim());
        return labels.length === 2
          && labels.every((label) => label === '已删除')
          && document.querySelectorAll('.et-c-status-delete').length === 0;
      })()`), '删除一个 SKU 后没有把同一 SPU 的其他 SKU 联动标记为已删除', 12000)
    } catch (error) {
      const snapshot = await complianceView.webContents.executeJavaScript(`(() => ({
        badges: [...document.querySelectorAll('.et-c-processed-badge')].map((item) => item.textContent.trim()),
        buttons: [...document.querySelectorAll('.et-c-status-delete')].map((item) => ({text: item.textContent.trim(), title: item.title, disabled: item.disabled})),
        confirmOpen: Boolean(document.querySelector('#et-c-info-confirm-host')?.open)
      }))()`)
      const stored = await backgroundPage.executeJavaScript(
        `chrome.storage.local.get([${JSON.stringify(SKU_STATUS_STORAGE_KEY)}, ${JSON.stringify(PROCESSED_SKU_STORAGE_KEY)}])`
      )
      throw new Error(`${error.message}；state=${JSON.stringify({productState, productDeleted, snapshot, stored})}`)
    }

    await backgroundPage.executeJavaScript(`(async () => {
      const statusKey = ${JSON.stringify(SKU_STATUS_STORAGE_KEY)};
      const processedKey = ${JSON.stringify(PROCESSED_SKU_STORAGE_KEY)};
      const stored = await chrome.storage.local.get([statusKey, processedKey]);
      delete stored[processedKey][${JSON.stringify(TEST_SIBLING_SKU_ID)}];
      stored[statusKey][${JSON.stringify(TEST_SIBLING_SKU_ID)}] = {
        kind: "onsale",
        label: "售卖中",
        title: "模拟其他 SKU 删除后遗留的旧状态",
        productId: ${JSON.stringify(TEST_PRODUCT_ID)},
        checkedAt: Date.now()
      };
      await chrome.storage.local.set({
        [statusKey]: stored[statusKey],
        [processedKey]: stored[processedKey]
      });
    })()`)
    await complianceView.webContents.reload()
    await waitFor(async () => complianceView.webContents.executeJavaScript(
      'document.querySelector(".sibling-operation-cell .et-c-status-delete")?.textContent === "删除商品"'
    ), '没有恢复用于模拟旧状态的同 SPU 删除按钮')
    await complianceView.webContents.executeJavaScript(
      'document.querySelector(".sibling-operation-cell .et-c-status-delete")?.click()'
    )
    await waitFor(async () => complianceView.webContents.executeJavaScript(
      'Boolean(document.querySelector("#et-c-info-confirm-host")?.open)'
    ), '再次删除商品确认框没有出现')
    await complianceView.webContents.executeJavaScript(`(() => {
      const host = document.querySelector('#et-c-info-confirm-host');
      host?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      return true;
    })()`)
    const alreadyDeletedRecovery = await waitFor(async () => complianceView.webContents.executeJavaScript(`(() => {
      const badge = document.querySelector('.sibling-subject-cell .et-c-processed-badge');
      return badge?.textContent.trim() === '已删除'
        && !document.querySelector('.sibling-operation-cell .et-c-status-delete');
    })()`), '商品已在回收站时仍停留在重试删除状态', 12000)
    console.log(JSON.stringify({
      ok: true,
      backgroundReady: true,
      productHostMessaging: true,
      currentPageStatusCache: true,
      cacheHitAvoidedRequest: true,
      expiredCacheRequeried: true,
      deleteButtonRules: true,
      statusBesideSkuAndDeleteInOperationColumn: true,
      linkedSkuDeletePropagation,
      alreadyDeletedRecovery,
      jdAiAutoPopupPreferenceToggle: true,
      refreshedCheckedAt: refreshedCache.checkedAt,
      productHostTabId: channelResult.tabId,
      extensionId: extension.id,
      name: extension.name,
      partition: 'persist:platform-compliance-smoke',
      userDataPath
    }))
    owner.contentView.removeChildView(complianceView)
    complianceView.webContents.close()
    productHost.dispose()
    extensionPage?.destroy()
    owner.destroy()
    storeSession.protocol.uninterceptProtocol('https')
    app.exit(0)
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: error?.stack || String(error), userDataPath}))
    app.exit(1)
  }
})
