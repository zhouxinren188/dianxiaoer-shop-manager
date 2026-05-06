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
          <p class="header-desc">按店铺维度统计销售数据、订单量（已剔除待付款和已取消订单）</p>
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
    </div>

    <!-- 筛选区 -->
    <el-card class="filter-card" shadow="never">
      <el-form :model="filterForm" inline class="filter-form">
        <el-form-item label="店铺">
          <el-select v-model="filterForm.storeId" placeholder="全部店铺" clearable style="width: 200px">
            <el-option
              v-for="store in storeOptions"
              :key="store.id"
              :label="store.name"
              :value="store.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="统计周期">
          <el-select v-model="filterForm.period" placeholder="选择周期" style="width: 140px" @change="handlePeriodChange">
            <el-option label="今日" value="today" />
            <el-option label="近7天" value="week" />
            <el-option label="近30天" value="month" />
            <el-option label="本季度" value="quarter" />
            <el-option label="自定义" value="custom" />
          </el-select>
          <el-date-picker
            v-if="filterForm.period === 'custom'"
            v-model="filterForm.dateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            style="width: 260px; margin-left: 8px"
            value-format="YYYY-MM-DD"
            :clearable="false"
          />
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

        <el-table-column label="店铺标签" width="160" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.platform" size="small" style="margin-right: 4px">{{ row.platform }}</el-tag>
            <el-tag v-for="tag in (row.tags || [])" :key="tag" size="small" type="info" style="margin-right: 4px">{{ tag }}</el-tag>
          </template>
        </el-table-column>

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

        <el-table-column label="销售占比" width="200" align="center">
          <template #default="{ row }">
            <el-progress :percentage="row.ratio" :color="progressColor" :stroke-width="10" />
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import {
  TrendCharts,
  Search,
  Refresh
} from '@element-plus/icons-vue'
import { fetchStoreSalesStats } from '@/api/salesOrder'
import { fetchStores } from '@/api/store'

const loading = ref(false)
const storeOptions = ref([])

const summary = reactive({
  totalSales: 0,
  totalOrders: 0,
  avgOrderValue: 0
})

const today = new Date().toISOString().slice(0, 10)
const filterForm = reactive({
  storeId: '',
  period: 'today',
  dateRange: [today, today]
})

const sortBy = ref('sales')

const tableData = ref([])

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

async function loadData() {
  loading.value = true
  try {
    const params = {}
    if (filterForm.storeId) params.store_id = filterForm.storeId
    if (filterForm.period === 'custom' && filterForm.dateRange) {
      params.start_date = filterForm.dateRange[0]
      params.end_date = filterForm.dateRange[1]
    } else if (filterForm.period) {
      params.period = filterForm.period
    }

    const res = await fetchStoreSalesStats(params)
    if (res) {
      const { summary: s, list } = res
      summary.totalSales = s?.totalSales || 0
      summary.totalOrders = s?.totalOrders || 0
      summary.avgOrderValue = s?.avgOrderValue || 0
      tableData.value = list || []
    }
  } catch (err) {
    console.error('[店铺销售统计] 加载失败:', err.message, err)
    ElMessage.error('加载数据失败：' + (err.message || '未知错误'))
  } finally {
    loading.value = false
  }
}

async function loadStoreOptions() {
  try {
    const res = await fetchStores({ pageSize: 1000 })
    if (res) {
      storeOptions.value = res.list || []
    }
  } catch (err) {
    console.error('[店铺销售统计] 加载店铺列表失败:', err.message)
  }
}

function handlePeriodChange(val) {
  if (val === 'custom' && !filterForm.dateRange) {
    filterForm.dateRange = [today, today]
  }
}

function handleSearch() {
  loadData()
}

function handleReset() {
  filterForm.storeId = ''
  filterForm.period = 'today'
  filterForm.dateRange = [today, today]
  loadData()
}

onMounted(() => {
  loadStoreOptions()
  loadData()
})
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
  grid-template-columns: repeat(3, 1fr);
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
</style>
