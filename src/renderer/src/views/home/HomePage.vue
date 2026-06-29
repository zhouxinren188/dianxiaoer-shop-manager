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

    <!-- KPI 统计卡片 -->
    <div class="kpi-grid">
      <!-- 本月销售 -->
      <div class="kpi-card">
        <div class="kpi-content">
          <div class="kpi-info">
            <p class="kpi-label">本月销售</p>
            <h3 class="kpi-value">¥ {{ formatMoney(stats.thisMonth.salesAmount) }}</h3>
            <p class="kpi-sub" v-html="formatOrderCount(stats.thisMonth)"></p>
          </div>
          <div class="kpi-icon" style="background:#eaf0fd">
            <el-icon :size="22" color="#2b5aed"><DataLine /></el-icon>
          </div>
        </div>
        <div class="kpi-footer">
          <span class="kpi-trend" :class="monthTrendType">
            <el-icon :size="12"><component :is="monthTrendType === 'up' ? Top : Bottom" /></el-icon>
            {{ monthTrendPct }}%
          </span>
          <span class="kpi-compare">较上月同期</span>
        </div>
      </div>

      <!-- 当日销售 -->
      <div class="kpi-card">
        <div class="kpi-content">
          <div class="kpi-info">
            <p class="kpi-label">当日销售</p>
            <h3 class="kpi-value">¥ {{ formatMoney(stats.today.salesAmount) }}</h3>
            <p class="kpi-sub" v-html="formatOrderCount(stats.today)"></p>
          </div>
          <div class="kpi-icon" style="background:#f0f5ff">
            <el-icon :size="22" color="#722ed1"><ShoppingCart /></el-icon>
          </div>
        </div>
        <div class="kpi-footer">
          <span class="kpi-trend" :class="dayTrendType">
            <el-icon :size="12"><component :is="dayTrendType === 'up' ? Top : Bottom" /></el-icon>
            {{ dayTrendPct }}%
          </span>
          <span class="kpi-compare">较昨日同期</span>
        </div>
      </div>
    </div>

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
                <span class="legend-dot" style="background:#fa8c16"></span>
                销售额（¥）
              </span>
              <span class="legend-item">
                <span class="legend-dot" style="background:#2b5aed"></span>
                订单笔数
              </span>
            </div>
          </div>
          <div class="chart-body" ref="chartContainer">
            <svg v-if="trendData.length" :viewBox="`0 0 ${chartW} ${chartH}`" class="trend-svg" preserveAspectRatio="xMidYMid meet">
              <!-- 网格线 -->
              <g class="grid-lines">
                <line v-for="i in 5" :key="'g'+i" :x1="padL" :y1="padT + plotH * (i-1) / 4" :x2="chartW - padR" :y2="padT + plotH * (i-1) / 4" stroke="#f0f0f0" stroke-width="1" />
              </g>

              <!-- 左 Y 轴刻度（销售额） -->
              <text v-for="(v, i) in yAxisLeft" :key="'yl'+i" :x="padL - 8" :y="padT + plotH * i / 4 + 4" text-anchor="end" class="axis-label">¥{{ v }}</text>

              <!-- 右 Y 轴刻度（订单数） -->
              <text v-for="(v, i) in yAxisRight" :key="'yr'+i" :x="chartW - padR + 8" :y="padT + plotH * i / 4 + 4" text-anchor="start" class="axis-label">{{ v }}</text>

              <!-- 柱状图（订单数） -->
              <rect
                v-for="(d, i) in trendData"
                :key="'bar'+i"
                :x="barX(i)"
                :y="barY(d.count)"
                :width="barW"
                :height="barH(d.count)"
                fill="#2b5aed"
                opacity="0.6"
                rx="2"
                class="bar-rect"
                @mouseenter="hoverIdx = i"
                @mouseleave="hoverIdx = -1"
              />

              <!-- 折线图（销售额） -->
              <polyline
                :points="linePoints"
                fill="none"
                stroke="#fa8c16"
                stroke-width="2"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
              <!-- 折线圆点 -->
              <circle
                v-for="(d, i) in trendData"
                :key="'dot'+i"
                :cx="dotX(i)"
                :cy="dotY(d.amount)"
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
                <text :x="tooltipX + 10" :y="tooltipY + 36" fill="#ffb066" class="tooltip-text">销售额：¥{{ formatMoney(trendData[hoverIdx].amount) }}</text>
                <text :x="tooltipX + 10" :y="tooltipY + 50" fill="#7ab8ff" class="tooltip-text">订单数：{{ trendData[hoverIdx].count }} 笔</text>
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
            <span class="chart-title">最新订单</span>
          </div>
          <div class="chart-body">
            <el-empty description="后续完善" />
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { UserFilled, ShoppingCart, DataLine, Top, Bottom } from '@element-plus/icons-vue'
import { get } from '@/api/request'

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
  today: { salesAmount: 0, orderCount: 0, warehouseBreakdown: [] },
  yesterday: { salesAmount: 0, orderCount: 0, warehouseBreakdown: [] },
  thisMonth: { salesAmount: 0, orderCount: 0, warehouseBreakdown: [] },
  lastMonth: { salesAmount: 0, orderCount: 0, warehouseBreakdown: [] }
})

// 格式化金额
function formatMoney(val) {
  return Number(val || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// 格式化订单数（含仓库明细）
function formatOrderCount(s) {
  const total = s.orderCount || 0
  const wh = s.warehouseBreakdown || []
  if (!wh.length) return `${total} 笔订单`
  const parts = wh.map(w => `${w.warehouse} ${w.count}笔`)
  return `共 ${total} 笔，${parts.join('，')}`
}

// 计算环比
function calcPct(curr, prev) {
  const c = Number(curr || 0)
  const p = Number(prev || 0)
  if (p === 0) return c > 0 ? 100 : 0
  return Math.round((c - p) / p * 1000) / 10
}

const monthTrendPct = computed(() => calcPct(stats.value.thisMonth.salesAmount, stats.value.lastMonth.salesAmount))
const monthTrendType = computed(() => stats.value.thisMonth.salesAmount >= stats.value.lastMonth.salesAmount ? 'up' : 'down')

const dayTrendPct = computed(() => calcPct(stats.value.today.salesAmount, stats.value.yesterday.salesAmount))
const dayTrendType = computed(() => stats.value.today.salesAmount >= stats.value.yesterday.salesAmount ? 'up' : 'down')

async function loadStats() {
  try {
    const data = await get('/api/dashboard-stats')
    if (data) {
      stats.value = data
    }
  } catch (err) {
    console.error('[HomePage] 加载统计失败:', err.message)
  }
}

// ===== 销售趋势图表 =====
const trendData = ref([])
const hoverIdx = ref(-1)
const chartContainer = ref(null)

// 图表尺寸
const chartW = 760
const chartH = 320
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
function barY(count) {
  return padT + plotH - (count / maxCount.value) * plotH
}

// 柱状图高度
function barH(count) {
  return (count / maxCount.value) * plotH
}

// 折线 Y 坐标
function dotY(amount) {
  return padT + plotH - (amount / maxAmount.value) * plotH
}

// 折线路径点
const linePoints = computed(() => {
  return trendData.value.map((d, i) => `${dotX(i)},${dotY(d.amount)}`).join(' ')
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
  const y = dotY(d.amount)
  return y > chartH - 80 ? y - 70 : y + 10
})

onMounted(() => {
  loadUserInfo()
  loadStats()
  loadTrend()
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

/* KPI 卡片 */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24px;
}

.kpi-card {
  background: #fff;
  padding: 20px 24px;
  border-radius: 12px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  transition: box-shadow 0.3s;
  cursor: pointer;
}

.kpi-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.kpi-content {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.kpi-label {
  font-size: 14px;
  color: #6b7280;
  margin: 0 0 8px;
}

.kpi-value {
  font-size: 28px;
  font-weight: 700;
  color: #1f2937;
  margin: 0;
}

.kpi-sub {
  font-size: 13px;
  color: #9ca3af;
  margin: 4px 0 0;
}

.kpi-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s;
}

.kpi-card:hover .kpi-icon {
  transform: scale(1.1);
}

.kpi-footer {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.kpi-trend {
  display: flex;
  align-items: center;
  gap: 2px;
  font-weight: 500;
}

.kpi-trend.up {
  color: #f5222d;
}

.kpi-trend.down {
  color: #10b981;
}

.kpi-compare {
  color: #9ca3af;
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

.chart-body {
  padding: 12px 20px 8px;
  min-height: 260px;
  display: flex;
  align-items: center;
  justify-content: center;
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
