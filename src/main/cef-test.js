/**
 * cef-test.js - 最小化 CEF 测试
 * 用 koffi struct type 创建所有结构体，验证浏览器创建
 */
const koffi = require('koffi')
const path = require('path')
const fs = require('fs')

const CEF_DIR = 'C:\\Users\\Administrator\\cef-dist\\cef_binary_147.0.10+gd58e84d+chromium-147.0.7727.118_windows64_minimal'
const LIBCEF_PATH = path.join(CEF_DIR, 'Release', 'libcef.dll')

if (!fs.existsSync(LIBCEF_PATH)) { console.error('libcef.dll not found'); process.exit(1) }

const gcRefs = []
const libcef = koffi.load(LIBCEF_PATH)

// === CEF 函数声明 ===
const cef_execute_process = libcef.func('cef_execute_process', 'int', ['void*', 'void*', 'void*'])
const cef_initialize = libcef.func('cef_initialize', 'int', ['void*', 'void*', 'void*', 'void*'])
const cef_do_message_loop_work = libcef.func('cef_do_message_loop_work', 'void', [])
const cef_browser_host_create_browser = libcef.func('cef_browser_host_create_browser', 'int', ['void*', 'void*', 'void*', 'void*', 'void*', 'void*'])
const cef_string_utf16_set = libcef.func('cef_string_utf16_set', 'int', [koffi.pointer(koffi.types.char16), 'size_t', 'void*', 'int'])
const cef_shutdown = libcef.func('cef_shutdown', 'void', [])

// === koffi 回调原型 ===
const voidSelfProto = koffi.proto('void', ['void*'])
const intSelfProto = koffi.proto('int', ['void*'])
const getHandlerProto = koffi.proto('void*', ['void*'])
const onAfterCreatedProto = koffi.proto('void', ['void*', 'void*'])

// === koffi struct 类型 ===
const cef_base_ref_counted_t = koffi.struct('cef_base_ref_counted_t', {
  size: 'size_t',
  add_ref: koffi.pointer(voidSelfProto),
  release: koffi.pointer(intSelfProto),
  has_one_ref: koffi.pointer(intSelfProto),
  has_at_least_one_ref: koffi.pointer(intSelfProto),
})

const cef_app_t_type = koffi.struct('cef_app_t_type', {
  base: cef_base_ref_counted_t,
  on_before_command_line_processing: koffi.pointer(koffi.proto('void', ['void*', 'void*', 'void*'])),
  on_register_custom_schemes: koffi.pointer(koffi.proto('void', ['void*', 'void*'])),
  get_resource_bundle_handler: koffi.pointer(getHandlerProto),
  get_browser_process_handler: koffi.pointer(getHandlerProto),
  get_render_process_handler: koffi.pointer(getHandlerProto),
})

// cef_life_span_handler_t: base(40) + on_before_popup(8) + on_before_popup_aborted(8) +
// on_before_dev_tools_popup(8) + on_after_created(8) + do_close(8) + on_before_close(8) = 88
const cef_life_span_handler_t_type = koffi.struct('cef_life_span_handler_t_type', {
  base: cef_base_ref_counted_t,
  on_before_popup: koffi.pointer(koffi.proto('int', ['void*', 'void*', 'void*', 'int', 'void*', 'void*', 'int', 'int', 'void*', 'void*', 'void*', 'void*', 'void*', 'void*'])),
  on_before_popup_aborted: koffi.pointer(koffi.proto('void', ['void*', 'void*', 'int'])),
  on_before_dev_tools_popup: koffi.pointer(koffi.proto('void', ['void*', 'void*', 'void*', 'void*', 'void*', 'void*'])),
  on_after_created: koffi.pointer(onAfterCreatedProto),
  do_close: koffi.pointer(koffi.proto('int', ['void*', 'void*'])),
  on_before_close: koffi.pointer(koffi.proto('void', ['void*', 'void*'])),
})

// cef_client_t: base(40) + 20 function pointers = 200 bytes
const cef_client_t_type = koffi.struct('cef_client_t_type', {
  base: cef_base_ref_counted_t,
  get_audio_handler: koffi.pointer(getHandlerProto),
  get_command_handler: koffi.pointer(getHandlerProto),
  get_context_menu_handler: koffi.pointer(getHandlerProto),
  get_dialog_handler: koffi.pointer(getHandlerProto),
  get_display_handler: koffi.pointer(getHandlerProto),
  get_download_handler: koffi.pointer(getHandlerProto),
  get_drag_handler: koffi.pointer(getHandlerProto),
  get_find_handler: koffi.pointer(getHandlerProto),
  get_focus_handler: koffi.pointer(getHandlerProto),
  get_frame_handler: koffi.pointer(getHandlerProto),
  get_permission_handler: koffi.pointer(getHandlerProto),
  get_jsdialog_handler: koffi.pointer(getHandlerProto),
  get_keyboard_handler: koffi.pointer(getHandlerProto),
  get_life_span_handler: koffi.pointer(getHandlerProto),
  get_load_handler: koffi.pointer(getHandlerProto),
  get_print_handler: koffi.pointer(getHandlerProto),
  get_render_handler: koffi.pointer(getHandlerProto),
  get_request_handler: koffi.pointer(getHandlerProto),
  on_process_message_received: koffi.pointer(koffi.proto('int', ['void*', 'void*', 'void*', 'int', 'void*'])),
})

console.log('sizeof cef_app_t_type:', koffi.sizeof(cef_app_t_type))
console.log('sizeof cef_client_t_type:', koffi.sizeof(cef_client_t_type))
console.log('sizeof cef_life_span_handler_t_type:', koffi.sizeof(cef_life_span_handler_t_type))

// === 注册回调 ===
const addRefCb = koffi.register(function() {}, koffi.pointer(voidSelfProto))
const releaseCb = koffi.register(function() { return 1 }, koffi.pointer(intSelfProto))
const hasOneRefCb = koffi.register(function() { return 1 }, koffi.pointer(intSelfProto))
const hasAtLeastOneRefCb = koffi.register(function() { return 1 }, koffi.pointer(intSelfProto))

let browserCreated = false

const onAfterCreatedCb = koffi.register(function(self, browser) {
  browserCreated = true
  console.log('>>> on_after_created called! browser created successfully! <<<')
}, koffi.pointer(onAfterCreatedProto))

// === 用 koffi.alloc 创建 cef_life_span_handler_t ===
const lifeSpanHandlerPtr = koffi.alloc(cef_life_span_handler_t_type, 1)
koffi.encode(lifeSpanHandlerPtr, cef_life_span_handler_t_type, {
  base: { size: koffi.sizeof(cef_life_span_handler_t_type), add_ref: addRefCb, release: releaseCb, has_one_ref: hasOneRefCb, has_at_least_one_ref: hasAtLeastOneRefCb },
  on_before_popup: null,
  on_before_popup_aborted: null,
  on_before_dev_tools_popup: null,
  on_after_created: onAfterCreatedCb,
  do_close: null,
  on_before_close: null,
})
console.log('life_span_handler created')

// === 用 koffi.alloc 创建 cef_client_t ===
const getLifeSpanHandlerCb = koffi.register(function(self) {
  return lifeSpanHandlerPtr
}, koffi.pointer(getHandlerProto))

const clientPtr = koffi.alloc(cef_client_t_type, 1)
koffi.encode(clientPtr, cef_client_t_type, {
  base: { size: koffi.sizeof(cef_client_t_type), add_ref: addRefCb, release: releaseCb, has_one_ref: hasOneRefCb, has_at_least_one_ref: hasAtLeastOneRefCb },
  get_audio_handler: null,
  get_command_handler: null,
  get_context_menu_handler: null,
  get_dialog_handler: null,
  get_display_handler: null,
  get_download_handler: null,
  get_drag_handler: null,
  get_find_handler: null,
  get_focus_handler: null,
  get_frame_handler: null,
  get_permission_handler: null,
  get_jsdialog_handler: null,
  get_keyboard_handler: null,
  get_life_span_handler: getLifeSpanHandlerCb,
  get_load_handler: null,
  get_print_handler: null,
  get_render_handler: null,
  get_request_handler: null,
  on_process_message_received: null,
})
console.log('client created')

// === cef_main_args_t ===
const mainArgsBuf = Buffer.alloc(8, 0)

// === cef_execute_process ===
const execResult = cef_execute_process(mainArgsBuf, null, null)
console.log('cef_execute_process:', execResult)
if (execResult >= 0) { console.log('Subprocess, exiting'); process.exit(execResult) }

// === cef_settings_t ===
const SETTINGS_SIZE = 448
const settingsBuf = Buffer.alloc(SETTINGS_SIZE, 0)
settingsBuf.writeBigUInt64LE(BigInt(SETTINGS_SIZE), 0)
settingsBuf.writeInt32LE(1, 8)    // no_sandbox
settingsBuf.writeInt32LE(0, 88)   // multi_threaded_message_loop
settingsBuf.writeInt32LE(1, 92)   // external_message_pump
settingsBuf.writeInt32LE(0, 100)  // command_line_args_disabled
settingsBuf.writeInt32LE(1, 436)  // disable_signal_handlers
settingsBuf.writeInt32LE(3, 256)  // log_severity = ERROR

function setStr(targetBuf, offset, jsStr) {
  if (!jsStr) return
  const fieldBuf = Buffer.alloc(24, 0); gcRefs.push(fieldBuf)
  const fieldPtr = koffi.as(fieldBuf, 'void*')
  const charBuf = Buffer.alloc(jsStr.length * 2 + 2, 0)
  for (let i = 0; i < jsStr.length; i++) charBuf.writeUInt16LE(jsStr.charCodeAt(i), i * 2)
  gcRefs.push(charBuf)
  const charPtr = koffi.as(charBuf, koffi.pointer(koffi.types.char16))
  cef_string_utf16_set(charPtr, jsStr.length, fieldPtr, 1)
  fieldBuf.copy(targetBuf, offset, 0, 24)
}

setStr(settingsBuf, 16, path.join(CEF_DIR, 'Release', 'bootstrap.exe'))
setStr(settingsBuf, 208, 'zh-CN')
setStr(settingsBuf, 288, path.join(CEF_DIR, 'Release'))
setStr(settingsBuf, 312, path.join(CEF_DIR, 'Release', 'locales'))

// === cef_initialize (NULL app) ===
const settingsPtr = koffi.as(settingsBuf, 'void*')
gcRefs.push(settingsBuf, mainArgsBuf)
const initResult = cef_initialize(mainArgsBuf, settingsPtr, null, null)
console.log('cef_initialize:', initResult)
if (!initResult) { console.log('FAILED: cef_initialize'); process.exit(1) }

cef_do_message_loop_work()

// === cef_window_info_t ===
const WINDOW_INFO_SIZE = 112
const wiBuf = Buffer.alloc(WINDOW_INFO_SIZE, 0)
wiBuf.writeBigUInt64LE(BigInt(WINDOW_INFO_SIZE), 0)
wiBuf.writeUInt32LE(0x00CF0000 | 0x02000000 | 0x04000000 | 0x10000000, 40) // WS_OVERLAPPEDWINDOW|...
wiBuf.writeInt32LE(-2147483648, 44) // bounds.x = CW_USEDEFAULT
wiBuf.writeInt32LE(-2147483648, 48) // bounds.y
wiBuf.writeInt32LE(-2147483648, 52) // bounds.width
wiBuf.writeInt32LE(-2147483648, 56) // bounds.height
wiBuf.writeInt32LE(1, 104)         // runtime_style = ALLOY
gcRefs.push(wiBuf)

// === URL ===
const urlBuf = Buffer.alloc(24, 0); gcRefs.push(urlBuf)
const urlFieldPtr = koffi.as(urlBuf, 'void*')
const url = 'about:blank'
const urlCharBuf = Buffer.alloc(url.length * 2 + 2, 0)
for (let i = 0; i < url.length; i++) urlCharBuf.writeUInt16LE(url.charCodeAt(i), i * 2)
gcRefs.push(urlCharBuf)
const urlCharPtr = koffi.as(urlCharBuf, koffi.pointer(koffi.types.char16))
cef_string_utf16_set(urlCharPtr, url.length, urlFieldPtr, 1)

// === cef_browser_settings_t ===
const BROWSER_SETTINGS_SIZE = 280
const bsBuf = Buffer.alloc(BROWSER_SETTINGS_SIZE, 0)
bsBuf.writeBigUInt64LE(BigInt(BROWSER_SETTINGS_SIZE), 0)
bsBuf.writeInt32LE(1, 204) // javascript = STATE_ENABLED
gcRefs.push(bsBuf)

// === 创建浏览器 ===
console.log('Calling cef_browser_host_create_browser...')
const wiPtr = koffi.as(wiBuf, 'void*')
const bsPtr = koffi.as(bsBuf, 'void*')

const result = cef_browser_host_create_browser(wiPtr, clientPtr, urlFieldPtr, bsPtr, null, null)
console.log('create_browser result:', result)

if (result) {
  // 做消息循环，等待浏览器创建回调
  for (let i = 0; i < 100; i++) {
    cef_do_message_loop_work()
    if (browserCreated) break
  }
  console.log('browserCreated:', browserCreated)
} else {
  console.log('Browser creation failed! Trying to diagnose...')
  // 验证参数
  console.log('window_info.size:', wiBuf.readBigUInt64LE(0).toString())
  console.log('window_info.style:', '0x' + wiBuf.readUInt32LE(40).toString(16))
  console.log('window_info.runtime_style:', wiBuf.readInt32LE(104))
  console.log('browser_settings.size:', bsBuf.readBigUInt64LE(0).toString())
  console.log('URL buf first 24 bytes:', urlBuf.toString('hex'))

  // 做100次消息循环看看是否有什么事件
  console.log('Running 100 message loop iterations...')
  for (let i = 0; i < 100; i++) {
    cef_do_message_loop_work()
  }
}

console.log('Test complete')
try { cef_shutdown() } catch(e) { console.log('shutdown error:', e.message) }
