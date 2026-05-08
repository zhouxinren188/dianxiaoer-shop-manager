/**
 * cef-host.js - CEF 宿主进程
 *
 * 在独立 Node.js 进程中加载 libcef.dll，初始化 CEF，
 * 创建浏览器窗口并嵌入到 Electron 窗口的 HWND 中。
 * 通过 stdin/stdout JSON 行协议与 Electron 主进程通信。
 *
 * 技术要点（经过测试验证）：
 * 1. koffi.as(buf, typed_ptr) 会对 Buffer 做 decode/re-encode 拷贝，损坏数据
 *    → 解决：所有 CEF 函数的 struct 指针参数用 void* 传递
 * 2. koffi.decode/encode 会破坏 cef_string_t 的指针值
 *    → 解决：用独立 Buffer + cef_string_utf16_set + Buffer.copy 写入字符串字段
 * 3. CEF ICU 数据需要在 libcef.dll 所在目录查找
 *    → 解决：部署时将 Resources 文件复制到 Release 目录
 * 4. CEF GPU 进程在某些系统上会崩溃
 *    → 解决：通过命令行传递 --disable-gpu --in-process-gpu
 * 5. CEF 147+ 要求在 cef_initialize 之前调用 cef_api_hash 配置 API 版本
 *    → 解决：调用 cef_api_hash(CEF_API_VERSION, 0)，否则 CToCpp 桥接层报 -1
 * 6. cef_browser_host_create_browser 需要 CEF 上下文已初始化
 *    → 解决：提供 cef_app_t + cef_browser_process_handler_t，在 on_context_initialized 后创建浏览器
 * 7. bootstrap.exe 需要 --bootstrap-module-name=libcef 才能加载 libcef.dll
 *    → 解决：通过 cef-embed.js spawn 参数传递
 *
 * 用法: node cef-host.js --hwnd=XXXXX --url=... --cef-dir=...
 */

const koffi = require('koffi')
const path = require('path')
const fs = require('fs')

// ========== 关键环境变量（备用）==========
if (!process.env.CEF_BOOTSTRAP_MODULE_NAME) {
  process.env.CEF_BOOTSTRAP_MODULE_NAME = 'libcef'
}

// ========== 命令行参数解析 ==========
const argv = {}
for (const arg of process.argv.slice(2)) {
  const idx = arg.indexOf('=')
  if (idx > 0) {
    argv[arg.substring(2, idx)] = arg.substring(idx + 1)
  }
}

const PARENT_HWND = parseInt(argv.hwnd || '0')
const START_URL = argv.url || 'about:blank'
const CEF_DIR = argv['cef-dir'] || ''
const CACHE_PATH = argv.cache || ''
const USER_AGENT = argv['user-agent'] || ''
const LOCALE = argv.locale || 'zh-CN'

if (!CEF_DIR) { sendError('Missing --cef-dir'); process.exit(1) }

// ========== CEF 路径 ==========
const CEF_RELEASE_DIR = path.join(CEF_DIR, 'Release')
// 使用 cef-subprocess.exe 包装器替代 bootstrap.exe
// cef-subprocess.exe 会自动注入 --bootstrap-module-name=libcef 再调用 bootstrap.exe
// 这解决了 CEF 不转发 --bootstrap-module-name 给子进程导致 "Missing module name" 的问题
const CEF_SUBPROCESS = fs.existsSync(path.join(CEF_RELEASE_DIR, 'cef-subprocess.exe'))
  ? path.join(CEF_RELEASE_DIR, 'cef-subprocess.exe')
  : path.join(CEF_RELEASE_DIR, 'bootstrap.exe')
const LIBCEF_PATH = path.join(CEF_RELEASE_DIR, 'libcef.dll')

if (!fs.existsSync(LIBCEF_PATH)) { sendError('libcef.dll not found: ' + LIBCEF_PATH); process.exit(1) }

console.error('[CEF-Host] libcef.dll:', LIBCEF_PATH)
console.error('[CEF-Host] subprocess:', CEF_SUBPROCESS)
console.error('[CEF-Host] parent HWND: 0x' + PARENT_HWND.toString(16))
console.error('[CEF-Host] URL:', START_URL)

// ========== IPC 通信 ==========
// ★ 不使用 Node.js readline，改用 Windows API 非阻塞读取 stdin
// 原因：紧密消息循环中 Node.js 事件循环不运行，readline 无法触发
function sendIpc(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function sendError(text) { sendIpc({ type: 'error', message: text }) }
function sendEvent(event, params) { sendIpc({ type: 'event', event, params }) }

// ========== koffi 回调函数原型定义 ==========
const voidSelfProto = koffi.proto('void', ['void*'])
const intSelfProto = koffi.proto('int', ['void*'])
const getHandlerSelfProto = koffi.proto('void*', ['void*'])
const onAfterCreatedProto = koffi.proto('void', ['void*', 'void*'])
const onBeforeCloseProto = koffi.proto('void', ['void*', 'void*'])
const onLoadEndProto = koffi.proto('void', ['void*', 'void*', 'void*', 'int'])
const onAddressChangeProto = koffi.proto('void', ['void*', 'void*', 'void*', 'void*'])
const onContextInitializedProto = koffi.proto('void', ['void*'])

// ========== CEF API 版本 ==========
// CEF 147+ 要求在 cef_initialize 之前调用 cef_api_hash 配置 API 版本
// 否则 CToCpp 桥接层无法确定结构体版本，返回 "invalid version -1"
const CEF_API_VERSION = 14700
// Windows 平台预期哈希: "1cf33dbf355efffcd993ab4d2ea391e6631f95f2"

// ========== 加载 libcef.dll ==========
console.error('[CEF-Host] Loading libcef.dll...')
const libcef = koffi.load(LIBCEF_PATH)

// 所有 CEF 结构体指针参数用 void* 传递，避免 koffi 的 decode/re-encode 问题
const cef_execute_process = libcef.func('cef_execute_process', 'int', ['void*', 'void*', 'void*'])
const cef_initialize = libcef.func('cef_initialize', 'int', ['void*', 'void*', 'void*', 'void*'])
const cef_shutdown = libcef.func('cef_shutdown', 'void', [])
const cef_do_message_loop_work = libcef.func('cef_do_message_loop_work', 'void', [])
const cef_run_message_loop = libcef.func('cef_run_message_loop', 'void', [])
const cef_quit_message_loop = libcef.func('cef_quit_message_loop', 'void', [])
// cef_post_delayed_task(TID_UI=0, task, delay_ms) — 在 CEF UI 线程上调度任务
const cef_post_delayed_task = libcef.func('cef_post_delayed_task', 'void', ['int', 'void*', 'int64'])
const cef_string_utf16_set = libcef.func('cef_string_utf16_set', 'int', [
  koffi.pointer(koffi.types.char16), 'size_t', 'void*', 'int'
])
// ★ 关键：cef_api_hash 必须在 cef_initialize 之前调用，配置 API 版本
// version=14700, entry=0 返回平台哈希，同时配置内部 API 版本
const cef_api_hash = libcef.func('cef_api_hash', 'str', ['int', 'int'])
const cef_api_version_func = libcef.func('cef_api_version', 'int', [])
const cef_browser_host_create_browser = libcef.func('cef_browser_host_create_browser', 'int', [
  'void*', 'void*', 'void*', 'void*', 'void*', 'void*'
])
const cef_browser_host_create_browser_sync = libcef.func('cef_browser_host_create_browser_sync', 'void*', [
  'void*', 'void*', 'void*', 'void*', 'void*', 'void*'
])

// ========== 原生内存分配 ==========
// koffi 回调返回 void* 时无法正确传递 Buffer 或 koffi.as() 指针对象
// 因此需要用 malloc 分配原生内存，用 memcpy 拷贝数据，返回原生指针
const ucrt = koffi.load('ucrtbase.dll')
const native_malloc = ucrt.func('malloc', 'void*', ['size_t'])
const native_free = ucrt.func('free', 'void', ['void*'])
const native_memcpy = ucrt.func('memcpy', 'void*', ['void*', 'void*', 'size_t'])

// ========== 全局引用（防止 GC） ==========
const _gcRefs = []

// ========== Windows 原生消息泵 ==========
// ★ 关键发现：CEF external_message_pump 模式下，cef_do_message_loop_work() 只处理 CEF 任务，
// 不处理 Windows 原生消息（WM_PAINT, WM_SIZE, WM_TIMER 等）。
// 应用必须自己用 PeekMessage/TranslateMessage/DispatchMessage 处理 Windows 消息，
// 否则 CEF 窗口会因消息饥饿而被 Windows 标记为"未响应"。
const user32 = koffi.load('user32.dll')
const peekMessageW = user32.func('PeekMessageW', 'int', ['void*', 'void*', 'uint32', 'uint32', 'uint32'])
const translateMessage = user32.func('TranslateMessage', 'int', ['void*'])
const dispatchMessageW = user32.func('DispatchMessageW', 'int64', ['void*'])

const PM_REMOVE = 1
const WM_QUIT = 0x0012

// 预分配 MSG 缓冲区（x64 Windows 上 sizeof(MSG) = 48 字节，分配 64 字节留余量）
const _msgBuf = Buffer.alloc(64, 0)
_gcRefs.push(_msgBuf)

/**
 * 泵送 Windows 原生消息。
 * 必须在每次 cef_do_message_loop_work() 之前调用，确保 CEF 窗口响应 WM_PAINT 等消息。
 */
function pumpWindowsMessages() {
  const msgPtr = koffi.as(_msgBuf, 'void*')
  while (peekMessageW(msgPtr, null, 0, 0, PM_REMOVE)) {
    // 检查 WM_QUIT
    if (_msgBuf.readUInt32LE(8) === WM_QUIT) {
      console.error('[CEF-Host] WM_QUIT received, exiting...')
      try { if (cefInitialized) cef_shutdown() } catch (e) {}
      process.exit(0)
    }
    translateMessage(msgPtr)
    dispatchMessageW(msgPtr)
  }
}

// ========== kernel32: 非阻塞 stdin 读取 + Sleep ==========
// 紧密轮询循环中 Node.js 事件循环不运行，需要用 Windows API 直接读取 stdin
const kernel32 = koffi.load('kernel32.dll')
const getStdHandle = kernel32.func('GetStdHandle', 'void*', ['uint32'])
const peekNamedPipe = kernel32.func('PeekNamedPipe', 'int', ['void*', 'void*', 'uint32', 'void*', 'void*', 'void*'])
const readFileFunc = kernel32.func('ReadFile', 'int', ['void*', 'void*', 'uint32', 'void*', 'void*'])
const sleepMs = kernel32.func('Sleep', 'void', ['uint32'])

const STD_INPUT_HANDLE = 0xFFFFFFF6  // (DWORD)-10
const _hStdin = getStdHandle(STD_INPUT_HANDLE)
let _stdinLineBuf = ''

/**
 * 非阻塞读取 stdin 并解析 IPC JSON 行。
 * 在紧密轮询循环的每次迭代中调用。
 */
function readStdinNonBlocking() {
  try {
    const totalBytesAvailBuf = Buffer.alloc(4, 0)
    const peekResult = peekNamedPipe(_hStdin, null, 0, null, totalBytesAvailBuf, null)
    if (!peekResult) return
    const totalBytesAvail = totalBytesAvailBuf.readUInt32LE(0)
    if (totalBytesAvail === 0) return

    const readBuf = Buffer.alloc(totalBytesAvail, 0)
    const bytesReadBuf = Buffer.alloc(4, 0)
    const readResult = readFileFunc(_hStdin, readBuf, totalBytesAvail, bytesReadBuf, null)
    if (!readResult) return
    const bytesRead = bytesReadBuf.readUInt32LE(0)
    if (bytesRead === 0) return

    _stdinLineBuf += readBuf.toString('utf8', 0, bytesRead)

    let nlIdx
    while ((nlIdx = _stdinLineBuf.indexOf('\n')) !== -1) {
      const line = _stdinLineBuf.substring(0, nlIdx).trim()
      _stdinLineBuf = _stdinLineBuf.substring(nlIdx + 1)
      if (line) {
        try { handleIpcMessage(JSON.parse(line)) }
        catch (e) { console.error('[CEF-Host] IPC parse error:', e.message) }
      }
    }
  } catch (e) {
    // stdin 读取失败不中断主循环
  }
}

/**
 * 将 Buffer 数据分配到原生内存，返回稳定的原生 void* 指针。
 * 这样从 koffi 回调中返回的指针才能被 CEF CToCpp 桥接正确读取。
 */
function bufferToNativePtr(buf) {
  const nativePtr = native_malloc(buf.length)
  if (!nativePtr) throw new Error('malloc failed for ' + buf.length + ' bytes')
  native_memcpy(nativePtr, koffi.as(buf, 'void*'), buf.length)
  _gcRefs.push(buf, nativePtr)  // 防止 GC，buf 的数据必须保持有效直到 memcpy 完成
  return nativePtr
}

// ========== cef_string_t 辅助函数 ==========

function jsStringToChar16Ptr(jsStr) {
  const buf = Buffer.alloc(jsStr.length * 2 + 2, 0)
  for (let i = 0; i < jsStr.length; i++) buf.writeUInt16LE(jsStr.charCodeAt(i), i * 2)
  const ptr = koffi.as(buf, koffi.pointer(koffi.types.char16))
  _gcRefs.push(buf)
  return { ptr, length: jsStr.length }
}

/**
 * 在独立的 Buffer 上调用 cef_string_utf16_set，
 * 然后用 Buffer.copy() 把 24 字节原始数据拷贝到目标 Buffer 的指定偏移处。
 */
function setCefStringField(targetBuf, offset, jsStr) {
  if (!jsStr) return
  const fieldBuf = Buffer.alloc(24, 0)
  _gcRefs.push(fieldBuf)
  const fieldPtr = koffi.as(fieldBuf, 'void*')
  const { ptr: char16Ptr, length: charLen } = jsStringToChar16Ptr(jsStr)
  const setResult = cef_string_utf16_set(char16Ptr, charLen, fieldPtr, 1)
  if (!setResult) {
    console.error('[CEF-Host] cef_string_utf16_set FAILED for: ' + jsStr.substring(0, 40))
    return
  }
  fieldBuf.copy(targetBuf, offset, 0, 24)
}

// ========== cef_settings_t 偏移量（x64 Windows）==========
const SETTINGS_SIZE = 448
const OFF = {
  size: 0, no_sandbox: 8, browser_subprocess_path: 16, framework_dir_path: 40,
  main_bundle_path: 64, multi_threaded_message_loop: 88, external_message_pump: 92,
  windowless_rendering_enabled: 96, command_line_args_disabled: 100, cache_path: 104,
  root_cache_path: 128, persist_session_cookies: 152, user_agent: 160,
  user_agent_product: 184, locale: 208, log_file: 232, log_severity: 256,
  log_items: 260, javascript_flags: 264, resources_dir_path: 288, locales_dir_path: 312,
  remote_debugging_port: 336, uncaught_exception_stack_size: 340, background_color: 344,
  accept_language_list: 352, cookieable_schemes_list: 376,
  cookieable_schemes_exclude_defaults: 400, chrome_policy_id: 408,
  chrome_app_icon_id: 432, disable_signal_handlers: 436, use_views_default_popup: 440,
}

// ========== cef_window_info_t 偏移量（x64 Windows）==========
const WINDOW_INFO_SIZE = 112
const WOFF = {
  size: 0, ex_style: 8, window_name: 16, style: 40, bounds: 44,
  parent_window: 64, menu: 72, windowless_rendering_enabled: 80,
  shared_texture_enabled: 84, external_begin_frame_enabled: 88,
  window: 96, runtime_style: 104
}

// ========== cef_browser_settings_t 偏移量（CEF 147，x64 Windows）==========
// CEF 147 中旧的 web_security/plugins 等字段已移除，替换为 chrome_status_bubble/chrome_zoom_bubble
const BROWSER_SETTINGS_SIZE = 264
const BOFF = {
  size: 0, windowless_frame_rate: 8, standard_font_family: 16,
  fixed_font_family: 40, serif_font_family: 64, sans_serif_font_family: 88,
  cursive_font_family: 112, fantasy_font_family: 136, default_font_size: 160,
  default_fixed_font_size: 164, minimum_font_size: 168, minimum_logical_font_size: 172,
  default_encoding: 176, remote_fonts: 200, javascript: 204,
  javascript_close_windows: 208, javascript_access_clipboard: 212,
  javascript_dom_paste: 216, image_loading: 220, image_shrink_standalone_to_fit: 224,
  text_area_resize: 228, tab_to_links: 232, local_storage: 236,
  databases_deprecated: 240, webgl: 244, background_color: 248,
  chrome_status_bubble: 252, chrome_zoom_bubble: 256
}

// ========== Win32 常量 ==========
const WS_CHILD = 0x40000000
const WS_CLIPCHILDREN = 0x02000000
const WS_CLIPSIBLINGS = 0x04000000
const WS_VISIBLE = 0x10000000
const CEF_RUNTIME_STYLE_ALLOY = 1

// ========== 状态 ==========
let browserPtr = null
let browserHostPtr = null
let cefInitialized = false
let messageLoopRunning = false

// ========== cef_client_t 创建（Buffer + 函数指针地址写入）==========

function createRefCountedBase(buf, structSize) {
  buf.writeBigUInt64LE(BigInt(structSize), 0)
  const addRefCb = koffi.register(function () {}, koffi.pointer(voidSelfProto))
  const releaseCb = koffi.register(function () { return 1 }, koffi.pointer(intSelfProto))
  const hasOneRefCb = koffi.register(function () { return 1 }, koffi.pointer(intSelfProto))
  const hasAtLeastOneRefCb = koffi.register(function () { return 1 }, koffi.pointer(intSelfProto))
  buf.writeBigUInt64LE(BigInt(koffi.address(addRefCb)), 8)
  buf.writeBigUInt64LE(BigInt(koffi.address(releaseCb)), 16)
  buf.writeBigUInt64LE(BigInt(koffi.address(hasOneRefCb)), 24)
  buf.writeBigUInt64LE(BigInt(koffi.address(hasAtLeastOneRefCb)), 32)
  _gcRefs.push(buf, addRefCb, releaseCb, hasOneRefCb, hasAtLeastOneRefCb)
}

function createCefClient() {
  // cef_client_t: base(40) + 19 function pointers = 192 bytes
  const CLIENT_SIZE = 192
  const buf = Buffer.alloc(CLIENT_SIZE, 0)
  createRefCountedBase(buf, CLIENT_SIZE)

  // 创建各 handler 并分配原生内存（回调返回值必须是原生指针）
  const lifeSpanHandlerPtr = createLifeSpanHandler()
  const loadHandlerPtr = createLoadHandler()
  const displayHandlerPtr = createDisplayHandler()

  // ★ 回调函数返回原生 malloc 指针，koffi 可以正确传递给 CEF
  const getDisplayHandlerCb = koffi.register(function (self) {
    return displayHandlerPtr
  }, koffi.pointer(getHandlerSelfProto))

  const getLifeSpanHandlerCb = koffi.register(function (self) {
    return lifeSpanHandlerPtr
  }, koffi.pointer(getHandlerSelfProto))

  const getLoadHandlerCb = koffi.register(function (self) {
    return loadHandlerPtr
  }, koffi.pointer(getHandlerSelfProto))

  // cef_client_t 函数指针偏移:
  // 40: get_audio_handler, 48: get_command_handler, 56: get_context_menu_handler,
  // 64: get_dialog_handler, 72: get_display_handler, 80: get_download_handler,
  // 88: get_drag_handler, 96: get_find_handler, 104: get_focus_handler,
  // 112: get_frame_handler, 120: get_permission_handler, 128: get_jsdialog_handler,
  // 136: get_keyboard_handler, 144: get_life_span_handler, 152: get_load_handler,
  // 160: get_print_handler, 168: get_render_handler, 176: get_request_handler,
  // 184: on_process_message_received

  buf.writeBigUInt64LE(BigInt(koffi.address(getDisplayHandlerCb)), 72)
  buf.writeBigUInt64LE(BigInt(koffi.address(getLifeSpanHandlerCb)), 144)
  buf.writeBigUInt64LE(BigInt(koffi.address(getLoadHandlerCb)), 152)

  _gcRefs.push(getDisplayHandlerCb, getLifeSpanHandlerCb, getLoadHandlerCb)
  // createCefClient 仍返回 void*，因为它作为参数传给 cef_browser_host_create_browser
  const clientPtr = koffi.as(buf, 'void*')
  _gcRefs.push(buf)
  return clientPtr
}

function createLifeSpanHandler() {
  // base(40) + on_before_popup(8) + on_before_popup_aborted(8) +
  // on_before_dev_tools_popup(8) + on_after_created(8) + do_close(8) + on_before_close(8) = 88
  const SIZE = 88
  const buf = Buffer.alloc(SIZE, 0)
  createRefCountedBase(buf, SIZE)

  const onAfterCreatedCb = koffi.register(function (self, browser) {
    browserPtr = browser
    console.error('[CEF-Host] on_after_created')
    sendEvent('after_created', {})

    // TODO: 通过 browser vtable 获取 cef_browser_host_t（后续实现 navigate/evaluate 时需要）

    sendIpc({ type: 'ready' })
  }, koffi.pointer(onAfterCreatedProto))

  const onBeforeCloseCb = koffi.register(function (self, browser) {
    browserPtr = null
    browserHostPtr = null
    console.error('[CEF-Host] on_before_close')
    sendEvent('before_close', {})
  }, koffi.pointer(onBeforeCloseProto))

  buf.writeBigUInt64LE(BigInt(koffi.address(onAfterCreatedCb)), 64)
  buf.writeBigUInt64LE(BigInt(koffi.address(onBeforeCloseCb)), 80)

  _gcRefs.push(onAfterCreatedCb, onBeforeCloseCb)
  return bufferToNativePtr(buf)  // 原生内存指针，回调返回值必须用原生指针
}

function createLoadHandler() {
  // base(40) + on_loading_state_change(8) + on_load_start(8) + on_load_end(8) + on_load_error(8) = 72
  const SIZE = 72
  const buf = Buffer.alloc(SIZE, 0)
  createRefCountedBase(buf, SIZE)

  const onLoadEndCb = koffi.register(function (self, browser, frame, httpStatusCode) {
    console.error('[CEF-Host] on_load_end status=' + httpStatusCode)
    sendEvent('load_end', { httpStatusCode })
  }, koffi.pointer(onLoadEndProto))

  buf.writeBigUInt64LE(BigInt(koffi.address(onLoadEndCb)), 56)

  _gcRefs.push(onLoadEndCb)
  return bufferToNativePtr(buf)
}

function createDisplayHandler() {
  // CEF 147: base(40) + 13 function pointers = 144
  // 新增了 on_contents_bounds_change(128) 和 get_root_window_screen_rect(136)
  const SIZE = 144
  const buf = Buffer.alloc(SIZE, 0)
  createRefCountedBase(buf, SIZE)

  const onAddressChangeCb = koffi.register(function (self, browser, frame, url) {
    // url 是 cef_string_t*，但 koffi 对 void* 不会自动解码
    sendEvent('address_change', {})
  }, koffi.pointer(onAddressChangeProto))

  buf.writeBigUInt64LE(BigInt(koffi.address(onAddressChangeCb)), 40)

  _gcRefs.push(onAddressChangeCb)
  return bufferToNativePtr(buf)
}

// ========== cef_browser_process_handler_t 创建（96 字节）==========
// base(40) + on_register_custom_preferences(8) + on_context_initialized(8) +
// on_before_child_process_launch(8) + on_already_running_app_relaunch(8) +
// on_schedule_message_pump_work(8) + get_default_client(8) +
// get_default_request_context_handler(8) = 96
function createBrowserProcessHandler() {
  const SIZE = 96
  const buf = Buffer.alloc(SIZE, 0)
  createRefCountedBase(buf, SIZE)

  // on_context_initialized at offset 48
  const onContextInitializedCb = koffi.register(function (self) {
    console.error('[CEF-Host] on_context_initialized - CEF context is ready')
    sendEvent('context_initialized', {})
    // 上下文初始化后创建浏览器
    createBrowser()
  }, koffi.pointer(onContextInitializedProto))

  // on_schedule_message_pump_work at offset 72
  // ★ 紧密轮询循环中已持续泵送，此回调无需额外操作
  const onScheduleMessagePumpWorkCb = koffi.register(function (self, delayMs) {
    // no-op: tight loop already pumps continuously
  }, koffi.pointer(koffi.proto('void', ['void*', 'int64'])))

  buf.writeBigUInt64LE(BigInt(koffi.address(onContextInitializedCb)), 48)
  buf.writeBigUInt64LE(BigInt(koffi.address(onScheduleMessagePumpWorkCb)), 72)

  _gcRefs.push(onContextInitializedCb, onScheduleMessagePumpWorkCb)
  // ★ 用 malloc 分配原生内存并拷贝数据，这样回调返回的指针才能被 CEF 正确读取
  return bufferToNativePtr(buf)
}

// ========== cef_app_t 创建（80 字节）==========
// base(40) + on_before_command_line_processing(8) + on_register_custom_schemes(8) +
// get_resource_bundle_handler(8) + get_browser_process_handler(8) +
// get_render_process_handler(8) = 80
function createCefApp(browserProcessHandlerNativePtr) {
  const SIZE = 80
  const buf = Buffer.alloc(SIZE, 0)
  createRefCountedBase(buf, SIZE)

  // get_browser_process_handler at offset 64
  // ★ 返回原生指针（malloc 分配的），koffi 可以正确传递原生 void*
  const getBrowserProcessHandlerCb = koffi.register(function (self) {
    return browserProcessHandlerNativePtr
  }, koffi.pointer(getHandlerSelfProto))

  buf.writeBigUInt64LE(BigInt(koffi.address(getBrowserProcessHandlerCb)), 64)

  _gcRefs.push(getBrowserProcessHandlerCb)
  // ★ 同样用 malloc 分配原生内存
  return bufferToNativePtr(buf)
}
function initializeCEF() {
  console.error('[CEF-Host] Initializing CEF...')

  // 0. ★ 调用 cef_api_hash 配置 API 版本（必须在所有其他 CEF 函数之前）
  const apiHash = cef_api_hash(CEF_API_VERSION, 0)
  console.error('[CEF-Host] cef_api_hash(' + CEF_API_VERSION + ', 0) = ' + apiHash)
  const expectedHash = '1cf33dbf355efffcd993ab4d2ea391e6631f95f2'
  if (apiHash !== expectedHash) {
    console.error('[CEF-Host] WARNING: API hash mismatch! Expected: ' + expectedHash)
    sendError('CEF API hash mismatch: got ' + apiHash + ', expected ' + expectedHash)
  }

  // 1. cef_main_args_t (8 bytes, HINSTANCE = NULL)
  const mainArgsBuf = Buffer.alloc(8, 0)
  const mainArgsPtr = koffi.as(mainArgsBuf, 'void*')
  _gcRefs.push(mainArgsBuf)

  // 2. cef_execute_process — 使用 NULL app 避免子进程中 CToCpp 崩溃
  const execResult = cef_execute_process(mainArgsPtr, null, null)
  console.error('[CEF-Host] cef_execute_process:', execResult)
  if (execResult >= 0) {
    console.error('[CEF-Host] Subprocess, exiting.')
    process.exit(execResult)
  }

  // 3. 构造 cef_settings_t
  const settingsBuf = Buffer.alloc(SETTINGS_SIZE, 0)

  settingsBuf.writeBigUInt64LE(BigInt(SETTINGS_SIZE), OFF.size)
  settingsBuf.writeInt32LE(1, OFF.no_sandbox)
  settingsBuf.writeInt32LE(0, OFF.multi_threaded_message_loop)
  settingsBuf.writeInt32LE(0, OFF.external_message_pump)  // ★ 0: 让 CEF 自己运行消息循环
  settingsBuf.writeInt32LE(0, OFF.windowless_rendering_enabled)
  settingsBuf.writeInt32LE(0, OFF.command_line_args_disabled)  // 允许 CEF 解析命令行
  settingsBuf.writeInt32LE(0, OFF.persist_session_cookies)
  settingsBuf.writeInt32LE(1, OFF.log_severity)  // LOGSEVERITY_VERBOSE
  settingsBuf.writeInt32LE(0, OFF.log_items)
  settingsBuf.writeInt32LE(0, OFF.remote_debugging_port)
  settingsBuf.writeInt32LE(0, OFF.uncaught_exception_stack_size)
  settingsBuf.writeUInt32LE(0xFFFFFFFF, OFF.background_color)
  settingsBuf.writeInt32LE(0, OFF.chrome_app_icon_id)
  settingsBuf.writeInt32LE(1, OFF.disable_signal_handlers)
  settingsBuf.writeInt32LE(0, OFF.use_views_default_popup)
  settingsBuf.writeInt32LE(0, OFF.cookieable_schemes_exclude_defaults)

  // 设置字符串字段
  setCefStringField(settingsBuf, OFF.browser_subprocess_path, CEF_SUBPROCESS)
  if (CACHE_PATH) setCefStringField(settingsBuf, OFF.cache_path, CACHE_PATH)
  setCefStringField(settingsBuf, OFF.locale, LOCALE)
  setCefStringField(settingsBuf, OFF.accept_language_list, 'zh-CN,zh,en-US,en')
  if (USER_AGENT) setCefStringField(settingsBuf, OFF.user_agent, USER_AGENT)

  const resourcesDir = path.join(CEF_DIR, 'Release')
  setCefStringField(settingsBuf, OFF.resources_dir_path, resourcesDir)
  const localesDir = path.join(CEF_DIR, 'Release', 'locales')
  setCefStringField(settingsBuf, OFF.locales_dir_path, localesDir)

  // 4. 创建 cef_browser_process_handler_t 和 cef_app_t
  //    bufferToNativePtr 已返回原生 void* 指针，可直接传给 FFI 和回调
  const browserProcessHandlerPtr = createBrowserProcessHandler()
  const appPtr = createCefApp(browserProcessHandlerPtr)
  console.error('[CEF-Host] Created cef_app_t and cef_browser_process_handler_t')

  // 5. cef_initialize — 使用 cef_app_t（提供 on_context_initialized 和 get_browser_process_handler）
  const settingsPtr = koffi.as(settingsBuf, 'void*')
  _gcRefs.push(settingsBuf)

  console.error('[CEF-Host] Calling cef_initialize (with cef_app_t)...')

  const initResult = cef_initialize(mainArgsPtr, settingsPtr, appPtr, null)
  console.error('[CEF-Host] cef_initialize result:', initResult)

  if (!initResult) {
    sendError('cef_initialize failed')
    process.exit(1)
  }

  cefInitialized = true
  console.error('[CEF-Host] CEF initialized successfully')
}

// ========== 创建浏览器 ==========
// 由 on_context_initialized 回调触发，或在超时后直接调用
let browserCreated = false
function createBrowser() {
  if (browserCreated) return
  browserCreated = true
  console.error('[CEF-Host] Creating browser...')

  const WS_OVERLAPPEDWINDOW = 0x00CF0000
  const CW_USEDEFAULT = -2147483648

  // 1. 构造 cef_window_info_t
  const windowInfoBuf = Buffer.alloc(WINDOW_INFO_SIZE, 0)
  windowInfoBuf.writeBigUInt64LE(BigInt(WINDOW_INFO_SIZE), WOFF.size)

  if (PARENT_HWND) {
    // SetAsChild 模式：作为子窗口嵌入到父窗口
    windowInfoBuf.writeUInt32LE(WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_VISIBLE, WOFF.style)
    windowInfoBuf.writeInt32LE(0, WOFF.bounds)           // x
    windowInfoBuf.writeInt32LE(0, WOFF.bounds + 4)       // y
    windowInfoBuf.writeInt32LE(800, WOFF.bounds + 8)     // width
    windowInfoBuf.writeInt32LE(600, WOFF.bounds + 12)    // height
    windowInfoBuf.writeBigUInt64LE(BigInt(PARENT_HWND), WOFF.parent_window)
  } else {
    // SetAsPopup 模式：创建独立顶层窗口（测试用）
    windowInfoBuf.writeUInt32LE(WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_VISIBLE, WOFF.style)
    windowInfoBuf.writeInt32LE(CW_USEDEFAULT, WOFF.bounds)
    windowInfoBuf.writeInt32LE(CW_USEDEFAULT, WOFF.bounds + 4)
    windowInfoBuf.writeInt32LE(CW_USEDEFAULT, WOFF.bounds + 8)
    windowInfoBuf.writeInt32LE(CW_USEDEFAULT, WOFF.bounds + 12)
  }
  windowInfoBuf.writeInt32LE(0, WOFF.windowless_rendering_enabled)
  windowInfoBuf.writeInt32LE(CEF_RUNTIME_STYLE_ALLOY, WOFF.runtime_style)

  // 2. 构造 URL cef_string_t
  const urlBuf = Buffer.alloc(24, 0)
  _gcRefs.push(urlBuf)
  const urlFieldPtr = koffi.as(urlBuf, 'void*')
  const { ptr: urlChar16, length: urlLen } = jsStringToChar16Ptr(START_URL)
  cef_string_utf16_set(urlChar16, urlLen, urlFieldPtr, 1)

  // 3. 构造 cef_browser_settings_t（264 字节，CEF 147）
  const browserSettingsBuf = Buffer.alloc(BROWSER_SETTINGS_SIZE, 0)
  browserSettingsBuf.writeBigUInt64LE(BigInt(BROWSER_SETTINGS_SIZE), BOFF.size)
  browserSettingsBuf.writeInt32LE(1, BOFF.javascript)
  browserSettingsBuf.writeInt32LE(1, BOFF.local_storage)
  browserSettingsBuf.writeInt32LE(1, BOFF.webgl)
  browserSettingsBuf.writeInt32LE(1, BOFF.image_loading)

  // 4. 创建 cef_client_t
  const clientPtr = createCefClient()

  // 5. 调用 cef_browser_host_create_browser
  const windowInfoPtr = koffi.as(windowInfoBuf, 'void*')
  const browserSettingsPtr = koffi.as(browserSettingsBuf, 'void*')
  _gcRefs.push(windowInfoBuf, browserSettingsBuf)

  console.error('[CEF-Host] Calling cef_browser_host_create_browser (async)...')
  console.error('[CEF-Host] window_info size:', windowInfoBuf.readBigUInt64LE(0).toString())
  console.error('[CEF-Host] browser_settings size:', browserSettingsBuf.readBigUInt64LE(0).toString())

  const createResult = cef_browser_host_create_browser(
    windowInfoPtr, clientPtr, urlFieldPtr, browserSettingsPtr, null, null
  )

  if (!createResult) {
    console.error('[CEF-Host] Async create_browser returned false, trying sync version...')
    try {
      const syncResult = cef_browser_host_create_browser_sync(
        windowInfoPtr, clientPtr, urlFieldPtr, browserSettingsPtr, null, null
      )
      if (syncResult) {
        browserPtr = syncResult
        console.error('[CEF-Host] Sync browser created successfully')
        sendIpc({ type: 'ready' })
        return
      } else {
        sendError('cef_browser_host_create_browser_sync returned NULL')
        console.error('[CEF-Host] Sync browser creation also failed')
        process.exit(1)
      }
    } catch (e) {
      sendError('Both async and sync browser creation failed: ' + e.message)
      console.error('[CEF-Host] Sync browser creation exception:', e.message)
      process.exit(1)
    }
  }

  console.error('[CEF-Host] Browser creation request submitted (result=' + createResult + ')')
  // ready 信号将在 on_after_created 回调中发送
}

// ========== CEF 消息循环（cef_run_message_loop）==========
// ★ 最终方案：让 CEF 自己运行消息循环。
// 之前的方案（external_message_pump + cef_do_message_loop_work + PeekMessageW）
// 无法保持 CEF 窗口响应，因为无论是 setImmediate 还是紧密 while 循环，
// 都无法像 CEF 内部的 GetMessage/TranslateMessage/DispatchMessage 那样
// 完整处理 Windows 消息。
//
// 现在改用 external_message_pump=0 + cef_run_message_loop()，
// CEF 内部完整运行 Windows 消息循环，窗口自然响应。
// IPC 通过 cef_post_delayed_task 调度 stdin 读取任务实现。

// cef_task_t: base(40) + execute(8) = 48 字节
const CEF_TASK_SIZE = 48
const CEF_TID_UI = 0

/**
 * 创建并调度一个 stdin 读取任务，delay_ms 后在 CEF UI 线程执行。
 * 任务执行时非阻塞读取 stdin，处理 IPC 命令，然后调度下一个任务。
 */
function scheduleStdinTask(delayMs) {
  const taskBuf = Buffer.alloc(CEF_TASK_SIZE, 0)
  createRefCountedBase(taskBuf, CEF_TASK_SIZE)

  const executeCb = koffi.register(function (self) {
    // 非阻塞读取 stdin IPC 命令
    readStdinNonBlocking()
    // 调度下一个 stdin 读取任务（10ms 后）
    scheduleStdinTask(10)
  }, koffi.pointer(voidSelfProto))

  taskBuf.writeBigUInt64LE(BigInt(koffi.address(executeCb)), 40)
  _gcRefs.push(taskBuf, executeCb)

  const taskPtr = bufferToNativePtr(taskBuf)
  cef_post_delayed_task(CEF_TID_UI, taskPtr, BigInt(delayMs))
}

/**
 * 启动 CEF 消息循环。
 * cef_run_message_loop() 会阻塞，CEF 内部完整运行 Windows 消息循环。
 * IPC 命令通过 cef_post_delayed_task 调度的 stdin 读取任务处理。
 */
function runCefMessageLoop() {
  if (messageLoopRunning) return
  messageLoopRunning = true
  console.error('[CEF-Host] Starting CEF message loop (cef_run_message_loop)...')

  // 先暂停 Node.js 对 stdin 的监听，避免与 PeekNamedPipe 冲突
  try { process.stdin.pause() } catch (e) {}

  // 调度第一个 stdin 读取任务（100ms 后执行）
  scheduleStdinTask(100)

  // ★ 阻塞调用，CEF 内部运行完整的 Windows 消息循环
  // 回调（on_after_created, on_load_end 等）在此调用中触发
  // stdin 读取任务通过 cef_post_delayed_task 定期触发
  cef_run_message_loop()

  console.error('[CEF-Host] Message loop exited')
  try { if (cefInitialized) cef_shutdown() } catch (e) {}
  process.exit(0)
}

// ========== 通过 vtable 调用 CEF browser 方法 ==========
// cef_browser_t::get_host vtable offset = 40 + 10*8 = 120
// cef_frame_t::load_url, execute_java_script 等方法也通过 vtable 调用
// 后续浏览器创建成功后再实现

// ========== IPC 命令处理 ==========
function handleIpcMessage(msg) {
  const id = msg.id
  const method = msg.method

  try {
    switch (method) {
      case 'navigate': handleNavigate(id, msg.params); break
      case 'evaluate': handleEvaluate(id, msg.params); break
      case 'getUrl': handleGetUrl(id); break
      case 'close': handleClose(id); break
      case 'resize': handleResize(id, msg.params); break
      case 'ping': sendIpc({ type: 'response', id, result: 'pong' }); break
      default: sendIpc({ type: 'response', id, error: 'Unknown method: ' + method })
    }
  } catch (e) {
    sendIpc({ type: 'response', id, error: e.message })
  }
}

function handleNavigate(id, params) {
  if (!browserPtr) { sendIpc({ type: 'response', id, error: 'No browser' }); return }
  // TODO: 通过 vtable 调用 cef_frame_t::load_url
  sendIpc({ type: 'response', id, error: 'navigate not yet implemented via vtable' })
}

function handleEvaluate(id, params) {
  if (!browserPtr) { sendIpc({ type: 'response', id, error: 'No browser' }); return }
  // TODO: 通过 vtable 调用 cef_frame_t::execute_java_script
  sendIpc({ type: 'response', id, error: 'evaluate not yet implemented via vtable' })
}

function handleGetUrl(id) {
  sendIpc({ type: 'response', id, result: '' })
}

function handleClose(id) {
  sendIpc({ type: 'response', id, result: true })
  // 通知 CEF 消息循环退出（cef_run_message_loop 会返回）
  try { cef_quit_message_loop() } catch (e) {}
}

function handleResize(id, params) {
  sendIpc({ type: 'response', id, result: true })
}

// ========== 进程退出处理 ==========
process.on('exit', () => {
  try { if (cefInitialized) cef_shutdown() } catch (e) {}
})

process.on('SIGINT', () => { handleClose(0) })

process.on('uncaughtException', (e) => {
  console.error('[CEF-Host] Uncaught exception:', e.message)
  sendError('Uncaught exception: ' + e.message)
})

// ========== 启动 ==========
console.error('[CEF-Host] Starting CEF host process...')
console.error('[CEF-Host] Process command line:', process.argv.join(' '))

// 检查关键命令行参数
const criticalArgs = ['--disable-gpu', '--in-process-gpu', '--bootstrap-module-name']
for (const arg of criticalArgs) {
  const found = process.argv.some(a => a === arg || a.startsWith(arg + '='))
  console.error('[CEF-Host] ' + arg + ': ' + (found ? 'FOUND' : 'NOT FOUND'))
}

initializeCEF()

// ★ 直接进入 CEF 消息循环（阻塞，CEF 内部运行完整的 Windows 消息循环）
// 不要在 cef_run_message_loop 之前调用 cef_do_message_loop_work，
// 因为 external_message_pump=0 时它可能进入阻塞消息循环
// on_after_created 等回调会在 cef_run_message_loop 内部触发
runCefMessageLoop()
