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
          <p class="welcome-desc">今天是你使用店小二网店管家的第 1 天，目前有 {{ todoCount }} 项待办任务需要处理。</p>
        </div>
      </div>
      <div class="welcome-stats">
        <div class="welcome-stat-item">
          <p class="ws-label">待办任务</p>
          <p class="ws-number">8 / 12</p>
        </div>
        <div class="welcome-stat-item">
          <p class="ws-label">今日消息</p>
          <p class="ws-number">24</p>
        </div>
        <div class="welcome-stat-item">
          <p class="ws-label">系统指数</p>
          <p class="ws-number green">98%</p>
        </div>
      </div>
    </div>

    <!-- KPI 统计卡片 -->
    <div class="kpi-grid">
      <div class="kpi-card" v-for="item in kpiData" :key="item.label">
        <div class="kpi-content">
          <div class="kpi-info">
            <p class="kpi-label">{{ item.label }}</p>
            <h3 class="kpi-value">{{ item.value }}</h3>
          </div>
          <div class="kpi-icon" :style="{ background: item.iconBg }">
            <el-icon :size="22" :color="item.iconColor"><component :is="item.icon" /></el-icon>
          </div>
        </div>
        <div class="kpi-footer">
          <span class="kpi-trend" :class="item.trendType">
            <el-icon :size="12"><component :is="item.trendIcon" /></el-icon>
            {{ item.trend }}
          </span>
          <span class="kpi-compare">较上月同期</span>
        </div>
      </div>
    </div>

    <!-- 图表区域 -->
    <el-row :gutter="24">
      <el-col :span="16">
        <div class="chart-card">
          <div class="chart-header">
            <span class="chart-title">销售趋势</span>
          </div>
          <div class="chart-body">
            <el-empty description="图表区域，后续完善" />
          </div>
        </div>
      </el-col>
      <el-col :span="8">
        <div class="chart-card">
          <div class="chart-header">
            <span class="chart-title">最新订单</span>
          </div>
          <div class="chart-body">
            <el-empty description="订单列表，后续完善" />
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import {
  UserFilled,
  ShoppingCart,
  DataLine,
  Service,
  ShoppingBag,
  Top,
  Bottom
} from '@element-plus/icons-vue'

const todoCount = 8
const currentUser = localStorage.getItem('currentUser') || '管理员'

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 9) return '早安'
  if (hour < 12) return '上午好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
})

const kpiData = [
  {
    label: '本月销售额',
    value: '¥ 128,450.00',
    icon: DataLine,
    iconBg: '#eaf0fd',
    iconColor: '#2b5aed',
    trend: '12.5%',
    trendType: 'up',
    trendIcon: Top
  },
  {
    label: '今日订单数',
    value: '256',
    icon: ShoppingCart,
    iconBg: '#f0f5ff',
    iconColor: '#722ed1',
    trend: '8.2%',
    trendType: 'up',
    trendIcon: Top
  },
  {
    label: '待处理售后',
    value: '5',
    icon: Service,
    iconBg: '#fff7e6',
    iconColor: '#fa8c16',
    trend: '3.1%',
    trendType: 'down',
    trendIcon: Bottom
  },
  {
    label: '待入库采购单',
    value: '3',
    icon: ShoppingBag,
    iconBg: '#fff1f0',
    iconColor: '#f5222d',
    trend: '1.2%',
    trendType: 'down',
    trendIcon: Bottom
  }
]
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

.welcome-stats {
  display: flex;
  gap: 48px;
  margin-right: 32px;
}

.welcome-stat-item {
  text-align: right;
}

.ws-label {
  font-size: 13px;
  color: #9ca3af;
  margin: 0 0 4px;
}

.ws-number {
  font-size: 22px;
  font-weight: 600;
  color: #1f2937;
  margin: 0;
}

.ws-number.green {
  color: #10b981;
}

/* KPI 卡片 */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
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
  font-size: 24px;
  font-weight: 700;
  color: #1f2937;
  margin: 0;
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
  color: #10b981;
}

.kpi-trend.down {
  color: #f5222d;
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
}

.chart-title {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}

.chart-body {
  padding: 24px;
  min-height: 300px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
