import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../src/main/purchase-order-capture.js', import.meta.url),
  'utf8'
)

describe('采购地址诊断日志', () => {
  it('记录后台地址窗口的关闭原因、结果和最后阶段', () => {
    expect(source).toContain('地址窗口关闭: platform=${platform}, purchaseNo=${purchaseNo}')
    expect(source).toContain('outcome=${addressOutcome}')
    expect(source).toContain('closeReason=${addressCloseReason}')
    expect(source).toContain('closeRequest=${addressCloseRequest}')
    expect(source).toContain('stage=${addressLastStage}')
    expect(source).toContain("cleanup('purchase_window_closed')")
    expect(source).toContain("cleanup('order_captured')")
  })

  it('记录结算页地址刷新是否执行以及候选项数量', () => {
    expect(source).toContain("runtimeLog.writeLog(\n          'PurchaseAddressRefresh'")
    expect(source).toContain("diagnostics.action = 'clicked-last-candidate'")
    expect(source).toContain("diagnostics.action = 'clicked-address-selector'")
    expect(source).toContain("console.log('[AddressRefresh] RESULT page='")
    expect(source).toContain("message.startsWith('[AddressRefresh]')")
  })

  it('只记录结算页地址匹配状态，不持久化所选地址原文', () => {
    expect(source).toContain("console.log('[DXE_ADDR_GUARD] validation: mode='")
    expect(source).toContain("',selectedCount=' + result.selectedCount")
    expect(source).toContain("refresh('installed')")
    expect(source).toContain("refresh('mutation')")
    expect(source).not.toContain("selectedText=' + result.selectedText")
  })

  it('结算页地址浮层可复制完整收货信息并兼容剪贴板降级', () => {
    expect(source).toContain("copyBtn.textContent = '\\u590d\\u5236'")
    expect(source).toContain("[info.shippingName, info.shippingPhone, info.shippingAddress]")
    expect(source).toContain("navigator.clipboard.writeText(copyText)")
    expect(source).toContain("fallbackCopyShippingInfo(copyText)")
    expect(source).toContain("document.execCommand('copy')")
    expect(source).toContain('titleGroup.appendChild(copyBtn)')
    expect(source).not.toContain('btnGroup.appendChild(copyBtn)')
  })

  it('开发版和正式版都隐藏自动改地址窗口，失败时也不保留诊断窗口', () => {
    expect(source).toContain('title: `设置收货地址 - ${platform}`')
    expect(source).toContain('show: false')
    expect(source).not.toContain('addressSetupVisualDebug')
    expect(source).not.toContain('debug_kept_open:${reason}')
    expect(source).not.toContain('本地诊断模式保留失败地址窗口')
  })
})
