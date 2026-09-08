<template>
  <div class="home-page">
    <!-- 欢迎区域 -->
    <div class="welcome-card">
      <div class="welcome-left">
        <div class="welcome-avatar">
          <el-icon :size="32" color="#2b5aed"><UserFilled /></el-icon>
        </div>
        <div class="welcome-info">
          <h1 class="welcome-title">{{ greeting }}，{{ currentUser }}。</h1>
          <p class="welcome-desc">今天是你使用店小二网店管家的第 {{ usageDays }} 天！感谢你的坚持与付出，稳住节奏，未来可期～</p>
        </div>
      </div>
    </div>

    <!-- 经营概览：右上角切换今日/昨日/本月/本年 -->
    <section class="overview-section">
      <div class="overview-toolbar">
        <div class="overview-heading">
          <span class="overview-title">经营概览</span>
          <el-button
            class="overview-refresh"
            :icon="Refresh"
            circle
            size="small"
            :loading="overviewRefreshing"
            aria-label="刷新经营概览"
            title="刷新经营概览"
            @click="refreshOverviewStats"
          />
        </div>
        <el-radio-group v-model="overviewPeriod" size="small">
          <el-radio-button label="today">今日</el-radio-button>
          <el-radio-button label="yesterday">昨日</el-radio-button>
          <el-radio-button label="month">本月</el-radio-button>
          <el-radio-button label="year">本年</el-radio-button>
        </el-radio-group>
      </div>

      <div class="overview-grid">
        <div class="overview-kpi-card">
          <div class="overview-kpi-content">
            <div class="overview-kpi-info">
              <p class="overview-kpi-label">{{ overviewPeriodLabel }}销售</p>
              <h3 class="overview-kpi-value">¥ {{ formatMoney(activeOverviewStats.salesAmount) }}</h3>
              <p class="overview-kpi-sub" :title="formatOrderCountPlain(activeOverviewStats)">
                {{ formatOrderCountPlain(activeOverviewStats) }}
              </p>
            </div>
            <div class="overview-kpi-icon is-sales">
              <el-icon :size="22"><ShoppingCart /></el-icon>
            </div>
          </div>
          <div class="overview-kpi-footer">
            <span v-if="activePeriodConfig.hasComparison !== false" class="overview-trend" :class="activeSalesTrendPct >= 0 ? 'up' : 'down'">
              {{ formatTrendText(activeSalesTrendPct, overviewCompareLabel) }}
            </span>
            <span v-else class="overview-status is-ready">完整自然日</span>
          </div>
        </div>

        <div class="overview-kpi-card">
          <div class="overview-kpi-content">
            <div class="overview-kpi-info">
              <p class="overview-kpi-label">{{ overviewPeriodLabel }}采购</p>
              <h3 class="overview-kpi-value">¥ {{ formatMoney(activeOverviewStats.purchaseAmount) }}</h3>
              <p class="overview-kpi-sub">{{ formatPurchaseCount(activeOverviewStats) }}</p>
            </div>
            <div class="overview-kpi-icon is-purchase">
              <el-icon :size="22"><Goods /></el-icon>
            </div>
          </div>
          <div class="overview-kpi-footer">
            <span v-if="activePeriodConfig.hasComparison !== false" class="overview-trend" :class="activePurchaseTrendPct >= 0 ? 'up' : 'down'">
              {{ formatTrendText(activePurchaseTrendPct, overviewCompareLabel) }}
            </span>
            <span v-else class="overview-status is-ready">完整自然日</span>
            <span class="overview-kpi-note">含采购运费</span>
          </div>
        </div>

        <div class="overview-kpi-card">
          <div class="overview-kpi-content">
            <div class="overview-kpi-info">
              <p class="overview-kpi-label">{{ overviewPeriodLabel }}快车消耗</p>
              <h3 class="overview-kpi-value" :class="{ 'is-placeholder': !hasMetricValue(activeOverviewStats.adSpend) }">
                {{ formatMetricMoney(activeOverviewStats.adSpend) }}
              </h3>
              <p class="overview-kpi-sub">{{ formatAdSpendStatus(activeOverviewStats) }}</p>
            </div>
            <div class="overview-kpi-icon is-ad">
              <el-icon :size="22"><DataLine /></el-icon>
            </div>
          </div>
          <div class="overview-kpi-footer">
            <span class="overview-status" :class="{ 'is-ready': hasMetricValue(activeOverviewStats.adSpend) }">
              {{ hasMetricValue(activeOverviewStats.adSpend) ? '数据已同步' : '暂未同步' }}
            </span>
          </div>
        </div>

        <div class="overview-kpi-card">
          <div class="overview-kpi-content">
            <div class="overview-kpi-info">
              <p class="overview-kpi-label is-with-help">
                <span>{{ overviewPeriodLabel }}预估毛利</span>
                <el-tooltip
                  placement="top"
                  content="预估毛利 = 销售额 - 采购金额（含运费）- 京东佣金（8%）- 云仓运费（约10元/单）- 快车消耗"
                >
                  <span class="overview-profit-help" aria-label="预估毛利计算口径">?</span>
                </el-tooltip>
              </p>
              <h3
                class="overview-kpi-value is-profit"
                :class="{
                  'is-placeholder': !hasMetricValue(activeOverviewStats.estimatedProfit),
                  'is-negative': hasMetricValue(activeOverviewStats.estimatedProfit) &&
                    Number(activeOverviewStats.estimatedProfit) < 0
                }"
              >
                {{ formatMetricMoney(activeOverviewStats.estimatedProfit) }}
              </h3>
              <p class="overview-kpi-sub">{{ formatProfitStatus(activeOverviewStats) }}</p>
            </div>
            <div class="overview-kpi-icon is-profit">
              <el-icon :size="22"><Wallet /></el-icon>
            </div>
          </div>
          <div class="overview-kpi-footer">
            <span class="overview-status" :class="{ 'is-ready': hasMetricValue(activeOverviewStats.estimatedProfit) }">
              {{ hasMetricValue(activeOverviewStats.estimatedProfit) ? '经营预估值' : '成本数据未完整' }}
            </span>
          </div>
        </div>
      </div>
    </section>





    <!-- 图表区域 -->
    <el-row :gutter="24">
      <el-col :span="16">
        <div class="chart-card">
          <div class="chart-header">
            <div class="chart-header-left">
              <span class="chart-title">销售趋势</span>
              <span class="chart-subtitle">近30天</span>
            </div>
            <div class="chart-legend">
              <span class="legend-item">
                <span class="legend-bar" style="background:#2b5aed"></span>
                销售额（¥）
              </span>
              <span class="legend-item">
                <span class="legend-line" style="background:#fa8c16"></span>
                订单笔数
              </span>
            </div>
          </div>
          <div class="chart-body sales-trend-body" ref="chartContainer">
            <svg v-if="trendData.length" :viewBox="`0 0 ${chartW} ${chartH}`" class="trend-svg" preserveAspectRatio="xMidYMid meet">
              <!-- 网格线 -->
              <g class="grid-lines">
                <line v-for="i in 5" :key="'g'+i" :x1="padL" :y1="padT + plotH * (i-1) / 4" :x2="chartW - padR" :y2="padT + plotH * (i-1) / 4" stroke="#f0f0f0" stroke-width="1" />
              </g>

              <!-- 左 Y 轴刻度（销售额） -->
              <text v-for="(v, i) in yAxisLeft" :key="'yl'+i" :x="padL - 8" :y="padT + plotH * i / 4 + 4" text-anchor="end" class="axis-label">¥{{ v }}</text>

              <!-- 右 Y 轴刻度（订单数） -->
              <text v-for="(v, i) in yAxisRight" :key="'yr'+i" :x="chartW - padR + 8" :y="padT + plotH * i / 4 + 4" text-anchor="start" class="axis-label">{{ v }}</text>

              <!-- 柱状图（销售额） -->
              <rect
                v-for="(d, i) in trendData"
                :key="'bar'+i"
                :x="barX(i)"
                :y="barY(d.amount)"
                :width="barW"
                :height="barH(d.amount)"
                fill="#2b5aed"
                opacity="0.6"
                rx="2"
                class="bar-rect"
                @mouseenter="hoverIdx = i"
                @mouseleave="hoverIdx = -1"
              />

              <!-- 曲线图（订单数） -->
              <path
                :d="linePath"
                fill="none"
                stroke="#fa8c16"
                stroke-width="2"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
              <!-- 曲线圆点 -->
              <circle
                v-for="(d, i) in trendData"
                :key="'dot'+i"
                :cx="dotX(i)"
                :cy="dotY(d.count)"
                r="3"
                :fill="hoverIdx === i ? '#fa8c16' : '#fff'"
                stroke="#fa8c16"
                stroke-width="1.5"
                class="line-dot"
                @mouseenter="hoverIdx = i"
                @mouseleave="hoverIdx = -1"
              />

              <!-- X 轴刻度（每5天显示一个） -->
              <text
                v-for="(d, i) in trendData"
                v-show="i % 5 === 0 || i === trendData.length - 1"
                :key="'xl'+i"
                :x="dotX(i)"
                :y="chartH - padB + 18"
                text-anchor="middle"
                class="axis-label"
              >{{ d.date.slice(5) }}</text>

              <!-- 悬停 tooltip -->
              <g v-if="hoverIdx >= 0" class="tooltip-group">
                <line
                  :x1="dotX(hoverIdx)"
                  :y1="padT"
                  :x2="dotX(hoverIdx)"
                  :y2="padT + plotH"
                  stroke="#d0d0d0"
                  stroke-width="1"
                  stroke-dasharray="3,3"
                />
                <rect
                  :x="tooltipX"
                  :y="tooltipY"
                  :width="150"
                  :height="56"
                  rx="6"
                  fill="rgba(31,41,55,0.95)"
                />
                <text :x="tooltipX + 10" :y="tooltipY + 20" fill="#fff" class="tooltip-text">{{ trendData[hoverIdx].date }}</text>
                <text :x="tooltipX + 10" :y="tooltipY + 36" fill="#7ab8ff" class="tooltip-text">销售额：¥{{ formatMoney(trendData[hoverIdx].amount) }}</text>
                <text :x="tooltipX + 10" :y="tooltipY + 50" fill="#ffb066" class="tooltip-text">订单数：{{ trendData[hoverIdx].count }} 笔</text>
              </g>
            </svg>
            <div v-else class="chart-empty">
              <el-icon :size="40" color="#d0d0d0"><DataLine /></el-icon>
              <p>暂无销售数据</p>
            </div>
          </div>
        </div>
      </el-col>
      <el-col :span="8">
        <div class="chart-card">
          <div class="chart-header">
            <div class="chart-header-left">
              <span class="chart-title">待开发票（{{ pendingInvoiceTotal }}）</span>
            </div>
          </div>
          <div class="chart-body invoice-summary" v-loading="invoiceLoading">
            <div v-if="pendingInvoices.length" class="invoice-list">
              <article
                v-for="invoice in pendingInvoices"
                :key="`${invoice.storeId}-${invoice.orderId}`"
                class="invoice-item"
              >
                <div class="invoice-item-top">
                  <div class="invoice-order-wrap">
                    <span class="invoice-inline-label">订单编号</span>
                    <button class="invoice-order-link" type="button" @click="openInvoiceOrder(invoice)">
                      {{ invoice.orderId }}
                    </button>
                  </div>
                  <div class="invoice-top-status">
                    <div class="invoice-amount-wrap">
                      <span class="invoice-inline-label">开票金额</span>
                      <span class="invoice-amount" aria-label="发票金额">¥{{ formatInvoiceAmount(invoice.invoiceAmount) }}</span>
                    </div>
                    <span class="invoice-countdown" aria-label="倒计时" :class="countdownClass(invoice.countdownEndTime)">
                      {{ formatInvoiceCountdown(invoice.countdownEndTime) }}
                    </span>
                  </div>
                </div>
                <div class="invoice-details-line">
                  <div class="invoice-company" :title="invoice.companyName || '-'">
                    <span class="invoice-inline-label">开票主体</span>
                    <span class="invoice-field-value">{{ invoice.companyName || '-' }}</span>
                  </div>
                  <div class="invoice-title" :title="invoice.invoiceTitle || '-'">
                    <span class="invoice-inline-label">发票抬头</span>
                    <span class="invoice-field-value">{{ invoice.invoiceTitle || '-' }}</span>
                  </div>
                </div>
              </article>
            </div>
            <div v-else-if="pendingInvoiceTotal > 0" class="invoice-waiting">
              <strong>{{ pendingInvoiceTotal }}</strong>
              <span>个待开发票订单</span>
              <small>明细将在店铺下次同步后显示</small>
            </div>
            <el-empty v-else description="暂无待开发票" :image-size="72" />
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { UserFilled, ShoppingCart, DataLine, Goods, Wallet, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { get } from '@/api/request'
import { fetchAftersaleMetrics } from '@/api/aftersale'
import { calculateDashboardProfit } from '@/utils/dashboard-profit'
import { getLatestLocalJdExpressPeriods } from '@/services/jd-express-spend-sync'

const currentUser = localStorage.getItem('currentUser') || '管理员'

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 9) return '早安'
  if (hour < 12) return '上午好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
})

// 使用天数：从注册日算起（优先从服务器获取）
const usageDays = ref(1)
let refreshTimer = null
let countdownTimer = null
let invoiceMetricRefreshTimer = null
let unsubscribeMetricUpdated = null
let handleJdExpressSpendSynced = null

async function loadUserInfo() {
  try {
    const data = await get('/api/auth/me')
    if (data && data.createdAt) {
      const created = new Date(data.createdAt)
      const now = new Date()
      const diff = Math.floor((now - created) / (1000 * 60 * 60 * 24))
      usageDays.value = diff > 0 ? diff + 1 : 1
      // 同步到 localStorage
      const info = JSON.parse(localStorage.getItem('userInfo') || '{}')
      info.createdAt = data.createdAt
      localStorage.setItem('userInfo', JSON.stringify(info))
    }
  } catch (err) {
    console.error('[HomePage] 获取用户信息失败:', err.message)
    // 降级：尝试从 localStorage 读取
    try {
      const info = JSON.parse(localStorage.getItem('userInfo') || '{}')
      if (info.createdAt) {
        const created = new Date(info.createdAt)
        const now = new Date()
        const diff = Math.floor((now - created) / (1000 * 60 * 60 * 24))
        usageDays.value = diff > 0 ? diff + 1 : 1
      }
    } catch {}
  }
}

const stats = ref({
  today: { salesAmount: 0, orderCount: 0, purchaseAmount: 0, purchaseCount: 0, adSpend: null, cloudOrderCount: null, estimatedProfit: null, warehouseBreakdown: [] },
  yesterday: { salesAmount: 0, orderCount: 0, purchaseAmount: 0, purchaseCount: 0, adSpend: null, cloudOrderCount: null, estimatedProfit: null, warehouseBreakdown: [] },
  yesterdayFull: { salesAmount: 0, orderCount: 0, purchaseAmount: 0, purchaseCount: 0, adSpend: null, cloudOrderCount: null, estimatedProfit: null, warehouseBreakdown: [] },
  thisMonth: { salesAmount: 0, orderCount: 0, purchaseAmount: 0, purchaseCount: 0, adSpend: null, cloudOrderCount: null, estimatedProfit: null, warehouseBreakdown: [] },
  lastMonth: { salesAmount: 0, orderCount: 0, purchaseAmount: 0, purchaseCount: 0, adSpend: null, cloudOrderCount: null, estimatedProfit: null, warehouseBreakdown: [] },
  thisYear: { salesAmount: 0, orderCount: 0, purchaseAmount: 0, purchaseCount: 0, adSpend: null, cloudOrderCount: null, estimatedProfit: null, warehouseBreakdown: [] },
  lastYear: { salesAmount: 0, orderCount: 0, purchaseAmount: 0, purchaseCount: 0, adSpend: null, cloudOrderCount: null, estimatedProfit: null, warehouseBreakdown: [] }
})
const overviewPeriod = ref('today')
const overviewRefreshing = ref(false)
// 格式化金额
function formatMoney(val) {
  return Number(val || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatOrderCountPlain(s) {
  const total = Number(s?.orderCount || 0)
  const warehouses = Array.isArray(s?.warehouseBreakdown) ? s.warehouseBreakdown : []
  if (!warehouses.length) return `${total} 笔订单`
  const details = warehouses.map(item => `${item.warehouse} ${Number(item.count || 0)}笔`)
  return `共 ${total} 笔，${details.join('，')}`
}

function formatPurchaseCount(s) {
  return `共 ${Number(s?.purchaseCount || 0)} 笔采购单`
}

function hasMetricValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function formatMetricMoney(value) {
  return hasMetricValue(value) ? `¥ ${formatMoney(value)}` : '--'
}

function formatAdSpendStatus(period) {
  if (period?.adTotalStoreCount === 0) return '暂无启用的京东店铺'
  if (!hasMetricValue(period?.adSpend)) return '暂未同步到快车消耗'
  const synced = Number(period?.adSyncedStoreCount)
  const total = Number(period?.adTotalStoreCount)
  if (Number.isFinite(synced) && Number.isFinite(total) && total > 0) {
    return `已同步 ${synced}/${total} 家店铺`
  }
  return period?.adSpendUpdatedAt ? `更新于 ${period.adSpendUpdatedAt}` : '数据已同步'
}

function formatProfitStatus(period) {
  if (!hasMetricValue(period?.estimatedProfit)) return '等待快车消耗同步'
  const rate = hasMetricValue(period?.estimatedProfitRate)
    ? Number(period.estimatedProfitRate)
    : (Number(period?.salesAmount || 0) > 0
        ? Number(period.estimatedProfit) / Number(period.salesAmount) * 100
        : 0)
  return `预估毛利率 ${rate.toFixed(1)}%`
}

function formatTrendText(percent, compareLabel) {
  const value = Number(percent || 0)
  if (value === 0) return `较${compareLabel}持平`
  return `较${compareLabel}${value > 0 ? '增长' : '下降'} ${Math.abs(value)}%`
}

// 计算环比
function calcPct(curr, prev) {
  const c = Number(curr || 0)
  const p = Number(prev || 0)
  if (p === 0) return c > 0 ? 100 : 0
  return Math.round((c - p) / p * 1000) / 10
}

const overviewPeriodConfig = {
  today: { current: 'today', previous: 'yesterday', label: '今日', compareLabel: '昨日同期' },
  yesterday: { current: 'yesterdayFull', previous: null, label: '昨日', compareLabel: '', hasComparison: false },
  month: { current: 'thisMonth', previous: 'lastMonth', label: '本月', compareLabel: '上月同期' },
  year: { current: 'thisYear', previous: 'lastYear', label: '本年', compareLabel: '去年同期' }
}

const activePeriodConfig = computed(() => overviewPeriodConfig[overviewPeriod.value] || overviewPeriodConfig.today)
const activePeriodStats = computed(() => stats.value[activePeriodConfig.value.current] || {})
const previousPeriodStats = computed(() => stats.value[activePeriodConfig.value.previous] || {})
const activeOverviewStats = computed(() => calculateDashboardProfit(activePeriodStats.value))

const overviewPeriodLabel = computed(() => activePeriodConfig.value.label)
const overviewCompareLabel = computed(() => activePeriodConfig.value.compareLabel)
const activeSalesTrendPct = computed(() => (
  calcPct(activePeriodStats.value.salesAmount, previousPeriodStats.value.salesAmount)
))
const activePurchaseTrendPct = computed(() => (
  calcPct(activePeriodStats.value.purchaseAmount, previousPeriodStats.value.purchaseAmount)
))

async function loadStats({ force = false } = {}) {
  try {
    const data = await get('/api/dashboard-stats', force ? { _ts: Date.now() } : undefined)
    if (data) {
      stats.value = { ...stats.value, ...data }
    }
    return true
  } catch (err) {
    console.error('[HomePage] 加载统计失败:', err.message)
    return false
  } finally {
    // 服务端升级前或短暂不可用时，也保留本机刚成功取得的今日/本月快车消耗。
    applyLocalJdExpressPeriods(getLatestLocalJdExpressPeriods())
  }
}

function applyLocalJdExpressPeriods(localPeriods) {
  if (!localPeriods) return
  for (const [key, values] of Object.entries(localPeriods)) {
    stats.value[key] = { ...stats.value[key], ...values }
  }
}

async function loadOverviewStats() {
  await loadStats()
}

async function refreshOverviewStats() {
  if (overviewRefreshing.value) return
  overviewRefreshing.value = true
  try {
    const succeeded = await loadStats({ force: true })
    if (succeeded) ElMessage.success('经营概览已刷新')
    else ElMessage.warning('刷新失败，请稍后重试')
  } finally {
    overviewRefreshing.value = false
  }
}

const pendingInvoiceTotal = ref(0)
const pendingInvoices = ref([])
const invoiceLoading = ref(false)
const countdownNow = ref(Date.now())

function formatInvoiceAmount(value) {
  return Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
}

function getCountdownDiff(endTime) {
  const end = Number(endTime)
  return Number.isFinite(end) && end > 0 ? end - countdownNow.value : null
}

function formatInvoiceCountdown(endTime) {
  const diff = getCountdownDiff(endTime)
  if (diff === null) return '待同步'
  const isOverdue = diff <= 0
  const totalSeconds = Math.floor(Math.abs(diff) / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const clock = [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':')
  if (isOverdue) return `已超时 ${days}天 ${clock}`
  return days > 0 ? `${days}天 ${clock}` : clock
}

function countdownClass(endTime) {
  const diff = getCountdownDiff(endTime)
  if (diff !== null && diff <= 0) return 'is-overdue'
  if (diff !== null && diff < 3 * 24 * 60 * 60 * 1000) return 'is-urgent'
  return ''
}

async function openInvoiceOrder(invoice) {
  if (!invoice?.storeId || !/^\d{10,30}$/.test(String(invoice?.orderId || ''))) {
    ElMessage.warning('订单信息不完整，请等待重新同步')
    return
  }
  try {
    const result = await window.electronAPI.invoke('open-store-backend-url', {
      storeId: invoice.storeId,
      url: 'https://shop.jd.com/jdm/finance/consumerInvoice/cinvoiceOrder',
      title: `${invoice.storeName || '京东店铺'} - 店铺后台`,
      focusExisting: false
    })
    if (result?.success === false) throw new Error(result.message || '打开失败')
  } catch (err) {
    ElMessage.error('打开发票页面失败: ' + err.message)
  }
}

async function loadPendingInvoiceTotal() {
  invoiceLoading.value = true
  try {
    const data = await fetchAftersaleMetrics({ _ts: Date.now() })
    const invoiceList = Array.isArray(data?.pendingInvoices) ? data.pendingInvoices : []
    const storeTotal = Array.isArray(data?.list)
      ? data.list.reduce((total, store) => total + Number(store?.pendingConsumerInvoices || 0), 0)
      : 0
    const summaryTotal = Number(data?.summary?.totalPendingConsumerInvoices || 0)
    pendingInvoiceTotal.value = Math.max(summaryTotal, storeTotal, invoiceList.length)
    pendingInvoices.value = invoiceList
  } catch (err) {
    console.error('[HomePage] 加载待开发票总数失败:', err.message)
  } finally {
    invoiceLoading.value = false
  }
}

// ===== 销售趋势图表 =====
const trendData = ref([])
const hoverIdx = ref(-1)
const chartContainer = ref(null)

// 图表尺寸
const chartW = 760
const chartH = 370
const padL = 56
const padR = 48
const padT = 20
const padB = 36
const plotW = chartW - padL - padR
const plotH = chartH - padT - padB

async function loadTrend() {
  try {
    const data = await get('/api/sales-trend')
    if (data && data.list) {
      trendData.value = data.list
    }
  } catch (err) {
    console.error('[HomePage] 加载趋势失败:', err.message)
  }
}

// Y 轴最大值
const maxAmount = computed(() => {
  const m = Math.max(...trendData.value.map(d => d.amount), 1)
  return m
})
const maxCount = computed(() => {
  const m = Math.max(...trendData.value.map(d => d.count), 1)
  return m
})

// 格式化金额缩写
function fmtShort(v) {
  if (v >= 10000) return (v / 10000).toFixed(1) + 'w'
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
  return Math.round(v).toString()
}

// 左 Y 轴刻度（销售额）— 顶部最大，底部0
const yAxisLeft = computed(() => {
  const m = maxAmount.value
  return [m, m * 3 / 4, m / 2, m / 4, 0].map(fmtShort)
})

// 右 Y 轴刻度（订单数）— 顶部最大，底部0
const yAxisRight = computed(() => {
  const m = maxCount.value
  return [Math.round(m), Math.round(m * 3 / 4), Math.round(m / 2), Math.round(m / 4), 0].map(String)
})

// 柱状图宽度
const barW = computed(() => {
  const n = trendData.value.length
  if (n === 0) return 0
  return Math.min(16, plotW / n * 0.5)
})

// X 坐标
function dotX(i) {
  const n = trendData.value.length
  if (n <= 1) return padL + plotW / 2
  return padL + (plotW / (n - 1)) * i
}

// 柱状图 X 坐标
function barX(i) {
  return dotX(i) - barW.value / 2
}

// 柱状图 Y 坐标
function barY(amount) {
  return padT + plotH - (amount / maxAmount.value) * plotH
}

// 柱状图高度
function barH(amount) {
  return (amount / maxAmount.value) * plotH
}

// 曲线 Y 坐标
function dotY(count) {
  return padT + plotH - (count / maxCount.value) * plotH
}

// 平滑曲线路径（Catmull-Rom 样条 → 三次贝塞尔）
const linePath = computed(() => {
  const pts = trendData.value.map((d, i) => ({ x: dotX(i), y: dotY(d.count) }))
  if (pts.length < 2) return pts.length === 1 ? `M ${pts[0].x},${pts[0].y}` : ''
  let path = `M ${pts[0].x},${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    path += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
  }
  return path
})

// Tooltip 位置
const tooltipX = computed(() => {
  if (hoverIdx.value < 0) return 0
  const x = dotX(hoverIdx.value)
  return x > chartW - padR - 160 ? x - 160 : x + 10
})
const tooltipY = computed(() => {
  if (hoverIdx.value < 0) return 0
  const d = trendData.value[hoverIdx.value]
  const y = dotY(d.count)
  return y > chartH - 80 ? y - 70 : y + 10
})

onMounted(() => {
  loadUserInfo()
  loadOverviewStats()
  loadTrend()
  loadPendingInvoiceTotal()
  handleJdExpressSpendSynced = (event) => {
    const localPeriods = event?.detail?.localPeriods
    applyLocalJdExpressPeriods(localPeriods)
    if (event?.detail?.serverSaved) loadStats()
  }
  window.addEventListener('jd-express-spend-synced', handleJdExpressSpendSynced)
  if (window.electronAPI?.onUpdate) {
    unsubscribeMetricUpdated = window.electronAPI.onUpdate('aftersale-metric-updated', event => {
      if (event?.metric !== 'pending_consumer_invoices') return
      clearTimeout(invoiceMetricRefreshTimer)
      invoiceMetricRefreshTimer = setTimeout(() => {
        loadPendingInvoiceTotal()
      }, 100)
    })
  }
  countdownTimer = setInterval(() => {
    countdownNow.value = Date.now()
  }, 1000)
  // 每5分钟自动刷新统计数据
  refreshTimer = setInterval(() => {
    loadOverviewStats()
    loadTrend()
    loadPendingInvoiceTotal()
  }, 5 * 60 * 1000)
})

onUnmounted(() => {
  if (handleJdExpressSpendSynced) {
    window.removeEventListener('jd-express-spend-synced', handleJdExpressSpendSynced)
    handleJdExpressSpendSynced = null
  }
  if (unsubscribeMetricUpdated) {
    unsubscribeMetricUpdated()
    unsubscribeMetricUpdated = null
  }
  if (invoiceMetricRefreshTimer) {
    clearTimeout(invoiceMetricRefreshTimer)
    invoiceMetricRefreshTimer = null
  }
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
})
</script>

<style scoped>
.home-page {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* 欢迎卡片 */
.welcome-card {
  background: #fff;
  padding: 24px 32px;
  border-radius: 12px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.welcome-left {
  display: flex;
  align-items: center;
  gap: 20px;
}

.welcome-avatar {
  width: 64px;
  height: 64px;
  background: #eaf0fd;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.welcome-title {
  font-size: 22px;
  font-weight: 700;
  color: #1f2937;
  margin: 0 0 6px;
}

.welcome-desc {
  font-size: 14px;
  color: #6b7280;
  margin: 0;
}

/* 可切换经营概览卡片 */
.overview-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.overview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 2px;
}

.overview-heading {
  display: flex;
  align-items: center;
  gap: 8px;
}

.overview-title {
  color: #1f2937;
  font-size: 16px;
  font-weight: 600;
}

.overview-refresh {
  color: #64748b;
}

.overview-refresh:hover {
  color: #2b5aed;
  border-color: #aebfff;
  background: #f3f6ff;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.overview-kpi-card {
  min-width: 0;
  padding: 18px 20px;
  background: #fff;
  border: 1px solid #f0f0f0;
  border-radius: 12px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  transition: box-shadow 0.2s ease, transform 0.2s ease;
}

.overview-kpi-card:hover {
  box-shadow: 0 5px 16px rgba(31, 41, 55, 0.08);
  transform: translateY(-1px);
}

.overview-kpi-content {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.overview-kpi-info {
  min-width: 0;
}

.overview-kpi-label {
  margin: 0 0 8px;
  color: #6b7280;
  font-size: 14px;
}

.overview-kpi-label.is-with-help {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.overview-profit-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #f59e0b;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  cursor: help;
  user-select: none;
}

.overview-kpi-value {
  margin: 0;
  color: #1f2937;
  font-size: 28px;
  font-weight: 700;
  white-space: nowrap;
}

.overview-kpi-value.is-profit:not(.is-placeholder) {
  color: #10b981;
}

.overview-kpi-value.is-profit.is-negative {
  color: #e5484d;
}

.overview-kpi-value.is-placeholder {
  color: #b6bdc9;
}

.overview-kpi-sub {
  min-height: 38px;
  margin: 4px 0 0;
  color: #9ca3af;
  font-size: 13px;
  line-height: 19px;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.overview-kpi-icon {
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  transition: transform 0.2s ease;
}

.overview-kpi-card:hover .overview-kpi-icon {
  transform: scale(1.06);
}

.overview-kpi-icon.is-sales {
  color: #2b5aed;
  background: #eaf0fd;
}

.overview-kpi-icon.is-purchase {
  color: #722ed1;
  background: #f2edff;
}

.overview-kpi-icon.is-ad {
  color: #fa8c16;
  background: #fff7e6;
}

.overview-kpi-icon.is-profit {
  color: #10b981;
  background: #ecfdf5;
}

.overview-kpi-footer {
  min-height: 20px;
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.overview-trend.up {
  color: #f5222d;
}

.overview-trend.down {
  color: #10b981;
}

.overview-kpi-note {
  color: #9ca3af;
}

.overview-status {
  color: #b7791f;
}

.overview-status.is-ready {
  color: #10b981;
}

@media (max-width: 1280px) {
  .overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .overview-toolbar,
  .overview-heading {
    align-items: flex-start;
  }

  .overview-toolbar {
    flex-direction: column;
  }

  .overview-grid {
    grid-template-columns: 1fr;
  }
}





/* 图表区域 */
.chart-card {
  background: #fff;
  border-radius: 12px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  overflow: hidden;
}

.chart-header {
  padding: 16px 24px;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chart-header-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.chart-title {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}

.chart-subtitle {
  font-size: 12px;
  color: #9ca3af;
}

.chart-legend {
  display: flex;
  gap: 16px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #6b7280;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.legend-bar {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  opacity: 0.6;
}

.legend-line {
  width: 14px;
  height: 3px;
  border-radius: 2px;
}

.chart-body {
  padding: 12px 20px 8px;
  min-height: 260px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sales-trend-body {
  min-height: 310px;
}

.invoice-summary {
  display: block;
  padding: 10px 12px;
  overflow: hidden;
}

.invoice-list {
  width: 100%;
  height: 295px;
  overflow-y: auto;
  padding-right: 4px;
}

.invoice-item {
  padding: 10px 12px;
  border: 1px solid #e4eaf5;
  border-radius: 8px;
  background: #fafcff;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.invoice-item + .invoice-item {
  margin-top: 8px;
}

.invoice-item:hover {
  border-color: #cbd8fa;
  background: #f7f9ff;
}

.invoice-item-top,
.invoice-details-line,
.invoice-order-wrap,
.invoice-top-status,
.invoice-amount-wrap,
.invoice-title,
.invoice-company {
  display: flex;
  align-items: center;
  min-width: 0;
}

.invoice-item-top,
.invoice-details-line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.invoice-top-status {
  justify-content: space-between;
  gap: 12px;
}

.invoice-amount-wrap {
  gap: 6px;
}

.invoice-amount-wrap .invoice-inline-label {
  margin-right: 0;
}

.invoice-details-line {
  margin-top: 7px;
}

.invoice-order-wrap,
.invoice-title,
.invoice-company {
  flex: 1;
}

.invoice-order-wrap {
  flex: 0 1 auto;
}

.invoice-title,
.invoice-company {
  flex: 1 1 0;
}

.invoice-inline-label {
  flex: 0 0 auto;
  margin-right: 8px;
  color: #8b95a7;
  font-size: 12px;
}

.invoice-field-value {
  min-width: 0;
  color: #303744;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.invoice-order-link {
  min-width: 0;
  width: max-content;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: #2b5aed;
  cursor: pointer;
  font: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.invoice-order-link:hover {
  text-decoration: underline;
}

.invoice-amount {
  flex: 0 0 auto;
  color: #f56c2d;
  font-weight: 600;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.invoice-countdown {
  flex: 0 0 auto;
  color: #2b5aed;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.invoice-countdown.is-urgent,
.invoice-countdown.is-overdue {
  color: #e5484d;
}

.invoice-waiting {
  height: 252px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #374151;
}

.invoice-waiting strong {
  color: #2b5aed;
  font-size: 48px;
  line-height: 1;
}

.invoice-waiting small {
  color: #9ca3af;
}

.trend-svg {
  width: 100%;
  height: auto;
}

.axis-label {
  font-size: 10px;
  fill: #9ca3af;
}

.bar-rect {
  transition: opacity 0.2s;
}

.bar-rect:hover {
  opacity: 0.3 !important;
}

.line-dot {
  cursor: pointer;
  transition: r 0.15s;
}

.line-dot:hover {
  r: 5;
}

.tooltip-text {
  font-size: 11px;
}

.chart-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: #d0d0d0;
}

.chart-empty p {
  margin: 0;
  font-size: 14px;
}
</style>
