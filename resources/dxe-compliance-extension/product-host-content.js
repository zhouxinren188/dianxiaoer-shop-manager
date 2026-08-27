(() => {
  if (window.__ECOMMERCE_TOOLBOX_PRODUCT_HOST__) return;
  window.__ECOMMERCE_TOOLBOX_PRODUCT_HOST__ = true;

  const REQUEST_SOURCE = "ECOMMERCE_TOOLBOX_COMPLIANCE_EXTENSION_V1";
  const RESPONSE_SOURCE = "ECOMMERCE_TOOLBOX_COMPLIANCE_PAGE_V1";

  function bridgeRequest(type, payload = {}, timeoutMs = 45000) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("等待商品列表官方接口响应超时"));
      }, timeoutMs);
      function onMessage(event) {
        if (event.source !== window || event.origin !== location.origin) return;
        const message = event.data;
        if (!message || message.source !== RESPONSE_SOURCE || message.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error || "商品列表官方接口调用失败"));
      }
      window.addEventListener("message", onMessage);
      window.postMessage({source: REQUEST_SOURCE, requestId, type, ...payload}, location.origin);
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TOOLBOX_PRODUCT_HOST_PROBE") {
      sendResponse({ok: true});
      return;
    }
    if (message?.type !== "TOOLBOX_PRODUCT_HOST_REQUEST") return;
    (async () => {
      try {
        const result = await bridgeRequest(message.action, message.payload || {});
        sendResponse({ok: true, result});
      } catch (error) {
        sendResponse({ok: false, error: error?.message || "商品列表官方接口调用失败"});
      }
    })();
    return true;
  });
})();
