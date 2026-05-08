/**
 * cef-init-test.js - CEF 初始化测试 v4
 * 关键：cef_initialize 所有参数用 void*，避免 koffi decode/re-encode
 */
const koffi = require('koffi')
const path = require('path')
const fs = require('fs')

const CEF_DIR = 'C:\\Users\\Administrator\\cef-dist\\cef_binary_147.0.10+gd58e84d+chromium-147.0.7727.118_windows64_minimal'

const cef_string_t = koffi.struct('cef_string_t', {
  str: koffi.pointer(koffi.types.char16),
  length: 'size_t',
  dtor: 'void*'
})

const libcef = koffi.load(path.join(CEF_DIR, 'Release', 'libcef.dll'))

// 所有 struct 指针参数用 void*
const cef_execute_process = libcef.func('cef_execute_process', 'int', ['void*', 'void*', 'void*'])
const cef_initialize = libcef.func('cef_initialize', 'int', ['void*', 'void*', 'void*', 'void*'])
const cef_shutdown = libcef.func('cef_shutdown', 'void', [])
const cef_string_utf16_set = libcef.func('cef_string_utf16_set', 'int', [
  koffi.pointer(koffi.types.char16), 'size_t', 'void*', 'int'
])
const cef_version_info = libcef.func('cef_version_info', 'int', ['int'])

console.log('CEF version:', cef_version_info(0), '.', cef_version_info(1), '.', cef_version_info(2))

const _gcRefs = []

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
  const setResult = cef_string_utf16_set(char16Ptr, charLen, fieldPtr, 1)
  if (!setResult) { console.error('  FAILED'); return }
  console.log('  OK: "' + jsStr.substring(0, 50) + '" len=' + fieldBuf.readBigUInt64LE(8))
  fieldBuf.copy(targetBuf, offset, 0, 24)
}

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

process.chdir(CEF_DIR)

const CEF_RELEASE = path.join(CEF_DIR, 'Release')
const CEF_RESOURCES = path.join(CEF_DIR, 'Resources')
const CEF_LOCALES = path.join(CEF_RESOURCES, 'locales')
const CEF_SUBPROCESS = path.join(CEF_RELEASE, 'bootstrap.exe')

console.log('  icudtl.dat:', fs.existsSync(path.join(CEF_RESOURCES, 'icudtl.dat')))

// cef_main_args_t (8 bytes, all zero = NULL HINSTANCE)
const mainArgsBuf = Buffer.alloc(8, 0)
const mainArgsPtr = koffi.as(mainArgsBuf, 'void*')
_gcRefs.push(mainArgsBuf)

// cef_execute_process
const execResult = cef_execute_process(mainArgsPtr, null, null)
console.log('cef_execute_process:', execResult)
if (execResult >= 0) process.exit(execResult)

// 构造 cef_settings_t
console.log('\nBuilding cef_settings_t...')
const settingsBuf = Buffer.alloc(SETTINGS_SIZE, 0)

settingsBuf.writeBigUInt64LE(BigInt(SETTINGS_SIZE), OFF.size)
settingsBuf.writeInt32LE(1, OFF.no_sandbox)
settingsBuf.writeInt32LE(0, OFF.multi_threaded_message_loop)
settingsBuf.writeInt32LE(1, OFF.external_message_pump)
settingsBuf.writeInt32LE(0, OFF.windowless_rendering_enabled)
settingsBuf.writeInt32LE(0, OFF.command_line_args_disabled)
settingsBuf.writeInt32LE(0, OFF.persist_session_cookies)
settingsBuf.writeInt32LE(1, OFF.log_severity)
settingsBuf.writeInt32LE(0, OFF.log_items)
settingsBuf.writeInt32LE(0, OFF.remote_debugging_port)
settingsBuf.writeInt32LE(0, OFF.uncaught_exception_stack_size)
settingsBuf.writeUInt32LE(0xFFFFFFFF, OFF.background_color)
settingsBuf.writeInt32LE(0, OFF.chrome_app_icon_id)
settingsBuf.writeInt32LE(1, OFF.disable_signal_handlers)
settingsBuf.writeInt32LE(0, OFF.use_views_default_popup)
settingsBuf.writeInt32LE(0, OFF.cookieable_schemes_exclude_defaults)

console.log('\nSetting string fields (only subprocess path, no resources_dir_path):')
setCefStringField(settingsBuf, OFF.browser_subprocess_path, CEF_SUBPROCESS)
// 不设置 resources_dir_path - 让 CEF 在 libcef.dll 目录（Release）查找
// setCefStringField(settingsBuf, OFF.resources_dir_path, CEF_RESOURCES)
// setCefStringField(settingsBuf, OFF.locales_dir_path, CEF_LOCALES)
setCefStringField(settingsBuf, OFF.locale, 'zh-CN')
setCefStringField(settingsBuf, OFF.accept_language_list, 'zh-CN,zh,en-US,en')

// 验证 settings buffer
console.log('\nVerification:')
console.log('  size:', settingsBuf.readBigUInt64LE(OFF.size))
console.log('  no_sandbox:', settingsBuf.readInt32LE(OFF.no_sandbox))
console.log('  resources_dir_path.len:', settingsBuf.readBigUInt64LE(OFF.resources_dir_path + 8))
console.log('  browser_subprocess_path.len:', settingsBuf.readBigUInt64LE(OFF.browser_subprocess_path + 8))

const settingsPtr = koffi.as(settingsBuf, 'void*')
_gcRefs.push(settingsBuf)

console.log('\nCalling cef_initialize...')
const initResult = cef_initialize(mainArgsPtr, settingsPtr, null, null)
console.log('cef_initialize result:', initResult)

if (initResult) {
  console.log('\nCEF initialized SUCCESSFULLY!')
  cef_shutdown()
  process.exit(0)
}

console.log('\ncef_initialize FAILED!')
for (const lf of [path.join(CEF_RELEASE, 'debug.log'), path.join(CEF_DIR, 'debug.log')]) {
  if (fs.existsSync(lf)) {
    console.log('\nLog (' + lf + '):')
    console.log(fs.readFileSync(lf, 'utf8').substring(0, 3000))
  }
}
process.exit(3)
