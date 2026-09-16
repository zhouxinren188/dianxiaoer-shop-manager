import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc'
import { parse as parseJavaScript } from '@babel/parser'
import * as Vue from 'vue'
import { renderToString } from '@vue/server-renderer'
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } from 'element-plus'
import { describe, expect, it } from 'vitest'
import * as summaries from '../src/renderer/src/utils/jdExpressCreationResult'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/renderer/src/views/operations/JdExpress.vue', import.meta.url), 'utf8')
const artifactRoot = path.resolve('node_modules/.cache/jd-express-result-qa')
const scopeId = 'data-v-jd-result-qa'
const fixture = { success: true, runId: 'local-qa-no-advertising-request', successCampaignCount: 60,
  campaignCount: 61, successUnitCount: 127, unitCount: 133, failureCount: 6,
  failures: [{ planName: '测试计划', unitName: '测试单元', message: '测试：关键词出价低于底价', stage: 'submit' }] }

async function renderFixture(result) {
  // 渲染真实组件的结束状态，不挂载、不连接服务器、不调用任何广告接口。
  const injection = `
    activeTool.value = 'custom'; activeStep.value = 2;
    config.keywordTotalUsage = 34935;
    selectedProducts.set('1', { skuId: '1', name: '测试商品', categoryId: '1', categoryName: '测试类目' });
    preflight.pin = 'qa'; preflight.limitsAvailable = true;
    preflight.limits.campaign.surplus = 0;
    createdFullResult.value = ${JSON.stringify(result)};
    Object.assign(creationVerification, { status: 'mismatch', missing: { keyword: 4 } });
  `
  const { descriptor } = parse(source.replace('</script>', injection + '\n</script>'))
  const script = compileScript(descriptor, { id: scopeId, inlineTemplate: true, genDefaultAs: 'ResultFixture' })
  const resolve = name => {
    if (name === 'vue') return Vue
    if (name === '@/utils/jdExpressCreationResult') return summaries
    if (name === '@/api/store') return { fetchStores: () => { throw new Error('QA must not query live stores') } }
    return require(name)
  }
  const imports = parseJavaScript(script.content, { sourceType: 'module' }).program.body
    .filter(node => node.type === 'ImportDeclaration')
  const bindings = {}
  let compiled = script.content
  for (const node of [...imports].reverse()) {
    const module = resolve(node.source.value)
    for (const specifier of node.specifiers) {
      bindings[specifier.local.name] = specifier.type === 'ImportSpecifier'
        ? module[specifier.imported.name] : specifier.type === 'ImportDefaultSpecifier' ? (module.default || module) : module
    }
    compiled = compiled.slice(0, node.start) + compiled.slice(node.end)
  }
  const component = new Function(...Object.keys(bindings), compiled + '\nreturn ResultFixture')(...Object.values(bindings))
  component.__scopeId = scopeId
  const app = Vue.createSSRApp(component).use(ElementPlus)
  app.provide(ID_INJECTION_KEY, { prefix: 1000, current: 0 })
  app.provide(ZINDEX_INJECTION_KEY, { current: 0 })
  const html = await renderToString(app)
  const css = compileStyle({ source: descriptor.styles[0].content, id: scopeId, scoped: true }).code
  return { html, css }
}

describe('真实快车预览组件的完成状态展示', () => {
  it('顶部明确部分成功，缺少关键词单独提示，不显示整批额度错误', async () => {
    const { html, css } = await renderFixture(fixture)
    expect(html).toContain('本轮任务已结束：部分成功')
    expect(html).toContain('成功 60/61 个计划、127/133 个单元；失败 6 个单元')
    expect(html).toContain('后台核验发现：关键词少 4 个')
    expect(html).not.toContain('当前仅剩 0 个额度')
    expect(html.indexOf('本轮任务已结束：部分成功')).toBeLessThan(html.indexOf('preview-metrics'))
    mkdirSync(artifactRoot, { recursive: true })
    const elementCss = readFileSync(require.resolve('element-plus/dist/index.css'), 'utf8')
    writeFileSync(path.join(artifactRoot, 'partial.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>快车结果展示本机检查</title><style>${elementCss}\n${css}\nbody{margin:0;background:#f1f3f7;font-family:Microsoft YaHei,Arial}.jd-express-page{padding:16px}</style>${html}</html>`)
  })
  it.each([
    [{ ...fixture, successUnitCount: 0, successCampaignCount: 0, failureCount: 133 }, '全部创建失败'],
    [{ ...fixture, successUnitCount: 133, successCampaignCount: 61, failureCount: 0 }, '全部创建成功'],
    [{ ...fixture, successUnitCount: 0, successCampaignCount: 0, failureCount: 0, skippedUnitCount: 133 }, '全部跳过']
  ])('终态在真实模板中正确显示：%s', async (result, expected) => {
    const { html } = await renderFixture(result)
    expect(html).toContain(`本轮任务已结束：${expected}`)
    expect(html).not.toContain('当前仅剩 0 个额度')
  })
})
