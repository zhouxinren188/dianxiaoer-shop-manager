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

  it('隐藏系统标题栏并把原生窗口按钮叠加到标签栏右侧', () => {
    const source = fs.readFileSync(path.resolve('src/main/store-backend-browser.js'), 'utf8')
    const toolbar = fs.readFileSync(path.resolve('resources/store-backend-toolbar.html'), 'utf8')

    expect(source).toContain("titleBarStyle: 'hidden'")
    expect(source).toContain('titleBarOverlay: {')
    expect(source).toContain("color: '#e8edf5'")
    expect(source).toContain('height: 43')
    expect(toolbar).toContain('padding: 5px 142px 0 8px')
    expect(toolbar).toContain('-webkit-app-region: drag')
    expect(toolbar).toContain('-webkit-app-region: no-drag')
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

  it('像普通浏览器一样处理网页离开确认，允许用户决定重载或保留编辑内容', () => {
    const source = fs.readFileSync(path.resolve('src/main/store-backend-browser.js'), 'utf8')

    expect(source).toContain("contents.on('will-prevent-unload'")
    expect(source).toContain("message: '离开此网站？'")
    expect(source).toContain("buttons: ['离开', '取消']")
    expect(source).toContain("action=${shouldLeave ? 'leave' : 'cancel'}")
    expect(source).toContain('if (shouldLeave) event.preventDefault()')
  })

  it('提供普通浏览器一致的网页右键菜单', () => {
    const source = fs.readFileSync(path.resolve('src/main/store-backend-browser.js'), 'utf8')

    expect(source).toContain("contents.on('context-menu'")
    expect(source).toContain("label: '复制'")
    expect(source).toContain("label: '粘贴'")
    expect(source).toContain("label: '在新标签页中打开链接'")
    expect(source).toContain("label: '复制链接地址'")
    expect(source).toContain("label: '后退'")
    expect(source).toContain("label: '重新加载'")
    expect(source).toContain("label: '查看网页源代码'")
    expect(source).toContain("label: '检查'")
    expect(source).toContain("'打开开发者工具（F12）'")
    expect(source).toContain("key === 'f12'")
    expect(source).toContain("input.control && input.shift && key === 'i'")
    expect(source).toContain("contents.openDevTools({ mode: 'detach', activate: true })")
    expect(source).toContain('contents.inspectElement(params.x, params.y)')
    expect(source).toContain('const sourceUrl = `view-source:${url}`')
  })
})
