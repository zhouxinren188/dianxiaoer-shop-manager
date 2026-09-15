import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/renderer/src/views/home/HomePage.vue', import.meta.url), 'utf8')

describe('首页趋势与结算发票布局', () => {
  it('保持左侧趋势、右侧结算和发票纵向堆叠，左右拉齐', () => {
    expect(source).toContain('class="dashboard-chart-column dashboard-side-column"')
    expect(source).toMatch(/\.dashboard-chart-row\s*\{\s*align-items:\s*stretch;/)
    expect(source).toMatch(/\.home-side-stack\s*\{[^}]*flex-direction:\s*column;/)
  })

  it('发票列表不按内容撑高父卡片，而在剩余高度内独立滚动', () => {
    expect(source).toMatch(/\.home-side-stack \.invoice-summary\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/)
    expect(source).toMatch(/\.home-side-stack \.invoice-list\s*\{[^}]*flex:\s*1;[^}]*height:\s*0;[^}]*min-height:\s*0;/)
    expect(source).toMatch(/\.invoice-list\s*\{[^}]*overflow-y:\s*auto;/)
  })
})
