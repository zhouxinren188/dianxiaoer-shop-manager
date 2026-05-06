<template>
  <div class="aftersale-page">
    <!-- 顶部标题区 -->
    <div class="page-header-card">
      <div class="header-left">
        <div class="header-icon">
          <el-icon :size="22" color="#fff"><Service /></el-icon>
        </div>
        <div class="header-info">
          <h2 class="header-title">商家售后纠纷</h2>
          <p class="header-desc">按店铺维度查看售后、纠纷、违规等运营指标</p>
        </div>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-row">
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" :style="{ color: summary.totalOverdueOrders > 0 ? '#f56c6c' : '#fa8c16' }">{{ summary.totalOverdueOrders }}</div>
        <div class="stat-label">总超时订单</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" :style="{ color: summary.totalPendingFollowUps > 0 ? '#f56c6c' : '#fa8c16' }">{{ summary.totalPendingFollowUps }}</div>
        <div class="stat-label">总待回复催单</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" :style="{ color: summary.totalPendingReviewAftersales > 0 ? '#f56c6c' : '#e6a23c' }">{{ summary.totalPendingReviewAftersales }}</div>
        <div class="stat-label">总待审核售后</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" :style="{ color: summary.totalPendingProcessAftersales > 0 ? '#f56c6c' : '#e6a23c' }">{{ summary.totalPendingProcessAftersales }}</div>
        <div class="stat-label">总待处理售后</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" :style="{ color: summary.totalPendingReplyDisputes > 0 ? '#f56c6c' : '#e6a23c' }">{{ summary.totalPendingReplyDisputes }}</div>
        <div class="stat-label">总待回复纠纷</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" :style="{ color: summary.totalPendingWarnings > 0 ? '#f56c6c' : '#fa8c16' }">{{ summary.totalPendingWarnings }}</div>
        <div class="stat-label">总待处理警告</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" :style="{ color: summary.totalPendingViolations > 0 ? '#f56c6c' : '#fa8c16' }">{{ summary.totalPendingViolations }}</div>
        <div class="stat-label">总待处理违规</div>
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
        <el-form-item>
          <el-button type="primary" @click="loadData">
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

    <!-- 店铺售后指标表格 -->
    <el-card class="table-card" shadow="never">
      <template #header>
        <div class="table-header">
          <span>店铺售后纠纷概览</span>
        </div>
      </template>

      <el-table
        :data="tableData"
        stripe
        border
        v-loading="loading"
        :header-cell-style="headerCellStyle"
        style="width: 100%"
      >
        <el-table-column prop="storeName" label="店铺名称" min-width="160" fixed="left" />
        <el-table-column label="店铺标签" width="140" align="center">
          <template #default="{ row }">
            <el-tag v-for="tag in (row.tags || [])" :key="tag" size="small" type="info" style="margin-right: 4px">{{ tag }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="店铺星级" width="160" align="center">
          <template #default="{ row }">
            <el-rate v-if="row.shopRating > 0" :model-value="row.shopRating" disabled allow-half size="small" />
            <span v-else style="color: #c0c4cc">-</span>
          </template>
        </el-table-column>
        <el-table-column label="超时订单" width="100" align="center">
          <template #default="{ row }">
            <span :class="alertClass(row.overdueOrders)">{{ row.overdueOrders || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待回复催单" width="110" align="center">
          <template #default="{ row }">
            <span :class="alertClass(row.pendingFollowUps)">{{ row.pendingFollowUps || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="取消订单" width="100" align="center">
          <template #default="{ row }">
            <span :class="alertClass(row.cancelledOrders)">{{ row.cancelledOrders || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待审核售后" width="110" align="center">
          <template #default="{ row }">
            <span :class="alertClass(row.pendingReviewAftersales)">{{ row.pendingReviewAftersales || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待处理售后" width="110" align="center">
          <template #default="{ row }">
            <span :class="alertClass(row.pendingProcessAftersales)">{{ row.pendingProcessAftersales || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待回复纠纷" width="110" align="center">
          <template #default="{ row }">
            <span :class="alertClass(row.pendingReplyDisputes)">{{ row.pendingReplyDisputes || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待举证纠纷" width="110" align="center">
          <template #default="{ row }">
            <span :class="alertClass(row.pendingEvidenceDisputes)">{{ row.pendingEvidenceDisputes || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待处理警告" width="110" align="center">
          <template #default="{ row }">
            <span :class="alertClass(row.pendingWarnings)">{{ row.pendingWarnings || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待处理违规" width="110" align="center">
          <template #default="{ row }">
            <span :class="alertClass(row.pendingViolations)">{{ row.pendingViolations || '-' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Service, Search, Refresh } from '@element-plus/icons-vue'
import { fetchStoreSalesStats } from '@/api/salesOrder'
import { fetchStores } from '@/api/store'

const loading = ref(false)
const storeOptions = ref([])
const tableData = ref([])

const summary = reactive({
  totalOverdueOrders: 0,
  totalPendingFollowUps: 0,
  totalPendingReviewAftersales: 0,
  totalPendingProcessAftersales: 0,
  totalPendingReplyDisputes: 0,
  totalPendingWarnings: 0,
  totalPendingViolations: 0
})

const filterForm = reactive({
  storeId: ''
})

function alertClass(val) {
  return val > 0 ? 'alert-value' : 'muted-value'
}

function headerCellStyle({ column }) {
  const base = { background: '#f5f7fa', fontWeight: 600 }
  const alertCols = ['超时订单', '待回复催单', '取消订单', '待审核售后', '待处理售后', '待回复纠纷', '待举证纠纷', '待处理警告', '待处理违规']
  if (alertCols.includes(column.label)) {
    base.background = '#fdf6ec'
  }
  return base
}

async function loadData() {
  loading.value = true
  try {
    const params = { period: 'today' }
    if (filterForm.storeId) params.store_id = filterForm.storeId
    const res = await fetchStoreSalesStats(params)
    if (res) {
      const list = res.list || []
      tableData.value = list
      // 汇总统计
      summary.totalOverdueOrders = list.reduce((s, r) => s + (r.overdueOrders || 0), 0)
      summary.totalPendingFollowUps = list.reduce((s, r) => s + (r.pendingFollowUps || 0), 0)
      summary.totalPendingReviewAftersales = list.reduce((s, r) => s + (r.pendingReviewAftersales || 0), 0)
      summary.totalPendingProcessAftersales = list.reduce((s, r) => s + (r.pendingProcessAftersales || 0), 0)
      summary.totalPendingReplyDisputes = list.reduce((s, r) => s + (r.pendingReplyDisputes || 0), 0)
      summary.totalPendingWarnings = list.reduce((s, r) => s + (r.pendingWarnings || 0), 0)
      summary.totalPendingViolations = list.reduce((s, r) => s + (r.pendingViolations || 0), 0)
    }
  } catch (err) {
    console.error('[商家售后纠纷] 加载失败:', err.message, err)
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
    console.error('[商家售后纠纷] 加载店铺列表失败:', err.message)
  }
}

function handleReset() {
  filterForm.storeId = ''
  loadData()
}

onMounted(() => {
  loadStoreOptions()
  loadData()
})
</script>

<style scoped>
.aftersale-page {
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
  background: #e6a23c;
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
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}

.stat-card {
  border-radius: 12px;
  text-align: center;
  padding: 6px 0;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.4;
}

.stat-label {
  font-size: 12px;
  color: #909399;
  margin-top: 2px;
}

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

.table-card {
  border-radius: 12px;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.alert-value {
  color: #f56c6c;
  font-weight: 600;
}

.muted-value {
  color: #c0c4cc;
}
</style>
