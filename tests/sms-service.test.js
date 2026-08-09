import { describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import smsService from '../server/services/sms-service.js'

const {
  normalizeReceiverPhone,
  buildSmsMessage,
  calculateSmsCount,
  createProviderPayload,
  sendSms
} = smsService

const config = {
  providerUrl: 'https://example.com/sms',
  appId: 'app-test',
  mchId: 'merchant-test',
  key: 'secret-test',
  signName: '【测试签名】',
  timeoutMs: 3000
}

describe('订单短信服务', () => {
  it('兼容 +86、86- 前缀和隐私号分机', () => {
    expect(normalizeReceiverPhone('+8613800138000')).toMatchObject({ phone: '13800138000', extension: '' })
    expect(normalizeReceiverPhone('86-13800138000')).toMatchObject({ phone: '13800138000', extension: '' })
    expect(normalizeReceiverPhone('86-13800138000-0567')).toMatchObject({ phone: '13800138000', extension: '0567' })
    expect(normalizeReceiverPhone('13800138000-0567')).toMatchObject({ phone: '13800138000', extension: '0567' })
  })

  it('拒绝掩码号码和无效手机号', () => {
    expect(() => normalizeReceiverPhone('138****8000')).toThrow('手机号格式不正确')
    expect(() => normalizeReceiverPhone('123')).toThrow('手机号格式不正确')
  })

  it('将隐私号分机加入正文并按旧版规则计算条数', () => {
    const message = buildSmsMessage('请及时取件。', '0567')
    expect(message).toBe('#0567#请及时取件。')
    expect(calculateSmsCount('【测试签名】', message)).toBe(1)
    expect(calculateSmsCount('【测试签名】', 'a'.repeat(130))).toBe(3)
  })

  it('按联璐接口字段顺序生成大写 MD5 签名', () => {
    const payload = createProviderPayload({
      config,
      phone: '13800138000',
      message: '测试短信',
      timestamp: 123456789
    })
    expect(payload).toMatchObject({
      AppId: 'app-test',
      MchId: 'merchant-test',
      PhoneNumberSet: ['13800138000'],
      SignName: '【测试签名】',
      SessionContext: '测试短信',
      TimeStamp: '123456789',
      SignType: 'MD5'
    })
    expect(payload.Signature).toMatch(/^[A-F0-9]{32}$/)
    const expectedSource =
      'AppId=app-test&MchId=merchant-test&SignName=【测试签名】' +
      '&SignType=MD5&TimeStamp=123456789&Type=1&Version=1.1.0&key=secret-test'
    expect(payload.Signature).toBe(crypto.createHash('md5').update(expectedSource, 'utf8').digest('hex').toUpperCase())
  })

  it('发送时只向运营商提交主号码并保留分机正文', async () => {
    const transport = vi.fn().mockResolvedValue({ statusCode: 200, data: { status: '00', message: 'ok' } })
    const result = await sendSms({
      config,
      phone: '13800138000-0567',
      message: '请及时取件。',
      transport
    })

    expect(transport).toHaveBeenCalledTimes(1)
    const [, payload] = transport.mock.calls[0]
    expect(payload.PhoneNumberSet).toEqual(['13800138000'])
    expect(payload.SessionContext).toBe('#0567#请及时取件。')
    expect(result).toMatchObject({ phone: '13800138000', extension: '0567', smsCount: 1 })
  })
})
