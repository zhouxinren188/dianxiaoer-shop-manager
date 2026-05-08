const koffi = require('koffi')
const path = require('path')

const CEF_DIR = 'C:\\Users\\Administrator\\cef-dist\\cef_binary_147.0.10+gd58e84d+chromium-147.0.7727.118_windows64_minimal'
const CEF_RELEASE_DIR = path.join(CEF_DIR, 'Release')
const LIBCEF_PATH = path.join(CEF_RELEASE_DIR, 'libcef.dll')

const libcef = koffi.load(LIBCEF_PATH)

const voidSelfProto = koffi.proto('void', ['void*'])
const intSelfProto = koffi.proto('int', ['void*'])
const getHandlerSelfProto = koffi.proto('void*', ['void*'])

const _gcRefs = []

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

// 创建 cef_client_t
const CLIENT_SIZE = 192
const clientBuf = Buffer.alloc(CLIENT_SIZE, 0)
createRefCountedBase(clientBuf, CLIENT_SIZE)

// 创建 life_span_handler
const LIFESPAN_SIZE = 88
const lifeSpanBuf = Buffer.alloc(LIFESPAN_SIZE, 0)
createRefCountedBase(lifeSpanBuf, LIFESPAN_SIZE)

const lifeSpanPtr = koffi.as(lifeSpanBuf, 'void*')
_gcRefs.push(lifeSpanPtr)

const getLifeSpanHandlerCb = koffi.register(function (self) {
  console.error('[DIAG] get_life_span_handler called!')
  return lifeSpanPtr
}, koffi.pointer(getHandlerSelfProto))

clientBuf.writeBigUInt64LE(BigInt(koffi.address(getLifeSpanHandlerCb)), 144)
_gcRefs.push(getLifeSpanHandlerCb)

// 检查 clientBuf
console.log('=== cef_client_t hex dump (base + handlers) ===')
for (let i = 0; i < 48; i += 8) {
  const val = clientBuf.readBigUInt64LE(i)
  console.log('  offset ' + i + ': 0x' + val.toString(16).padStart(16, '0'))
}
console.log('  offset 144 (get_life_span_handler): 0x' + clientBuf.readBigUInt64LE(144).toString(16).padStart(16, '0'))

const clientPtr = clientBuf  // 直接用 Buffer，koffi 会自动转为 void*
_gcRefs.push(clientPtr)
console.log('\nclientBuf will be passed directly as Buffer to CEF functions')

// 初始化 CEF
const cef_execute_process = libcef.func('cef_execute_process', 'int', ['void*', 'void*', 'void*'])
const cef_initialize = libcef.func('cef_initialize', 'int', ['void*', 'void*', 'void*', 'void*'])
const cef_do_message_loop_work = libcef.func('cef_do_message_loop_work', 'void', [])
const cef_string_utf16_set = libcef.func('cef_string_utf16_set', 'int', [
  koffi.pointer(koffi.types.char16), 'size_t', 'void*', 'int'
])
const cef_browser_host_create_browser = libcef.func('cef_browser_host_create_browser', 'int', [
  'void*', 'void*', 'void*', 'void*', 'void*', 'void*'
])
const cef_browser_host_create_browser_sync = libcef.func('cef_browser_host_create_browser_sync', 'void*', [
  'void*', 'void*', 'void*', 'void*', 'void*', 'void*'
])

function jsStringToChar16Ptr(jsStr) {
  const buf = Buffer.alloc(jsStr.length * 2 + 2, 0)
  for (let i = 0; i < jsStr.length; i++) buf.writeUInt16LE(jsStr.charCodeAt(i), i * 2)
  const ptr = koffi.as(buf, koffi.pointer(koffi.types.char16))
  _gcRefs.push(buf)
  return { ptr, length: jsStr.length }
}

function setCefStringField(targetBuf, offset, jsStr) {
  if (!jsStr) return
  const fieldBuf = Buffer.alloc(24, 0)
  _gcRefs.push(fieldBuf)
  const fieldPtr = koffi.as(fieldBuf, 'void*')
  const { ptr: char16Ptr, length: charLen } = jsStringToChar16Ptr(jsStr)
  cef_string_utf16_set(char16Ptr, charLen, fieldPtr, 1)
  fieldBuf.copy(targetBuf, offset, 0, 24)
}

const mainArgsBuf = Buffer.alloc(8, 0)
_gcRefs.push(mainArgsBuf)

const execResult = cef_execute_process(mainArgsBuf, null, null)
console.log('cef_execute_process:', execResult)
if (execResult >= 0) { process.exit(execResult) }

// cef_settings_t
const SETTINGS_SIZE = 448
const settingsBuf = Buffer.alloc(SETTINGS_SIZE, 0)
settingsBuf.writeBigUInt64LE(BigInt(SETTINGS_SIZE), 0)
settingsBuf.writeInt32LE(1, 8) // no_sandbox
settingsBuf.writeInt32LE(1, 92) // external_message_pump
settingsBuf.writeInt32LE(0, 100) // command_line_args_disabled
settingsBuf.writeInt32LE(1, 436) // disable_signal_handlers
setCefStringField(settingsBuf, 16, path.join(CEF_RELEASE_DIR, 'cef-subprocess.exe'))
setCefStringField(settingsBuf, 208, 'zh-CN')
setCefStringField(settingsBuf, 288, CEF_RELEASE_DIR)
setCefStringField(settingsBuf, 312, path.join(CEF_RELEASE_DIR, 'locales'))

_gcRefs.push(settingsBuf)

console.log('Calling cef_initialize...')
const initResult = cef_initialize(mainArgsBuf, settingsBuf, null, null)
console.log('cef_initialize result:', initResult)

if (!initResult) {
  console.log('cef_initialize FAILED')
  process.exit(1)
}

cef_do_message_loop_work()

// 创建浏览器
const WS_OVERLAPPEDWINDOW = 0x00CF0000
const WS_CLIPCHILDREN = 0x02000000
const WS_CLIPSIBLINGS = 0x04000000
const WS_VISIBLE = 0x10000000
const CW_USEDEFAULT = -2147483648

const WINDOW_INFO_SIZE = 112
const WOFF = { size: 0, ex_style: 8, window_name: 16, style: 40, bounds: 44, parent_window: 64, menu: 72, windowless_rendering_enabled: 80, shared_texture_enabled: 84, external_begin_frame_enabled: 88, window: 96, runtime_style: 104 }

const windowInfoBuf = Buffer.alloc(WINDOW_INFO_SIZE, 0)
windowInfoBuf.writeBigUInt64LE(BigInt(WINDOW_INFO_SIZE), WOFF.size)
windowInfoBuf.writeUInt32LE(WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_VISIBLE, WOFF.style)
windowInfoBuf.writeInt32LE(CW_USEDEFAULT, WOFF.bounds)
windowInfoBuf.writeInt32LE(CW_USEDEFAULT, WOFF.bounds + 4)
windowInfoBuf.writeInt32LE(CW_USEDEFAULT, WOFF.bounds + 8)
windowInfoBuf.writeInt32LE(CW_USEDEFAULT, WOFF.bounds + 12)
windowInfoBuf.writeInt32LE(1, WOFF.runtime_style) // CEF_RUNTIME_STYLE_ALLOY

// URL
const urlBuf = Buffer.alloc(24, 0)
_gcRefs.push(urlBuf)
const { ptr: urlChar16, length: urlLen } = jsStringToChar16Ptr('about:blank')
cef_string_utf16_set(urlChar16, urlLen, urlBuf, 1)

// Browser settings
const BROWSER_SETTINGS_SIZE = 280
const browserSettingsBuf = Buffer.alloc(BROWSER_SETTINGS_SIZE, 0)
browserSettingsBuf.writeBigUInt64LE(BigInt(BROWSER_SETTINGS_SIZE), 0)

_gcRefs.push(windowInfoBuf, browserSettingsBuf)

console.log('\n=== Creating browser ===')
console.log('window_info size:', windowInfoBuf.readBigUInt64LE(0).toString())
console.log('browser_settings size:', browserSettingsBuf.readBigUInt64LE(0).toString())
console.log('client size:', CLIENT_SIZE)

// 启动消息循环
const timer = setInterval(() => {
  try { cef_do_message_loop_work() } catch (e) { clearInterval(timer) }
}, 16)

// 做几次消息循环
for (let i = 0; i < 5; i++) cef_do_message_loop_work()

console.log('\nTrying async create_browser...')
const asyncResult = cef_browser_host_create_browser(windowInfoBuf, clientBuf, urlBuf, browserSettingsBuf, null, null)
console.log('Async result:', asyncResult)

if (!asyncResult) {
  console.log('Trying sync create_browser...')
  const syncResult = cef_browser_host_create_browser_sync(windowInfoBuf, clientBuf, urlBuf, browserSettingsBuf, null, null)
  console.log('Sync result:', syncResult)
  if (!syncResult) {
    console.log('FAILED: Both async and sync returned failure/null')
    clearInterval(timer)
    process.exit(1)
  }
  console.log('SUCCESS! Browser created via sync.')
} else {
  console.log('SUCCESS! Browser creation request submitted via async.')
}
