<template>
  <div class="store-sales-stats-page">
    <!-- 顶部标题区 -->
    <div class="page-header-card">
      <div class="header-left">
        <div class="header-icon">
          <el-icon :size="22" color="#fff"><TrendCharts /></el-icon>
        </div>
        <div class="header-info">
          <h2 class="header-title">店铺销售统计</h2>
          <p class="header-desc">按店铺维度统计销售数据、订单量及趋势分析</p>
        </div>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-row">
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #1890ff">¥{{ summary.totalSales.toFixed(2) }}</div>
        <div class="stat-label">总销售额</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #67c23a">{{ summary.totalOrders }}</div>
        <div class="stat-label">总订单数</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #e6a23c">¥{{ summary.avgOrderValue.toFixed(2) }}</div>
        <div class="stat-label">平均客单价</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #f56c6c">{{ summary.returnRate }}%</div>
        <div class="stat-label">退货率</div>
      </el-card>
    </div>

    <!-- 筛选区 -->
    <el-card class="filter-card" shadow="never">
      <el-form :model="filterForm" inline class="filter-form">
        <el-form-item label="店铺">
          <el-select v-model="filterForm.store" placeholder="全部店铺" clearable style="width: 180px">
            <el-option label="优选好物旗舰店" value="store1" />
            <el-option label="数码潮流小店" value="store2" />
            <el-option label="家居生活馆" value="store3" />
            <el-option label="潮流服饰店" value="store4" />
          </el-select>
        </el-form-item>
        <el-form-item label="统计周期">
          <el-select v-model="filterForm.period" placeholder="选择周期" style="width: 140px">
            <el-option label="今日" value="today" />
            <el-option label="近7天" value="week" />
            <el-option label="近30天" value="month" />
            <el-option label="本季度" value="quarter" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">
            <el-icon><Search /></el-icon>
            查询
          </el-button>
          <el-button @click="handleReset">
            <el-icon><Refresh /></el-icon>
            重置
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 店铺销售对比表格 -->
    <el-card class="table-card" shadow="never">
      <template #header>
        <div class="table-header">
          <span>店铺销售排行</span>
          <el-radio-group v-model="sortBy" size="small">
            <el-radio-button label="sales">按销售额</el-radio-button>
            <el-radio-button label="orders">按订单数</el-radio-button>
          </el-radio-group>
        </div>
      </template>

      <el-table
        :data="sortedTableData"
        stripe
        border
        v-loading="loading"
        :header-cell-style="{ background: '#f5f7fa', fontWeight: 600 }"
      >
        <el-table-column type="index" label="排名" width="70" align="center" />

        <el-table-column prop="storeName" label="店铺名称" min-width="180" />

        <el-table-column prop="salesAmount" label="销售额" width="140" align="right">
          <template #default="{ row }">
            <span style="color: #f56c6c; font-weight: 600">¥{{ row.salesAmount.toFixed(2) }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="orderCount" label="订单数" width="100" align="center" />

        <el-table-column prop="avgOrderValue" label="客单价" width="110" align="right">
          <template #default="{ row }">
            <span>¥{{ row.avgOrderValue.toFixed(2) }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="soldQty" label="售出件数" width="100" align="center" />

        <el-table-column prop="returnCount" label="退货数" width="90" align="center">
          <template #default="{ row }">
            <span :style="{ color: row.returnCount > 0 ? '#f56c6c' : '#909399' }">{{ row.returnCount }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="returnRate" label="退货率" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.returnRate > 5 ? 'danger' : 'success'" size="small">{{ row.returnRate }}%</el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="trend" label="环比趋势" width="110" align="center">
          <template #default="{ row }">
            <div class="trend-cell">
              <el-icon :size="14" :color="row.trend >= 0 ? '#67c23a' : '#f56c6c'">
                <component :is="row.trend >= 0 ? 'ArrowUp' : 'ArrowDown'" />
              </el-icon>
              <span :style="{ color: row.trend >= 0 ? '#67c23a' : '#f56c6c', fontWeight: 500 }">
                {{ Math.abs(row.trend) }}%
              </span>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="销售占比" width="160" align="center">
          <template #default="{ row }">
            <el-progress :percentage="row.ratio" :color="progressColor" :stroke-width="10" />
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import {
  TrendCharts,
  Search,
  Refresh,
  ArrowUp,
  ArrowDown
} from '@element-plus/icons-vue'

const loading = ref(false)

const summary = reactive({
  totalSales: 256890.60,
  totalOrders: 1865,
  avgOrderValue: 137.74,
  returnRate: 2.8
})

const filterForm = reactive({
  store: '',
  period: 'week'
})

const sortBy = ref('sales')

const tableData = ref([
  { storeName: '优选好物旗舰店', salesAmount: 98560.00, orderCount: 720, avgOrderValue: 136.89, soldQty: 1250, returnCount: 18, returnRate: 2.5, trend: 12.5, ratio: 38.4 },
  { storeName: '数码潮流小店', salesAmount: 67890.50, orderCount: 510, avgOrderValue: 133.12, soldQty: 890, returnCount: 22, returnRate: 4.3, trend: 8.2, ratio: 26.4 },
  { storeName: '家居生活馆', salesAmount: 52340.00, orderCount: 380, avgOrderValue: 137.74, soldQty: 620, returnCount: 8, returnRate: 2.1, trend: -3.5, ratio: 20.4 },
  { storeName: '潮流服饰店', salesAmount: 38100.10, orderCount: 255, avgOrderValue: 149.41, soldQty: 480, returnCount: 12, returnRate: 4.7, trend: 5.6, ratio: 14.8 }
])

const progressColor = [
  { color: '#f56c6c', percentage: 20 },
  { color: '#e6a23c', percentage: 40 },
  { color: '#5cb87a', percentage: 60 },
  { color: '#1989fa', percentage: 80 },
  { color: '#6f7ad3', percentage: 100 }
]

const sortedTableData = computed(() => {
  const data = [...tableData.value]
  if (sortBy.value === 'sales') {
    data.sort((a, b) => b.salesAmount - a.salesAmount)
  } else {
    data.sort((a, b) => b.orderCount - a.orderCount)
  }
  return data
})

function handleSearch() {
  loading.value = true
  setTimeout(() => { loading.value = false }, 300)
}

function handleReset() {
  filterForm.store = ''
  filterForm.period = 'week'
  handleSearch()
}
</script>

<style scoped>
.store-sales-stats-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header-card {
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-icon {
  width: 48px;
  height: 48px;
  background: #1890ff;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  color: #1f2d3d;
  margin: 0 0 4px;
}

.header-desc {
  font-size: 13px;
  color: #909399;
  margin: 0;
}

/* 统计卡片 */
.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.stat-card {
  border-radius: 12px;
  text-align: center;
  padding: 8px 0;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.4;
}

.stat-label {
  font-size: 13px;
  color: #909399;
  margin-top: 4px;
}

/* 筛选 */
.filter-card {
  border-radius: 12px;
}

.filter-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.filter-form :deep(.el-form-item) {
  margin-bottom: 0;
  margin-right: 0;
}

/* 表格 */
.table-card {
  border-radius: 12px;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.trend-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
</style>
