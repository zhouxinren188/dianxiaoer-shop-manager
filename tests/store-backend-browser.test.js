import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import helpers from '../src/main/store-backend-browser-helpers.js'

const {
  isHttpUrl,
  normalizeTabUrl,
  isLikelyLoginUrl,
  selectOldestInactiveTab
} = helpers

describe('店铺后台多标签浏览器', () => {
  it('规范化标签网址并只允许网页协议', () => {
    expect(normalizeTabUrl('https://shop.jd.com/orders?a=1#detail')).toBe('https://shop.jd.com/orders?a=1')
    expect(isHttpUrl('https://shop.jd.com/orders')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('file:///C:/secret.txt')).toBe(false)
  })

  it('识别京东登录跳转，避免把登录页覆盖成恢复目标', () => {
    expect(isLikelyLoginUrl('https://passport.jd.com/new/login.aspx')).toBe(true)
    expect(isLikelyLoginUrl('https://shop.jd.com/jdm/order/list')).toBe(false)
  })

  it('把店铺名称放在窗口标题最前面，便于在任务栏区分多个店铺', () => {
    const source = fs.readFileSync(path.resolve('src/main/store-backend-browser.js'), 'utf8')
    const storeManage = fs.readFileSync(path.resolve('src/renderer/src/views/user/StoreManage.vue'), 'utf8')
    const orderList = fs.readFileSync(path.resolve('src/renderer/src/views/sales/OrderList.vue'), 'utf8')

    expect(source).toContain('this.window.setTitle(this.baseTitle)')
    expect(source).not.toContain('this.window.setTitle(`${this.baseTitle} - ${tab.title}`)')
    expect(storeManage).toContain('title: `${row.name} - 店铺后台`')
    expect(orderList).toContain("title: `${store.name || '京东代销'} - 采购单详情`")
  })

  it('达到标签上限时只回收最久未使用的后台标签', () => {
    const tabs = [
      { id: 'active', lastActiveAt: 1 },
      { id: 'newer', lastActiveAt: 30 },
      { id: 'oldest', lastActiveAt: 10 }
    ]
    expect(selectOldestInactiveTab(tabs, 'active')?.id).toBe('oldest')
  })

  it('把网页弹窗合并为 WebContentsView 标签并在关闭时释放资源', () => {
    const source = fs.readFileSync(path.resolve('src/main/store-backend-browser.js'), 'utf8')
    const toolbar = fs.readFileSync(path.resolve('resources/store-backend-toolbar.html'), 'utf8')

    expect(source).toContain('new WebContentsView')
    expect(source).toContain('contents.setWindowOpenHandler')
    expect(source).toContain("action: 'allow'")
    expect(source).toContain('outlivesOpener: true')
    expect(source).toContain('createWindow: browserWindowOptions =>')
    expect(source).toContain('webContents: browserWindowOptions.webContents')
    expect(source).toContain('new WebContentsView({ webContents: options.webContents })')
    expect(source).toContain('this.window.contentView.addChildView(tab.view)')
    expect(source).toContain('this.window.contentView.removeChildView(tab.view)')
    expect(source).toContain('tab.view.webContents.close()')
    expect(source).toContain('session: this.platformSession')
    expect(toolbar).toContain('关闭标签页')
    expect(toolbar).toContain("action('navigate'")
  })
})
