(() => {
  if (window.__ECOMMERCE_TOOLBOX_COMPLIANCE_UI__) return;
  window.__ECOMMERCE_TOOLBOX_COMPLIANCE_UI__ = true;

  const IS_TOP_FRAME = window === window.top;

  const REQUEST_SOURCE = "ECOMMERCE_TOOLBOX_COMPLIANCE_EXTENSION_V1";
  const RESPONSE_SOURCE = "ECOMMERCE_TOOLBOX_COMPLIANCE_PAGE_V1";
  const FETCH_REQUEST_SOURCE = "ECOMMERCE_TOOLBOX_COMPLIANCE_FETCH_PAGE_V1";
  const FETCH_RESPONSE_SOURCE = "ECOMMERCE_TOOLBOX_COMPLIANCE_FETCH_EXTENSION_V1";
  const STORAGE_KEY = "ecommerceToolboxComplianceCleaner";
  const PROCESSED_SKU_STORAGE_KEY = "ecommerceToolboxComplianceProcessedSkus";
  const PROCESSED_INFO_PRODUCT_STORAGE_KEY = "ecommerceToolboxComplianceProcessedInfoProducts";
  const SKU_STATUS_STORAGE_KEY = "ecommerceToolboxComplianceSkuStatusCacheV1";
  const PROCESSED_SKU_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const PROCESSED_INFO_PRODUCT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const SKU_STATUS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const SKU_STATUS_CACHE_LIMIT = 20000;
  const INFO_TAB_VALUE = "8";
  const TARGET_TAB_VALUES = new Set(["2", "6"]);
  const ON_SALE_STATE = 4;
  const PRODUCT_BATCH_SIZE = 100;
  const DIAGNOSTIC_LIMIT = 120;
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  const diagnosticLogs = [];
  let diagnosticFingerprint = "";
  function diagnosticLog(event, details = {}) {
    const entry = {
      time: new Date().toISOString(),
      event,
      details
    };
    diagnosticLogs.push(entry);
    if (diagnosticLogs.length > DIAGNOSTIC_LIMIT) diagnosticLogs.splice(0, diagnosticLogs.length - DIAGNOSTIC_LIMIT);
    console.info("[电商综合工具箱][合规]", event, details);
    void chrome.runtime.sendMessage({type: "TOOLBOX_COMPLIANCE_DIAGNOSTIC", entry}).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TOOLBOX_GET_COMPLIANCE_LOGS") {
      sendResponse({
        ok: true,
        url: location.href,
        topFrame: IS_TOP_FRAME,
        logs: diagnosticLogs
      });
      return;
    }
    if (message?.type !== "TOOLBOX_SHOW_INFORMATION_CONFIRM" || !IS_TOP_FRAME) return;
    const payload = message.payload || {};
    showInformationProductConfirm(payload.productId, payload.skuId, payload.count, false)
      .then((confirmed) => sendResponse({ok: true, confirmed}))
      .catch((error) => sendResponse({ok: false, error: error?.message || "删除确认框显示失败"}));
    return true;
  });

  window.addEventListener("error", (event) => {
    diagnosticLog("window_error", {message: event.message, file: event.filename, line: event.lineno});
  });
  window.addEventListener("unhandledrejection", (event) => {
    diagnosticLog("unhandled_rejection", {message: event.reason?.message || String(event.reason || "")});
  });
  diagnosticLog("script_started", {url: location.href, topFrame: IS_TOP_FRAME});

  let runToken = 0;
  let scanToken = 0;
  let products = [];
  let allSourceSkuIds = [];
  let sourceSkuIds = [];
  let processedSkuRecords = {};
  let processedInfoProductRecords = {};
  let skuStatusRecords = {};
  const visibleSkuStatusPending = new Set();
  let visibleSkuStatusTimer = 0;
  let visibleSkuStatusRunning = false;
  let visibleSkuStatusQueued = false;
  let visibleSkuStatusLastFailureAt = 0;
  let failureDetails = [];
  const infoProductCache = new Map();
  const infoProductPending = new Set();
  const detailSkuCache = new Map();
  const detailSkuPending = new Set();
  const selectedInfoProducts = new Map();
  let state = {
    panelOpen: false,
    status: "idle",
    message: "先读取当前筛选结果，不会立即修改商品",
    delayMs: 1000,
    scannedPages: 0,
    skuCount: 0,
    markedCount: 0,
    productCount: 0,
    onSaleCount: 0,
    success: 0,
    failed: 0,
    processed: 0,
    total: 0
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== FETCH_REQUEST_SOURCE || !message.requestId) return;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TOOLBOX_COMPLIANCE_SFF_FETCH",
        url: message.url,
        headers: message.headers,
        body: message.body
      });
      if (!response?.ok) throw new Error(response?.error || "扩展后台请求商品接口失败");
      window.postMessage({
        source: FETCH_RESPONSE_SOURCE,
        requestId: message.requestId,
        ok: true,
        response: response.response
      }, location.origin);
    } catch (error) {
      window.postMessage({
        source: FETCH_RESPONSE_SOURCE,
        requestId: message.requestId,
        ok: false,
        error: error?.message || "扩展后台请求商品接口失败"
      }, location.origin);
    }
  });

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function loadProcessedSkuRecords() {
    const stored = (await chrome.storage.local.get(PROCESSED_SKU_STORAGE_KEY))[PROCESSED_SKU_STORAGE_KEY];
    const cutoff = Date.now() - PROCESSED_SKU_RETENTION_MS;
    const next = {};
    for (const [skuId, record] of Object.entries(stored && typeof stored === "object" ? stored : {})) {
      if (/^\d{8,20}$/.test(skuId) && Number(record?.deletedAt) >= cutoff) next[skuId] = record;
    }
    processedSkuRecords = next;
    await chrome.storage.local.set({[PROCESSED_SKU_STORAGE_KEY]: processedSkuRecords});
  }

  function normalizedSkuStatusRecord(record, cutoff = Date.now() - SKU_STATUS_RETENTION_MS) {
    if (!record || typeof record !== "object") return null;
    const checkedAt = Number(record.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt < cutoff) return null;
    const kind = String(record.kind || "");
    if (!new Set(["onsale", "offsale", "nonexistent", "unknown"]).has(kind)) return null;
    const label = ({onsale: "售卖中", offsale: "已下架", nonexistent: "查无商品"})[kind]
      || String(record.label || "").trim();
    if (!label) return null;
    const productId = String(record.productId || "").trim();
    return {
      kind,
      label: label.slice(0, 40),
      title: String(record.title || "").slice(0, 300),
      productId: /^\d{8,20}$/.test(productId) ? productId : "",
      checkedAt
    };
  }

  async function saveSkuStatusRecords() {
    const cutoff = Date.now() - SKU_STATUS_RETENTION_MS;
    const entries = Object.entries(skuStatusRecords)
      .map(([skuId, record]) => [skuId, normalizedSkuStatusRecord(record, cutoff)])
      .filter(([skuId, record]) => /^\d{8,20}$/.test(skuId) && record)
      .sort((left, right) => right[1].checkedAt - left[1].checkedAt)
      .slice(0, SKU_STATUS_CACHE_LIMIT);
    skuStatusRecords = Object.fromEntries(entries);
    await chrome.storage.local.set({[SKU_STATUS_STORAGE_KEY]: skuStatusRecords});
  }

  async function loadSkuStatusRecords() {
    const stored = (await chrome.storage.local.get(SKU_STATUS_STORAGE_KEY))[SKU_STATUS_STORAGE_KEY];
    skuStatusRecords = stored && typeof stored === "object" ? stored : {};
    await saveSkuStatusRecords();
  }

  function cacheSkuStatusRecords(records) {
    const checkedAt = Date.now();
    for (const [skuIdValue, status] of Object.entries(records || {})) {
      const skuId = String(skuIdValue || "");
      if (!/^\d{8,20}$/.test(skuId) || !status) continue;
      skuStatusRecords[skuId] = {...status, checkedAt};
    }
    void saveSkuStatusRecords().catch((error) => {
      diagnosticLog("sku_status_cache_save_failed", {message: error?.message || String(error)});
    });
  }

  async function loadProcessedInfoProductRecords() {
    const stored = (await chrome.storage.local.get(PROCESSED_INFO_PRODUCT_STORAGE_KEY))[PROCESSED_INFO_PRODUCT_STORAGE_KEY];
    const cutoff = Date.now() - PROCESSED_INFO_PRODUCT_RETENTION_MS;
    const next = {};
    for (const [productId, record] of Object.entries(stored && typeof stored === "object" ? stored : {})) {
      if (!/^\d{8,20}$/.test(productId) || Number(record?.deletedAt) < cutoff) continue;
      next[productId] = {
        deletedAt: Number(record.deletedAt),
        salesVolume: Number.isFinite(Number(record?.salesVolume)) ? Math.max(0, Number(record.salesVolume)) : null
      };
    }
    processedInfoProductRecords = next;
    await chrome.storage.local.set({[PROCESSED_INFO_PRODUCT_STORAGE_KEY]: processedInfoProductRecords});
  }

  async function markInfoProductsDeleted(records) {
    const deletedAt = Date.now();
    for (const record of records) {
      const id = String(record?.productId ?? "").trim();
      if (!/^\d{8,20}$/.test(id)) continue;
      processedInfoProductRecords[id] = {
        deletedAt,
        salesVolume: Number.isFinite(Number(record?.salesVolume)) ? Math.max(0, Number(record.salesVolume)) : null
      };
    }
    await chrome.storage.local.set({[PROCESSED_INFO_PRODUCT_STORAGE_KEY]: processedInfoProductRecords});
    ensureInformationViolationRows();
    ensureLegalQueryDetailRows();
  }

  async function markInfoProductDeleted(productId, salesVolume) {
    await markInfoProductsDeleted([{productId, salesVolume}]);
  }

  async function markSkuIdsDeleted(records) {
    const deletedAt = Date.now();
    for (const record of records) {
      const skuId = String(record?.skuId ?? "");
      if (!/^\d{8,20}$/.test(skuId)) continue;
      processedSkuRecords[String(skuId)] = {
        productId: String(record?.productId ?? ""),
        deletedAt,
        source: record?.source === "recycle" ? "recycle" : "delete"
      };
      delete skuStatusRecords[skuId];
    }
    await chrome.storage.local.set({
      [PROCESSED_SKU_STORAGE_KEY]: processedSkuRecords,
      [SKU_STATUS_STORAGE_KEY]: skuStatusRecords
    });
    state.markedCount = allSourceSkuIds.filter((skuId) => processedSkuRecords[skuId]).length;
    annotateProcessedRows();
  }

  function knownSkuIdsForProduct(product) {
    const productId = String(product?.productId ?? "").trim();
    const skuIds = new Set((product?.skuIds || []).map((skuId) => String(skuId)));
    for (const [skuId, status] of Object.entries(skuStatusRecords)) {
      if (String(status?.productId || "") === productId) skuIds.add(String(skuId));
    }
    for (const [skuId, record] of Object.entries(processedSkuRecords)) {
      if (String(record?.productId || "") === productId) skuIds.add(String(skuId));
    }
    return [...skuIds].filter((skuId) => /^\d{8,20}$/.test(skuId));
  }

  async function markProductDeleted(product) {
    await markSkuIdsDeleted(knownSkuIdsForProduct(product).map((skuId) => ({
      skuId,
      productId: product.productId,
      source: product.deletionSource === "recycle" ? "recycle" : "delete"
    })));
  }

  async function markProductsDeleted(productsToMark) {
    await markSkuIdsDeleted(productsToMark.flatMap((product) => knownSkuIdsForProduct(product).map((skuId) => ({
      skuId,
      productId: product.productId,
      source: product.deletionSource === "recycle" ? "recycle" : "delete"
    }))));
  }

  function findSkuTextContainer(row, skuId) {
    const skuPattern = new RegExp(`SKU\\s*[:：]\\s*${skuId}(?!\\d)`, 'i');
    const walker = document.createTreeWalker(row, 4);
    let textNode = walker.nextNode();
    while (textNode) {
      const parent = textNode.parentElement;
      if (parent && !parent.closest('.et-c-processed-badge, .et-c-status-actions')
        && skuPattern.test(textNode.nodeValue || '')) return parent;
      textNode = walker.nextNode();
    }
    return [...row.querySelectorAll('[role="gridcell"], td, span, div')]
      .find((element) => skuPattern.test(element.textContent || '')) || row;
  }

  function directRowCells(row) {
    return [...(row?.children || [])].filter((element) => element.matches(
      'td, [role="gridcell"], .ag-cell'
    ));
  }

  function operationCellInsideRow(row) {
    const explicit = row?.querySelector([
      '[col-id="operation"]',
      '[col-id="operate"]',
      '[data-col-key="operation"]',
      '[data-col-key="operate"]',
      'td[class*="fix-right"]',
      'td[class*="fixed-right"]'
    ].join(','));
    if (explicit) return explicit;

    const cells = directRowCells(row);
    const table = row.closest('table');
    const headerRows = table?.tHead?.rows ? [...table.tHead.rows] : [];
    const headers = headerRows.length ? [...headerRows.at(-1).cells] : [];
    const operationIndex = headers.findIndex((header) => (header.innerText || header.textContent || '').trim() === '操作');
    if (operationIndex >= 0 && cells[operationIndex]) return cells[operationIndex];

    return null;
  }

  function tableBodyRows(table) {
    return [...(table?.tBodies || [])].flatMap((body) => [...body.rows]);
  }

  function matchingFixedRow(row, table) {
    const targetRows = tableBodyRows(table);
    if (!targetRows.length) return null;
    const identityAttributes = ['data-row-key', 'data-key', 'row-key', 'aria-rowindex'];
    for (const attribute of identityAttributes) {
      const identity = row.getAttribute(attribute);
      if (!identity) continue;
      const matchingRow = targetRows.find((targetRow) => targetRow.getAttribute(attribute) === identity);
      if (matchingRow) return matchingRow;
    }

    const sourceRows = tableBodyRows(row.closest('table'));
    const rowIndex = sourceRows.indexOf(row);
    return rowIndex >= 0 ? targetRows[rowIndex] || null : null;
  }

  function findRowOperationCell(row) {
    const insideRow = operationCellInsideRow(row);
    const gridRoot = row.closest('[role="grid"], .ag-root, .ag-root-wrapper') || document;
    const operationHeader = [...gridRoot.querySelectorAll('[role="columnheader"], .ag-header-cell')]
      .find((header) => (header.innerText || header.textContent || '').trim() === '操作');
    const columnId = operationHeader?.getAttribute('col-id') || operationHeader?.dataset?.colId || '';
    const pinnedContainers = [...gridRoot.querySelectorAll(
      '.ag-pinned-right-cols-container, [class*="pinned-right-cols"]'
    )];
    for (const container of pinnedContainers) {
      const targetRows = [...container.querySelectorAll('[role="row"], .ag-row')];
      const targetRow = ['row-id', 'row-index', 'aria-rowindex', 'data-row-key', 'data-key']
        .map((attribute) => {
          const identity = row.getAttribute(attribute);
          return identity
            ? targetRows.find((candidate) => candidate.getAttribute(attribute) === identity)
            : null;
        })
        .find(Boolean);
      if (!targetRow) continue;
      const targetCell = columnId
        ? [...targetRow.querySelectorAll('[col-id]')].find((cell) => cell.getAttribute('col-id') === columnId)
        : null;
      if (targetCell) return targetCell;
      const fallbackCell = directRowCells(targetRow).at(-1);
      if (fallbackCell) return fallbackCell;
    }

    const sourceTable = row.closest('table');
    const operationTables = [...new Set(
      [...document.querySelectorAll('th, [role="columnheader"], .ag-header-cell')]
        .filter((header) => (header.innerText || header.textContent || '').trim() === '操作')
        .map((header) => header.closest('table'))
        .filter(Boolean)
    )];
    const fixedOperationTables = operationTables.filter((table) => table !== sourceTable && table.closest([
      '.ant-table-fixed-right',
      '.ant-table-fixed-right-holder',
      '[class*="fixed-right"]',
      '[class*="fixedRight"]',
      '[class*="sticky-right"]'
    ].join(',')));

    for (const operationTable of [...fixedOperationTables, ...operationTables.filter((table) => table !== sourceTable)]) {
      const targetRow = matchingFixedRow(row, operationTable);
      if (!targetRow) continue;
      const targetCell = operationCellInsideRow(targetRow) || directRowCells(targetRow).at(-1);
      if (targetCell) return targetCell;
    }

    if (insideRow) return insideRow;

    if (columnId && globalThis.CSS?.escape) {
      const matchingCell = row.querySelector(`[col-id="${CSS.escape(columnId)}"]`);
      if (matchingCell) return matchingCell;
    }
    return null;
  }

  function findOperationActionsContainer(operationCell) {
    if (!(operationCell instanceof Element)) return null;
    return operationCell.querySelector(':scope > .ag-cell-wrapper > .ag-cell-value')
      || operationCell.querySelector('.ag-cell-wrapper .ag-cell-value')
      || operationCell.querySelector('.ag-cell-value')
      || operationCell;
  }

  function annotateProcessedRows() {
    if (!Object.keys(processedSkuRecords).length && !Object.keys(skuStatusRecords).length && !visibleSkuStatusPending.size) return;
    const rows = [...document.querySelectorAll("tbody tr, tr.render-row, [role='row']")];
    for (const row of rows) {
      const text = row.innerText || row.textContent || "";
      const skuIds = [...new Set([...text.matchAll(/SKU\s*[:：]\s*(\d{8,20})/gi)].map((match) => match[1]))];
      if (!skuIds.length) continue;
      for (const badge of row.querySelectorAll(".et-c-processed-badge[data-sku-id]")) {
        const badgeSkuId = badge.dataset.skuId || "";
        if (!new RegExp(`SKU\\s*[:：]\\s*${badgeSkuId}(?!\\d)`, "i").test(text)) badge.remove();
      }
      for (const button of row.querySelectorAll(".et-c-status-delete[data-sku-id]")) {
        const buttonSkuId = button.dataset.skuId || "";
        if (!new RegExp(`SKU\\s*[:：]\\s*${buttonSkuId}(?!\\d)`, "i").test(text)) button.remove();
      }
      for (const controls of row.querySelectorAll(".et-c-status-actions[data-sku-id]")) {
        const controlsSkuId = controls.dataset.skuId || "";
        if (!new RegExp(`SKU\\s*[:：]\\s*${controlsSkuId}(?!\\d)`, "i").test(text)) controls.remove();
      }
      const operationCell = findRowOperationCell(row);
      const actionContainer = findOperationActionsContainer(operationCell);
      if (operationCell && actionContainer) {
        operationCell.classList.add('et-c-operation-cell');
        actionContainer.classList.add('et-c-operation-actions-container');
        for (const controls of operationCell.querySelectorAll('.et-c-status-actions[data-sku-id]')) {
          if (!skuIds.includes(controls.dataset.skuId || '')) controls.remove();
        }
      }
      for (const skuId of skuIds) {
        const deletedRecord = processedSkuRecords[skuId];
        const statusRecord = skuStatusRecords[skuId];
        const pending = visibleSkuStatusPending.has(skuId);
        let controls = operationCell?.querySelector(`.et-c-status-actions[data-sku-id="${skuId}"]`)
          || row.querySelector(`.et-c-status-actions[data-sku-id="${skuId}"]`);
        let badge = controls?.querySelector(`.et-c-processed-badge[data-sku-id="${skuId}"]`)
          || row.querySelector(`.et-c-processed-badge[data-sku-id="${skuId}"]`);
        let deleteButton = controls?.querySelector(`.et-c-status-delete[data-sku-id="${skuId}"]`)
          || row.querySelector(`.et-c-status-delete[data-sku-id="${skuId}"]`);
        if (!deletedRecord && !statusRecord && !pending) {
          controls?.remove();
          badge?.remove();
          deleteButton?.remove();
          continue;
        }
        if (!badge) badge = document.createElement("span");
        badge.dataset.skuId = skuId;
        if (deletedRecord) {
          badge.className = "et-c-processed-badge et-c-state-deleted";
          badge.textContent = "已删除";
          const action = deletedRecord.source === "recycle" ? "确认该商品已在回收站" : "删除该商品";
          badge.title = `插件已于 ${new Date(deletedRecord.deletedAt).toLocaleString("zh-CN", {hour12: false})} ${action}`;
        } else if (statusRecord) {
          badge.className = `et-c-processed-badge et-c-state-${statusRecord.kind}`;
          badge.textContent = statusRecord.label;
          badge.title = statusRecord.title || `商品当前状态：${statusRecord.label}`;
        } else {
          badge.className = "et-c-processed-badge et-c-state-unknown";
          badge.textContent = "查询中";
          badge.title = "正在实时查询该 SKU 的商品状态";
        }
        const skuTextContainer = findSkuTextContainer(row, skuId);
        if (badge.parentElement !== skuTextContainer) skuTextContainer.appendChild(badge);
        const canDelete = Boolean(
          !deletedRecord
          && new Set(["onsale", "offsale"]).has(statusRecord?.kind)
          && /^\d{8,20}$/.test(String(statusRecord?.productId || ""))
        );
        if (!canDelete || !operationCell || !actionContainer) {
          deleteButton?.remove();
          controls?.remove();
          continue;
        }
        if (!controls) {
          controls = document.createElement("span");
          controls.className = "et-c-status-actions";
          controls.dataset.skuId = skuId;
          actionContainer.appendChild(controls);
        }
        if (controls.parentElement !== actionContainer) actionContainer.appendChild(controls);
        if (deleteButton && deleteButton.parentElement !== controls) controls.appendChild(deleteButton);
        const productId = String(statusRecord.productId);
        if (deleteButton?.dataset.productId !== productId) {
          deleteButton?.remove();
          deleteButton = null;
        }
        if (!deleteButton) {
          deleteButton = document.createElement("button");
          deleteButton.type = "button";
          deleteButton.className = "el-button el-button--text et-c-status-delete";
          deleteButton.dataset.skuId = skuId;
          deleteButton.dataset.productId = productId;
          deleteButton.textContent = "删除商品";
          deleteButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void deleteInformationProduct(productId, event.currentTarget, skuId);
          });
          controls.appendChild(deleteButton);
        }
      }
    }
  }

  function ensureSubjectColumnWidth() {
    const headers = [...document.querySelectorAll(".ag-header-cell, th, [role='columnheader']")];
    const header = headers.find((element) => /(?:预警|处置)主体/.test(element.innerText || element.textContent || ""))
      || document.querySelector('.ag-header-cell[col-id="targetDesc"]');
    if (!(header instanceof HTMLElement) || header.dataset.etResizePending === "1") return;
    const currentWidth = header.getBoundingClientRect().width;
    const targetWidth = 260;
    if (!Number.isFinite(currentWidth) || currentWidth <= 0) return;
    const handle = header.querySelector(".ag-header-cell-resize");
    if (!(handle instanceof HTMLElement)) {
      const row = header.closest("tr");
      const table = header.closest("table");
      const columnIndex = row ? [...row.children].indexOf(header) : -1;
      header.style.setProperty("width", `${targetWidth}px`, "important");
      header.style.setProperty("min-width", `${targetWidth}px`, "important");
      if (table && columnIndex >= 0) {
        let scope = table.parentElement;
        while (scope && scope !== document.body && scope.querySelectorAll("table").length < 2) {
          scope = scope.parentElement;
        }
        const relatedTables = scope && scope !== document.body ? [...scope.querySelectorAll("table")] : [table];
        for (const relatedTable of relatedTables) {
          const column = relatedTable.querySelectorAll("colgroup col")[columnIndex];
          if (column) {
            column.setAttribute("width", String(targetWidth));
            column.style.setProperty("width", `${targetWidth}px`, "important");
            column.style.setProperty("min-width", `${targetWidth}px`, "important");
          }
          for (const tableRow of relatedTable.rows) {
            const cell = tableRow.cells[columnIndex];
            if (!(cell instanceof HTMLElement)) continue;
            cell.style.setProperty("width", `${targetWidth}px`, "important");
            cell.style.setProperty("min-width", `${targetWidth}px`, "important");
          }
        }
      }
      return;
    }
    if (currentWidth >= targetWidth - 1) return;
    const rect = handle.getBoundingClientRect();
    const startX = rect.left + Math.max(1, rect.width / 2);
    const startY = rect.top + Math.max(1, rect.height / 2);
    const endX = startX + targetWidth - currentWidth;
    header.dataset.etResizePending = "1";
    handle.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: startX,
      clientY: startY
    }));
    document.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: endX,
      clientY: startY
    }));
    document.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 0,
      clientX: endX,
      clientY: startY
    }));
    setTimeout(() => delete header.dataset.etResizePending, 500);
  }

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function selectedComplianceTab() {
    const selectors = [
      '[role="tab"][aria-selected="true"]',
      '[role="tab"].active',
      '.jd-tabs__item.is-active',
      '.jd-tabs__item.active',
      '[class*="tab"][class*="active"]'
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        const text = element.textContent?.trim() || "";
        for (const name of ["店铺合规", "风险诊断", "预警单", "违约单", "处置记录", "信息违规"]) {
          if (text.includes(name)) return name;
        }
      }
    }
    return "";
  }

  function isComplianceSection() {
    return location.hostname.toLowerCase() === "illegal-jdm.shop.jd.com"
      && /^\/legal(?:\/|$)/i.test(location.pathname);
  }

  let jdAiAutoCloseRoute = "";
  let jdAiAutoCloseDeadline = 0;
  let jdAiAutoCloseDone = false;
  const JD_AI_AUTO_POPUP_STORAGE_KEY = "ecommerceToolboxJdAiAutoPopupV1";
  let jdAiAutoPopupEnabled = false;

  function findJdAiPanelTitle() {
    if (!document.body) return null;
    const walker = document.createTreeWalker(document.body, 4);
    let textNode = walker.nextNode();
    while (textNode) {
      const text = (textNode.nodeValue || "").replace(/\s+/g, "").trim();
      const parent = textNode.parentElement;
      if (/^(?:京麦)?AI超级助手$/i.test(text) && parent && visible(parent)) return parent;
      textNode = walker.nextNode();
    }
    return null;
  }

  function findJdAiPanelRoot(title) {
    let current = title;
    for (let depth = 0; current && current !== document.body && depth < 12; depth += 1) {
      const rect = current.getBoundingClientRect();
      if (rect.width >= 240 && rect.height >= 240
        && rect.left >= window.innerWidth / 2 && rect.right >= window.innerWidth - 80) return current;
      current = current.parentElement;
    }
    return null;
  }

  function findJdAiPanelCloseButton(panel) {
    const panelRect = panel.getBoundingClientRect();
    const candidates = [...panel.querySelectorAll('button, [role="button"], [aria-label], [title], a, i, span')]
      .map((element) => element.closest('button, [role="button"], a') || element)
      .filter((element, index, list) => list.indexOf(element) === index && visible(element))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width <= 72 && rect.height <= 72
          && rect.top <= panelRect.top + 90 && rect.right >= panelRect.right - 90;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.textContent || ''}`.trim();
        const semanticScore = /关闭|close/i.test(label) ? 100 : /^[×xX]$/.test(label) ? 80 : 0;
        const positionScore = Math.max(0, 50 - Math.abs(panelRect.right - rect.right))
          + Math.max(0, 30 - Math.abs((panelRect.top + 28) - (rect.top + rect.height / 2)));
        return {element, score: semanticScore + positionScore};
      })
      .sort((left, right) => right.score - left.score);
    return candidates[0]?.score >= 30 ? candidates[0].element : null;
  }

  function findJdAiAutoPopupSwitch(panel) {
    const walker = document.createTreeWalker(panel, 4);
    let textNode = walker.nextNode();
    while (textNode) {
      if ((textNode.nodeValue || "").replace(/\s+/g, "").trim() === "允许本页面自动弹出") {
        let current = textNode.parentElement;
        for (let depth = 0; current && current !== panel.parentElement && depth < 7; depth += 1) {
          const control = current.matches?.('[role="switch"], input[type="checkbox"], [class*="switch"]')
            ? current
            : current.querySelector?.('[role="switch"], input[type="checkbox"], [class*="switch"]');
          if (control && visible(control)) return control;
          current = current.parentElement;
        }
      }
      textNode = walker.nextNode();
    }
    return null;
  }

  function jdAiSwitchEnabled(control) {
    const checkbox = control.matches?.('input[type="checkbox"]')
      ? control
      : control.querySelector?.('input[type="checkbox"]');
    if (checkbox) return Boolean(checkbox.checked);
    const ariaControl = control.hasAttribute?.('aria-checked')
      ? control
      : control.querySelector?.('[aria-checked]');
    if (ariaControl) return ariaControl.getAttribute('aria-checked') === 'true';
    const className = `${control.className || ""} ${control.querySelector?.('[class*="checked"], [class*="active"]')?.className || ""}`;
    if (/\bis-(?:checked|active)\b|\bchecked\b|\bactive\b/i.test(className)) return true;
    if (/switch/i.test(className)) return false;
    return null;
  }

  function saveJdAiAutoPopupPreference(enabled, source) {
    if (typeof enabled !== "boolean" || enabled === jdAiAutoPopupEnabled) return;
    jdAiAutoPopupEnabled = enabled;
    try {
      const result = chrome.storage.local.set({
        [JD_AI_AUTO_POPUP_STORAGE_KEY]: {enabled, updatedAt: Date.now()}
      });
      result?.catch?.(() => {});
    } catch (_error) {
      // The in-memory preference still applies for the current page.
    }
    diagnosticLog("jd_ai_auto_popup_preference_changed", {enabled, source});
  }

  function observeJdAiAutoPopupSwitch(panel) {
    const control = findJdAiAutoPopupSwitch(panel);
    if (!control) return;
    const current = jdAiSwitchEnabled(control);
    if (typeof current === "boolean") saveJdAiAutoPopupPreference(current, "visible_switch");
  }

  function jdAiSwitchFromEventTarget(target) {
    if (!(target instanceof Element)) return null;
    const control = target.closest('[role="switch"], input[type="checkbox"], [class*="switch"]');
    if (!control) return null;
    let current = control;
    for (let depth = 0; current && current !== document.body && depth < 7; depth += 1) {
      if ((current.textContent || "").replace(/\s+/g, "").includes("允许本页面自动弹出")) return control;
      current = current.parentElement;
    }
    return null;
  }

  function handleJdAiAutoPopupSwitchInteraction(event) {
    const control = jdAiSwitchFromEventTarget(event.target);
    if (!control) return;
    const syncAfterChange = () => setTimeout(() => {
      const enabled = jdAiSwitchEnabled(control);
      saveJdAiAutoPopupPreference(enabled, "switch_interaction");
      scheduleEnsureUi();
    }, 80);
    syncAfterChange();
  }

  function suppressInitialJdAiPanel(complianceSection) {
    if (!IS_TOP_FRAME) return;
    const route = complianceSection ? `${location.pathname}${location.search}` : "";
    if (route !== jdAiAutoCloseRoute) {
      jdAiAutoCloseRoute = route;
      jdAiAutoCloseDeadline = route ? Date.now() + 15000 : 0;
      jdAiAutoCloseDone = false;
    }
    const title = findJdAiPanelTitle();
    const panel = title ? findJdAiPanelRoot(title) : null;
    if (panel) observeJdAiAutoPopupSwitch(panel);
    if (!route || Date.now() > jdAiAutoCloseDeadline) return;
    if (jdAiAutoPopupEnabled) {
      if (panel) jdAiAutoCloseDone = true;
      return;
    }
    if (jdAiAutoCloseDone) return;
    const closeButton = panel ? findJdAiPanelCloseButton(panel) : null;
    if (!closeButton) return;
    jdAiAutoCloseDone = true;
    closeButton.click();
    diagnosticLog("jd_ai_initial_panel_closed", {route});
  }

  function targetPageName() {
    if (!isComplianceSection()) return "";
    const tabValue = new URL(location.href).searchParams.get("tabsActiveName") || "";
    if (!TARGET_TAB_VALUES.has(tabValue)) return "";
    return selectedComplianceTab() || `合规页签 ${tabValue}`;
  }

  function isInformationViolationView() {
    if (document.querySelector(".conent_wrap_spu, .content_wrap_spu")) return true;
    if (!isComplianceSection()) return false;
    const tabValue = new URL(location.href).searchParams.get("tabsActiveName") || "";
    if (tabValue === INFO_TAB_VALUE) return true;
    if (selectedComplianceTab() === "信息违规") return true;
    return Boolean(document.querySelector(".conent_wrap_spu, .content_wrap_spu"));
  }

  async function bridgeRequest(type, payload = {}, timeoutMs = 50000) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("等待商品列表官方接口响应超时")), timeoutMs);
    });
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({
          type: "TOOLBOX_PRODUCT_API_REQUEST",
          action: type,
          payload
        }),
        timeout
      ]);
      if (!response?.ok) throw new Error(response?.error || "商品列表官方接口调用失败");
      return response.result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function extractSkuIdsFromRows() {
    let rows = [...document.querySelectorAll("tbody tr, tr.render-row, [role='row']")]
      .filter((row) => visible(row));
    if (!rows.length) rows = [...document.querySelectorAll("tbody tr, tr.render-row, [role='row']")];
    const result = new Set();
    for (const row of rows) {
      const text = row.innerText || row.textContent || "";
      for (const match of text.matchAll(/SKU\s*[:：]\s*(\d{8,20})/gi)) result.add(match[1]);
    }
    return [...result];
  }

  function paginationInfo() {
    const candidates = [...document.querySelectorAll('button[aria-label="下一页"], [role="button"][aria-label="下一页"], [role="pagination"] button.btn-next, .el-pagination button.btn-next, button.btn-next')]
      .filter((element) => visible(element));
    const next = candidates.at(-1) || null;
    if (!next) return {root: null, next: null};
    const root = next.closest('[role="pagination"], [aria-label="pagination"], .jd-pagination, [class*="pagination"]')
      || next.parentElement;
    return {root, next};
  }

  function disabled(element) {
    return !element
      || element.disabled
      || element.getAttribute("aria-disabled") === "true"
      || /(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/.test(element.className || "");
  }

  function activePageText(root) {
    if (!root) return "1";
    const active = root.querySelector('[aria-current="page"], .is-active, .active, [class*="selected"]');
    return active?.textContent?.trim() || "";
  }

  function pageSignature() {
    const {root} = paginationInfo();
    return `${activePageText(root)}|${rowContentSignature()}`;
  }

  function rowContentSignature() {
    let rows = [...document.querySelectorAll("tbody tr, tr.render-row, [role='row']")]
      .filter((row) => visible(row));
    if (!rows.length) rows = [...document.querySelectorAll("tbody tr, tr.render-row, [role='row']")];
    return rows.map((row) => String(row.innerText || row.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 600))
      .filter(Boolean)
      .join("||");
  }

  function tableIsLoading() {
    return [...document.querySelectorAll(".el-loading-mask, .jd-loading, .jd-spin, [aria-busy='true'], [class*='loading-mask']")]
      .some((element) => visible(element));
  }

  async function waitForPageChange(before, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    const separatorIndex = before.indexOf("|");
    const beforeRows = separatorIndex >= 0 ? before.slice(separatorIndex + 1) : before;
    let stableSignature = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      await sleep(150);
      const now = pageSignature();
      const nowSeparatorIndex = now.indexOf("|");
      const nowRows = nowSeparatorIndex >= 0 ? now.slice(nowSeparatorIndex + 1) : now;
      if (!nowRows || nowRows === beforeRows || tableIsLoading()) {
        stableSignature = "";
        stableSince = 0;
        continue;
      }
      if (now !== stableSignature) {
        stableSignature = now;
        stableSince = Date.now();
        continue;
      }
      if (Date.now() - stableSince >= 900) return;
    }
    throw new Error("分页切换后列表没有响应，请稍后重试");
  }

  async function goToFirstPage() {
    const {root} = paginationInfo();
    if (!root || activePageText(root) === "1") return;
    const first = [...root.querySelectorAll("button, li, a, [role='button']")]
      .find((element) => visible(element) && element.textContent?.trim() === "1" && !disabled(element));
    if (!first) return;
    const before = pageSignature();
    first.click();
    await waitForPageChange(before);
  }

  async function collectAllSkuIds(token) {
    await goToFirstPage();
    const skuIds = new Set();
    const seenSignatures = new Set();
    let pages = 0;
    while (pages < 500) {
      if (token !== scanToken) throw new Error("读取已停止");
      const signature = pageSignature();
      if (seenSignatures.has(signature)) break;
      seenSignatures.add(signature);
      extractSkuIdsFromRows().forEach((skuId) => skuIds.add(skuId));
      pages += 1;
      state.scannedPages = pages;
      state.skuCount = skuIds.size;
      state.message = `正在读取第 ${pages} 页，已找到 ${skuIds.size} 个 SKU`;
      render();
      const {next} = paginationInfo();
      if (!next || disabled(next)) break;
      next.click();
      await waitForPageChange(signature);
    }
    if (pages >= 500) throw new Error("分页超过 500 页，已停止以防页面循环");
    return [...skuIds];
  }

  function productItems(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return [];
    for (const key of ["data", "list", "records", "content", "result"]) {
      if (Array.isArray(value[key])) return value[key];
      if (value[key] && typeof value[key] === "object") {
        const nested = productItems(value[key]);
        if (nested.length) return nested;
      }
    }
    return [];
  }

  function itemSkuIds(item) {
    const values = [];
    const lists = [item?.skuInfoVOList, item?.skuList, item?.skus];
    for (const list of lists) {
      for (const sku of Array.isArray(list) ? list : []) {
        values.push(sku?.skuId, sku?.id, sku?.jdSkuId);
      }
    }
    values.push(item?.skuId, item?.productSkuInfoVO?.skuId);
    return [...new Set(values.map((value) => String(value ?? "").trim()).filter((value) => /^\d{8,20}$/.test(value)))];
  }

  function itemState(item) {
    const value = item?.productStatusVO?.productState ?? item?.productState ?? item?.skuStatus;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function itemStatusDescription(item) {
    return String(item?.productStatusVO?.statusDesc ?? item?.statusDesc ?? "").trim();
  }

  function productStatusRecord(product) {
    const description = String(product?.statusDescription || "").trim();
    if (product?.productState === ON_SALE_STATE) {
      return {kind: "onsale", label: "售卖中", title: description || "商品当前在售"};
    }
    if (/下架/.test(description)) {
      return {kind: "offsale", label: "已下架", title: `京麦商品状态：${description}`};
    }
    if (description) return {kind: "unknown", label: description, title: `京麦商品状态：${description}`};
    if (product?.productState !== null && product?.productState !== undefined) {
      return {kind: "offsale", label: "已下架", title: `京麦商品状态值：${product.productState}`};
    }
    return {kind: "unknown", label: "状态未知", title: "商品查询已返回编码，但没有返回可识别的状态"};
  }

  async function refreshSkuStatusRecords(productsToMark, nonexistentSkuIds = [], unknownSkuIds = []) {
    const nextRecords = {};
    for (const product of productsToMark) {
      const status = productStatusRecord(product);
      for (const skuId of product.skuIds || []) {
        nextRecords[String(skuId)] = {...status, productId: String(product.productId)};
      }
    }
    for (const skuId of nonexistentSkuIds) {
      nextRecords[String(skuId)] = {
        kind: "nonexistent",
        label: "查无商品",
        title: "正常商品与回收站接口均响应成功，但都没有返回该 SKU；商品可能已超过回收站保留期限"
      };
    }
    for (const skuId of unknownSkuIds) {
      nextRecords[String(skuId)] = {
        kind: "unknown",
        label: "状态未知",
        title: "商品查询返回了无法与该 SKU 直接对应的商品编码；为避免频繁查询，插件不会继续追查或处理"
      };
    }
    const checkedAt = Date.now();
    for (const [skuId, status] of Object.entries(nextRecords)) {
      skuStatusRecords[skuId] = {...status, checkedAt};
    }
    await saveSkuStatusRecords();
    annotateProcessedRows();
  }

  async function mapSkuIdsToProducts(skuIds, token, options = {}) {
    const quiet = options.quiet === true;
    const productMap = new Map();
    const foundSkuIds = new Set();
    const addProduct = (item, matchedSkuIds) => {
      if (!matchedSkuIds.length) return;
      const productId = String(item?.productId ?? item?.productInfoVO?.productId ?? "").trim();
      if (!/^\d{8,20}$/.test(productId)) return;
      matchedSkuIds.forEach((skuId) => foundSkuIds.add(skuId));
      const existing = productMap.get(productId) || {
        productId,
        skuIds: new Set(),
        productState: itemState(item),
        statusDescription: itemStatusDescription(item),
        name: String(item?.productName || item?.wareName || "")
      };
      matchedSkuIds.forEach((skuId) => existing.skuIds.add(skuId));
      if (itemState(item) !== null) existing.productState = itemState(item);
      if (itemStatusDescription(item)) existing.statusDescription = itemStatusDescription(item);
      productMap.set(productId, existing);
    };
    const ambiguousSkuIds = new Set();
    const anonymousProductIds = new Set();
    for (let offset = 0; offset < skuIds.length; offset += 100) {
      if (token !== scanToken) throw new Error("读取已停止");
      const batch = skuIds.slice(offset, offset + 100);
      const batchSet = new Set(batch);
      if (!quiet) {
        state.message = `正在查询商品状态（${Math.min(offset + batch.length, skuIds.length)} / ${skuIds.length}）`;
        render();
      }
      const result = await bridgeRequest("QUERY_PRODUCTS", {skuIds: batch}, 35000);
      const items = productItems(result);
      let batchHasAnonymousProduct = false;
      for (const item of items) {
        const matchedSkuIds = itemSkuIds(item).filter((skuId) => batchSet.has(skuId));
        addProduct(item, matchedSkuIds);
        if (!matchedSkuIds.length) {
          const productId = String(item?.productId ?? item?.productInfoVO?.productId ?? "").trim();
          if (/^\d{8,20}$/.test(productId)) {
            batchHasAnonymousProduct = true;
            anonymousProductIds.add(productId);
          }
        }
      }
      if (batchHasAnonymousProduct) {
        batch.filter((skuId) => !foundSkuIds.has(skuId)).forEach((skuId) => ambiguousSkuIds.add(skuId));
      }
    }
    const mapped = [...productMap.values()].map((item) => ({...item, skuIds: [...item.skuIds]}));
    const missing = skuIds.filter((skuId) => !foundSkuIds.has(skuId));
    return {mapped, missing, ambiguousSkuIds: [...ambiguousSkuIds], anonymousProductIds: [...anonymousProductIds]};
  }

  async function verifyRecycleSkuIds(skuIds, token, options = {}) {
    const quiet = options.quiet === true;
    const onResolved = typeof options.onResolved === "function" ? options.onResolved : null;
    const confirmed = [];
    const missing = [];
    for (let index = 0; index < skuIds.length; index += 1) {
      if (token !== scanToken) throw new Error("读取已停止");
      const skuId = skuIds[index];
      if (!quiet) {
        state.message = `正在复核回收站（${index + 1} / ${skuIds.length}）`;
        render();
      }
      const result = await bridgeRequest("QUERY_RECYCLE_PRODUCTS", {skuIds: [skuId]}, 35000);
      const item = productItems(result)[0];
      const productId = String(item?.productId ?? item?.productInfoVO?.productId ?? "").trim();
      if (item && /^\d{8,20}$/.test(productId)) {
        const record = {skuId, productId, source: "recycle"};
        confirmed.push(record);
        if (onResolved) await onResolved({kind: "confirmed", skuId, record, index, total: skuIds.length});
      } else {
        missing.push(skuId);
        if (onResolved) await onResolved({kind: "missing", skuId, index, total: skuIds.length});
      }
    }
    return {confirmed, missing};
  }

  function scheduleVisibleSkuStatusRefresh(delayMs = 650) {
    clearTimeout(visibleSkuStatusTimer);
    visibleSkuStatusTimer = setTimeout(() => {
      void refreshVisibleSkuStatuses();
    }, delayMs);
  }

  async function refreshVisibleSkuStatuses() {
    if (!targetPageName() || state.status === "scanning" || state.status === "running") return;
    if (Date.now() - visibleSkuStatusLastFailureAt < 15000) return;
    if (visibleSkuStatusRunning) {
      visibleSkuStatusQueued = true;
      return;
    }
    visibleSkuStatusRunning = true;
    const token = scanToken;
    let querySkuIds = [];
    try {
      await saveSkuStatusRecords();
      const visibleSkuIds = extractSkuIdsFromRows();
      annotateProcessedRows();
      querySkuIds = visibleSkuIds.filter((skuId) =>
        !processedSkuRecords[skuId]
        && !skuStatusRecords[skuId]
        && !visibleSkuStatusPending.has(skuId)
      );
      if (!querySkuIds.length) return;
      querySkuIds.forEach((skuId) => visibleSkuStatusPending.add(skuId));
      annotateProcessedRows();
      diagnosticLog("visible_sku_status_query_started", {
        visibleCount: visibleSkuIds.length,
        queryCount: querySkuIds.length,
        localHitCount: visibleSkuIds.length - querySkuIds.length
      });
      await bridgeRequest("PING", {}, 60000);
      const {mapped, missing, ambiguousSkuIds} = await mapSkuIdsToProducts(querySkuIds, token, {quiet: true});
      if (token !== scanToken) return;
      const mappedSkuIds = mapped.flatMap((product) => product.skuIds || []);
      mappedSkuIds.forEach((skuId) => visibleSkuStatusPending.delete(String(skuId)));
      if (mapped.length) await refreshSkuStatusRecords(mapped);
      const ambiguousSet = new Set(ambiguousSkuIds);
      const recycleCheck = missing.length
        ? await verifyRecycleSkuIds(missing, token, {
            quiet: true,
            onResolved: async ({kind, skuId, record}) => {
              visibleSkuStatusPending.delete(skuId);
              if (kind === "confirmed") {
                await markSkuIdsDeleted([record]);
              } else if (ambiguousSet.has(skuId)) {
                await refreshSkuStatusRecords([], [], [skuId]);
              } else {
                await refreshSkuStatusRecords([], [skuId]);
              }
            }
          })
        : {confirmed: [], missing: []};
      if (token !== scanToken) return;
      const unknown = recycleCheck.missing.filter((skuId) => ambiguousSet.has(skuId));
      const nonexistent = recycleCheck.missing.filter((skuId) => !ambiguousSet.has(skuId));
      visibleSkuStatusLastFailureAt = 0;
      diagnosticLog("visible_sku_status_query_finished", {
        queried: querySkuIds.length,
        products: mapped.length,
        recycle: recycleCheck.confirmed.length,
        nonexistent: nonexistent.length,
        unknown: unknown.length
      });
    } catch (error) {
      if (token === scanToken) {
        visibleSkuStatusLastFailureAt = Date.now();
        diagnosticLog("visible_sku_status_query_failed", {message: error?.message || String(error)});
      }
    } finally {
      querySkuIds.forEach((skuId) => visibleSkuStatusPending.delete(skuId));
      annotateProcessedRows();
      visibleSkuStatusRunning = false;
      if (visibleSkuStatusQueued) {
        visibleSkuStatusQueued = false;
        scheduleVisibleSkuStatusRefresh(800);
      }
    }
  }

  function statusLabel() {
    return ({
      idle: "待读取",
      scanning: "读取中",
      ready: "待确认",
      running: "处理中",
      stopped: "已停止",
      done: "已完成",
      error: "有异常"
    })[state.status] || "待读取";
  }

  function progressPercent() {
    if (!state.total) return state.status === "ready" ? 0 : 0;
    return Math.min(100, Math.round(state.processed / state.total * 100));
  }

  function ensureStyle() {
    if (document.getElementById("et-compliance-style")) return;
    const style = document.createElement("style");
    style.id = "et-compliance-style";
    style.textContent = `
      #et-compliance-launcher{position:fixed;right:0;top:180px;z-index:2147483644;display:grid;place-items:center;width:62px;height:62px;padding:7px;border:1px solid rgba(229,200,169,.92);border-right:0;border-radius:15px 0 0 15px;background:rgba(255,249,238,.96);box-shadow:-2px 5px 14px rgba(69,49,31,.14),inset 0 0 0 1px rgba(255,255,255,.58);backdrop-filter:blur(9px);cursor:pointer}
      #et-compliance-launcher::before{content:'';position:absolute;left:10px;right:10px;bottom:7px;height:15px;border-radius:50%;background:radial-gradient(ellipse at center,rgba(255,102,22,.88) 0%,rgba(255,136,55,.58) 44%,rgba(255,181,112,.26) 65%,rgba(255,188,128,0) 84%);filter:blur(.5px)}
      #et-compliance-launcher::after{content:none}
      #et-compliance-launcher img{position:relative;z-index:1;width:43px;height:43px;object-fit:contain;transform:translateY(-1px);filter:drop-shadow(0 2px 2px rgba(57,43,31,.2))}
      #et-compliance-panel{position:fixed;right:12px;top:192px;z-index:2147483645;width:350px;max-width:calc(100vw - 24px);max-height:calc(100vh - 204px);overflow:auto;border-radius:18px;background:#f7f9ff;color:#17213b;box-shadow:0 18px 55px #13204a3b;font:14px/1.45 Arial,"Microsoft YaHei",sans-serif}
      #et-compliance-panel *{box-sizing:border-box}
      #et-compliance-panel button,#et-compliance-panel input{font:inherit}
      .et-c-head{display:flex;align-items:center;gap:11px;padding:15px 16px;color:#fff;background:linear-gradient(135deg,#ff5b31,#ec3d23);border-radius:18px 18px 0 0}
      .et-c-head img{width:38px;height:38px;object-fit:contain}.et-c-head-text{flex:1}.et-c-head strong{display:block;font-size:19px}.et-c-head small{display:block;opacity:.9}
      .et-c-close{display:flex!important;align-items:center!important;justify-content:center!important;width:38px;height:38px;padding:0!important;border:0;border-radius:11px;background:#ffffff2b;color:#fff;font-size:24px!important;line-height:1!important;cursor:pointer}
      .et-c-body{padding:12px}.et-c-card{margin-bottom:11px;padding:12px;border:1px solid #d8e0f5;border-radius:14px;background:#fff}
      .et-c-status{display:flex;align-items:center;justify-content:space-between;gap:8px}.et-c-badge{padding:3px 9px;border-radius:999px;background:#fff0ed;color:#e33f29;font-weight:700}.et-c-page{color:#62708e;font-size:13px}
      .et-c-progress{height:7px;margin:10px 0 9px;border-radius:999px;background:#edf0f8;overflow:hidden}.et-c-progress i{display:block;height:100%;width:var(--p);background:linear-gradient(90deg,#ff6842,#ec3d23);transition:width .2s}
      .et-c-counts{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.et-c-count{padding:8px 4px;text-align:center;border-radius:10px;background:#f5f7fc}.et-c-count b{display:block;font-size:20px}.et-c-count span{color:#73809d;font-size:12px}
      .et-c-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:9px}.et-c-summary div{padding:7px 3px;text-align:center;border:1px solid #e5e9f4;border-radius:9px}.et-c-summary b{display:block}.et-c-summary span{font-size:11px;color:#77839c}
      .et-c-message{margin-top:9px;color:#5c6882;word-break:break-all}.et-c-message.error{color:#e33f29}
      .et-c-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.et-c-row label{color:#46526d}.et-c-delay{display:flex;align-items:center;gap:6px}.et-c-delay input{width:58px;height:32px;padding:4px 7px;border:1px solid #bfcaf0;border-radius:8px;text-align:center;outline:none}
      .et-c-note{margin-top:10px;padding-top:9px;border-top:1px solid #edf0f5;color:#e34a32;font-size:12px}
      .et-c-actions{display:grid;grid-template-columns:1fr 1.45fr;gap:9px}.et-c-btn{height:40px;border:0;border-radius:10px;cursor:pointer;font-weight:700}.et-c-read{background:#eef2ff;color:#3558d9;border:1px solid #cbd6ff}.et-c-run{background:linear-gradient(90deg,#ff643c,#ee4025);color:#fff}.et-c-btn:disabled{cursor:not-allowed;opacity:.45}.et-c-fail{cursor:help;color:#d94834!important}
      .et-c-operation-cell{height:100%!important;padding-top:0!important;padding-bottom:0!important;line-height:normal!important}.et-c-operation-cell>.ag-cell-wrapper{display:flex!important;align-items:center!important;width:100%!important;height:100%!important;min-height:0!important}.et-c-operation-actions-container{display:flex!important;align-items:center!important;flex-wrap:wrap!important;column-gap:10px!important;row-gap:0!important;width:100%!important;max-width:100%!important;overflow:visible!important;line-height:24px!important;white-space:normal!important}.et-c-operation-actions-container>div{width:auto!important;min-width:0!important;margin:0!important}.et-c-status-actions{display:inline-flex!important;align-items:center!important;width:auto!important;min-width:0!important;max-width:100%!important;margin:0!important;line-height:24px!important;white-space:nowrap!important}.et-c-status-delete{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:auto!important;height:24px!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;color:#f5222d!important;font:12px/24px Arial,"Microsoft YaHei",sans-serif!important;white-space:nowrap!important;cursor:pointer!important}.et-c-status-delete:hover{background:transparent!important;color:#cf1322!important}.et-c-status-delete.is-done{color:#168044!important;cursor:default!important}.et-c-status-delete.is-failed{color:#c93320!important}.et-c-status-actions .et-c-processed-badge{margin-left:0!important}.et-c-processed-badge{display:inline-block!important;margin-left:7px!important;padding:1px 7px!important;border:1px solid transparent!important;border-radius:999px!important;font:700 12px/19px Arial,"Microsoft YaHei",sans-serif!important;vertical-align:middle!important;white-space:nowrap!important}.et-c-state-deleted{border-color:#97d7ad!important;background:#eaf8ef!important;color:#168044!important}.et-c-state-onsale{border-color:#8db7ff!important;background:#eaf2ff!important;color:#2464cb!important}.et-c-state-offsale{border-color:#c7ceda!important;background:#f1f3f6!important;color:#596274!important}.et-c-state-unknown{border-color:#f0bd70!important;background:#fff5e5!important;color:#b46b08!important}.et-c-state-nonexistent{border-color:#c8cdd5!important;background:#eef0f3!important;color:#666d78!important}
      .et-c-info-action{display:flex!important;align-items:center!important;gap:7px!important;width:max-content!important;margin-top:4px!important;font:12px/24px Arial,"Microsoft YaHei",sans-serif!important;white-space:nowrap!important}.et-c-info-select{width:14px!important;height:14px!important;margin:0!important;accent-color:#f05236!important}.et-c-info-sales{color:#657087!important}.et-c-info-sales-number{color:inherit!important;font-weight:400!important}.et-c-info-sales-number.is-positive{color:#169653!important;font-weight:700!important}.et-c-info-delete{height:24px!important;padding:0 8px!important;border:1px solid #ffb7a8!important;border-radius:5px!important;background:#fff2ef!important;color:#e44029!important;font:12px/22px Arial,"Microsoft YaHei",sans-serif!important;cursor:pointer!important}.et-c-info-delete:hover{border-color:#f06a52!important;background:#ffe8e2!important}.et-c-info-delete.is-done{border-color:#9dd8af!important;background:#eaf8ef!important;color:#178044!important;cursor:default!important}.et-c-info-delete.is-failed{border-color:#ef8a78!important;background:#fff0ed!important;color:#c93320!important}.et-c-detail-action{display:inline-flex!important;align-items:center!important;gap:7px!important;margin-left:10px!important;font:12px/24px Arial,"Microsoft YaHei",sans-serif!important;white-space:nowrap!important}.et-c-detail-status{display:inline-block!important;padding:1px 7px!important;border:1px solid transparent!important;border-radius:999px!important;font-weight:700!important;line-height:19px!important}.et-c-detail-action .et-c-info-delete[hidden]{display:none!important}#et-c-info-batch-toolbar{display:inline-flex!important;align-items:center!important;gap:8px!important;margin-left:9px!important;vertical-align:middle!important;font:13px/28px Arial,"Microsoft YaHei",sans-serif!important;white-space:nowrap!important}#et-c-info-batch-toolbar .et-c-info-select-all{width:15px!important;height:15px!important;margin:0!important;accent-color:#f05236!important;cursor:pointer!important}.et-c-info-batch-delete{display:inline-flex!important;align-items:center!important;justify-content:center!important;width:auto!important;min-width:0!important;max-width:none!important;height:28px!important;padding:0 6px!important;border:1px solid #f36b55!important;border-radius:5px!important;background:#fff4f1!important;color:#df4029!important;font:12px/26px Arial,"Microsoft YaHei",sans-serif!important;white-space:nowrap!important;cursor:pointer!important}.et-c-info-batch-delete.is-failed{border-color:#dc3825!important;background:#ffe7e2!important;color:#bd2818!important}.et-c-info-batch-delete:disabled{opacity:.45!important;cursor:not-allowed!important}
      .et-c-info-confirm-mask{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;padding:18px;background:transparent;backdrop-filter:none;font:14px/1.45 Arial,"Microsoft YaHei",sans-serif}.et-c-info-confirm-box{width:min(360px,calc(100vw - 36px));padding:20px;border:1px solid #e3e7ef;border-radius:15px;background:#fff;box-shadow:0 18px 44px #15204738;text-align:center}.et-c-info-confirm-box h3{margin:0 0 12px;font-size:18px;color:#26324b}.et-c-info-confirm-box p{margin:0;color:#59657e;line-height:1.75;white-space:pre-line}.et-c-info-confirm-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}.et-c-info-confirm-actions button{height:38px;border-radius:9px;font-weight:700;cursor:pointer}.et-c-info-confirm-cancel{border:1px solid #d4daea;background:#fff;color:#536079}.et-c-info-confirm-ok{border:0;background:linear-gradient(90deg,#ff643c,#ee4025);color:#fff}
      .et-c-confirm-mask{position:absolute;inset:0;z-index:20;display:grid;place-items:center;padding:18px;border-radius:18px;background:#17213b73;backdrop-filter:blur(2px)}.et-c-confirm-box{width:100%;max-width:350px;padding:20px;border-radius:15px;background:#fff;box-shadow:0 18px 44px #1520474d;text-align:center}.et-c-confirm-box h3{margin:0 0 12px;font-size:18px;color:#26324b}.et-c-confirm-box p{margin:0;color:#59657e;line-height:1.75;white-space:pre-line}.et-c-confirm-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}.et-c-confirm-actions button{height:38px;border-radius:9px;font-weight:700;cursor:pointer}.et-c-confirm-cancel{border:1px solid #d4daea;background:#fff;color:#536079}.et-c-confirm-ok{border:0;background:linear-gradient(90deg,#ff643c,#ee4025);color:#fff}
    `;
    document.documentElement.appendChild(style);
  }

  function render() {
    const launcher = document.getElementById("et-compliance-launcher");
    const panel = document.getElementById("et-compliance-panel");
    if (!launcher || !panel) return;
    launcher.style.display = state.panelOpen ? "none" : "grid";
    panel.style.display = state.panelOpen ? "block" : "none";
    if (!state.panelOpen) return;
    const busy = state.status === "scanning" || state.status === "running";
    const ready = products.length > 0 && state.status === "ready";
    const failureTitle = failureDetails.length
      ? failureDetails.slice(0, 30).map((item) => `${item.id || "-"}：${item.error}`).join("\n")
      : "无失败商品";
    panel.innerHTML = `
      <div class="et-c-head">
        <img src="${chrome.runtime.getURL("assets/wolf-logo.png")}" alt="小灰狼">
        <div class="et-c-head-text"><strong>违规商品清理助手</strong><small>SKU 查询商品编码后，按状态下架并删除</small></div>
        <button class="et-c-close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="et-c-body">
        <section class="et-c-card">
          <div class="et-c-status"><span class="et-c-badge">${statusLabel()}</span><span class="et-c-page">${escapeHtml(targetPageName() || "店铺合规")}</span></div>
          <div class="et-c-progress" style="--p:${progressPercent()}%"><i></i></div>
          <div class="et-c-counts">
            <div class="et-c-count"><b>${state.success}</b><span>成功删除</span></div>
            <div class="et-c-count et-c-fail" title="${escapeHtml(failureTitle)}"><b>${state.failed}</b><span>失败（悬停查看）</span></div>
            <div class="et-c-count"><b>${state.processed}/${state.total}</b><span>已处理</span></div>
          </div>
          <div class="et-c-summary">
            <div><b>${state.skuCount}</b><span>违规 SKU</span></div>
            <div><b>${state.productCount}</b><span>SPU 商品</span></div>
            <div><b>${state.onSaleCount}</b><span>当前在售</span></div>
            <div><b>${state.markedCount}</b><span>已标记删除</span></div>
          </div>
          <div class="et-c-message ${state.status === "error" ? "error" : ""}">${escapeHtml(state.message)}</div>
        </section>
        <section class="et-c-card">
          <div class="et-c-row"><label>每批处理间隔（${PRODUCT_BATCH_SIZE} 个商品）</label><span class="et-c-delay"><input id="et-c-delay" type="number" min="0.5" max="10" step="0.5" value="${state.delayMs / 1000}" ${busy ? "disabled" : ""}> 秒</span></div>
          <div class="et-c-note">温馨提示：仅处理当前合规页签及其筛选结果。删除后商品进入回收站，45 天内可还原，超时将无法恢复。</div>
        </section>
        <div class="et-c-actions">
          <button class="et-c-btn et-c-read" type="button" ${busy ? "disabled" : ""}>${products.length ? "重新读取" : "读取违规商品"}</button>
          <button class="et-c-btn et-c-run" type="button" ${state.status === "running" || ready ? "" : "disabled"}>${state.status === "running" ? "停止处理" : "下架并删除"}</button>
        </div>
      </div>`;
    panel.querySelector(".et-c-close")?.addEventListener("click", () => {
      state.panelOpen = false;
      render();
    });
    panel.querySelector(".et-c-read")?.addEventListener("click", scanProducts);
    panel.querySelector(".et-c-run")?.addEventListener("click", () => {
      if (state.status === "running") stopProcessing();
      else processProducts();
    });
    panel.querySelector("#et-c-delay")?.addEventListener("change", async (event) => {
      const seconds = Math.min(10, Math.max(0.5, Number(event.target.value) || 1));
      state.delayMs = Math.round(seconds * 1000);
      event.target.value = String(state.delayMs / 1000);
      await chrome.storage.local.set({[STORAGE_KEY]: {delayMs: state.delayMs}});
    });
  }

  async function scanProducts() {
    if (state.status === "scanning" || state.status === "running") return;
    if (!targetPageName()) {
      state.status = "error";
      state.message = "请打开指定合规页面（tabsActiveName=2 或 6）";
      render();
      return;
    }
    const token = ++scanToken;
    products = [];
    allSourceSkuIds = [];
    sourceSkuIds = [];
    failureDetails = [];
    Object.assign(state, {
      status: "scanning",
      message: "正在读取当前筛选结果",
      scannedPages: 0,
      skuCount: 0,
      markedCount: 0,
      productCount: 0,
      onSaleCount: 0,
      success: 0,
      failed: 0,
      processed: 0,
      total: 0
    });
    render();
    try {
      await bridgeRequest("PING", {}, 60000);
      allSourceSkuIds = await collectAllSkuIds(token);
      if (!allSourceSkuIds.length) throw new Error("当前筛选结果中没有识别到 SKU");
      await loadProcessedSkuRecords();
      annotateProcessedRows();
      sourceSkuIds = allSourceSkuIds.filter((skuId) => !processedSkuRecords[skuId]);
      state.skuCount = allSourceSkuIds.length;
      state.markedCount = allSourceSkuIds.length - sourceSkuIds.length;
      state.productCount = new Set(allSourceSkuIds
        .map((skuId) => String(processedSkuRecords[skuId]?.productId ?? ""))
        .filter((productId) => /^\d{8,20}$/.test(productId))).size;
      if (!sourceSkuIds.length) {
        state.status = "done";
        state.message = `当前 ${allSourceSkuIds.length} 个违规 SKU 均已标记为删除，无需重复处理`;
        render();
        return;
      }
      const {mapped, missing: normalMissing, ambiguousSkuIds, anonymousProductIds} = await mapSkuIdsToProducts(sourceSkuIds, token);
      if (token !== scanToken) return;
      products = mapped;
      const recycleCheck = normalMissing.length
        ? await verifyRecycleSkuIds(normalMissing, token)
        : {confirmed: [], missing: []};
      if (token !== scanToken) return;
      if (recycleCheck.confirmed.length) await markSkuIdsDeleted(recycleCheck.confirmed);
      const ambiguousSet = new Set(ambiguousSkuIds);
      const unknown = recycleCheck.missing.filter((skuId) => ambiguousSet.has(skuId));
      const nonexistent = recycleCheck.missing.filter((skuId) => !ambiguousSet.has(skuId));
      sourceSkuIds = [...new Set(products.flatMap((item) => item.skuIds || []))];
      await refreshSkuStatusRecords(products, nonexistent, unknown);
      state.skuCount = allSourceSkuIds.length;
      const knownProductIds = new Set([
        ...products.map((item) => String(item.productId)),
        ...anonymousProductIds,
        ...allSourceSkuIds.map((skuId) => String(processedSkuRecords[skuId]?.productId ?? ""))
      ].filter((productId) => /^\d{8,20}$/.test(productId)));
      state.productCount = knownProductIds.size;
      state.onSaleCount = products.filter((item) => item.productState === ON_SALE_STATE).length;
      state.total = products.length;
      state.message = products.length
        ? `读取完成：本次 ${sourceSkuIds.length} 个 SKU 对应 ${products.length} 个商品${state.markedCount ? `，已确认 ${state.markedCount} 个已删除 SKU` : ""}${unknown.length ? `，${unknown.length} 个状态未知` : ""}${nonexistent.length ? `，另有 ${nonexistent.length} 个商品不存在` : ""}`
        : unknown.length || nonexistent.length
          ? `读取完成：${state.markedCount} 个 SKU 已删除${unknown.length ? `，${unknown.length} 个状态未知` : ""}${nonexistent.length ? `，${nonexistent.length} 个商品不存在` : ""}，无需处理`
          : `读取完成：当前 ${state.markedCount} 个违规 SKU 均已在回收站，无需重复处理`;
      state.status = products.length ? "ready" : "done";
      render();
    } catch (error) {
      if (token !== scanToken) return;
      state.status = "error";
      state.message = error?.message || "读取违规商品失败";
      render();
    }
  }

  function operationResultMap(value) {
    const rows = Array.isArray(value) ? value : productItems(value);
    const result = new Map();
    for (const item of rows) {
      const productId = String(item?.data ?? item?.productId ?? "").trim();
      if (!/^\d{8,20}$/.test(productId)) continue;
      result.set(productId, {
        success: Boolean(item?.success),
        error: String(item?.message || item?.msg || item?.errorMsg || item?.reason || "").trim()
      });
    }
    return result;
  }

  async function queryProducts(productIds) {
    const result = await bridgeRequest("QUERY_PRODUCTS", {productIds}, 35000);
    const items = new Map();
    for (const item of productItems(result)) {
      const productId = String(item?.productId ?? item?.productInfoVO?.productId ?? "").trim();
      if (/^\d{8,20}$/.test(productId)) items.set(productId, item);
    }
    return items;
  }

  async function findProductInRecycle(product, token) {
    const productId = String(product?.productId ?? "").trim();
    const skuIds = knownSkuIdsForProduct(product).slice(0, 100);
    if (!/^\d{8,20}$/.test(productId) || !skuIds.length) return null;
    if (token !== runToken) throw new Error("用户停止处理");
    const result = await bridgeRequest("QUERY_RECYCLE_PRODUCTS", {skuIds}, 35000);
    if (token !== runToken) throw new Error("用户停止处理");
    const matched = productItems(result).find((item) =>
      String(item?.productId ?? item?.productInfoVO?.productId ?? "").trim() === productId
    );
    if (!matched) return null;
    diagnosticLog("product_already_deleted_confirmed", {productId, skuIds});
    return {...product, skuIds, deletionSource: "recycle"};
  }

  function updateProductStatusFromItem(product, item) {
    product.productState = itemState(item);
    product.statusDescription = itemStatusDescription(item);
    const status = productStatusRecord(product);
    const nextRecords = {};
    for (const skuId of product.skuIds || []) {
      nextRecords[String(skuId)] = {...status, productId: String(product.productId)};
    }
    cacheSkuStatusRecords(nextRecords);
  }

  function markProductOffSale(product) {
    product.productState = null;
    product.statusDescription = "已下架";
    const status = productStatusRecord(product);
    const nextRecords = {};
    for (const skuId of product.skuIds || []) {
      nextRecords[String(skuId)] = {...status, productId: String(product.productId)};
    }
    cacheSkuStatusRecords(nextRecords);
  }

  async function waitBatchUntilOffSale(productsToVerify, token) {
    const remaining = new Map(productsToVerify.map((product) => [String(product.productId), product]));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (token !== runToken) throw new Error("用户停止处理");
      await sleep(Math.max(1000, state.delayMs));
      const items = await queryProducts([...remaining.keys()]);
      for (const [productId, product] of [...remaining]) {
        const item = items.get(productId);
        if (!item || itemState(item) === ON_SALE_STATE) continue;
        updateProductStatusFromItem(product, item);
        remaining.delete(productId);
      }
      annotateProcessedRows();
      if (!remaining.size) break;
    }
    return {
      verified: productsToVerify.filter((product) => !remaining.has(String(product.productId))),
      failed: [...remaining.values()]
    };
  }

  async function processBatch(batch, token) {
    const failures = new Map();
    const deleted = [];
    const fail = (product, error) => {
      if (!failures.has(String(product.productId))) failures.set(String(product.productId), {product, error});
    };
    const acceptDeleted = (product) => {
      const productId = String(product?.productId ?? "");
      failures.delete(productId);
      if (!deleted.some((item) => String(item.productId) === productId)) deleted.push(product);
    };
    const productIds = batch.map((product) => String(product.productId));
    state.message = `正在查询本批 ${batch.length} 个商品状态`;
    render();
    const freshItems = await queryProducts(productIds);
    if (token !== runToken) throw new Error("用户停止处理");
    const onSaleProducts = [];
    const readyToDelete = [];
    for (const product of batch) {
      const fresh = freshItems.get(String(product.productId));
      if (!fresh) {
        const recycled = await findProductInRecycle(product, token);
        if (recycled) acceptDeleted(recycled);
        else fail(product, "批量复查时未找到该商品，回收站也未确认已删除");
        continue;
      }
      updateProductStatusFromItem(product, fresh);
      if (itemState(fresh) === ON_SALE_STATE) onSaleProducts.push(product);
      else readyToDelete.push(product);
    }
    annotateProcessedRows();

    if (onSaleProducts.length) {
      state.message = `正在批量下架 ${onSaleProducts.length} 个商品`;
      render();
      const downResult = await bridgeRequest("UPDATE_STATUS", {
        operation: "down",
        productIds: onSaleProducts.map((product) => product.productId)
      }, 35000);
      if (token !== runToken) throw new Error("用户停止处理");
      const downResults = operationResultMap(downResult);
      const downSucceeded = [];
      for (const product of onSaleProducts) {
        const result = downResults.get(String(product.productId));
        if (result?.success) downSucceeded.push(product);
        else {
          const recycled = await findProductInRecycle(product, token);
          if (recycled) acceptDeleted(recycled);
          else fail(product, result?.error || "批量下架未返回成功");
        }
      }
      const verification = downSucceeded.length
        ? await waitBatchUntilOffSale(downSucceeded, token)
        : {verified: [], failed: []};
      for (const product of verification.verified) {
        markProductOffSale(product);
        readyToDelete.push(product);
      }
      for (const product of verification.failed) fail(product, "下架后仍显示为在售，已阻止删除");
      annotateProcessedRows();
    }

    const deletable = readyToDelete.filter((product) => !failures.has(String(product.productId)));
    if (deletable.length) {
      if (token !== runToken) throw new Error("用户停止处理");
      state.message = `正在批量删除 ${deletable.length} 个商品`;
      render();
      const deleteResult = await bridgeRequest("UPDATE_STATUS", {
        operation: "del",
        productIds: deletable.map((product) => product.productId)
      }, 35000);
      const deleteResults = operationResultMap(deleteResult);
      for (const product of deletable) {
        const result = deleteResults.get(String(product.productId));
        if (result?.success) acceptDeleted(product);
        else {
          const recycled = await findProductInRecycle(product, token);
          if (recycled) acceptDeleted(recycled);
          else fail(product, result?.error || "批量删除未返回成功");
        }
      }
    }
    if (deleted.length) await markProductsDeleted(deleted);
    return {deleted, failures: [...failures.values()]};
  }

  function informationProductCodeEntries() {
    if (!document.body) return [];
    return [...document.querySelectorAll(".conent_wrap_spu, .content_wrap_spu")]
      .map((owner) => ({
        owner,
        productId: (owner.textContent || "").match(/商品编号\s*[:：]\s*(\d{8,20})/)?.[1] || ""
      }))
      .filter(({owner, productId}) => productId && visible(owner));
  }

  function informationSalesVolume(item) {
    const value = Number(item?.salesVolume ?? item?.productInfoVO?.salesVolume);
    return Number.isFinite(value) ? Math.max(0, value) : null;
  }

  async function loadInformationProductDetails(productIds) {
    const ids = [...new Set(productIds.map((value) => String(value ?? "").trim()))]
      .filter((productId) => /^\d{8,20}$/.test(productId) && !infoProductCache.has(productId) && !infoProductPending.has(productId));
    if (!ids.length) return;
    ids.forEach((productId) => infoProductPending.add(productId));
    diagnosticLog("information_query_started", {productCount: ids.length, productIds: ids.slice(0, 20)});
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      try {
        const items = await queryProducts(batch);
        for (const productId of batch) {
          const item = items.get(productId);
          infoProductCache.set(productId, item
            ? {item, salesVolume: informationSalesVolume(item)}
            : {item: null, salesVolume: null, error: "商品查询接口未返回该商品"});
        }
        diagnosticLog("information_query_finished", {requested: batch.length, returned: items.size});
      } catch (error) {
        for (const productId of batch) {
          infoProductCache.set(productId, {item: null, salesVolume: null, error: error?.message || "商品查询失败"});
        }
        diagnosticLog("information_query_failed", {requested: batch.length, message: error?.message || String(error)});
      } finally {
        batch.forEach((productId) => infoProductPending.delete(productId));
      }
    }
    ensureInformationViolationRows();
  }

  function showInformationProductConfirm(productId = "", skuId = "", count = 0, alignUpper = false) {
    return new Promise((resolve) => {
      document.getElementById("et-c-info-confirm-host")?.remove();
      if (!document.getElementById("et-c-info-confirm-backdrop-style")) {
        const backdropStyle = document.createElement("style");
        backdropStyle.id = "et-c-info-confirm-backdrop-style";
        backdropStyle.textContent = "#et-c-info-confirm-host::backdrop{background:rgba(20,28,48,.46)!important;backdrop-filter:blur(1px)!important}";
        (document.head || document.documentElement).appendChild(backdropStyle);
      }
      const host = document.createElement("dialog");
      host.id = "et-c-info-confirm-host";
      const placementCss = alignUpper
        ? "left:0!important;right:0!important;top:clamp(28px,10vh,120px)!important;bottom:auto!important;margin:0 auto!important;"
        : "inset:0!important;margin:auto!important;";
      host.style.cssText = `all:initial!important;position:fixed!important;${placementCss}z-index:2147483647!important;display:block!important;width:min(350px,calc(100vw - 36px))!important;max-width:none!important;height:max-content!important;max-height:calc(100vh - 36px)!important;padding:0!important;border:0!important;border-radius:15px!important;background:transparent!important;box-shadow:none!important;transform:none!important;opacity:1!important;overflow:visible!important;color-scheme:light!important`;
      const contentHost = document.createElement("et-c-info-confirm-content");
      contentHost.style.cssText = "all:initial!important;display:block!important;width:100%!important;height:auto!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important";
      const shadow = contentHost.attachShadow({mode: "closed"});
      shadow.innerHTML = `
        <style>
          *{box-sizing:border-box}
          .box{width:100%;padding:20px;border:1px solid #e3e7ef;border-radius:15px;background:#fff;box-shadow:0 14px 38px rgba(21,32,71,.22);text-align:center;font:14px/1.45 Arial,"Microsoft YaHei",sans-serif;color:#26324b}
          h3{margin:0 0 10px;font-size:18px;font-weight:500}p{margin:0;color:#59657e;line-height:1.7;white-space:pre-line}.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}button{height:38px;border-radius:9px;font:700 14px Arial,"Microsoft YaHei",sans-serif;cursor:pointer}.cancel{border:1px solid #d4daea;background:#fff;color:#536079}.ok{border:0;background:linear-gradient(90deg,#ff643c,#ee4025);color:#fff}
        </style>
        <div class="box" role="dialog" aria-modal="true" aria-label="确认删除商品">
          <h3>${count ? "确认批量删除" : "确认删除商品"}</h3>
          <p>${count
            ? `已选 ${Number(count)} 个商品\n在售商品先下架，再批量删除。`
            : `${skuId ? `SKU：${escapeHtml(skuId)}\n` : ""}商品编码：${escapeHtml(productId)}\n在售商品将先下架，再执行删除。`}</p>
          <div class="actions">
            <button class="cancel" type="button">取消</button>
            <button class="ok" type="button">确认删除</button>
          </div>
        </div>`;
      host.appendChild(contentHost);
      let settled = false;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        try {
          if (host.open) host.close();
        } catch (_error) {}
        host.remove();
        resolve(confirmed);
      };
      shadow.querySelector(".cancel")?.addEventListener("click", () => finish(false));
      shadow.querySelector(".ok")?.addEventListener("click", () => finish(true));
      host.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish(false);
      });
      host.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        finish(true);
      });
      (document.body || document.documentElement).appendChild(host);
      host.showModal();
      shadow.querySelector(".ok")?.focus();
    });
  }

  async function requestInformationConfirm(payload) {
    if (IS_TOP_FRAME) {
      diagnosticLog("information_confirm_top_frame", {
        count: Number(payload.count) || 0,
        productId: String(payload.productId || ""),
        skuId: String(payload.skuId || "")
      });
      return showInformationProductConfirm(payload.productId, payload.skuId, payload.count, false);
    }

    diagnosticLog("information_confirm_relay", {
      count: Number(payload.count) || 0,
      productId: String(payload.productId || ""),
      skuId: String(payload.skuId || "")
    });
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TOOLBOX_INFORMATION_CONFIRM_REQUEST",
        payload
      });
      if (response?.ok) return Boolean(response.confirmed);
      throw new Error(response?.error || "顶层确认框未响应");
    } catch (error) {
      diagnosticLog("information_confirm_relay_failed", {
        message: error?.message || String(error)
      });
    }
    return showInformationProductConfirm(payload.productId, payload.skuId, payload.count, false);
  }

  function confirmInformationProductDelete(productId, skuId = "") {
    return requestInformationConfirm({productId, skuId});
  }

  function confirmInformationBatchDelete(count) {
    return requestInformationConfirm({count});
  }

  async function deleteInformationProduct(productId, button, skuId = "") {
    if (state.status === "running" || state.status === "scanning") {
      button.title = "工作台任务正在运行，请完成后再操作";
      return;
    }
    if (!await confirmInformationProductDelete(productId, skuId)) return;
    const action = button.closest(".et-c-info-action, .et-c-detail-action");
    const salesVolume = infoProductCache.get(productId)?.salesVolume
      ?? (skuId ? detailSkuCache.get(skuId)?.salesVolume : null)
      ?? processedInfoProductRecords[productId]?.salesVolume
      ?? null;
    button.disabled = true;
    button.classList.remove("is-failed");
    button.textContent = "处理中";
    try {
      const token = ++runToken;
      diagnosticLog("information_single_delete_started", {productId, skuId});
      const result = await processBatch([{productId, skuIds: skuId ? [skuId] : []}], token);
      if (!result.deleted.length) throw new Error(result.failures[0]?.error || "删除接口未返回成功");
      await markInfoProductDeleted(productId, salesVolume);
      button.classList.add("is-done");
      button.textContent = "已删除";
      button.title = "该商品已下架并删除";
      diagnosticLog("information_single_delete_finished", {productId, skuId});
      action?.classList.add("is-done");
      document.querySelectorAll(`.et-c-detail-action[data-product-id="${productId}"] .et-c-info-delete`).forEach((relatedButton) => {
        relatedButton.disabled = true;
        relatedButton.classList.add("is-done");
        relatedButton.textContent = "已删除";
        relatedButton.title = "该商品已下架并删除";
      });
    } catch (error) {
      button.disabled = false;
      button.classList.add("is-failed");
      button.textContent = "重试删除";
      button.title = error?.message || "删除商品失败";
      diagnosticLog("information_single_delete_failed", {productId, skuId, message: error?.message || String(error)});
    }
  }

  function updateInformationBatchControls() {
    const toolbar = document.getElementById("et-c-info-batch-toolbar");
    const selectAll = document.querySelector(".et-c-info-select-all");
    if (!toolbar && !selectAll) return;
    const currentIds = informationProductCodeEntries().map(({productId}) => productId);
    const selectableIds = currentIds.filter((productId) => !processedInfoProductRecords[productId]);
    const allCurrentSelected = selectableIds.length > 0 && selectableIds.every((productId) => selectedInfoProducts.has(productId));
    const selectedCurrentCount = selectableIds.filter((productId) => selectedInfoProducts.has(productId)).length;
    const button = toolbar?.querySelector(".et-c-info-batch-delete");
    if (selectAll) {
      selectAll.checked = allCurrentSelected;
      selectAll.indeterminate = selectedCurrentCount > 0 && !allCurrentSelected;
    }
    if (button) {
      if (button.dataset.running !== "1") {
        button.textContent = `${button.dataset.lastError ? "重试批量删除" : "批量删除"}（${selectedInfoProducts.size}）`;
      }
      button.disabled = selectedInfoProducts.size === 0 || button.dataset.running === "1";
    }
  }

  async function deleteSelectedInformationProducts(button) {
    const productIds = [...selectedInfoProducts.keys()]
      .filter((productId) => !processedInfoProductRecords[productId]);
    if (!productIds.length || button.dataset.running === "1") return;
    diagnosticLog("information_batch_delete_clicked", {selectedCount: productIds.length});
    if (!await confirmInformationBatchDelete(productIds.length)) {
      diagnosticLog("information_batch_delete_cancelled", {selectedCount: productIds.length});
      return;
    }
    diagnosticLog("information_batch_delete_confirmed", {selectedCount: productIds.length});
    button.dataset.running = "1";
    delete button.dataset.lastError;
    button.classList.remove("is-failed");
    button.disabled = true;
    button.textContent = `处理中 0/${productIds.length}`;
    state.status = "running";
    const failures = [];
    const deletedRecords = [];
    let requestFailed = false;
    try {
      const token = ++runToken;
      diagnosticLog("information_batch_delete_started", {selectedCount: productIds.length, productIds: productIds.slice(0, 100)});
      for (let offset = 0; offset < productIds.length; offset += PRODUCT_BATCH_SIZE) {
        const batchIds = productIds.slice(offset, offset + PRODUCT_BATCH_SIZE);
        button.textContent = `处理中 ${Math.min(offset + batchIds.length, productIds.length)}/${productIds.length}`;
        const result = await processBatch(batchIds.map((productId) => ({productId, skuIds: []})), token);
        diagnosticLog("information_batch_delete_batch_finished", {
          requested: batchIds.length,
          deleted: result.deleted.length,
          failed: result.failures.length
        });
        for (const product of result.deleted) {
          deletedRecords.push({
            productId: product.productId,
            salesVolume: infoProductCache.get(String(product.productId))?.salesVolume
          });
          selectedInfoProducts.delete(String(product.productId));
        }
        failures.push(...result.failures);
        if (offset + batchIds.length < productIds.length) await sleep(state.delayMs);
      }
      if (deletedRecords.length) await markInfoProductsDeleted(deletedRecords);
      button.title = failures.length
        ? `成功 ${deletedRecords.length} 个，失败 ${failures.length} 个：${failures.slice(0, 10).map((item) => item.error).join("；")}`
        : `已删除 ${deletedRecords.length} 个商品`;
      if (failures.length) button.dataset.lastError = "1";
      else delete button.dataset.lastError;
      diagnosticLog("information_batch_delete_finished", {selectedCount: productIds.length, deleted: deletedRecords.length, failed: failures.length});
    } catch (error) {
      requestFailed = true;
      button.title = error?.message || "批量删除失败";
      button.dataset.lastError = "1";
      button.classList.add("is-failed");
      diagnosticLog("information_batch_delete_failed", {selectedCount: productIds.length, message: error?.message || String(error)});
    } finally {
      state.status = requestFailed || failures.length ? "error" : "done";
      delete button.dataset.running;
      updateInformationBatchControls();
      if (failures.length) button.classList.add("is-failed");
      ensureInformationViolationRows();
    }
  }

  function toggleCurrentInformationPageSelection(checked) {
    for (const {productId} of informationProductCodeEntries()) {
      if (processedInfoProductRecords[productId]) continue;
      if (checked) selectedInfoProducts.set(productId, true);
      else selectedInfoProducts.delete(productId);
    }
    document.querySelectorAll(".et-c-info-select").forEach((input) => {
      if (!input.disabled) input.checked = checked;
    });
    updateInformationBatchControls();
  }

  function ensureInformationSelectAllControl() {
    const existing = document.getElementById("et-c-info-batch-toolbar");
    if (existing?.closest("thead")) return;
    existing?.remove();
    const header = [...document.querySelectorAll("thead th")].find((element) => {
      const cell = element.querySelector(":scope > .cell") || element;
      return cell.textContent?.trim() === "商品信息";
    });
    if (!header) return;
    const cell = header.querySelector(":scope > .cell") || header;
    const wrap = document.createElement("span");
    wrap.id = "et-c-info-batch-toolbar";
    wrap.innerHTML = `<input class="et-c-info-select-all" type="checkbox" aria-label="全选本页" title="全选本页"><button class="et-c-info-batch-delete" type="button" disabled>批量删除（0）</button>`;
    const stop = (event) => event.stopPropagation();
    wrap.addEventListener("pointerdown", stop);
    wrap.addEventListener("mousedown", stop);
    wrap.addEventListener("click", stop);
    wrap.querySelector("input")?.addEventListener("change", (event) => {
      toggleCurrentInformationPageSelection(event.currentTarget.checked);
    });
    wrap.querySelector(".et-c-info-batch-delete")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void deleteSelectedInformationProducts(event.currentTarget);
    });
    cell.appendChild(wrap);
  }

  function ensureInformationBatchControls() {
    if (!isInformationViolationView()) {
      document.getElementById("et-c-info-batch-toolbar")?.remove();
      return;
    }
    ensureInformationSelectAllControl();
    updateInformationBatchControls();
  }

  function ensureInformationViolationRows() {
    const entries = informationProductCodeEntries();
    if (!isInformationViolationView() && !entries.length) {
      document.querySelectorAll(".et-c-info-action").forEach((element) => element.remove());
      document.getElementById("et-c-info-batch-toolbar")?.remove();
      return;
    }
    const missingProductIds = [];
    let createdCount = 0;
    for (const {productId, owner} of entries) {
      const cell = owner.closest("td, [role='gridcell'], .ag-cell, [class*='cell']") || owner.parentElement || owner;
      const row = owner.closest("tr") || cell;
      const rowActions = [...(row.querySelectorAll?.(".et-c-info-action") || [])];
      let action = rowActions.find((element) => element.dataset.productId === productId) || null;
      rowActions.forEach((element) => {
        if (element !== action) element.remove();
      });
      if (!action) {
        action = document.createElement("span");
        action.className = "et-c-info-action";
        action.dataset.productId = productId;
        action.innerHTML = `<input class="et-c-info-select" type="checkbox" title="选择该商品"><span class="et-c-info-sales">近30天销售 -- 件</span><button class="et-c-info-delete" type="button">删除商品</button>`;
        if (cell && owner !== cell) owner.insertAdjacentElement("afterend", action);
        else (cell || owner).appendChild(action);
        createdCount += 1;
        action.querySelector(".et-c-info-select")?.addEventListener("change", (event) => {
          if (event.currentTarget.checked) selectedInfoProducts.set(productId, true);
          else selectedInfoProducts.delete(productId);
          updateInformationBatchControls();
        });
        action.querySelector(".et-c-info-delete")?.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          deleteInformationProduct(productId, event.currentTarget);
        });
      }
      const sales = action.querySelector(".et-c-info-sales");
      const button = action.querySelector(".et-c-info-delete");
      const selector = action.querySelector(".et-c-info-select");
      const deletedRecord = processedInfoProductRecords[productId];
      const detail = infoProductCache.get(productId);
      const salesVolume = detail?.salesVolume ?? deletedRecord?.salesVolume;
      if (sales) {
        const numericSales = Number(salesVolume);
        const hasNumericSales = salesVolume !== null && salesVolume !== undefined && salesVolume !== "" && Number.isFinite(numericSales);
        sales.innerHTML = hasNumericSales
          ? `近30天销售 <span class="et-c-info-sales-number${numericSales > 0 ? " is-positive" : ""}">${numericSales}</span> 件`
          : detail?.error ? "近30天销售 -- 件" : "近30天销售 查询中";
      }
      if (deletedRecord && button) {
        button.disabled = true;
        button.classList.add("is-done");
        button.textContent = "已删除";
        button.title = `插件已于 ${new Date(deletedRecord.deletedAt).toLocaleString("zh-CN", {hour12: false})} 删除该商品`;
        action.classList.add("is-done");
      }
      if (selector) {
        selector.checked = selectedInfoProducts.has(productId);
        selector.disabled = Boolean(deletedRecord);
      }
      if (!detail && !deletedRecord && !infoProductPending.has(productId)) missingProductIds.push(productId);
    }
    if (createdCount) diagnosticLog("information_actions_created", {createdCount, entryCount: entries.length});
    if (missingProductIds.length) void loadInformationProductDetails(missingProductIds);
    ensureInformationBatchControls();
  }

  function isLegalQueryDetailView() {
    return location.hostname.toLowerCase() === "illegal-jdm.shop.jd.com"
      && /^\/legal\/legalQueryDetail(?:\/|$)/i.test(location.pathname);
  }

  function legalDetailSkuEntries() {
    if (!isLegalQueryDetailView()) return [];
    return [...document.querySelectorAll('a[href*="wares-jdm.jd.com/ware/wareList"][href*="skuId="]')]
      .map((anchor) => {
        let skuId = "";
        try {
          skuId = new URL(anchor.href, location.href).searchParams.get("skuId") || "";
        } catch {}
        if (!/^\d{8,20}$/.test(skuId)) skuId = (anchor.textContent || "").match(/\d{8,20}/)?.[0] || "";
        return {anchor, skuId};
      })
      .filter(({anchor, skuId}) => /^\d{8,20}$/.test(skuId) && visible(anchor));
  }

  function legalDetailSkuStatus(detail, deletedRecord) {
    if (!detail) return {kind: "unknown", label: "状态查询中", title: "正在实时查询京麦商品状态"};
    if (deletedRecord || detail.deleted) {
      return {kind: "deleted", label: "已删除", title: "该商品已在回收站中"};
    }
    if (detail.nonexistent) {
      return {
        kind: "nonexistent",
        label: "查无商品",
        title: "正常商品与回收站接口均未返回该 SKU"
      };
    }
    if (detail.error) return {kind: "unknown", label: "查询失败", title: detail.error};
    const productState = itemState(detail.item);
    const description = itemStatusDescription(detail.item);
    if (productState === ON_SALE_STATE) {
      return {kind: "onsale", label: "售卖中", title: description || "商品当前在售"};
    }
    if (productState !== null || /下架/.test(description)) {
      return {kind: "offsale", label: "已下架", title: description || `京麦商品状态值：${productState}`};
    }
    return {kind: "unknown", label: "状态未知", title: "商品查询成功，但没有返回可识别的状态"};
  }

  async function loadLegalDetailSkuDetails(skuIds) {
    const ids = [...new Set(skuIds.map((value) => String(value || "")))]
      .filter((skuId) => /^\d{8,20}$/.test(skuId) && !detailSkuCache.has(skuId) && !detailSkuPending.has(skuId));
    if (!ids.length) return;
    ids.forEach((skuId) => detailSkuPending.add(skuId));
    const recycleRecords = [];
    diagnosticLog("detail_sku_query_started", {skuCount: ids.length, skuIds: ids.slice(0, 20)});
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      try {
        const result = await bridgeRequest("QUERY_PRODUCTS", {skuIds: batch}, 35000);
        const items = productItems(result);
        const unresolved = [];
        for (const skuId of batch) {
          let item = items.find((candidate) => itemSkuIds(candidate).includes(skuId)) || null;
          if (!item && batch.length === 1 && items.length === 1) item = items[0];
          const productId = String(item?.productId ?? item?.productInfoVO?.productId ?? "").trim();
          if (item && /^\d{8,20}$/.test(productId)) {
            detailSkuCache.set(skuId, {item, productId, salesVolume: informationSalesVolume(item)});
          } else {
            unresolved.push(skuId);
          }
        }
        for (const skuId of unresolved) {
          try {
            const singleResult = await bridgeRequest("QUERY_PRODUCTS", {skuIds: [skuId]}, 35000);
            const item = productItems(singleResult)[0] || null;
            const productId = String(item?.productId ?? item?.productInfoVO?.productId ?? "").trim();
            if (item && /^\d{8,20}$/.test(productId)) {
              detailSkuCache.set(skuId, {item, productId, salesVolume: informationSalesVolume(item)});
              continue;
            }
            diagnosticLog("detail_sku_recycle_query_started", {skuId});
            const recycleResult = await bridgeRequest("QUERY_RECYCLE_PRODUCTS", {skuIds: [skuId]}, 35000);
            const recycleItem = productItems(recycleResult)[0] || null;
            const recycleProductId = String(recycleItem?.productId ?? recycleItem?.productInfoVO?.productId ?? "").trim();
            if (recycleItem && /^\d{8,20}$/.test(recycleProductId)) {
              detailSkuCache.set(skuId, {
                item: recycleItem,
                productId: recycleProductId,
                salesVolume: null,
                deleted: true,
                source: "recycle"
              });
              recycleRecords.push({skuId, productId: recycleProductId, salesVolume: null, source: "recycle"});
              diagnosticLog("detail_sku_recycle_query_confirmed", {skuId, productId: recycleProductId});
            } else {
              detailSkuCache.set(skuId, {item: null, productId: "", salesVolume: null, nonexistent: true});
              diagnosticLog("detail_sku_recycle_query_missing", {skuId});
            }
          } catch (error) {
            detailSkuCache.set(skuId, {item: null, productId: "", salesVolume: null, error: error?.message || "SKU 查询失败"});
            diagnosticLog("detail_sku_recycle_query_failed", {skuId, message: error?.message || String(error)});
          }
        }
        diagnosticLog("detail_sku_query_finished", {requested: batch.length, returned: items.length, retriedIndividually: unresolved.length});
      } catch (error) {
        for (const skuId of batch) {
          detailSkuCache.set(skuId, {item: null, productId: "", salesVolume: null, error: error?.message || "SKU 查询失败"});
        }
        diagnosticLog("detail_sku_query_failed", {requested: batch.length, message: error?.message || String(error)});
      } finally {
        batch.forEach((skuId) => detailSkuPending.delete(skuId));
      }
    }
    if (recycleRecords.length) {
      await markSkuIdsDeleted(recycleRecords);
      await markInfoProductsDeleted(recycleRecords);
    }
    ensureLegalQueryDetailRows();
  }

  function ensureLegalQueryDetailRows() {
    if (!isLegalQueryDetailView()) {
      document.querySelectorAll(".et-c-detail-action").forEach((element) => element.remove());
      return;
    }
    const missingSkuIds = [];
    for (const {anchor, skuId} of legalDetailSkuEntries()) {
      const line = anchor.parentElement || anchor;
      const lineActions = [...line.querySelectorAll(".et-c-detail-action")];
      let action = lineActions.find((element) => element.dataset.skuId === skuId) || null;
      lineActions.forEach((element) => {
        if (element !== action) element.remove();
      });
      if (!action) {
        action = document.createElement("span");
        action.className = "et-c-detail-action";
        action.dataset.skuId = skuId;
        action.innerHTML = `<span class="et-c-detail-status et-c-state-unknown">状态查询中</span><span class="et-c-info-sales">近30天销售 查询中</span><button class="et-c-info-delete" type="button" disabled hidden>删除商品</button>`;
        anchor.insertAdjacentElement("afterend", action);
      }
      const detail = detailSkuCache.get(skuId);
      const status = action.querySelector(".et-c-detail-status");
      const sales = action.querySelector(".et-c-info-sales");
      const button = action.querySelector(".et-c-info-delete");
      if (detail?.productId) action.dataset.productId = detail.productId;
      const deletedRecord = detail?.productId ? processedInfoProductRecords[detail.productId] : null;
      const statusRecord = legalDetailSkuStatus(detail, deletedRecord);
      if (status) {
        status.className = `et-c-detail-status et-c-state-${statusRecord.kind}`;
        status.textContent = statusRecord.label;
        status.title = statusRecord.title;
      }
      if (sales) {
        const numericSales = Number(detail?.salesVolume);
        const hasNumericSales = detail?.salesVolume !== null && detail?.salesVolume !== undefined && detail?.salesVolume !== "" && Number.isFinite(numericSales);
        sales.innerHTML = hasNumericSales
          ? `近30天销售 <span class="et-c-info-sales-number${numericSales > 0 ? " is-positive" : ""}">${numericSales}</span> 件`
          : detail?.deleted || detail?.nonexistent || detail?.error ? "近30天销售 -- 件" : "近30天销售 查询中";
      }
      const canDelete = Boolean(detail?.productId && !detail.deleted && !detail.nonexistent && !detail.error && !deletedRecord);
      if (button) {
        button.hidden = !canDelete;
        button.disabled = !canDelete;
      }
      if (button && canDelete && !button.dataset.bound) {
        button.dataset.bound = "1";
        button.disabled = false;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          deleteInformationProduct(detail.productId, event.currentTarget, skuId);
        });
      }
      if (!detail && !detailSkuPending.has(skuId)) missingSkuIds.push(skuId);
    }
    if (missingSkuIds.length) void loadLegalDetailSkuDetails(missingSkuIds);
  }

  function looksLikeVerification(message) {
    return /验证|风控|安全校验|captcha|risk|购物无忧/i.test(String(message || ""));
  }

  function confirmInWorkbench(message) {
    const panel = document.getElementById("et-compliance-panel");
    if (!panel || !state.panelOpen) return Promise.resolve(false);
    return new Promise((resolve) => {
      panel.querySelector(".et-c-confirm-mask")?.remove();
      const mask = document.createElement("div");
      mask.className = "et-c-confirm-mask";
      mask.innerHTML = `
        <div class="et-c-confirm-box" role="dialog" aria-modal="true" aria-label="确认下架并删除">
          <h3>确认下架并删除</h3>
          <p>${escapeHtml(message)}</p>
          <div class="et-c-confirm-actions">
            <button class="et-c-confirm-cancel" type="button">取消</button>
            <button class="et-c-confirm-ok" type="button">确定处理</button>
          </div>
        </div>`;
      const finish = (confirmed) => {
        mask.remove();
        resolve(confirmed);
      };
      mask.querySelector(".et-c-confirm-cancel")?.addEventListener("click", () => finish(false));
      mask.querySelector(".et-c-confirm-ok")?.addEventListener("click", () => finish(true));
      panel.appendChild(mask);
    });
  }

  async function processProducts() {
    if (!products.length || state.status === "running") return;
    const onSale = products.filter((item) => item.productState === ON_SALE_STATE).length;
    const confirmed = await confirmInWorkbench(
      `共处理 ${products.length} 个商品，其中 ${onSale} 个需先下架。\n`
      + "删除后进入回收站，45 天内可恢复。"
    );
    if (!confirmed) return;
    const token = ++runToken;
    failureDetails = [];
    Object.assign(state, {
      status: "running",
      message: `正在按每批 ${PRODUCT_BATCH_SIZE} 个商品执行下架与删除`,
      success: 0,
      failed: 0,
      processed: 0,
      total: products.length
    });
    render();
    for (let offset = 0; offset < products.length; offset += PRODUCT_BATCH_SIZE) {
      if (token !== runToken) break;
      const batch = products.slice(offset, offset + PRODUCT_BATCH_SIZE);
      try {
        const result = await processBatch(batch, token);
        state.success += result.deleted.length;
        state.failed += result.failures.length;
        for (const failure of result.failures) {
          failureDetails.push({
            id: `商品 ${failure.product.productId}`,
            error: failure.error || "处理失败"
          });
        }
        const verificationFailure = result.failures.find((failure) => looksLikeVerification(failure.error));
        const wholeBatchFailed = result.failures.length === batch.length && !result.deleted.length;
        if (verificationFailure || wholeBatchFailed) {
          state.processed += batch.length;
          state.status = "error";
          state.message = verificationFailure
            ? "检测到京东验证，已停止后续批次；完成验证后请重新读取"
            : "本批商品全部失败，已停止后续批次；请查看失败原因后重试";
          render();
          return;
        }
      } catch (error) {
        if (token !== runToken && error?.message === "用户停止处理") break;
        state.failed += batch.length;
        for (const product of batch) {
          failureDetails.push({id: `商品 ${product.productId}`, error: error?.message || "批次处理异常"});
        }
        state.processed += batch.length;
        state.status = "error";
        state.message = `批次请求异常，已停止后续处理：${error?.message || "请完成验证后重试"}`;
        render();
        return;
      }
      state.processed += batch.length;
      render();
      if (token === runToken && state.processed < state.total) await sleep(state.delayMs);
    }
    if (token !== runToken) return;
    state.status = "done";
    state.message = state.failed
      ? `处理完成：成功 ${state.success}，失败 ${state.failed}；鼠标停在失败数量上查看原因`
      : `处理完成：${state.success} 个商品已删除`;
    render();
  }

  function stopProcessing() {
    if (state.status !== "running") return;
    runToken += 1;
    state.status = "stopped";
    state.message = "已停止；已提交成功的操作不会撤销，可重新读取后继续";
    render();
  }

  function ensureUi() {
    const complianceSection = isComplianceSection();
    suppressInitialJdAiPanel(complianceSection);
    const informationViolationView = isInformationViolationView();
    const legalDetailView = isLegalQueryDetailView();
    const productNodeCount = document.querySelectorAll(".conent_wrap_spu, .content_wrap_spu").length;
    const actionCount = document.querySelectorAll(".et-c-info-action").length;
    const detailSkuNodeCount = legalDetailView ? legalDetailSkuEntries().length : 0;
    const detailActionCount = document.querySelectorAll(".et-c-detail-action").length;
    const nextFingerprint = `${complianceSection}|${informationViolationView}|${legalDetailView}|${productNodeCount}|${actionCount}|${detailSkuNodeCount}|${detailActionCount}|${location.href}`;
    if (nextFingerprint !== diagnosticFingerprint) {
      diagnosticFingerprint = nextFingerprint;
      diagnosticLog("ui_probe", {complianceSection, informationViolationView, legalDetailView, productNodeCount, actionCount, detailSkuNodeCount, detailActionCount});
    }
    if (!complianceSection && !informationViolationView) {
      document.getElementById("et-compliance-launcher")?.remove();
      document.getElementById("et-compliance-panel")?.remove();
      return;
    }
    ensureStyle();
    if (informationViolationView || productNodeCount) {
      try {
        ensureInformationViolationRows();
      } catch (error) {
        diagnosticLog("information_injection_error", {message: error?.message || String(error)});
      }
    }
    if (legalDetailView) {
      try {
        ensureLegalQueryDetailRows();
      } catch (error) {
        diagnosticLog("detail_injection_error", {message: error?.message || String(error)});
      }
    }
    let created = false;
    if (IS_TOP_FRAME && complianceSection) {
      if (!document.getElementById("et-compliance-launcher")) {
        const launcher = document.createElement("button");
        launcher.id = "et-compliance-launcher";
        launcher.type = "button";
        launcher.title = "打开电商综合工具箱";
        launcher.innerHTML = `<img src="${chrome.runtime.getURL("assets/wolf-logo.png")}" alt="小灰狼">`;
        launcher.addEventListener("click", () => {
          state.panelOpen = true;
          render();
        });
        document.documentElement.appendChild(launcher);
        created = true;
      }
      if (!document.getElementById("et-compliance-panel")) {
        const panel = document.createElement("aside");
        panel.id = "et-compliance-panel";
        document.documentElement.appendChild(panel);
        created = true;
      }
      if (created) render();
      if (!informationViolationView && !legalDetailView) {
        annotateProcessedRows();
        ensureSubjectColumnWidth();
        scheduleVisibleSkuStatusRefresh();
      }
    } else {
      document.getElementById("et-compliance-launcher")?.remove();
      document.getElementById("et-compliance-panel")?.remove();
    }
  }

  let detectionTimer = 0;
  function scheduleEnsureUi() {
    clearTimeout(detectionTimer);
    detectionTimer = setTimeout(ensureUi, 300);
  }

  (async () => {
    document.addEventListener("click", handleJdAiAutoPopupSwitchInteraction, true);
    document.addEventListener("change", handleJdAiAutoPopupSwitchInteraction, true);
    try {
      const saved = (await chrome.storage.local.get(JD_AI_AUTO_POPUP_STORAGE_KEY))[JD_AI_AUTO_POPUP_STORAGE_KEY];
      if (typeof saved?.enabled === "boolean") jdAiAutoPopupEnabled = saved.enabled;
    } catch (_error) {
      jdAiAutoPopupEnabled = false;
    }
    try {
      const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (saved && Number(saved.delayMs) >= 500) state.delayMs = Number(saved.delayMs);
    } catch (_error) {
      // The default delay remains usable if storage is unavailable.
    }
    try {
      await loadProcessedSkuRecords();
    } catch (_error) {
      processedSkuRecords = {};
    }
    try {
      await loadSkuStatusRecords();
    } catch (_error) {
      skuStatusRecords = {};
    }
    try {
      await loadProcessedInfoProductRecords();
    } catch (_error) {
      processedInfoProductRecords = {};
    }
    state.panelOpen = false;
    ensureUi();
    new MutationObserver((mutations) => {
      const hasExternalChange = mutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return !target?.closest?.("#et-compliance-panel, #et-compliance-launcher");
      });
      if (hasExternalChange) scheduleEnsureUi();
    }).observe(document.documentElement, {childList: true, subtree: true});
    window.addEventListener("popstate", scheduleEnsureUi);
    window.addEventListener("hashchange", scheduleEnsureUi);
  })();
})();
