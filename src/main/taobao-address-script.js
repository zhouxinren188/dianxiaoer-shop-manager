'use strict'

function normalizeTaobaoAddressForMatch(value) {
  return String(value || '')
    .replace(/[【】\[\]［］()（）]/g, '')
    .replace(/[\s·•・,，。;；:：\-—_]/g, '')
}

function taobaoAddressDetailMatches(rowText, targetDetail) {
  const normalizedTarget = normalizeTaobaoAddressForMatch(targetDetail)
  return !!normalizedTarget && normalizeTaobaoAddressForMatch(rowText).includes(normalizedTarget)
}

const TAOBAO_ADDRESS_ROLLING_LIMIT = 10
const TAOBAO_ADDRESS_CLEANUP_BATCH = 5

// 淘宝地址页会灰度发布不同版本，不能依赖单一 className。
// 这个脚本以“可见表单 + 中文语义 + 旧版选择器”组合定位，并且只在
// 检测到成功提示或地址列表中确实出现目标地址后才返回 success。
function buildTaobaoAddressManagerScript(receiverName, receiverPhone, parsedAddr, options = {}) {
  const originalDetail = parsedAddr && parsedAddr.other ? parsedAddr.other : ''
  const streetMatch = originalDetail.match(/^(.{1,20}?(?:街道办事处|街道|镇|乡|苏木))(.*)$/)
  const street = streetMatch ? streetMatch[1] : ''
  const detail = streetMatch && streetMatch[2] ? streetMatch[2] : originalDetail
  const province = parsedAddr && parsedAddr.province ? parsedAddr.province : ''
  const city = parsedAddr && (parsedAddr.city || parsedAddr.province) ? (parsedAddr.city || parsedAddr.province) : ''
  const area = parsedAddr && parsedAddr.area ? parsedAddr.area : ''
  const target = JSON.stringify({
    name: receiverName || '',
    phone: receiverPhone || '',
    province,
    city,
    area,
    street,
    detail,
    fullAddress: province + (city === province ? '' : city) + area + originalDetail
  })
  const protectedTargets = JSON.stringify(
    (Array.isArray(options.protectedAddresses) ? options.protectedAddresses : [])
      .map(item => ({
        name: String(item && item.name ? item.name : ''),
        phone: String(item && item.phone ? item.phone : ''),
        detail: String(item && item.detail ? item.detail : '')
      }))
      .filter(item => item.name && item.phone && item.detail)
  )

  return `
(async function() {
  if (window.__tbAddrV2Running) return 'already_running';
  window.__tbAddrV2Running = true;
  window.__tbAddrResult = null;
  window.__tbAddrResultDetail = '';

  var target = ${target};
  var protectedTargets = ${protectedTargets};
  var addressRollingLimit = ${TAOBAO_ADDRESS_ROLLING_LIMIT};
  var addressCleanupBatch = ${TAOBAO_ADDRESS_CLEANUP_BATCH};
  var formRoot = null;
  var saveClicked = false;
  var finished = false;
  var startedAt = Date.now();

  function log(code, detail) {
    console.log('[AddressAutoFill][TB] ' + code + ' elapsedMs=' + (Date.now() - startedAt) + (detail ? ' ' + detail : ''));
  }

  function finish(result, detail) {
    if (finished) return result;
    finished = true;
    window.__tbAddrResult = result;
    window.__tbAddrResultDetail = detail || '';
    if (result === 'need_login' || result === 'need_verify') window.__tbAddrV2Running = false;
    log('RESULT', result + (detail ? ':' + detail : ''));
    return result;
  }

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  // 淘宝地址页是异步渲染的 SPA。隐藏窗口中的短间隔定时器即使关闭后台节流，
  // 在部分 Windows/Chromium 环境仍可能被延后；DOM 变化监听可以在按钮或表单
  // 真正出现时立即继续，定时轮询仅作为没有 DOM 变化时的后备手段。
  function waitForDom(readValue, timeoutMs) {
    return new Promise(function(resolve) {
      var settled = false;
      var observer = null;
      var intervalId = null;
      var timeoutId = null;

      function finishWait(value) {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        if (intervalId) clearInterval(intervalId);
        if (timeoutId) clearTimeout(timeoutId);
        resolve(value || null);
      }

      function check() {
        if (settled) return;
        try {
          var value = readValue();
          if (value) finishWait(value);
        } catch (e) {}
      }

      try {
        observer = new MutationObserver(check);
        observer.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'aria-hidden', 'aria-expanded']
        });
      } catch (e) {}
      intervalId = setInterval(check, 250);
      timeoutId = setTimeout(function() { finishWait(null); }, timeoutMs);
      check();
    });
  }

  function nodeText(el) {
    return ((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function visibleAll(selector, root) {
    var scope = root || document;
    var nodes = [];
    try { nodes = Array.prototype.slice.call(scope.querySelectorAll(selector)); } catch (e) { return []; }
    return nodes.filter(isVisible);
  }

  function firstVisible(selectors, root) {
    for (var i = 0; i < selectors.length; i++) {
      var found = visibleAll(selectors[i], root);
      if (found.length) return found[0];
    }
    return null;
  }

  function normalizeRegion(value) {
    return String(value || '')
      .replace(/特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|盟/g, '')
      .replace(/[省市区县]$/g, '')
      .replace(/\\s+/g, '');
  }

  function regionTextMatches(actual, expected) {
    var a = normalizeRegion(actual);
    var e = normalizeRegion(expected);
    return !!a && !!e && (a === e || a.indexOf(e) === 0 || e.indexOf(a) === 0);
  }

  function detectBlockingIssue() {
    var url = location.href.toLowerCase();
    if (url.indexOf('login.taobao.com') >= 0 || url.indexOf('login.tmall.com') >= 0 || url.indexOf('passport') >= 0) {
      return 'need_login';
    }
    var challenge = document.querySelector('.J_MIDDLEWARE_FRAME_WIDGET, iframe[src*="punish"], iframe[src*="captcha"], [class*="captcha"], [class*="Captcha"]');
    var body = nodeText(document.body);
    if (challenge || /滑块验证|请完成.{0,6}验证|拖动滑块|验证后继续/.test(body)) return 'need_verify';
    return '';
  }

  function findField(kind) {
    var selectors = {
      name: [
        '#fullName', 'input[name="fullName"]', 'input[name="receiver"]',
        'input[name="consignee"]', 'input[placeholder*="收货人"]',
        'input[placeholder*="姓名"]', 'input[aria-label*="收货人"]'
      ],
      phone: [
        '#mobile', 'input[name="mobile"]', 'input[name="phone"]',
        'input[name="mobilePhone"]', 'input[placeholder*="手机号"]',
        'input[placeholder*="手机号码"]', 'input[placeholder*="联系电话"]',
        'input[placeholder*="电话"]', 'input[aria-label*="手机"]'
      ],
      detail: [
        '.cndzk-entrance-associate-area-textarea', 'textarea[name="addressDetail"]',
        'textarea[name="detailAddress"]', 'textarea[placeholder*="详细地址"]',
        'textarea[placeholder*="街道"]', 'textarea[placeholder*="门牌号"]',
        'input[name="addressDetail"]', 'input[name="detailAddress"]',
        'input[placeholder*="详细地址"]', 'input[placeholder*="门牌号"]'
      ]
    };
    return firstVisible(selectors[kind] || [], document);
  }

  function getFormRoot() {
    var nameEl = findField('name');
    var phoneEl = findField('phone');
    var detailEl = findField('detail');
    if (!nameEl || !phoneEl || !detailEl) return null;
    // 新版淘宝把智能粘贴、地区选择与下方字段拆在不同容器中。
    // 必须优先取整个对话框；若把最近的 form 当根节点，会看不到前两项。
    var dialogSelector = '[role="dialog"], .next-dialog, [class*="Dialog"], [class*="dialog"], [class*="Modal"], [class*="modal"]';
    return nameEl.closest(dialogSelector)
      || phoneEl.closest(dialogSelector)
      || detailEl.closest(dialogSelector)
      || nameEl.closest('form')
      || phoneEl.closest('form')
      || detailEl.closest('form')
      || document.body;
  }

  function findButtonByText(pattern, root) {
    var candidates = visibleAll('button, a, [role="button"]', root || document);
    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var text = nodeText(candidates[i]);
      if (!pattern.test(text)) continue;
      if (!best || text.length < nodeText(best).length) best = candidates[i];
    }
    return best;
  }

  function findAddButton() {
    var semantic = findButtonByText(/^(新增|添加|新建)(收货)?地址$|^添加新地址$/, document);
    if (semantic) return semantic;
    var selectors = [
      '.h-btn', '.addAddress', '[class*="addAddress"]', '[class*="AddAddress"]',
      '[class*="add-address"]', '[class*="address-add"]', '[data-testid*="add-address"]'
    ];
    var candidate = firstVisible(selectors, document);
    if (!candidate) return null;
    var text = nodeText(candidate);
    return !text || /新增|添加|新建/.test(text) ? candidate : null;
  }

  function setNativeValue(el, value) {
    if (!el) return false;
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    el.focus();
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    } catch (e) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return String(el.value || '') === String(value || '');
  }

  function optionContainers() {
    var selector = [
      '.cndzk-entrance-division-box', '.next-menu', '[role="listbox"]',
      '[class*="cascader"]', '[class*="Cascader"]', '[class*="dropdown"]',
      '[class*="Dropdown"]', '[class*="popup"]', '[class*="Popup"]',
      '[class*="picker"]', '[class*="Picker"]', '[class*="region-panel"]'
    ].join(',');
    return visibleAll(selector, document);
  }

  function findRegionOption(value) {
    var containers = optionContainers();
    var matches = [];
    for (var i = 0; i < containers.length; i++) {
      var items = visibleAll('li, a, [role="option"], [class*="item"], [class*="Item"], span, div', containers[i]);
      for (var j = 0; j < items.length; j++) {
        var text = nodeText(items[j]);
        if (text.length > 0 && text.length < 30 && regionTextMatches(text, value)) matches.push(items[j]);
      }
    }
    matches.sort(function(a, b) { return nodeText(a).length - nodeText(b).length; });
    return matches[0] || null;
  }

  async function chooseRegionOption(value, timeoutMs) {
    if (!value) return true;
    var end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      var option = findRegionOption(value);
      if (option) {
        option.click();
        await sleep(300);
        return true;
      }
      await sleep(120);
    }
    return false;
  }

  function setNativeSelect(select, value) {
    if (!select || !value) return false;
    var options = Array.prototype.slice.call(select.options || []);
    var match = options.find(function(option) { return regionTextMatches(option.textContent || option.label, value); });
    if (!match) return false;
    select.value = match.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function findSemanticRegionTrigger(root) {
    var knownFields = [findField('name'), findField('phone'), findField('detail')];
    var interactiveSelector = [
      'input', 'button', '[role="button"]', '[role="combobox"]', '[aria-haspopup]',
      '[tabindex]', '[class*="select"]', '[class*="Select"]',
      '[class*="picker"]', '[class*="Picker"]'
    ].join(',');
    var candidates = visibleAll(interactiveSelector, root);
    var semanticPattern = /省.{0,4}市.{0,4}(区|县)|所在地区|所在区域|选择地区|选择省|请选择.{0,8}(地区|省市)/;

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (knownFields.indexOf(candidate) >= 0) continue;
      var semanticText = [
        candidate.getAttribute('placeholder') || '',
        candidate.getAttribute('aria-label') || '',
        candidate.getAttribute('title') || '',
        nodeText(candidate).slice(0, 80)
      ].join(' ');
      if (semanticPattern.test(semanticText)) return candidate;
    }

    // 新版表单可能只在左侧保留“所在地区”标签，真实控件使用随机类名。
    var labels = visibleAll('label, span, div', root);
    for (var j = 0; j < labels.length; j++) {
      var labelText = nodeText(labels[j]);
      if (labelText !== '所在地区' && labelText !== '省市区' && labelText !== '所在区域') continue;
      var row = labels[j].closest('.next-form-item, [class*="form-item"], [class*="FormItem"], [class*="field"], [class*="Field"]')
        || (labels[j].parentElement && labels[j].parentElement.parentElement)
        || labels[j].parentElement;
      if (!row) continue;
      var rowCandidates = visibleAll(interactiveSelector + ', div, span', row);
      for (var k = 0; k < rowCandidates.length; k++) {
        var rowCandidate = rowCandidates[k];
        if (rowCandidate === labels[j] || knownFields.indexOf(rowCandidate) >= 0) continue;
        var rowText = nodeText(rowCandidate);
        var role = rowCandidate.getAttribute('role') || '';
        var placeholder = rowCandidate.getAttribute('placeholder') || '';
        if (role === 'combobox' || /请选择|省.{0,4}市|地区|区域/.test(rowText + ' ' + placeholder)) return rowCandidate;
      }
    }
    return null;
  }

  function logRegionDiagnostics(root) {
    var knownFields = [findField('name'), findField('phone'), findField('detail')];
    var controls = visibleAll('input, button, [role], [aria-haspopup], [tabindex], select', root);
    var logged = 0;
    for (var i = 0; i < controls.length && logged < 12; i++) {
      var el = controls[i];
      if (knownFields.indexOf(el) >= 0) continue;
      var description = [
        'tag=' + el.tagName,
        'id=' + (el.id || '-'),
        'name=' + (el.getAttribute('name') || '-'),
        'role=' + (el.getAttribute('role') || '-'),
        'placeholder=' + (el.getAttribute('placeholder') || '-'),
        'aria=' + (el.getAttribute('aria-label') || '-'),
        'class=' + String(el.className || '-').slice(0, 120)
      ].join(',');
      log('REGION_CONTROL', description);
      logged++;
    }
    if (!logged) log('REGION_CONTROL', 'none');
  }

  async function fillRegion() {
    var root = formRoot || document;
    var currentText = nodeText(root);
    if (currentText.indexOf(target.province) >= 0 && (!target.area || currentText.indexOf(target.area) >= 0)) {
      log('REGION_ALREADY_SET');
      return true;
    }

    var selects = visibleAll('select', root);
    if (selects.length >= 2) {
      var nativeOk = setNativeSelect(selects[0], target.province);
      await sleep(200);
      if (selects[1]) nativeOk = setNativeSelect(selects[1], target.city) && nativeOk;
      await sleep(200);
      if (selects[2] && target.area) nativeOk = setNativeSelect(selects[2], target.area) && nativeOk;
      if (nativeOk) {
        log('REGION_NATIVE_OK');
        return true;
      }
    }

    var trigger = firstVisible([
      '.cndzk-entrance-division-header-click', '.cndzk-entrance-division',
      '[class*="division"][class*="header"]', '[class*="region"] [role="combobox"]',
      '[class*="Region"] [role="combobox"]', '[class*="area"] [role="combobox"]',
      '[class*="cascader"] input', '[class*="Cascader"] input',
      'input[placeholder*="省市区"]', 'input[placeholder*="所在地区"]',
      'input[placeholder*="选择地区"]'
    ], root);

    if (!trigger) trigger = findSemanticRegionTrigger(root);

    if (!trigger) {
      logRegionDiagnostics(root);
      log('REGION_TRIGGER_MISSING');
      return false;
    }

    trigger.click();
    await sleep(250);
    var provinceOk = await chooseRegionOption(target.province, 5000);
    if (!provinceOk) return false;

    var municipalities = ['北京', '天津', '上海', '重庆'];
    var isMunicipality = municipalities.some(function(name) { return normalizeRegion(target.province).indexOf(name) === 0; });
    var cityOk = await chooseRegionOption(target.city, isMunicipality ? 1200 : 4000);
    if (!cityOk && !isMunicipality) return false;

    var areaOk = await chooseRegionOption(target.area, 5000);
    if (!areaOk && target.area) return false;
    // i.taobao.com 新版地址弹窗增加了街道第四级。
    if (target.street && location.hostname === 'i.taobao.com') {
      var streetOk = await chooseRegionOption(target.street, 5000);
      if (!streetOk) return false;
      log('REGION_STREET_OK');
    }
    log('REGION_CASCADE_OK');
    return true;
  }

  async function checkDefaultAddress() {
    var root = formRoot || document;
    var rows = visibleAll('.check-default, [class*="default"], [class*="Default"], label', root);
    var defaultRow = null;
    for (var i = 0; i < rows.length; i++) {
      if (/设置为默认收货地址|设为默认地址|默认地址/.test(nodeText(rows[i]))) {
        defaultRow = rows[i];
        break;
      }
    }
    if (!defaultRow) {
      log('DEFAULT_CONTROL_MISSING');
      return false;
    }

    var input = defaultRow.querySelector('input[type="checkbox"], input[type="radio"]')
      || root.querySelector('.check-default input[type="checkbox"], .check-default input[type="radio"]');
    var control = defaultRow.querySelector('[role="checkbox"], [role="radio"], .next-checkbox, .next-radio, .next-checkbox-wrapper, .next-radio-wrapper')
      || defaultRow;

    function isChecked() {
      if (input && input.checked) return true;
      if (input && input.getAttribute('aria-checked') === 'true') return true;
      if (control && control.getAttribute('aria-checked') === 'true') return true;
      return !!defaultRow.querySelector('[aria-checked="true"], .next-checkbox.checked, .next-radio.checked, .next-checked');
    }

    if (isChecked()) {
      log('DEFAULT_ALREADY_CHECKED');
      return true;
    }

    // Fusion Next 的原生 input 通常不可见，但直接 click 仍会触发 React onChange。
    (input || control).click();
    for (var checkTry = 0; checkTry < 8; checkTry++) {
      await sleep(100);
      if (isChecked()) {
        log('DEFAULT_CHECKED');
        return true;
      }
    }
    log('DEFAULT_UNCONFIRMED');
    return false;
  }

  function findSaveButton() {
    var root = formRoot || document;
    var button = findButtonByText(/^(保存|提交|确认保存|确定)$/, root);
    if (button) return button;
    return firstVisible([
      '.next-dialog-footer .next-btn-primary', '.next-overlay-wrapper .next-btn-primary',
      '[class*="dialog"] [class*="primary"]', '[class*="Dialog"] [class*="primary"]',
      'button[type="submit"]'
    ], root);
  }

  async function trySmartPaste() {
    // 智能粘贴区可能不在字段 form 内，因此最末级始终允许回退到整页搜索。
    var root = formRoot || document;
    var smartTextarea = firstVisible([
      'textarea[placeholder*="粘贴文本到此处"]',
      'textarea[placeholder*="自动识别收货信息"]',
      'textarea[placeholder*="智能识别"]'
    ], root);
    var recognizeButton = findButtonByText(/^粘贴并识别$|^智能识别$/, root);
    if (!smartTextarea) {
      smartTextarea = firstVisible([
        'textarea[placeholder*="粘贴文本到此处"]',
        'textarea[placeholder*="自动识别收货信息"]',
        'textarea[placeholder*="智能识别"]'
      ], document);
    }
    if (!recognizeButton) recognizeButton = findButtonByText(/^粘贴并识别$|^智能识别$/, document);
    if (!smartTextarea || !recognizeButton) {
      log('SMART_PASTE_MISSING', 'textarea=' + !!smartTextarea + ',button=' + !!recognizeButton);
      return false;
    }

    var smartText = [target.name, target.phone, target.fullAddress].filter(Boolean).join('，');
    if (!setNativeValue(smartTextarea, smartText)) {
      log('SMART_PASTE_VALUE_REJECTED');
      return false;
    }
    await sleep(200);
    recognizeButton.click();
    log('SMART_PASTE_CLICKED');

    for (var i = 0; i < 20; i++) {
      await sleep(200);
      formRoot = getFormRoot() || formRoot;
      var formText = nodeText(formRoot);
      var provinceOk = !target.province || formText.indexOf(target.province) >= 0;
      var areaOk = !target.area || formText.indexOf(target.area) >= 0;
      var nameEl = findField('name');
      var phoneEl = findField('phone');
      if (provinceOk && areaOk && nameEl && phoneEl && String(nameEl.value || '').length > 0 && String(phoneEl.value || '').length > 0) {
        log('SMART_PASTE_OK');
        return true;
      }
    }
    log('SMART_PASTE_UNCONFIRMED');
    return false;
  }

  function explicitSuccessVisible() {
    if (!saveClicked) return false;
    var notices = visibleAll('[role="alert"], .next-message, .next-feedback, [class*="toast"], [class*="Toast"], [class*="message"], [class*="Message"]', document);
    for (var i = 0; i < notices.length; i++) {
      var text = nodeText(notices[i]);
      if (/((保存|新增|添加|修改).{0,8}成功)|操作成功/.test(text)) return true;
    }
    return false;
  }

  var rowActionPattern = /^(修改|删除|设为默认|设置默认|设为默认地址|设为默认收货地址|取消默认|置顶|取消置顶)$/;

  var normalizeAddressForMatch = ${normalizeTaobaoAddressForMatch.toString()};
  var addressDetailMatches = ${taobaoAddressDetailMatches.toString()
    .replaceAll('normalizeTaobaoAddressForMatch', 'normalizeAddressForMatch')};

  function actionOwner(el) {
    if (!el) return null;
    var interactive = el.closest && el.closest('button, a, [role="button"]');
    return interactive || el;
  }

  function getRowActions(root) {
    var nodes = visibleAll('button, a, span, [role="button"]', root);
    var owners = [];
    for (var i = 0; i < nodes.length; i++) {
      if (!rowActionPattern.test(nodeText(nodes[i]))) continue;
      var owner = actionOwner(nodes[i]);
      if (!owner || owners.indexOf(owner) >= 0) continue;
      var nestedDuplicate = false;
      for (var ownerIndex = 0; ownerIndex < owners.length; ownerIndex++) {
        var existingOwner = owners[ownerIndex];
        if (nodeText(existingOwner) !== nodeText(owner)) continue;
        if (existingOwner.contains(owner)) {
          owners[ownerIndex] = owner;
          nestedDuplicate = true;
          break;
        }
        if (owner.contains(existingOwner)) {
          nestedDuplicate = true;
          break;
        }
      }
      if (!nestedDuplicate) owners.push(owner);
    }
    return owners;
  }

  function getRowAction(root, pattern) {
    var actions = getRowActions(root);
    for (var i = 0; i < actions.length; i++) {
      if (pattern.test(nodeText(actions[i]))) return actions[i];
    }
    return null;
  }

  function matchesAddressTarget(row, addressTarget) {
    if (!row || row === document.body || (formRoot && (row === formRoot || formRoot.contains(row) || row.contains(formRoot)))) return false;
    var text = nodeText(row);
    if (!text || text.length > 700) return false;

    var phoneDigits = String(addressTarget.phone || '').replace(/\\D/g, '').slice(-11);
    var rowDigits = text.replace(/\\D/g, '');
    var detailOk = addressDetailMatches(text, addressTarget.detail);
    var nameOk = !!addressTarget.name && text.indexOf(addressTarget.name) >= 0;
    var phoneOk = !!phoneDigits && rowDigits.indexOf(phoneDigits) >= 0;
    var regionOk = !!addressTarget.area && text.indexOf(addressTarget.area) >= 0;
    var locationOk = addressTarget.detail ? detailOk : regionOk;
    return nameOk && phoneOk && locationOk;
  }

  function matchesTargetAddressRow(row) {
    return matchesAddressTarget(row, target);
  }

  function matchesProtectedAddressRow(row) {
    for (var i = 0; i < protectedTargets.length; i++) {
      if (matchesAddressTarget(row, protectedTargets[i])) return true;
    }
    return false;
  }

  function collectManageableAddressRows() {
    var rows = [];

    function collectFromCandidate(candidate, maxDepth) {
      if (!candidate || candidate === document.body) return;
      var current = candidate;
      for (var depth = 0; depth < maxDepth && current && current !== document.body; depth++) {
        var actions = getRowActions(current);
        var text = nodeText(current);
        var hasDelete = actions.some(function(action) { return /^删除$/.test(nodeText(action)); });
        if (text && text.length <= 700 && actions.length >= 2 && actions.length <= 6 && hasDelete) {
          if (rows.indexOf(current) < 0) rows.push(current);
          return;
        }
        current = current.parentElement;
      }
    }

    // 地址较多时，全页遍历每一个 span 并逐层回溯会反复触发布局计算。
    // 优先从表格行和新版地址卡片的结构节点开始，只收集可管理的地址行。
    var structuralSelector = [
      '#addressCard tr', '#addressCard [role="row"]',
      '#addressCard [class*="listItem"]', '#addressCard [class*="addressContent"]',
      '[class*="addressList"] tr', '[class*="addressList"] [role="row"]',
      '[class*="address-list"] tr', '[class*="address-list"] [role="row"]',
      'table tr', '[role="row"]'
    ].join(',');
    var structuralRows = [];
    try { structuralRows = Array.prototype.slice.call(document.querySelectorAll(structuralSelector)); } catch (e) {}
    for (var structuralIndex = 0; structuralIndex < structuralRows.length; structuralIndex++) {
      collectFromCandidate(structuralRows[structuralIndex], 5);
    }
    if (rows.length) return rows;

    // 灰度页面结构不匹配时再走语义兜底。只扫描交互元素和明确的删除控件，
    // 不扫描全页普通 span，避免地址数量增加后出现平方级耗时。
    var actionNodes = visibleAll('button, a, [role="button"], .delete, [class*="delete"]', document);
    for (var i = 0; i < actionNodes.length; i++) {
      if (!rowActionPattern.test(nodeText(actionNodes[i]))) continue;
      collectFromCandidate(actionOwner(actionNodes[i]), 8);
    }

    return rows;
  }

  function collectAddressRows() {
    var manageableRows = collectManageableAddressRows();
    var rows = [];
    for (var i = 0; i < manageableRows.length; i++) {
      if (matchesTargetAddressRow(manageableRows[i])) rows.push(manageableRows[i]);
    }
    return rows;
  }

  function findTargetAddressOutsideForm() {
    var rows = collectAddressRows();
    if (!rows.length) return null;
    log('EXISTING_ROW_MATCHED', 'count=' + rows.length);
    return rows[0];
  }

  function targetAddressVisibleOutsideForm() {
    return !!findTargetAddressOutsideForm();
  }

  function cleanupRowIsProtected(row) {
    return matchesTargetAddressRow(row) ||
      matchesProtectedAddressRow(row) ||
      !!getRowAction(row, /^取消默认$/) ||
      !!getRowAction(row, /^取消置顶$/);
  }

  function findDeleteConfirmButton() {
    var dialogs = visibleAll('[role="dialog"], .next-dialog, [class*="Dialog"], [class*="dialog"], [class*="Modal"], [class*="modal"]', document);
    for (var i = 0; i < dialogs.length; i++) {
      var dialogText = nodeText(dialogs[i]);
      if (!/删除|移除/.test(dialogText)) continue;
      var button = findButtonByText(/^(确定|确认|删除|确认删除)$/, dialogs[i]);
      if (button) return button;
    }
    return null;
  }

  async function cleanupHistoricalAddresses(reservedSlots) {
    var desiredMax = Math.max(0, addressRollingLimit - Math.max(0, Number(reservedSlots) || 0));
    var rows = collectManageableAddressRows();
    if (rows.length <= desiredMax) {
      log('CLEANUP_SKIPPED', 'count=' + rows.length + ',limit=' + desiredMax);
      return 0;
    }

    var deleteGoal = Math.min(addressCleanupBatch, rows.length - desiredMax);
    var deleted = 0;
    log('CLEANUP_START', 'count=' + rows.length + ',goal=' + deleteGoal + ',limit=' + desiredMax);

    while (deleted < deleteGoal) {
      rows = collectManageableAddressRows();
      if (rows.length <= desiredMax) break;

      var candidate = null;
      var deleteButton = null;
      for (var rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
        var row = rows[rowIndex];
        if (cleanupRowIsProtected(row)) continue;
        var rowDeleteButton = getRowAction(row, /^删除$/);
        if (!rowDeleteButton) continue;
        candidate = row;
        deleteButton = rowDeleteButton;
        break;
      }

      if (!candidate || !deleteButton) {
        log('CLEANUP_NO_CANDIDATE', 'count=' + rows.length + ',deleted=' + deleted);
        break;
      }

      var beforeCount = rows.length;
      deleteButton.click();
      log('CLEANUP_DELETE_CLICKED', 'attempt=' + (deleted + 1) + ',count=' + beforeCount);

      var confirmClicked = false;
      var deleteConfirmed = false;
      for (var waitTry = 0; waitTry < 40; waitTry++) {
        await sleep(150);
        if (!confirmClicked) {
          var confirmButton = findDeleteConfirmButton();
          if (confirmButton) {
            confirmButton.click();
            confirmClicked = true;
            log('CLEANUP_CONFIRM_CLICKED', 'attempt=' + (deleted + 1));
          }
        }
        var currentRows = collectManageableAddressRows();
        if (currentRows.length < beforeCount) {
          deleteConfirmed = true;
          break;
        }
        var issue = detectBlockingIssue();
        if (issue) break;
      }

      if (!deleteConfirmed) {
        log('CLEANUP_DELETE_UNCONFIRMED', 'attempt=' + (deleted + 1));
        break;
      }

      deleted++;
      log('CLEANUP_DELETE_CONFIRMED', 'deleted=' + deleted);
      await sleep(350);
    }

    log('CLEANUP_DONE', 'deleted=' + deleted + ',remaining=' + collectManageableAddressRows().length);
    return deleted;
  }

  async function ensureExistingAddressDefault(candidate) {
    var row = candidate;
    if (!matchesTargetAddressRow(row)) {
      log('EXISTING_ROW_SCOPE_INVALID');
      return false;
    }

    if (getRowAction(row, /^取消默认$/)) {
      log('EXISTING_ADDRESS_ALREADY_DEFAULT');
      return true;
    }

    var setDefaultButton = getRowAction(row, /^(设为默认|设置默认|设为默认地址|设为默认收货地址)$/);
    if (!setDefaultButton) {
      log('EXISTING_DEFAULT_ACTION_MISSING');
      return false;
    }

    setDefaultButton.click();
    log('EXISTING_DEFAULT_CLICKED');
    for (var checkTry = 0; checkTry < 20; checkTry++) {
      await sleep(150);
      var refreshedRow = findTargetAddressOutsideForm();
      if (refreshedRow && getRowAction(refreshedRow, /^取消默认$/)) {
        log('EXISTING_DEFAULT_CONFIRMED');
        return true;
      }
    }
    log('EXISTING_DEFAULT_UNCONFIRMED');
    return false;
  }

  function clickSecondaryConfirm() {
    var dialogs = visibleAll('[role="dialog"], .next-dialog, [class*="Dialog"], [class*="dialog"], [class*="Modal"], [class*="modal"]', document);
    for (var i = 0; i < dialogs.length; i++) {
      var dialog = dialogs[i];
      if (formRoot && (dialog === formRoot || dialog.contains(formRoot))) continue;
      var text = nodeText(dialog);
      if (!/确认|确定|街道|地址/.test(text)) continue;
      var button = findButtonByText(/^(确认|确定|继续保存)$/, dialog);
      if (button) {
        button.click();
        log('SECONDARY_CONFIRM_CLICKED');
        return true;
      }
    }
    return false;
  }

  log('START', location.host + location.pathname);

  var initialIssue = detectBlockingIssue();
  if (initialIssue) return finish(initialIssue, 'page_blocked');
  var existingAddress = findTargetAddressOutsideForm();
  if (existingAddress) {
    try { await cleanupHistoricalAddresses(0); } catch (cleanupError) { log('CLEANUP_ERROR', cleanupError && cleanupError.message ? cleanupError.message : 'unknown'); }
    existingAddress = findTargetAddressOutsideForm();
    var existingDefaultOk = await ensureExistingAddressDefault(existingAddress);
    return finish(existingDefaultOk ? 'success' : 'default_unconfirmed', existingDefaultOk ? 'existing_address_default' : 'existing_address_not_default');
  }

  try { await cleanupHistoricalAddresses(1); } catch (cleanupError) { log('CLEANUP_ERROR', cleanupError && cleanupError.message ? cleanupError.message : 'unknown'); }

  var addButton = await waitForDom(findAddButton, 30000);
  if (!addButton) {
    var addIssue = detectBlockingIssue();
    return addIssue
      ? finish(addIssue, 'waiting_add_button')
      : finish('no_button', 'add_button_not_found');
  }

  addButton.click();
  log('ADD_BUTTON_CLICKED');

  formRoot = await waitForDom(getFormRoot, 30000);
  if (!formRoot) {
    var formIssue = detectBlockingIssue();
    return formIssue
      ? finish(formIssue, 'waiting_form')
      : finish('no_form', 'address_form_not_found');
  }
  log('FORM_READY');

  // 新版页面优先使用淘宝自带的智能地址识别，识别失败再回退到级联选择。
  var smartPasteOk = await trySmartPaste();
  var regionOk = smartPasteOk || await fillRegion();
  if (!regionOk) return finish('no_region', 'region_selector_failed');

  // 省市区变化可能触发 React 重绘，因此在级联选择后重新获取并填写字段。
  formRoot = getFormRoot() || formRoot;
  var nameEl = findField('name');
  var phoneEl = findField('phone');
  var detailEl = findField('detail');
  if (!nameEl || !phoneEl || !detailEl) return finish('no_form', 'fields_missing_after_region');

  var nameOk = setNativeValue(nameEl, target.name);
  var phoneOk = setNativeValue(phoneEl, target.phone);
  var detailOk = setNativeValue(detailEl, target.detail);
  if (!nameOk || !phoneOk || !detailOk) return finish('validation_failed', 'field_value_rejected');
  log('FIELDS_FILLED');
  var defaultOk = await checkDefaultAddress();
  if (!defaultOk) return finish('default_unconfirmed', 'default_checkbox_failed');
  await sleep(250);

  var saveButton = findSaveButton();
  if (!saveButton) return finish('no_save_button', 'save_button_not_found');
  saveClicked = true;
  saveButton.click();
  log('SAVE_CLICKED');

  for (var resultTry = 0; resultTry < 50; resultTry++) {
    if (explicitSuccessVisible()) return finish('success', 'success_notice');
    clickSecondaryConfirm();
    if (resultTry > 3 && targetAddressVisibleOutsideForm()) return finish('success', 'address_list_verified');

    var currentIssue = detectBlockingIssue();
    if (currentIssue) return finish(currentIssue, 'after_save');

    var bodyText = nodeText(document.body);
    if (resultTry > 5 && /请输入|请选择|格式不正确|地址信息不完整|手机号格式/.test(bodyText) && isVisible(formRoot)) {
      return finish('validation_failed', 'page_validation_message');
    }
    await sleep(400);
  }

  return finish('save_unconfirmed', 'no_success_evidence');
})().catch(function(error) {
  window.__tbAddrResult = 'script_error';
  window.__tbAddrResultDetail = error && error.message ? error.message : String(error);
  console.log('[AddressAutoFill][TB] RESULT script_error');
  return 'script_error';
})
`
}

const TAOBAO_TERMINAL_FAILURE_RESULTS = [
  'no_button',
  'no_form',
  'no_region',
  'no_save_button',
  'validation_failed',
  'default_unconfirmed',
  'save_unconfirmed',
  'script_error',
  'load_failed'
]

module.exports = {
  buildTaobaoAddressManagerScript,
  normalizeTaobaoAddressForMatch,
  taobaoAddressDetailMatches,
  TAOBAO_TERMINAL_FAILURE_RESULTS
}
