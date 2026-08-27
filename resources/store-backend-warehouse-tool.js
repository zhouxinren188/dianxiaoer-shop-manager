(() => {
  'use strict';

  const STORAGE_PREFIX = 'dxeWarehouseRegionTool:';
  const logoUrl = '__DXE_WAREHOUSE_LOGO_URL__';
  const chromeApi = window.chrome || {};
  if (!window.chrome) window.chrome = chromeApi;
  chromeApi.storage = chromeApi.storage || {};
  chromeApi.storage.local = {
    async get(key) {
      const keys = Array.isArray(key)
        ? key
        : typeof key === 'string' ? [key] : Object.keys(key || {});
      const result = {};
      for (const item of keys) {
        try {
          const saved = localStorage.getItem(STORAGE_PREFIX + item);
          result[item] = saved == null
            ? (key && typeof key === 'object' && !Array.isArray(key) ? key[item] : undefined)
            : JSON.parse(saved);
        } catch {
          result[item] = undefined;
        }
      }
      return result;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values || {})) {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
      }
    }
  };
  chromeApi.runtime = chromeApi.runtime || {};
  chromeApi.runtime.getURL = (resourcePath) => resourcePath === 'assets/wolf-logo.png' ? logoUrl : resourcePath;
})();

(() => {
  if (window.__ECOMMERCE_TOOLBOX_WAREHOUSE_BRIDGE__) return;
  window.__ECOMMERCE_TOOLBOX_WAREHOUSE_BRIDGE__ = true;

  const REQUEST_SOURCE = "ECOMMERCE_TOOLBOX_WAREHOUSE_EXTENSION_V1";
  const RESPONSE_SOURCE = "ECOMMERCE_TOOLBOX_WAREHOUSE_PAGE_V1";
  const REQUEST_APP_ID = "KZFBL0OIH93MGTTRPGQK";
  const DEFAULT_SECURITY_BUSINESS_ID = "0248a";
  const API_VERSION = "1.0";
  const API = {
    regions: "dsm.order.bff.PartitionWarehousePriorityService.getRegionHierarchyWithPriorityCounts",
    warehouses: "dsm.order.bff.PartitionWarehousePriorityService.getConfigurableWarehousesByRegion",
    priorities: "dsm.order.bff.PartitionWarehousePriorityService.getWarehousePrioritiesByRegion",
    save: "dsm.order.bff.PartitionWarehousePriorityService.saveWarehousePriorityByRegionId"
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
    throw new Error("京麦页面签名组件未就绪，请刷新仓库管理页面后重试");
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

  function withPageContext(body) {
    const sourceBody = body && typeof body === "object" ? body : {};
    const subScene = new URL(location.href).searchParams.get("subScene") || "";
    // 京麦仓库管理页官方前端的 PageSource.Pc 枚举值。
    // 即使业务入参为空，官方请求拦截器也会创建 request 并写入 source。
    const request = {
      ...(sourceBody.request && typeof sourceBody.request === "object" ? sourceBody.request : {}),
      source: "2000"
    };
    if (subScene) {
      request.dsmContext = {
        ...(request.dsmContext || {}),
        extensions: {
          ...(request.dsmContext?.extensions || {}),
          subScene
        }
      };
    }
    return {...sourceBody, request};
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
    if (!signed?.h5st) throw new Error("京麦未能生成仓库接口签名");
    return encodeURI(signed.h5st);
  }

  async function callApi(api, rawBody = {}) {
    const body = withPageContext(rawBody);
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
      "x-referer-page": location.href,
      "x-requested-with": "XMLHttpRequest",
      "x-rp-client": "h5_1.0.0"
    };
    if (eid) headers["dsm-eid"] = eid;

    const endpoint = `https://sff.jd.com/api?v=${API_VERSION}&appId=${REQUEST_APP_ID}&api=${encodeURIComponent(api)}`;
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers,
      body: bodyText
    });

    let result;
    try {
      result = await response.json();
    } catch (_error) {
      throw new Error(`接口返回无法解析（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(result?.msg || `接口请求失败（HTTP ${response.status}）`);
    if (String(result?.code) !== "200") {
      const code = result?.bCode || result?.code || "未知代码";
      throw new Error(`${result?.msg || "仓库接口调用失败"}（${code}）`);
    }
    return result.data;
  }

  async function handle(message) {
    if (message.type === "PING") {
      await waitForSecuritySdk();
      return {ready: true};
    }
    if (message.type === "LOAD_REGIONS") return callApi(API.regions, {});
    if (message.type === "LOAD_WAREHOUSES") {
      return callApi(API.warehouses, {
        request: {data: {regionId: Number(message.regionId), level: Number(message.level)}}
      });
    }
    if (message.type === "LOAD_PRIORITIES") {
      return callApi(API.priorities, {
        request: {data: {regionId: Number(message.regionId), level: Number(message.level)}}
      });
    }
    if (message.type === "SAVE_PRIORITIES") {
      const details = Array.isArray(message.details)
        ? message.details.map((item) => ({
          priority: Number(item.priority),
          seqNum: item.seqNum,
          type: item.type,
          warehouseId: item.warehouseId
        }))
        : [];
      if (!details.length) throw new Error("未选择要保存的仓库");
      return callApi(API.save, {
        request: {
          data: {
            regionId: Number(message.regionId),
            level: Number(message.level),
            details
          }
        }
      });
    }
    throw new Error("不支持的仓库页面桥接操作");
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
        error: error?.message || "仓库接口调用失败"
      }, location.origin);
    }
  });
})();
(() => {
  if (window.__ECOMMERCE_TOOLBOX_WAREHOUSE_UI__) return;
  window.__ECOMMERCE_TOOLBOX_WAREHOUSE_UI__ = true;

  const TARGET_PATH = "/jdm/trade/warehousing/warehouse-manage";
  const STORAGE_KEY = "ecommerceToolboxWarehouseState";
  const REQUEST_SOURCE = "ECOMMERCE_TOOLBOX_WAREHOUSE_EXTENSION_V1";
  const RESPONSE_SOURCE = "ECOMMERCE_TOOLBOX_WAREHOUSE_PAGE_V1";
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  let regions = [];
  let warehouses = [];
  let runToken = 0;
  let state = freshState();

  function freshState() {
    return {
      status: "idle",
      panelOpen: false,
      delayMs: 1000,
      selectedRegionIds: [],
      rules: {},
      currentRegion: "",
      total: 0,
      success: 0,
      failed: 0,
      processed: 0,
      message: "请先读取省份和仓库",
      logs: []
    };
  }

  function ensureTargetPage() {
    if (location.hostname !== "shop.jd.com" || !location.pathname.startsWith(TARGET_PATH)) {
      throw new Error("请在京麦“仓库管理”页面运行此功能");
    }
  }

  function isCoverageAreaTabActive() {
    return [...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
      .some((tab) => tab.textContent?.trim().includes("覆盖区域管理"));
  }

  function ensureCoverageAreaTab() {
    if (!isCoverageAreaTabActive()) {
      throw new Error("请先切换到“覆盖区域管理”页签");
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return [];
    for (const key of ["data", "list", "records", "content", "result"]) {
      if (Array.isArray(value[key])) return value[key];
    }
    return [];
  }

  function normalizeRegions(value) {
    const source = asArray(value);
    const found = [];
    const walk = (items) => {
      for (const item of items || []) {
        if (!item || typeof item !== "object") continue;
        if (Number(item.level) === 1) found.push(item);
        const children = Array.isArray(item.childAreaNums)
          ? item.childAreaNums
          : Array.isArray(item.children) ? item.children : [];
        if (children.length) walk(children);
      }
    };
    walk(source);
    const candidates = found.length
      ? found
      : source.filter((item) => item && Number(item.id) !== 0 && item.name);
    const unique = new Map();
    for (const item of candidates) {
      const id = Number(item.id);
      if (!Number.isFinite(id) || !item.name) continue;
      unique.set(String(id), {
        id,
        name: String(item.name),
        level: Number(item.level) || 1,
        configured: Number(item.num) || 0
      });
    }
    return [...unique.values()];
  }

  function warehouseKey(item) {
    return String(item?.seqNum ?? item?.warehouseId ?? item?.id ?? item?.name ?? "");
  }

  function normalizeWarehouses(value) {
    return asArray(value).map((item, index) => {
      const key = warehouseKey(item) || String(index);
      return {
        ...item,
        key,
        seqNum: item?.seqNum ?? item?.warehouseCode ?? item?.id,
        warehouseId: item?.warehouseId ?? item?.id,
        name: String(item?.name || item?.warehouseName || `仓库 ${index + 1}`),
        priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : "",
        immutable: Boolean(item?.immutable) || Number(item?.seqNum) === 0
      };
    }).filter((item) => item.key && !item.immutable && Number(item.seqNum) !== 0);
  }

  function bridgeRequest(type, payload = {}, timeoutMs = 25000) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("等待京麦仓库接口响应超时"));
      }, timeoutMs);
      function onMessage(event) {
        if (event.source !== window || event.origin !== location.origin) return;
        const message = event.data;
        if (!message || message.source !== RESPONSE_SOURCE || message.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error || "京麦仓库接口调用失败"));
      }
      window.addEventListener("message", onMessage);
      window.postMessage({source: REQUEST_SOURCE, requestId, type, ...payload}, location.origin);
    });
  }

  async function persist(renderAfter = true) {
    state.logs = state.logs.slice(-500);
    await chrome.storage.local.set({[STORAGE_KEY]: state});
    if (renderAfter) render();
  }

  function addLog(region, status, message) {
    state.logs.push({
      regionId: region?.id ?? "",
      region: region?.name || "-",
      status,
      message,
      time: new Date().toLocaleString("zh-CN", {hour12: false})
    });
  }

  function selectedRegions() {
    const selected = new Set(state.selectedRegionIds.map(String));
    return regions.filter((item) => selected.has(String(item.id)));
  }

  function selectedRules() {
    return warehouses.map((warehouse) => {
      const saved = state.rules[warehouse.key] || {};
      return {...warehouse, ...saved};
    }).filter((item) => item.selected && !item.immutable);
  }

  function validateSelection() {
    if (!regions.length || !warehouses.length) throw new Error("请先读取省份和仓库");
    const selectedRegionList = selectedRegions();
    if (!selectedRegionList.length) throw new Error("请至少勾选一个省份");
    const rules = selectedRules();
    if (!rules.length) throw new Error("请至少勾选一个仓库");
    for (const rule of rules) {
      const priority = Number(rule.priority);
      if (!Number.isInteger(priority) || priority < 0 || priority > 10000) {
        throw new Error(`${rule.name} 的优先级需填写 0–10000 的整数`);
      }
    }
    const priorities = rules.map((item) => Number(item.priority));
    if (new Set(priorities).size !== priorities.length) throw new Error("仓库优先级不能重复");
    return {selectedRegionList, rules};
  }

  async function loadData() {
    ensureTargetPage();
    if (!isCoverageAreaTabActive()) {
      state.status = "error";
      state.message = "请先切换到“覆盖区域管理”页签";
      await persist();
      return;
    }
    if (state.status === "running") return;
    if (state.status === "paused") runToken += 1;
    state.status = "loading";
    state.message = "正在读取京麦省份和仓库";
    await persist();
    try {
      await bridgeRequest("PING", {}, 22000);
      const [regionResult, warehouseResult] = await Promise.all([
        bridgeRequest("LOAD_REGIONS"),
        bridgeRequest("LOAD_WAREHOUSES", {regionId: 0, level: 0})
      ]);
      regions = normalizeRegions(regionResult);
      warehouses = normalizeWarehouses(warehouseResult);
      if (!regions.length) throw new Error("接口未返回可设置省份");
      if (!warehouses.length) throw new Error("接口未返回可配置仓库");

      const validRegionIds = new Set(regions.map((item) => String(item.id)));
      state.selectedRegionIds = state.selectedRegionIds.filter((id) => validRegionIds.has(String(id)));
      const nextRules = {};
      warehouses.forEach((warehouse) => {
        nextRules[warehouse.key] = {
          selected: false,
          priority: ""
        };
      });
      state.rules = nextRules;
      state.status = "idle";
      state.message = `已读取 ${regions.length} 个省份、${warehouses.length} 个仓库`;
      await persist();
    } catch (error) {
      state.status = "error";
      state.message = error?.message || "读取仓库设置失败";
      await persist();
    }
  }

  async function detailsForRegion(region, rules) {
    const result = await bridgeRequest("LOAD_WAREHOUSES", {
      regionId: region.id,
      level: region.level
    });
    const available = normalizeWarehouses(result);
    const byCode = new Map(available.map((item) => [String(item.seqNum), item]));
    const byName = new Map(available.map((item) => [item.name, item]));
    return rules.map((rule) => {
      const current = byCode.get(String(rule.seqNum)) || byName.get(rule.name);
      if (!current) throw new Error(`该区域没有可配置仓库：${rule.name}`);
      if (current.immutable) throw new Error(`该区域的仓库不可修改：${rule.name}`);
      if (current.warehouseId == null) throw new Error(`无法识别仓库 ID：${rule.name}`);
      return {
        priority: Number(rule.priority),
        seqNum: current.seqNum,
        type: current.type,
        warehouseId: current.warehouseId
      };
    });
  }

  async function runBatch() {
    let selection;
    try {
      ensureCoverageAreaTab();
      selection = validateSelection();
    } catch (error) {
      state.message = error.message;
      await persist();
      return;
    }

    const token = ++runToken;
    state.status = "running";
    state.total = selection.selectedRegionList.length;
    state.success = 0;
    state.failed = 0;
    state.processed = 0;
    state.currentRegion = "";
    state.logs = [];
    state.message = "开始批量设置省份仓库优先级";
    await persist();

    let consecutiveFailures = 0;
    for (let index = 0; index < selection.selectedRegionList.length; index += 1) {
      if (state.status !== "running" || token !== runToken) return;
      const region = selection.selectedRegionList[index];
      state.currentRegion = region.name;
      state.message = `正在设置 ${region.name}`;
      await persist();
      try {
        const details = await detailsForRegion(region, selection.rules);
        if (state.status !== "running" || token !== runToken) return;
        await bridgeRequest("SAVE_PRIORITIES", {
          regionId: region.id,
          level: region.level,
          details
        });
        if (state.status !== "running" || token !== runToken) return;
        state.success += 1;
        consecutiveFailures = 0;
        addLog(region, "success", `已保存 ${details.length} 个仓库`);
      } catch (error) {
        state.failed += 1;
        consecutiveFailures += 1;
        addLog(region, "failed", error?.message || "保存失败");
      }
      state.processed += 1;
      await persist();

      if (consecutiveFailures >= 3) {
        state.status = "error";
        state.message = "连续 3 个省份失败，任务已停止，请查看记录";
        await persist();
        return;
      }
      if (index < selection.selectedRegionList.length - 1) await sleep(state.delayMs);
    }

    if (token !== runToken) return;
    state.status = "done";
    state.message = `处理完成：成功 ${state.success}，失败 ${state.failed}`;
    await persist();
  }

  function statusText() {
    return ({
      idle: "待开始",
      loading: "读取中",
      running: "运行中",
      paused: "已暂停",
      done: "已完成",
      error: "需处理"
    })[state.status] || "待开始";
  }

  function statusClass() {
    if (state.status === "running" || state.status === "loading") return "running";
    if (state.status === "done") return "done";
    if (state.status === "error") return "error";
    return "idle";
  }

  function failedRegionTooltip() {
    const names = [...new Set(state.logs
      .filter((item) => item.status === "failed" && item.region && item.region !== "-")
      .map((item) => item.region))];
    return names.length ? `失败省份：${names.join("、")}` : "暂无失败省份";
  }

  const host = document.createElement("div");
  host.id = "ecommerce-toolbox-warehouse-host";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({mode: "open"});
  const logoUrl = chrome.runtime.getURL("assets/wolf-logo.png");

  shadow.innerHTML = `
    <style>
      *{box-sizing:border-box}button,input{font:inherit}.launcher{position:fixed;right:0;top:170px;z-index:2147483600;display:grid;place-items:center;width:62px;height:68px;padding:7px 7px 16px;border:1px solid rgba(229,200,169,.92);border-right:0;border-radius:22px 0 0 22px;background:rgba(255,249,238,.96);box-shadow:-3px 8px 24px rgba(69,49,31,.24),inset 0 0 0 1px rgba(255,255,255,.72);backdrop-filter:blur(9px);cursor:pointer}.launcher::before{content:'';position:absolute;left:0;top:14px;bottom:14px;width:4px;border-radius:0 5px 5px 0;background:#ff5a18}.launcher::after{content:'•••';position:absolute;left:50%;bottom:4px;transform:translateX(-50%);color:#f26522;font-size:8px;line-height:8px;letter-spacing:2px;white-space:nowrap}.launcher[hidden]{display:none}.launcher img{display:block;width:43px;height:43px;object-fit:contain;transform:translateY(-2px);filter:drop-shadow(0 2px 2px rgba(57,43,31,.2))}.panel{position:fixed;right:14px;top:149px;z-index:2147483601;width:440px;max-height:calc(100vh - 163px);display:flex;flex-direction:column;border:1px solid #dbe3ff;border-radius:18px;background:#f7f9ff;color:#1f2940;box-shadow:0 16px 48px rgba(30,43,95,.26);overflow:hidden}.panel[hidden]{display:none}.header{flex:none;display:flex;align-items:center;gap:10px;padding:15px 16px;background:linear-gradient(120deg,#315ff4,#5b3fde);color:#fff}.header img{width:38px;height:38px;object-fit:contain}.header h2{font-size:18px;margin:0 0 2px}.header p{font-size:12px;margin:0;opacity:.86}.close{margin-left:auto;width:34px;height:34px;border:0;border-radius:10px;background:rgba(255,255,255,.17);color:#fff;font-size:24px;line-height:30px;cursor:pointer}.body{overflow:auto;padding:12px}.card{margin-bottom:9px;padding:10px;border:1px solid #dbe3f5;border-radius:13px;background:#fff}.status-row,.toolbar,.actions,.summary{display:flex;align-items:center;gap:7px}.status{padding:4px 9px;border-radius:999px;font-size:12px;font-weight:700;background:#eef1f7;color:#68738b}.status.running{background:#e7f7ec;color:#17844b}.status.done{background:#e8efff;color:#2b5cdb}.status.error{background:#ffebeb;color:#d53c3c}.current-region{max-width:116px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#40506f;font-size:11px}.reload{margin-left:auto;border:1px solid #b9c9f7;border-radius:8px;padding:5px 10px;background:#fff;color:#315fdd;cursor:pointer}.progress{height:7px;margin:10px 0 12px;border-radius:99px;background:#e9edf7;overflow:hidden}.progress i{display:block;height:100%;background:linear-gradient(90deg,#4d6df6,#7250e9);transition:width .2s}.summary>div{flex:1;text-align:center;padding:9px 4px;border-radius:10px;background:#f4f6fb}.summary strong{display:block;font-size:19px}.summary span{font-size:11px;color:#7b859a}.current{margin:10px 0 0;font-size:12px;color:#5f6b83}.message{margin:5px 0 0;font-size:12px;color:#e04b32}.section-head{display:flex;align-items:center;margin-bottom:6px}.section-head strong{font-size:13px}.section-head small{margin-left:auto;color:#7b859a;font-size:11px}.toolbar{margin-bottom:6px}.mini{border:1px solid #cbd6ef;border-radius:6px;padding:2px 6px;background:#fff;color:#40506f;font-size:11px;line-height:18px;cursor:pointer}.regions{display:flex;flex-wrap:wrap;gap:4px;max-height:88px;overflow:auto}.region{display:flex;align-items:center;gap:3px;padding:2px 5px;border:1px solid #d9e0ef;border-radius:6px;background:#fafbfe;font-size:11px;line-height:17px;cursor:pointer}.region input,.warehouse>input[type=checkbox]{width:13px;height:13px;margin:0}.region:has(input:checked){border-color:#4d6df6;background:#eef2ff;color:#315fdd}.region em{font-style:normal;color:#9aa3b3}.warehouses{display:flex;flex-direction:column;gap:4px;max-height:148px;overflow:auto;padding-right:2px}.warehouse{display:grid;grid-template-columns:15px 1fr 64px;align-items:center;gap:5px;padding:4px 6px;border:1px solid #e0e5f0;border-radius:7px;min-height:39px;cursor:pointer}.warehouse.disabled{opacity:.55;cursor:default}.warehouse .name{font-size:11px;font-weight:700;line-height:14px}.warehouse .code{display:block;color:#8993a6;font-size:10px;font-weight:400;line-height:13px}.rank{width:60px;height:26px;border:1px solid #c8d2e8;border-radius:6px;padding:0 5px;text-align:center;font-size:11px;cursor:text}.settings{display:flex;align-items:center;gap:8px}.settings input[type=number]{width:75px;height:31px;border:1px solid #c8d2e8;border-radius:7px;padding:0 8px}.settings span{font-size:12px;color:#667189}.confirm{display:flex;align-items:flex-start;gap:7px;margin-top:10px;padding-top:10px;border-top:1px solid #edf0f6;color:#c44b2d;font-size:12px;line-height:18px}.actions{margin:12px 0 7px}.primary,.pause{height:38px;border:0;border-radius:10px;font-weight:800;cursor:pointer}.primary{flex:1;background:linear-gradient(90deg,#315ff4,#526ff5);color:#fff}.pause{width:100px;background:#e8ecf5;color:#566178}.primary:disabled,.pause:disabled{opacity:.45;cursor:not-allowed}.log-head{display:flex;align-items:center;margin:12px 0 7px;font-size:12px;color:#68738b}.clear{margin-left:auto;border:0;background:none;color:#d25242;cursor:pointer}.logs{max-height:140px;overflow:auto;border-top:1px solid #e3e7f0}.log{display:grid;grid-template-columns:70px 1fr;gap:8px;padding:7px 2px;border-bottom:1px dashed #e4e8f1;font-size:11px}.log b{color:#247b4c}.log.failed b{color:#d54545}.empty{padding:10px 0;text-align:center;color:#a1a9b8;font-size:12px}@media(max-width:620px){.panel{right:0;top:85px;width:min(440px,100vw);max-height:calc(100vh - 85px);height:calc(100vh - 85px);border-radius:0}}
      .launcher{height:62px;padding:7px;border-radius:15px 0 0 15px;box-shadow:-2px 5px 14px rgba(69,49,31,.14),inset 0 0 0 1px rgba(255,255,255,.58)}.launcher::before{left:10px;right:10px;top:auto;bottom:7px;width:auto;height:15px;border-radius:50%;background:radial-gradient(ellipse at center,rgba(255,102,22,.88) 0%,rgba(255,136,55,.58) 44%,rgba(255,181,112,.26) 65%,rgba(255,188,128,0) 84%);filter:blur(.5px)}.launcher::after{content:none}.launcher img{position:relative;z-index:1;transform:translateY(-1px)}
      .regions{display:flex;flex-wrap:wrap;gap:4px;max-height:none;overflow:visible}
      .region{display:flex;align-items:center;gap:3px;padding:2px 5px;border:1px solid #d9e0ef;border-radius:6px;background:#fafbfe;font-size:11px;line-height:17px;white-space:nowrap}
      .region:has(input:checked){border-color:#4d6df6;background:#eef2ff;color:#315fdd}
      .warehouses{max-height:none;overflow:visible;padding-right:0}
      .progress-card{padding:8px 10px}
      .progress-card .status-row{gap:8px}
      .compact-summary{display:flex;align-items:center;gap:10px;margin-left:auto}
      .compact-summary span{font-size:10px;color:#7b859a;white-space:nowrap}
      .compact-summary b{margin-right:2px;color:#25314b;font-size:14px}
      .compact-summary .failed-count{cursor:help}
      .progress-card .reload{margin-left:0;padding:4px 8px;font-size:12px}
      .progress-card .progress{height:6px;margin:7px 0 0}
      .progress-note{margin:6px 0 0;color:#d84b34;font-size:11px;line-height:15px}
      .notice{margin-top:9px;padding-top:8px;border-top:1px solid #edf0f6;color:#c44b2d;font-size:11px;line-height:17px}
      .notice b{margin-right:4px}
      .settings input[type=number]{width:52px;height:27px;padding:0 5px;text-align:center}
      .close{display:flex;align-items:center;justify-content:center;padding:0;line-height:1}
    </style>
    <button class="launcher" data-action="open" title="打开电商综合工具箱"><img src="${logoUrl}" alt="小灰狼"></button>
    <section class="panel" hidden><header class="header"><img src="${logoUrl}" alt="小灰狼"><div><h2>仓库分区库存助手</h2><p>按省份批量设置仓库出库优先级</p></div><button class="close" data-action="close" title="关闭">×</button></header><div class="body" data-role="body"></div></section>
  `;

  const launcher = shadow.querySelector(".launcher");
  const panel = shadow.querySelector(".panel");
  const body = shadow.querySelector('[data-role="body"]');

  function syncPageAvailability() {
    host.style.display = isCoverageAreaTabActive() ? "" : "none";
  }

  let availabilityFrame = 0;
  const pageObserver = new MutationObserver(() => {
    if (availabilityFrame) return;
    availabilityFrame = requestAnimationFrame(() => {
      availabilityFrame = 0;
      syncPageAvailability();
    });
  });
  pageObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["aria-selected"],
    childList: true,
    subtree: true
  });

  function render() {
    launcher.hidden = state.panelOpen;
    panel.hidden = !state.panelOpen;
    if (!state.panelOpen) return;
    const busy = ["loading", "running"].includes(state.status);
    const progress = state.total ? Math.round((state.processed / state.total) * 100) : 0;
    const selected = new Set(state.selectedRegionIds.map(String));
    const regionHtml = regions.length ? regions.map((region) => `
      <label class="region"><input type="checkbox" data-region-id="${region.id}" ${selected.has(String(region.id)) ? "checked" : ""} ${busy ? "disabled" : ""}><span>${escapeHtml(region.name)}</span></label>
    `).join("") : '<div class="empty">尚未读取省份</div>';
    const warehouseHtml = warehouses.length ? warehouses.map((warehouse) => {
      const rule = state.rules[warehouse.key] || {};
      const disabled = busy || warehouse.immutable;
      return `<div class="warehouse ${warehouse.immutable ? "disabled" : ""}" data-rule-row="${escapeHtml(warehouse.key)}"><input type="checkbox" data-rule-select="${escapeHtml(warehouse.key)}" ${rule.selected ? "checked" : ""} ${disabled ? "disabled" : ""}><div class="name">${escapeHtml(warehouse.name)}<span class="code">${escapeHtml(warehouse.seqNum)}${warehouse.immutable ? " · 不可修改" : ""}</span></div><input class="rank" type="number" min="0" max="10000" step="1" data-rule-priority="${escapeHtml(warehouse.key)}" value="${escapeHtml(rule.priority ?? "")}" ${disabled ? "disabled" : ""} title="优先级越小越优先"></div>`;
    }).join("") : '<div class="empty">尚未读取仓库</div>';
    const progressNote = state.status === "error" ? state.message : "";

    body.innerHTML = `
      <div class="card progress-card"><div class="status-row"><span class="status ${statusClass()}">${statusText()}</span>${state.status === "running" && state.currentRegion ? `<span class="current-region" title="正在设置：${escapeHtml(state.currentRegion)}">正在设置：${escapeHtml(state.currentRegion)}</span>` : ""}<div class="compact-summary"><span><b>${state.success}</b>成功</span><span class="failed-count" title="${escapeHtml(failedRegionTooltip())}"><b>${state.failed}</b>失败</span><span><b>${state.processed}/${state.total}</b>进度</span></div><button class="reload" data-action="reload" ${busy ? "disabled" : ""}>重新读取</button></div><div class="progress"><i style="width:${progress}%"></i></div>${progressNote ? `<p class="progress-note">${escapeHtml(progressNote)}</p>` : ""}</div>
      <div class="card"><div class="section-head"><strong>选择省份</strong><small>已选 ${selectedRegions().length}/${regions.length}</small></div><div class="toolbar"><button class="mini" data-action="regions-all" ${busy ? "disabled" : ""}>全选</button><button class="mini" data-action="regions-invert" ${busy ? "disabled" : ""}>反选</button><button class="mini" data-action="regions-clear" ${busy ? "disabled" : ""}>清空</button></div><div class="regions">${regionHtml}</div></div>
      <div class="card"><div class="section-head"><strong>仓库与优先级</strong><small>数值越小越优先</small></div><div class="toolbar"><button class="mini" data-action="warehouses-all" ${busy ? "disabled" : ""}>全选并排序</button><button class="mini" data-action="warehouses-clear" ${busy ? "disabled" : ""}>清空选择</button></div><div class="warehouses">${warehouseHtml}</div></div>
      <div class="card"><div class="settings"><span>每个省份处理间隔</span><input type="number" min="0.5" max="10" step="0.5" data-setting="delay" value="${state.delayMs / 1000}" ${busy ? "disabled" : ""}><span>秒</span></div><div class="notice"><b>温馨提示：</b>将按上方选择的仓库和优先级覆盖所选省份的现有设置，未勾选省份不会处理。</div></div>
      <div class="actions"><button class="primary" data-action="toggle-run" ${state.status === "loading" ? "disabled" : ""}>${state.status === "running" ? "停止处理" : "开始批量设置"}</button></div>
    `;
  }

  shadow.addEventListener("click", async (event) => {
    const warehouseRow = event.target.closest("[data-rule-row]");
    if (warehouseRow && !event.target.closest("input,button")) {
      const key = warehouseRow.dataset.ruleRow;
      const checkbox = warehouseRow.querySelector("[data-rule-select]");
      if (checkbox && !checkbox.disabled) {
        state.rules[key] = {...state.rules[key], selected: !checkbox.checked};
        await persist();
      }
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "open") {
      state.panelOpen = true;
      await persist();
      if (!regions.length && state.status !== "loading") await loadData();
    } else if (action === "close") {
      state.panelOpen = false;
      await persist();
    } else if (action === "reload") {
      await loadData();
    } else if (action === "regions-all") {
      state.selectedRegionIds = regions.map((item) => item.id);
      await persist();
    } else if (action === "regions-invert") {
      const current = new Set(state.selectedRegionIds.map(String));
      state.selectedRegionIds = regions.filter((item) => !current.has(String(item.id))).map((item) => item.id);
      await persist();
    } else if (action === "regions-clear") {
      state.selectedRegionIds = [];
      await persist();
    } else if (action === "warehouses-all") {
      let priority = 1;
      for (const warehouse of warehouses) {
        if (warehouse.immutable) continue;
        state.rules[warehouse.key] = {selected: true, priority};
        priority += 1;
      }
      await persist();
    } else if (action === "warehouses-clear") {
      for (const warehouse of warehouses) {
        state.rules[warehouse.key] = {...state.rules[warehouse.key], selected: false};
      }
      await persist();
    } else if (action === "toggle-run") {
      if (state.status === "running") {
        runToken += 1;
        state.status = "idle";
        state.currentRegion = "";
        state.message = "已停止处理";
        await persist();
      } else {
        await runBatch();
      }
    } else if (action === "clear-logs") {
      state.logs = [];
      await persist();
    }
  });

  shadow.addEventListener("change", async (event) => {
    const target = event.target;
    if (target.matches("[data-region-id]")) {
      const id = target.dataset.regionId;
      const selected = new Set(state.selectedRegionIds.map(String));
      if (target.checked) selected.add(id); else selected.delete(id);
      state.selectedRegionIds = [...selected];
      await persist();
    } else if (target.matches("[data-rule-select]")) {
      const key = target.dataset.ruleSelect;
      state.rules[key] = {...state.rules[key], selected: target.checked};
      await persist();
    } else if (target.matches("[data-rule-priority]")) {
      const key = target.dataset.rulePriority;
      state.rules[key] = {...state.rules[key], priority: target.value};
      // 数字框失焦时不重绘，避免吞掉紧接着发生的复选框或按钮点击。
      await persist(false);
    } else if (target.matches('[data-setting="delay"]')) {
      const seconds = Math.max(0.5, Math.min(10, Number(target.value) || 1));
      state.delayMs = Math.round(seconds * 1000);
      target.value = String(seconds);
      await persist(false);
    }
  });

  (async () => {
    try {
      ensureTargetPage();
      const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
      if (saved && typeof saved === "object") state = {...freshState(), ...saved};
      // 每次进入或刷新页面都保持收起，由用户点击右侧浮标后再打开。
      state.panelOpen = false;
      if (["running", "loading", "paused"].includes(state.status)) {
        state.status = "idle";
        state.message = "页面已重新载入，请重新读取后再开始";
      }
      syncPageAvailability();
      render();
    } catch (_error) {
      host.remove();
    }
  })();
})();
