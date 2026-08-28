'use strict'

const path = require('path')
const { app, BrowserWindow, ipcMain, session } = require('electron')
const {
  ORDER_PURCHASE_ACTION_CHANNEL,
  buildOrderPurchasePanelScript,
  buildOrderPurchaseLogisticsScript,
  buildOrderPurchaseSyncStateScript
} = require('../src/main/store-backend-order-purchase-panel')

const ORDER_ID = '3599471007575277'

function waitFor(check, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check()
        if (value) return resolve(value)
      } catch (_) {}
      if (Date.now() >= deadline) return reject(new Error(message))
      setTimeout(poll, 100)
    }
    poll()
  })
}

async function main() {
  const testSession = session.fromPartition(`dxe-order-purchase-panel-smoke-${Date.now()}`, { cache: false })
  await testSession.protocol.handle('https', request => {
    const requestUrl = new URL(request.url)
    if (requestUrl.hostname !== 'shop.jd.com') return new Response('not found', { status: 404 })
    if (requestUrl.pathname === '/api/dxe-smoke/aftersale-detail') {
      return new Response(JSON.stringify({ code: 200, data: { orderId: '3557439004118866' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      })
    }
    const isAfterSale = requestUrl.pathname.startsWith('/jdm/trade/after-sale/independent-after-sale/detail')
    return new Response(`<!doctype html>
      <html><body style="margin:0;background:#f5f6f8;font-family:Arial">
        <main id="content" style="width:1200px;margin:20px auto">
          ${isAfterSale
            ? '<section id="aftersale-status-card" style="height:180px;background:#fff;margin:0 20px">售后服务处理中</section><div id="aftersale-detail-layout" style="display:grid;grid-template-columns:720px 420px;gap:20px;margin:12px 20px 0"><div><section id="aftersale-info-card" style="height:260px;background:#fff"><h2><span>申请信息</span></h2></section><section style="height:260px;background:#fff;margin-top:12px"><h2><span>服务单日志</span></h2></section></div><aside id="aftersale-goods-card" style="height:360px;background:#fff"><h2><span>售后商品信息</span></h2></aside></div>'
            : '<section id="status-card" style="height:180px;background:#fff">买家已付款，待商家发货</section><section id="order-info-card" style="height:260px;background:#fff;margin-top:12px"><h2><span>订单信息</span></h2></section>'}
        </main>
        ${isAfterSale ? '<script>setTimeout(() => fetch("/api/dxe-smoke/aftersale-detail").then(response => response.json()), 0)</script>' : ''}
      </body></html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  })

  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      session: testSession,
      preload: path.resolve(__dirname, '../resources/store-backend-page-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const actionMessages = []
  const actionRequests = []
  ipcMain.handle(ORDER_PURCHASE_ACTION_CHANNEL, async (_event, payload) => {
    actionRequests.push(payload)
    return { ok: true, result: { action: payload.action } }
  })
  win.webContents.on('console-message', (_event, levelOrDetails, ...legacyArgs) => {
    const message = String(
      levelOrDetails && typeof levelOrDetails === 'object'
        ? levelOrDetails.message || ''
        : legacyArgs[0] || ''
    )
    if (message.startsWith('[DXE_ORDER_PURCHASE_LOGISTICS_TEST]')) actionMessages.push(message)
  })

  try {
    await win.loadURL(`https://shop.jd.com/jdm/trade/orders/order-details?orderId=${ORDER_ID}`)
    await win.webContents.executeJavaScript(buildOrderPurchasePanelScript({
      state: 'ready',
      orderId: ORDER_ID,
      pageKey: `order:${ORDER_ID}`,
      orders: [
        {
          id: 81,
          purchaseNo: 'A8101',
          platform: 'taobao',
          platformLabel: '淘宝/天猫',
          accountId: 18,
          accountName: '淘_天下物品',
          platformOrderNo: 'TB8101',
          goodsName: '古风油纸伞',
          sku: 'SKU-001',
          quantity: 2,
          purchasePrice: 26.99,
          totalAmount: 56.98,
          shippingFee: 3,
          warehouseName: '九间1号库',
          aftersaleStatusLabel: '无售后',
          purchaseTypeLabel: '三方代发',
          status: 'in_transit',
          statusLabel: '运输中',
          logisticsCompany: '中通快递',
          logisticsNo: 'ZT123456',
          logisticsLabel: '中通快递 · ZT123456'
        },
        {
          id: 82,
          purchaseNo: 'A8102',
          purchaseTypeLabel: '仓库转发',
          status: 'pending',
          statusLabel: '待发货',
          logisticsLabel: '暂无物流信息'
        }
      ],
      actionPrefix: '[DXE_ORDER_PURCHASE_LOGISTICS_TEST]',
      actionNonce: 'electron-smoke-nonce'
    }), true)

    await win.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('dxe-order-purchase-panel-host')?.shadowRoot;
      root?.querySelector('.logistics-link')?.click();
      return true;
    })()`)
    await win.webContents.executeJavaScript(buildOrderPurchaseLogisticsScript({
      state: 'ready',
      orderId: ORDER_ID,
      pageKey: `order:${ORDER_ID}`,
      purchaseId: 81,
      data: {
        company: '中通快递',
        trackingNo: 'ZT123456',
        source: 'local',
        tracks: [
          { time: '2026-08-28 10:20:00', context: '快件已到达沈阳转运中心' },
          { time: '2026-08-27 19:10:00', context: '快件已揽收' }
        ]
      }
    }), true)
    await win.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('dxe-order-purchase-panel-host')?.shadowRoot;
      root?.querySelector('.sync')?.click();
      return true;
    })()`)
    await win.webContents.executeJavaScript(buildOrderPurchaseSyncStateScript({
      state: 'ready',
      orderId: ORDER_ID,
      pageKey: `order:${ORDER_ID}`,
      successCount: 1,
      failCount: 0
    }), true)
    const aftersaleDialogState = await win.webContents.executeJavaScript(`(() => {
      const root = document.getElementById('dxe-order-purchase-panel-host')?.shadowRoot;
      root?.querySelector('.mark-aftersale')?.click();
      const backdrop = root?.querySelector('.aftersale-backdrop');
      const purchase = root?.querySelector('.aftersale-purchase');
      if (purchase) {
        purchase.value = '82';
        purchase.dispatchEvent(new Event('change'));
      }
      const status = root?.querySelector('.aftersale-status');
      const remark = root?.querySelector('.aftersale-remark');
      if (status) status.value = 'pending_return_refund';
      if (remark) remark.value = '用户已退款，请申请退货退款。';
      const snapshot = {
        visible: Boolean(backdrop && !backdrop.hidden),
        purchaseOptionCount: purchase?.options?.length || 0,
        quickPhraseCount: root?.querySelector('.quick-select')?.options?.length || 0,
        statusExists: Boolean(status),
        statusValue: status?.value || '',
        remarkExists: Boolean(remark),
        remarkValue: remark?.value || ''
      };
      root?.querySelector('.aftersale-save')?.click();
      return snapshot;
    })()`)
    await waitFor(
      () => actionRequests.some(payload => payload.action === 'mark-aftersale'),
      '标记售后操作未通过 preload IPC 发送到主进程'
    )

    const snapshot = await waitFor(
      () => win.webContents.executeJavaScript(`(() => {
        const host = document.getElementById('dxe-order-purchase-panel-host');
        const orderInfo = document.getElementById('order-info-card');
        if (!host?.shadowRoot) return null;
        const logisticsValue = host.shadowRoot.querySelector('.logistics-value');
        const selection = window.getSelection();
        selection.removeAllRanges();
        if (logisticsValue) {
          const range = document.createRange();
          range.selectNodeContents(logisticsValue);
          selection.addRange(range);
        }
        return {
          immediatelyBeforeOrderInfo: host.nextElementSibling === orderInfo,
          bodyText: host.shadowRoot.textContent,
          originalStatusPreserved: document.getElementById('status-card')?.textContent,
          hostPosition: getComputedStyle(host).position,
          panelWidth: host.getBoundingClientRect().width,
          logisticsButtonCount: host.shadowRoot.querySelectorAll('.logistics-link').length,
          logisticsButtonText: host.shadowRoot.querySelector('.logistics-link')?.textContent,
          selectedLogisticsText: selection.toString(),
          logisticsValueUserSelect: logisticsValue ? getComputedStyle(logisticsValue).userSelect : '',
          syncButtonText: host.shadowRoot.querySelector('.sync')?.textContent,
          syncButtonDisabled: host.shadowRoot.querySelector('.sync')?.disabled,
          logisticsDialogVisible: !host.shadowRoot.querySelector('.dialog-backdrop')?.hidden,
          logisticsDialogText: host.shadowRoot.querySelector('.dialog-backdrop')?.textContent
        };
      })()`),
      '采购信息区域未成功插入'
    )

    if (!snapshot.immediatelyBeforeOrderInfo) throw new Error('采购信息区域没有位于订单信息上方')
    if (!snapshot.bodyText.includes('A8101') || !snapshot.bodyText.includes('A8102')) throw new Error('多采购单内容缺失')
    if (!snapshot.bodyText.includes('三方代发') || !snapshot.bodyText.includes('仓库转发')) throw new Error('采购类型内容缺失')
    if (!snapshot.bodyText.includes('运输中') || !snapshot.bodyText.includes('待发货')) throw new Error('采购状态内容缺失')
    if (!snapshot.bodyText.includes('中通快递 · ZT123456')) throw new Error('物流信息内容缺失')
    if (snapshot.logisticsButtonCount !== 1) throw new Error('物流轨迹入口数量不正确')
    if (snapshot.logisticsButtonText !== '查看轨迹') throw new Error('物流单号不应包含在轨迹按钮内')
    if (!snapshot.selectedLogisticsText.includes('ZT123456') || snapshot.logisticsValueUserSelect !== 'text') throw new Error('物流单号文本不可选择复制')
    if (!snapshot.logisticsDialogVisible) throw new Error('点击后物流轨迹弹层未显示')
    if (!snapshot.logisticsDialogText.includes('快件已到达沈阳转运中心') || !snapshot.logisticsDialogText.includes('快件已揽收')) throw new Error('物流轨迹内容缺失')
    if (snapshot.syncButtonText !== '同步完成' || snapshot.syncButtonDisabled) throw new Error('同步采购单按钮完成态不正确')
    if (!aftersaleDialogState.visible || aftersaleDialogState.purchaseOptionCount !== 2 || aftersaleDialogState.quickPhraseCount !== 4) throw new Error('标记售后弹层内容不完整')
    if (!actionRequests.some(payload => payload.action === 'view-logistics' && payload.purchaseId === 81)) throw new Error('物流轨迹操作未通过 preload IPC 发送到主进程')
    if (!actionRequests.some(payload => payload.action === 'sync-orders')) throw new Error('同步采购单操作未通过 preload IPC 发送到主进程')
    if (!actionRequests.some(payload => payload.action === 'mark-aftersale'
      && payload.purchaseId === 82
      && payload.aftersaleStatus === 'pending_return_refund'
      && payload.aftersaleRemark === '用户已退款，请申请退货退款。')) throw new Error(`标记售后表单数据不正确: ${JSON.stringify({ actionRequests: actionRequests.filter(payload => payload.action === 'mark-aftersale'), aftersaleDialogState })}`)
    if (actionMessages.length) throw new Error('已有正式 IPC 通道时不应回退到控制台消息')
    if (snapshot.originalStatusPreserved !== '买家已付款，待商家发货') throw new Error('京东原页面内容被改写')
    if (snapshot.hostPosition === 'fixed' || snapshot.hostPosition === 'absolute') throw new Error('采购信息区域不应悬浮遮挡')
    if (snapshot.panelWidth < 1000) throw new Error('采购信息区域没有继承订单卡片宽度')

    const afterSaleServiceId = '4048292768'
    const afterSaleOrderId = '3557439004118866'
    await win.loadURL(`https://shop.jd.com/jdm/trade/after-sale/independent-after-sale/detail?afsServiceId=${afterSaleServiceId}`)
    await waitFor(
      () => actionRequests.some(payload => payload.action === 'resolve-aftersale-order'
        && payload.afsServiceId === afterSaleServiceId
        && payload.orderId === afterSaleOrderId),
      '售后详情接口响应中的销售订单号未通过 preload IPC 回传'
    )
    await win.webContents.executeJavaScript(buildOrderPurchasePanelScript({
      state: 'ready',
      orderId: afterSaleOrderId,
      pageKey: `aftersale:${afterSaleServiceId}`,
      orders: [{
        id: 83,
        purchaseNo: 'A8303',
        platform: 'taobao',
        platformLabel: '淘宝/天猫',
        accountName: '淘_天下物品',
        platformOrderNo: '5127692041018003142',
        createdAt: '2026-08-14 16:07:00',
        updatedAt: '2026-08-28 11:20:00',
        goodsName: '古风油纸伞中国风装饰伞',
        sku: 'SKU-8303',
        quantity: 1,
        purchasePrice: 26.99,
        totalAmount: 26.99,
        shippingFee: 0,
        warehouseName: '九间1号库',
        sourceUrl: 'https://detail.tmall.com/item.htm?id=8303',
        purchaseTypeLabel: '仓库转发',
        status: 'shipped',
        statusLabel: '已发货',
        aftersaleStatusLabel: '待商家处理',
        logisticsCompany: '极兔速递',
        logisticsNo: 'JT8303',
        logisticsLabel: '极兔速递 · JT8303',
        shippingName: '张学军',
        shippingPhone: '17305271170',
        shippingAddress: '内蒙古包头市九原区',
        remark: '售后页完整采购信息测试'
      }],
      actionPrefix: '[DXE_ORDER_PURCHASE_LOGISTICS_TEST]',
      actionNonce: 'electron-smoke-aftersale-nonce'
    }), true)

    const afterSaleSnapshot = await waitFor(
      () => win.webContents.executeJavaScript(`(() => {
        const host = document.getElementById('dxe-order-purchase-panel-host');
        const layout = document.getElementById('aftersale-detail-layout');
        const infoCard = document.getElementById('aftersale-info-card');
        if (!host?.shadowRoot) return null;
        const hostRect = host.getBoundingClientRect();
        const layoutRect = layout.getBoundingClientRect();
        const infoCardRect = infoCard.getBoundingClientRect();
        return {
          insideAfterSaleMainColumn: host.parentElement === infoCard.parentElement,
          immediatelyBeforeAfterSaleInfo: host.nextElementSibling === infoCard,
          alignedWithAfterSaleMainColumn: Math.abs(hostRect.left - infoCardRect.left) <= 1 && Math.abs(hostRect.width - infoCardRect.width) <= 1,
          narrowerThanFullLayout: hostRect.width < layoutRect.width,
          bodyText: host.shadowRoot.textContent,
          sourceLink: host.shadowRoot.querySelector('.order-footer a')?.href || '',
          editButtonCount: [...host.shadowRoot.querySelectorAll('button')].filter(button => button.textContent.includes('编辑订单')).length,
          originalAfterSaleStatusPreserved: document.getElementById('aftersale-status-card')?.textContent,
          hostPosition: getComputedStyle(host).position,
          panelWidth: host.getBoundingClientRect().width
        };
      })()`),
      '售后详情采购信息区域未成功插入'
    )

    if (!afterSaleSnapshot.insideAfterSaleMainColumn) throw new Error('售后采购信息区域没有进入售后详情左侧主内容栏')
    if (!afterSaleSnapshot.immediatelyBeforeAfterSaleInfo) throw new Error('售后采购信息区域没有位于申请信息上方')
    if (!afterSaleSnapshot.alignedWithAfterSaleMainColumn) throw new Error('售后采购信息区域没有与售后左侧内容栏对齐')
    if (!afterSaleSnapshot.narrowerThanFullLayout) throw new Error('售后采购信息区域仍然跨越了右侧商品信息栏')
    for (const expectedText of ['A8303', '5127692041018003142', '仓库转发', '待商家处理', '极兔速递 · JT8303', '收件地址', '采购备注']) {
      if (!afterSaleSnapshot.bodyText.includes(expectedText)) throw new Error(`售后采购信息缺失：${expectedText}`)
    }
    if (!afterSaleSnapshot.sourceLink.includes('detail.tmall.com/item.htm?id=8303')) throw new Error('售后采购货源链接缺失')
    if (afterSaleSnapshot.editButtonCount !== 0) throw new Error('售后采购信息不应显示编辑订单')
    if (afterSaleSnapshot.originalAfterSaleStatusPreserved !== '售后服务处理中') throw new Error('京东原售后页面内容被改写')
    if (afterSaleSnapshot.hostPosition === 'fixed' || afterSaleSnapshot.hostPosition === 'absolute') throw new Error('售后采购信息区域不应悬浮遮挡')
    if (afterSaleSnapshot.panelWidth < 600) throw new Error('售后采购信息区域宽度异常')

    console.log(JSON.stringify({ success: true, orderPage: snapshot, afterSalePage: afterSaleSnapshot }, null, 2))
  } finally {
    ipcMain.removeHandler(ORDER_PURCHASE_ACTION_CHANNEL)
    if (!win.isDestroyed()) win.destroy()
    testSession.protocol.unhandle('https')
  }
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch(error => {
    console.error(error.stack || error.message || String(error))
    app.exit(1)
  })
