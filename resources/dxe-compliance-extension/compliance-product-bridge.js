(() => {
  if (window.__ECOMMERCE_TOOLBOX_COMPLIANCE_BRIDGE__) return;
  window.__ECOMMERCE_TOOLBOX_COMPLIANCE_BRIDGE__ = true;

  const REQUEST_SOURCE = "ECOMMERCE_TOOLBOX_COMPLIANCE_EXTENSION_V1";
  const RESPONSE_SOURCE = "ECOMMERCE_TOOLBOX_COMPLIANCE_PAGE_V1";
  const FETCH_REQUEST_SOURCE = "ECOMMERCE_TOOLBOX_COMPLIANCE_FETCH_PAGE_V1";
  const FETCH_RESPONSE_SOURCE = "ECOMMERCE_TOOLBOX_COMPLIANCE_FETCH_EXTENSION_V1";
  const REQUEST_APP_ID = "3MC69M4R3HFKCQ4S01DN";
  const DEFAULT_SECURITY_BUSINESS_ID = "0248a";
  const API_VERSION = "1.0";
  const API = {
    query: "dsm.product.manage.ProductInfoReadViewService.queryValidProductList",
    queryRecycle: "dsm.product.manage.ProductInfoReadViewService.queryRecycleProductList",
    update: "dsm.product.manage.ProductStatusUpdateViewService.updateProductStatus"
  };
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function waitForSecuritySdk(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const config = window.__DSM_SECURITY_CONFIG || {};
      if (config.securitySdkReady) {
        try {
          await config.securitySdkReady;
        } catch (_error) {
          // Continue to the concrete readiness checks below.
        }
      }
      if (typeof window.ParamsSign === "function" && window.CryptoJS?.SHA256) {
        return {config};
      }
      await sleep(150);
    }
    throw new Error("京麦页面签名组件未就绪，请刷新当前页面后重试");
  }

  function cookieLanguage() {
    const match = /(?:^|;)\s*dsm-lang\s*=\s*([^;]+)/i.exec(document.cookie);
    return match ? match[1].trim().replaceAll("-", "_") : "zh_CN";
  }

  function traceId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
      const random = Math.floor(Math.random() * 16);
      const value = character === "x" ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    });
  }

  function getJsToken() {
    if (typeof window.getJsToken !== "function") return Promise.resolve("");
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve("");
        }
      }, 1500);
      try {
        window.getJsToken((result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result?.jsToken || "");
        }, 1200);
      } catch (_error) {
        clearTimeout(timer);
        resolve("");
      }
    });
  }

  async function signBody(api, body) {
    const {config} = await waitForSecuritySdk();
    const businessId = config.securityWhiteList?.[api]
      || config.defaultBusinessId
      || DEFAULT_SECURITY_BUSINESS_ID;
    const signer = new window.ParamsSign({
      appId: businessId,
      preRequest: false,
      debug: false,
      onSign() {}
    });
    const bodyHash = window.CryptoJS.SHA256(JSON.stringify(body)).toString().toUpperCase();
    const signed = await signer.sign({
      body: bodyHash,
      appId: REQUEST_APP_ID,
      api,
      v: API_VERSION
    });
    if (!signed?.h5st) throw new Error("京麦未能生成商品接口签名");
    return encodeURI(signed.h5st);
  }

  function extensionFetch(url, headers, body, timeoutMs = 45000) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("等待扩展后台请求商品接口超时"));
      }, timeoutMs);
      function onMessage(event) {
        if (event.source !== window || event.origin !== location.origin) return;
        const message = event.data;
        if (!message || message.source !== FETCH_RESPONSE_SOURCE || message.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (message.ok) resolve(message.response);
        else reject(new Error(message.error || "扩展后台请求商品接口失败"));
      }
      window.addEventListener("message", onMessage);
      window.postMessage({
        source: FETCH_REQUEST_SOURCE,
        requestId,
        url,
        headers,
        body
      }, location.origin);
    });
  }

  async function callApi(api, body) {
    const bodyText = JSON.stringify(body);
    const [h5st, eid] = await Promise.all([signBody(api, body), getJsToken()]);
    const language = cookieLanguage();
    const headers = {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json;charset=UTF-8",
      "dsm-file-path": "lineation-price",
      "dsm-lang": language,
      "dsm-language": language,
      "dsm-platform": "pc",
      "dsm-site": "",
      "dsm-trace-id": traceId(),
      "h5st": h5st,
      "x-referer-page": "https://wares-jdm.jd.com/ware/wareList",
      "x-requested-with": "XMLHttpRequest",
      "x-rp-client": "h5_1.0.0"
    };
    if (eid) headers["dsm-eid"] = eid;

    const endpoint = `https://sff.jd.com/api?v=${API_VERSION}&appId=${REQUEST_APP_ID}&api=${encodeURIComponent(api)}`;
    let response;
    if (location.hostname === "wares-jdm.jd.com") {
      const directResponse = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers,
        body: bodyText
      });
      response = {
        ok: directResponse.ok,
        status: directResponse.status,
        bodyText: await directResponse.text()
      };
    } else {
      response = await extensionFetch(endpoint, headers, bodyText);
    }

    let result;
    try {
      result = JSON.parse(response.bodyText);
    } catch (_error) {
      throw new Error(`接口返回无法解析（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(result?.msg || `接口请求失败（HTTP ${response.status}）`);
    if (String(result?.code) !== "200") {
      const code = result?.bCode || result?.code || "未知代码";
      throw new Error(`${result?.msg || "商品接口调用失败"}（${code}）`);
    }
    return result.data;
  }

  function numberIds(values, limit = 100) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const text = String(value ?? "").trim();
      if (!/^\d{8,20}$/.test(text) || seen.has(text)) continue;
      seen.add(text);
      result.push(Number(text));
      if (result.length >= limit) break;
    }
    return result;
  }

  async function handle(message) {
    if (message.type === "PING") {
      await waitForSecuritySdk();
      return {ready: true};
    }
    if (message.type === "QUERY_PRODUCTS") {
      const skuIdList = numberIds(message.skuIds);
      const productIdList = numberIds(message.productIds);
      if (!skuIdList.length && !productIdList.length) throw new Error("未提供要查询的 SKU 或商品编码");
      return callApi(API.query, {
        productListQueryReq: {
          productName: null,
          skuIdList: skuIdList.length ? skuIdList : null,
          categoryIdList: null,
          productIdList: productIdList.length ? productIdList : null,
          salesVolume: null,
          jdPrice: null,
          shopCategory: null,
          stockNum: null,
          brandIdList: [],
          itemNum: null,
          productState: "11",
          modified: null,
          productType: null,
          startOnlineTime: null,
          endOnlineTime: null,
          startOfflineTime: null,
          endOfflineTime: null,
          startCreated: null,
          endCreated: null,
          startModified: null,
          endModified: null,
          categoryIds: [],
          minSalesVolume: null,
          maxSalesVolume: null,
          minJdPrice: null,
          maxJdPrice: null,
          minStockNum: null,
          maxStockNum: null,
          supplyProductIdList: null,
          supplySkuIdList: null,
          supplyIdList: null,
          sortMap: {modified: "desc"},
          pageNum: 1,
          pageSize: 100
        },
        accessContext: {
          source: "web",
          businessModel: "0",
          proxyBelongBizId: "",
          originType: null
        }
      });
    }
    if (message.type === "QUERY_RECYCLE_PRODUCTS") {
      const skuIdList = numberIds(message.skuIds);
      if (!skuIdList.length) throw new Error("未提供要查询回收站的 SKU");
      return callApi(API.queryRecycle, {
        productListQueryReq: {
          productIdList: null,
          productName: null,
          deleteTime: null,
          skuIdList,
          productState: null,
          startDeleteTime: null,
          endDeleteTime: null,
          sortMap: {modified: "desc"},
          pageNum: 1,
          pageSize: 100
        },
        accessContext: {
          source: "web",
          businessModel: "0",
          proxyBelongBizId: "",
          originType: null
        }
      });
    }
    if (message.type === "UPDATE_STATUS") {
      const operation = String(message.operation || "");
      if (!new Set(["down", "del"]).has(operation)) throw new Error("不支持的商品状态操作");
      const productIds = numberIds(message.productIds);
      if (!productIds.length) throw new Error("未提供要处理的商品编码");
      return callApi(API.update, {
        productStatusReq: {
          operation,
          skuGroups: productIds.map((productId) => operation === "del"
            ? {productId, skuIds: []}
            : {productId}),
          downReason: ""
        },
        accessContext: {
          source: "web",
          businessModel: "0",
          proxyBelongBizId: "",
          originType: null
        }
      });
    }
    throw new Error("不支持的违规商品页面桥接操作");
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== REQUEST_SOURCE || !message.requestId) return;
    try {
      const result = await handle(message);
      window.postMessage({source: RESPONSE_SOURCE, requestId: message.requestId, ok: true, result}, location.origin);
    } catch (error) {
      window.postMessage({
        source: RESPONSE_SOURCE,
        requestId: message.requestId,
        ok: false,
        error: error?.message || "商品接口调用失败"
      }, location.origin);
    }
  });
})();
