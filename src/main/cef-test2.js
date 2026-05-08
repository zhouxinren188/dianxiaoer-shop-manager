/**
 * cef-test2.js - 测试 cef_app_t 传递方式
 * 重点验证 Buffer + koffi.as vs koffi.alloc + koffi.address
 */
const koffi = require('koffi')
const path = require('path')

const CEF_DIR = 'C:\\Users\\Administrator\\cef-dist\\cef_binary_147.0.10+gd58e84d+chromium-147.0.7727.118_windows64_minimal'
process.env.CEF_BOOTSTRAP_MODULE_NAME = 'libcef'

const libcef = koffi.load(path.join(CEF_DIR, 'Release', 'libcef.dll'))
const gcRefs = []

const voidSelfProto = koffi.proto('void', ['void*'])
const intSelfProto = koffi.proto('int', ['void*'])
const cef_execute_process = libcef.func('cef_execute_process', 'int', ['void*', 'void*', 'void*'])
const cef_initialize = libcef.func('cef_initialize', 'int', ['void*', 'void*', 'void*', 'void*'])
const cef_do_message_loop_work = libcef.func('cef_do_message_loop_work', 'void', [])
const cef_string_utf16_set = libcef.func('cef_string_utf16_set', 'int', [koffi.pointer(koffi.types.char16), 'size_t', 'void*', 'int'])
const cef_shutdown = libcef.func('cef_shutdown', 'void', [])
const cef_browser_host_create_browser = libcef.func('cef_browser_host_create_browser', 'int', ['void*', 'void*', 'void*', 'void*', 'void*', 'void*'])

const addRefCb = koffi.register(function(){}, koffi.pointer(voidSelfProto))
const releaseCb = koffi.register(function(){ return 1 }, koffi.pointer(intSelfProto))
const hasOneRefCb = koffi.register(function(){ return 1 }, koffi.pointer(intSelfProto))
const hasAtLeastOneRefCb = koffi.register(function(){ return 1 }, koffi.pointer(intSelfProto))

function setStr(tb, off, s) {
  if (!s) return
  const fb = Buffer.alloc(24,0); gcRefs.push(fb)
  const fp = koffi.as(fb, 'void*')
  const cb = Buffer.alloc(s.length*2+2,0)
  for(let i=0;i<s.length;i++) cb.writeUInt16LE(s.charCodeAt(i),i*2)
  gcRefs.push(cb)
  const cp = koffi.as(cb, koffi.pointer(koffi.types.char16))
  cef_string_utf16_set(cp, s.length, fp, 1)
  fb.copy(tb, off, 0, 24)
}

// ============ Step 1: NULL app 基础测试 ============
console.log('=== Test: NULL app ===')
const mainArgsBuf = Buffer.alloc(8, 0); gcRefs.push(mainArgsBuf)
const execResult = cef_execute_process(mainArgsBuf, null, null)
console.log('cef_execute_process:', execResult)
if (execResult >= 0) { process.exit(execResult) }

const settingsBuf = Buffer.alloc(448, 0); gcRefs.push(settingsBuf)
settingsBuf.writeBigUInt64LE(448n, 0)
settingsBuf.writeInt32LE(1, 8)   // no_sandbox
settingsBuf.writeInt32LE(0, 88)  // multi_threaded_message_loop
settingsBuf.writeInt32LE(1, 92)  // external_message_pump
settingsBuf.writeInt32LE(0, 100) // command_line_args_disabled
settingsBuf.writeInt32LE(1, 436) // disable_signal_handlers
settingsBuf.writeInt32LE(3, 256) // log_severity=ERROR
setStr(settingsBuf, 16, path.join(CEF_DIR,'Release','bootstrap.exe'))
setStr(settingsBuf, 208, 'zh-CN')
setStr(settingsBuf, 288, path.join(CEF_DIR,'Release'))
setStr(settingsBuf, 312, path.join(CEF_DIR,'Release','locales'))

const settingsPtr = koffi.as(settingsBuf, 'void*')

let r = cef_initialize(mainArgsBuf, settingsPtr, null, null)
console.log('cef_initialize with NULL app:', r)

if (!r) {
  console.log('FAILED: cef_initialize with NULL app')
  process.exit(1)
}

cef_do_message_loop_work()

// ============ Step 2: 用 Buffer 创建 client ============
console.log('\n=== Creating client via Buffer ===')
const CLIENT_SIZE = 192
const clientBuf = Buffer.alloc(CLIENT_SIZE, 0)
gcRefs.push(clientBuf)
clientBuf.writeBigUInt64LE(BigInt(CLIENT_SIZE), 0)
clientBuf.writeBigUInt64LE(BigInt(koffi.address(addRefCb)), 8)
clientBuf.writeBigUInt64LE(BigInt(koffi.address(releaseCb)), 16)
clientBuf.writeBigUInt64LE(BigInt(koffi.address(hasOneRefCb)), 24)
clientBuf.writeBigUInt64LE(BigInt(koffi.address(hasAtLeastOneRefCb)), 32)
const clientPtr = koffi.as(clientBuf, 'void*')
gcRefs.push(clientPtr)
console.log('client base.size:', clientBuf.readBigUInt64LE(0).toString())

// ============ Step 3: 创建浏览器 ============
console.log('\n=== Creating browser ===')
const wiBuf = Buffer.alloc(112, 0); gcRefs.push(wiBuf)
wiBuf.writeBigUInt64LE(112n, 0)
wiBuf.writeUInt32LE(0x16CF0000, 40) // WS_OVERLAPPEDWINDOW|...
wiBuf.writeInt32LE(-2147483648, 44)    // x=CW_USEDEFAULT
wiBuf.writeInt32LE(-2147483648, 48)   // y
wiBuf.writeInt32LE(-2147483648, 52)   // width
wiBuf.writeInt32LE(-2147483648, 56)   // height
wiBuf.writeInt32LE(1, 104)            // runtime_style=ALLOY

const urlBuf = Buffer.alloc(24, 0); gcRefs.push(urlBuf)
const urlFieldPtr = koffi.as(urlBuf, 'void*')
const url = 'about:blank'
const urlCharBuf = Buffer.alloc(url.length*2+2, 0)
for(let i=0;i<url.length;i++) urlCharBuf.writeUInt16LE(url.charCodeAt(i),i*2)
gcRefs.push(urlCharBuf)
const urlCharPtr = koffi.as(urlCharBuf, koffi.pointer(koffi.types.char16))
cef_string_utf16_set(urlCharPtr, url.length, urlFieldPtr, 1)

const bsBuf = Buffer.alloc(280, 0); gcRefs.push(bsBuf)
bsBuf.writeBigUInt64LE(280n, 0)
bsBuf.writeInt32LE(1, 204) // javascript

const wiPtr = koffi.as(wiBuf, 'void*')
const bsPtr = koffi.as(bsBuf, 'void*')

console.log('Calling cef_browser_host_create_browser...')
const result = cef_browser_host_create_browser(wiPtr, clientPtr, urlFieldPtr, bsPtr, null, null)
console.log('create_browser result:', result)

if (result) {
  console.log('>>> SUCCESS! Browser creation request submitted! <<<')
  for (let i = 0; i < 50; i++) cef_do_message_loop_work()
} else {
  console.log('FAILED: create_browser returned false')
  // 做100次消息循环看看
  for (let i = 0; i < 100; i++) cef_do_message_loop_work()
}

console.log('\nTest complete')
try { cef_shutdown() } catch(e) {}
