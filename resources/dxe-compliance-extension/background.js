const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const PRODUCT_HOST_URL = "https://wares-jdm.jd.com/ware/wareList?activeTab=OnsaleWare&businessModel=0";
const complianceDiagnosticLogs = new Map();

function isAllowedComplianceSender(sender) {
  return [sender.tab?.url, sender.url].some((value) =>
    /^https:\/\/(?:[^/]+\.)?shop\.jd\.com\//i.test(String(value || ""))
    || /^https:\/\/keeper-jdm\.jd\.com\//i.test(String(value || ""))
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TOOLBOX_COMPLIANCE_DIAGNOSTIC") {
    const tabId = sender.tab?.id;
    if (tabId == null || !message.entry) return;
    if (!complianceDiagnosticLogs.has(tabId) && complianceDiagnosticLogs.size >= 50) {
      complianceDiagnosticLogs.delete(complianceDiagnosticLogs.keys().next().value);
    }
    if (message.entry.event === "script_started" && sender.frameId === 0) complianceDiagnosticLogs.set(tabId, []);
    const logs = complianceDiagnosticLogs.get(tabId) || [];
    logs.push({...message.entry, frameId: sender.frameId ?? -1, frameUrl: sender.url || ""});
    if (logs.length > 240) logs.splice(0, logs.length - 240);
    complianceDiagnosticLogs.set(tabId, logs);
    return;
  }
  if (message?.type === "TOOLBOX_GET_COMPLIANCE_LOGS") {
    const tabId = Number(message.tabId);
    sendResponse({ok: true, logs: complianceDiagnosticLogs.get(tabId) || []});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "TOOLBOX_INFORMATION_CONFIRM_REQUEST") return;
  const tabId = sender.tab?.id;
  if (!tabId || !isAllowedComplianceSender(sender)) {
    sendResponse({ok: false, error: "仅允许从京麦店铺合规页面发起删除确认"});
    return;
  }
  (async () => {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "TOOLBOX_SHOW_INFORMATION_CONFIRM",
        payload: message.payload || {}
      }, {frameId: 0});
      sendResponse(response?.ok
        ? {ok: true, confirmed: Boolean(response.confirmed)}
        : {ok: false, error: response?.error || "顶层确认框未响应"});
    } catch (error) {
      sendResponse({ok: false, error: error?.message || "无法在顶层页面显示确认框"});
    }
  })();
  return true;
});

async function probeProductHost(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {type: "TOOLBOX_PRODUCT_HOST_PROBE"});
    return Boolean(response?.ok);
  } catch (_error) {
    return false;
  }
}

async function waitForProductHost(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeProductHost(tabId)) return tabId;
    await wait(300);
  }
  throw new Error("商品列表官方页面加载超时，请确认京麦账号已登录");
}

async function findProductHostTab() {
  const tabs = await chrome.tabs.query({url: "https://wares-jdm.jd.com/ware/wareList*"});
  for (const tab of tabs) {
    if (tab.id && await probeProductHost(tab.id)) return tab.id;
  }
  const loadingTabIds = tabs.map((tab) => tab.id).filter(Boolean);
  if (!loadingTabIds.length) return null;
  try {
    return await Promise.any(loadingTabIds.map((tabId) => waitForProductHost(tabId)));
  } catch (_error) {
    return null;
  }
}

async function getProductHostTab() {
  const tabId = await findProductHostTab();
  if (!tabId) throw new Error(`店小二尚未创建商品接口环境：${PRODUCT_HOST_URL}`);
  return tabId;
}

function messageChannelClosed(error) {
  return /message channel closed|asynchronous response|receiving end does not exist|could not establish connection/i
    .test(String(error?.message || error || ""));
}

async function productHostErrorMessage(error, tabId) {
  if (!messageChannelClosed(error)) return error?.message || "无法连接商品列表官方页面";
  return tabId
    ? "商品列表接口页在响应前刷新或中断；请稍后重新读取"
    : "未找到店小二创建的商品接口环境；请关闭后重新进入店铺后台";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "TOOLBOX_PRODUCT_API_REQUEST") return;
  if (!isAllowedComplianceSender(sender)) {
    sendResponse({ok: false, error: "仅允许从京麦店铺合规页面调用商品接口"});
    return;
  }
  if (!new Set(["PING", "QUERY_PRODUCTS", "QUERY_RECYCLE_PRODUCTS", "UPDATE_STATUS"]).has(message.action)) {
    sendResponse({ok: false, error: "不支持的商品接口操作"});
    return;
  }
  (async () => {
    let tabId = null;
    try {
      tabId = await getProductHostTab();
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "TOOLBOX_PRODUCT_HOST_REQUEST",
        action: message.action,
        payload: message.payload || {}
      });
      sendResponse(response?.ok ? response : {ok: false, error: response?.error || "商品列表官方接口调用失败"});
    } catch (error) {
      sendResponse({ok: false, error: await productHostErrorMessage(error, tabId)});
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "TOOLBOX_COMPLIANCE_SFF_FETCH") return;
  if (!isAllowedComplianceSender(sender)) {
    sendResponse({ok: false, error: "仅允许从京麦店铺合规页面调用商品接口"});
    return;
  }
  let endpoint;
  try {
    endpoint = new URL(message.url);
  } catch (_error) {
    sendResponse({ok: false, error: "商品接口地址无效"});
    return;
  }
  const allowedApis = new Set([
    "dsm.product.manage.ProductInfoReadViewService.queryValidProductList",
    "dsm.product.manage.ProductInfoReadViewService.queryRecycleProductList",
    "dsm.product.manage.ProductStatusUpdateViewService.updateProductStatus"
  ]);
  if (endpoint.origin !== "https://sff.jd.com"
    || endpoint.pathname !== "/api"
    || endpoint.searchParams.get("appId") !== "3MC69M4R3HFKCQ4S01DN"
    || !allowedApis.has(endpoint.searchParams.get("api"))) {
    sendResponse({ok: false, error: "已阻止非商品管理接口请求"});
    return;
  }

  (async () => {
    try {
      const response = await fetch(endpoint.href, {
        method: "POST",
        credentials: "include",
        headers: message.headers && typeof message.headers === "object" ? message.headers : {},
        body: String(message.body || "")
      });
      const bodyText = await response.text();
      sendResponse({
        ok: true,
        response: {ok: response.ok, status: response.status, bodyText}
      });
    } catch (error) {
      sendResponse({ok: false, error: error?.message || "商品接口网络请求失败"});
    }
  })();
  return true;
});
