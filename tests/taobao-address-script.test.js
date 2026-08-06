import { describe, expect, it } from 'vitest'
import vm from 'node:vm'
import taobaoAddressScript from '../src/main/taobao-address-script.js'

const { buildTaobaoAddressManagerScript, TAOBAO_TERMINAL_FAILURE_RESULTS } = taobaoAddressScript

describe('淘宝地址管理脚本 v2', () => {
  it('生成的注入脚本语法有效', () => {
    const script = buildTaobaoAddressManagerScript('测试收件人', '13800138000', {
      province: '广东',
      city: '广州',
      area: '天河区',
      other: '测试路1号【A1001】'
    })

    expect(() => new vm.Script(script)).not.toThrow()
  })

  it('通过 JSON 序列化安全嵌入地址数据', () => {
    const script = buildTaobaoAddressManagerScript('张"三', '13800138000', {
      province: '广东',
      city: '广州',
      area: '天河区',
      other: '测试路\\1号\n二楼'
    })

    expect(script).toContain('张\\"三')
    expect(script).toContain('测试路\\\\1号\\n二楼')
  })

  it('不再依赖旧版 addressList 作为页面就绪条件', () => {
    const script = buildTaobaoAddressManagerScript('', '', {})

    expect(script).not.toContain("querySelector('.addressList')")
    expect(script).toContain('[AddressAutoFill][TB]')
    expect(script).toContain('save_unconfirmed')
  })

  it('支持新版智能粘贴并拆分街道第四级', () => {
    const script = buildTaobaoAddressManagerScript('小小', '17305271170', {
      province: '江苏',
      city: '宿迁',
      area: '沭阳县',
      other: '沭城街道阳城大厦4楼收邮政【A7656】'
    })

    expect(script).toContain('SMART_PASTE_CLICKED')
    expect(script).toContain('"street":"沭城街道"')
    expect(script).toContain('"detail":"阳城大厦4楼收邮政【A7656】"')
  })

  it('列出所有需要向前端报告失败的终态', () => {
    expect(TAOBAO_TERMINAL_FAILURE_RESULTS).toEqual(expect.arrayContaining([
      'no_button',
      'no_form',
      'no_region',
      'no_save_button',
      'validation_failed',
      'default_unconfirmed',
      'save_unconfirmed',
      'script_error',
      'load_failed'
    ]))
  })

  it('只在单条地址行内判断地址和默认状态', () => {
    const script = buildTaobaoAddressManagerScript('文先生', '18400821635', {
      province: '湖南省',
      city: '湘潭市',
      area: '湘潭县',
      other: '易俗河镇裕鑫水岸龙庭楼七栋一单元1701'
    })

    expect(script).toContain('collectAddressRows')
    expect(script).toContain('EXISTING_ROW_SCOPE_INVALID')
    expect(script).toContain('getRowAction(row, /^取消默认$/)')
    expect(script).not.toContain('[class*="address"], [class*="Address"]')
  })
})
