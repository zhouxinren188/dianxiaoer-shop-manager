import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import warehouseTool from '../src/main/store-backend-warehouse-tool.js'

const { isWarehouseManageUrl, loadWarehouseToolSource } = warehouseTool

describe('店铺后台分区库存工具', () => {
  it('仅匹配京麦官方仓库管理页', () => {
    expect(isWarehouseManageUrl('https://shop.jd.com/jdm/trade/warehousing/warehouse-manage')).toBe(true)
    expect(isWarehouseManageUrl('https://shop.jd.com/jdm/trade/warehousing/warehouse-manage?subScene=1')).toBe(true)
    expect(isWarehouseManageUrl('https://shop.jd.com/jdm/order/list')).toBe(false)
    expect(isWarehouseManageUrl('http://shop.jd.com/jdm/trade/warehousing/warehouse-manage')).toBe(false)
    expect(isWarehouseManageUrl('https://evil.example/jdm/trade/warehousing/warehouse-manage')).toBe(false)
  })

  it('使用京麦页面签名能力、官方仓库接口和内置的原始品牌素材', () => {
    const source = loadWarehouseToolSource(path.resolve('.'))

    expect(source).toContain("new window.ParamsSign")
    expect(source).toContain("window.CryptoJS?.SHA256")
    expect(source).toContain('PartitionWarehousePriorityService.getRegionHierarchyWithPriorityCounts')
    expect(source).toContain('PartitionWarehousePriorityService.getConfigurableWarehousesByRegion')
    expect(source).toContain('PartitionWarehousePriorityService.saveWarehousePriorityByRegionId')
    expect(source).toContain('data:image/png;base64,')
    expect(source).not.toContain('__DXE_WAREHOUSE_LOGO_URL__')
  })

  it('原样保留附属插件的界面结构、文案和批量处理机制', () => {
    const source = fs.readFileSync(path.resolve('resources/store-backend-warehouse-tool.js'), 'utf8')

    expect(source).toContain("priority < 0 || priority > 10000")
    expect(source).toContain("仓库优先级不能重复")
    expect(source).toContain("consecutiveFailures >= 3")
    expect(source).toContain("runToken += 1")
    expect(source).toContain("ecommerceToolboxWarehouseState")
    expect(source).toContain('width:440px')
    expect(source).toContain('<img src="${logoUrl}" alt="小灰狼">')
    expect(source).toContain('<h2>仓库分区库存助手</h2>')
    expect(source).toContain('data-action="toggle-run"')
    expect(source).toContain('top:149px')
    expect(source).toContain('data-rule-row=')
    expect(source).toContain('正在设置：${escapeHtml(state.currentRegion)}')
    expect(source).not.toContain('state.processed += 1;\n      state.currentRegion = "";')
    expect(source).not.toContain('data-confirm')
    expect(source).not.toContain('<strong>处理记录</strong>')
  })

  it('为每个店铺后台标签绑定重新注入，并在销毁时清理定时器', () => {
    const source = fs.readFileSync(path.resolve('src/main/store-backend-warehouse-tool.js'), 'utf8')
    const indexSource = fs.readFileSync(path.resolve('src/main/index.js'), 'utf8')

    expect(source).toContain("webContents.on('did-finish-load'")
    expect(source).toContain("webContents.on('did-navigate-in-page'")
    expect(source).toContain("webContents.once('destroyed'")
    expect(indexSource).toContain('attachWarehouseRegionTool(webContents')
    expect(indexSource).toContain('storeId,')
  })
})
