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
      <div class="header-right">
        <el-button type="warning" @click="handleSyncAll" :loading="syncing" :disabled="syncing">
          <el-icon><Refresh /></el-icon>
          {{ syncing && syncProgress ? syncProgress : '同步所有店铺' }}
        </el-button>
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
        <el-form-item label="店铺标签">
          <el-select v-model="filterForm.storeTag" placeholder="全部标签" clearable style="width: 160px">
            <el-option
              v-for="tag in storeTagOptions"
              :key="tag"
              :label="tag"
              :value="tag"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="店铺">
          <el-select v-model="filterForm.storeId" placeholder="全部店铺" clearable style="width: 200px">
            <el-option
              v-for="store in filteredStoreOptions"
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
          <span v-if="lastUpdateTime" class="update-time">最近更新: {{ lastUpdateTime }}</span>
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
        <el-table-column label="平台" width="80" align="center">
          <template #default="{ row }">
            <span>{{ platformLabel(row.platform) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="超时订单" width="100" align="center">
          <template #default="{ row }">
            <span :class="clickableClass(row.overdueOrders)" @click="openBackend(row, 'overdueOrders')">{{ row.overdueOrders || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待回复催单" width="110" align="center">
          <template #default="{ row }">
            <span :class="clickableClass(row.pendingFollowUps)" @click="openBackend(row, 'pendingFollowUps')">{{ row.pendingFollowUps || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="取消订单" width="100" align="center">
          <template #default="{ row }">
            <span :class="clickableClass(row.cancelledOrders)" @click="openBackend(row, 'cancelledOrders')">{{ row.cancelledOrders || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待审核售后" width="110" align="center">
          <template #default="{ row }">
            <span :class="clickableClass(row.pendingReviewAftersales)" @click="openBackend(row, 'pendingReviewAftersales')">{{ row.pendingReviewAftersales || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待处理售后" width="110" align="center">
          <template #default="{ row }">
            <span :class="clickableClass(row.pendingProcessAftersales)" @click="openBackend(row, 'pendingProcessAftersales')">{{ row.pendingProcessAftersales || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待回复纠纷" width="110" align="center">
          <template #default="{ row }">
            <span :class="clickableClass(row.pendingReplyDisputes)" @click="openBackend(row, 'pendingReplyDisputes')">{{ row.pendingReplyDisputes || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待举证纠纷" width="110" align="center">
          <template #default="{ row }">
            <span :class="clickableClass(row.pendingEvidenceDisputes)" @click="openBackend(row, 'pendingEvidenceDisputes')">{{ row.pendingEvidenceDisputes || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待处理警告" width="110" align="center">
          <template #default="{ row }">
            <span :class="clickableClass(row.pendingWarnings)" @click="openBackend(row, 'pendingWarnings')">{{ row.pendingWarnings || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="待处理违规" width="110" align="center">
          <template #default="{ row }">
            <span :class="clickableClass(row.pendingViolations)" @click="openBackend(row, 'pendingViolations')">{{ row.pendingViolations || '-' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Service, Search, Refresh } from '@element-plus/icons-vue'
import { fetchAftersaleMetrics } from '@/api/aftersale'
import { fetchStores } from '@/api/store'

const loading = ref(false)
const syncing = ref(false)
const syncProgress = ref('')
const storeOptions = ref([])
const tableData = ref([])
const lastUpdateTime = ref('')

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
  storeId: '',
  storeTag: ''
})

// 从所有店铺中提取唯一标签
const storeTagOptions = computed(() => {
  const tagSet = new Set()
  for (const s of storeOptions.value) {
    let tags = s.tags
    if (typeof tags === 'string') {
      try { tags = JSON.parse(tags) } catch { tags = null }
    }
    if (Array.isArray(tags)) {
      tags.forEach(t => { if (t && typeof t === 'string') tagSet.add(t.trim()) })
    }
  }
  return [...tagSet].sort()
})

// 按标签过滤后的店铺列表
const filteredStoreOptions = computed(() => {
  if (!filterForm.storeTag) return storeOptions.value
  return storeOptions.value.filter(s => {
    let tags = s.tags
    if (typeof tags === 'string') {
      try { tags = JSON.parse(tags) } catch { tags = null }
    }
    return Array.isArray(tags) && tags.some(t => t && t.trim() === filterForm.storeTag)
  })
})

// 标签变更时联动
watch(() => filterForm.storeTag, () => {
  if (filterForm.storeId && filterForm.storeTag) {
    const inFiltered = filteredStoreOptions.value.some(s => s.id === filterForm.storeId)
    if (!inFiltered) filterForm.storeId = ''
  }
  loadData()
})

function platformLabel(platform) {
  const labels = { jd: '京东', pdd: '拼多多', taobao: '淘宝', tmall: '天猫', douyin: '抖音' }
  return labels[platform] || platform || '-'
}

function alertClass(val) {
  return val > 0 ? 'alert-value' : 'muted-value'
}

function clickableClass(val) {
  if (val > 0) return 'clickable-value'
  return 'muted-value'
}

// 指标字段到京东后台URL的映射
const BACKEND_URL_MAP = {
  overdueOrders: 'https://shop.jd.com/jdm/trade/risk/warning-center?type=sendGoodsWorning&secondType=sendGoodsWorningOvertime',
  pendingFollowUps: 'https://shop.jd.com/jdm/trade/risk/warning-center',
  cancelledOrders: 'https://shop.jd.com/jdm/trade/after-sale/independent-after-sale/list?tabCode=waitAudit',
  pendingReviewAftersales: 'https://shop.jd.com/jdm/trade/after-sale/independent-after-sale/list?tabCode=waitProcess',
  pendingProcessAftersales: 'https://shop.jd.com/jdm/trade/after-sale/independent-after-sale/list?tabCode=waitProcess',
  pendingReplyDisputes: 'https://shop.jd.com/jdm/trade/after-sale/trade-dispute/list?tabCode=WAIT_REPLY',
  pendingEvidenceDisputes: 'https://shop.jd.com/jdm/trade/after-sale/trade-dispute/list?tabCode=WAIT_EVIDENCE',
  pendingWarnings: 'https://illegal-jdm.shop.jd.com/legal?tabsActiveName=6',
  pendingViolations: 'https://illegal-jdm.shop.jd.com/legal?tabsActiveName=2'
}

function openBackend(row, field) {
  const val = row[field]
  if (!val || val <= 0) return
  const url = BACKEND_URL_MAP[field]
  if (!url) return

  const storeName = row.storeName || ''
  window.electronAPI.invoke('open-store-backend-url', {
    storeId: row.storeId,
    url,
    title: `${storeName} - ${field}`
  }).catch(err => {
    console.error('[商家售后纠纷] 打开后台页面失败:', err.message)
  })
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
    const params = {}
    if (filterForm.storeId) params.store_id = filterForm.storeId
    const res = await fetchAftersaleMetrics(params)
    if (res) {
      let list = res.list || []
      // 按标签客户端过滤
      if (filterForm.storeTag) {
        list = list.filter(row => {
          const tags = row.tags || []
          return tags.some(t => t && t.trim() === filterForm.storeTag)
        })
      }
      tableData.value = list

      const s = res.summary || {}
      summary.totalOverdueOrders = s.totalOverdueOrders || 0
      summary.totalPendingFollowUps = s.totalPendingFollowUps || 0
      summary.totalPendingReviewAftersales = s.totalPendingReviewAftersales || 0
      summary.totalPendingProcessAftersales = s.totalPendingProcessAftersales || 0
      summary.totalPendingReplyDisputes = s.totalPendingReplyDisputes || 0
      summary.totalPendingWarnings = s.totalPendingWarnings || 0
      summary.totalPendingViolations = s.totalPendingViolations || 0

      // 最近更新时间
      const updateTimes = list.filter(r => r.updatedAt).map(r => new Date(r.updatedAt))
      if (updateTimes.length > 0) {
        const latest = updateTimes.reduce((a, b) => a > b ? a : b)
        lastUpdateTime.value = latest.toLocaleString('zh-CN')
      } else {
        lastUpdateTime.value = ''
      }
    }
  } catch (err) {
    console.error('[商家售后纠纷] 加载失败:', err.message, err)
    ElMessage.error('加载数据失败：' + (err.message || '未知错误'))
  } finally {
    loading.value = false
  }
}

async function handleSyncAll() {
  syncing.value = true
  syncProgress.value = ''

  const jdStores = storeOptions.value.filter(s => s.platform === 'jd')
  if (jdStores.length === 0) {
    ElMessage.warning('没有京东店铺可供同步')
    syncing.value = false
    return
  }

  let successCount = 0
  let failCount = 0
  let skipCount = 0

  for (let i = 0; i < jdStores.length; i++) {
    const store = jdStores[i]
    syncProgress.value = `正在同步 ${i + 1}/${jdStores.length}：${store.name}`
    try {
      const result = await window.electronAPI.invoke('fetch-aftersale-metrics', { storeId: store.id })
      if (result.success) {
        successCount++
        // 每成功一个店铺就刷新表格，实时展示数据
        loadData()
      } else if (result.message && result.message.includes('Cookie')) {
        skipCount++
      } else {
        failCount++
        console.warn('[商家售后纠纷] 同步失败:', store.name, result.message)
      }
    } catch (err) {
      failCount++
      console.error('[商家售后纠纷] 同步异常:', store.name, err.message)
    }
  }

  syncing.value = false
  syncProgress.value = ''

  if (successCount > 0) {
    const parts = [`${successCount}个成功`]
    if (failCount > 0) parts.push(`${failCount}个失败`)
    if (skipCount > 0) parts.push(`${skipCount}个未登录跳过`)
    ElMessage.success(`同步完成：${parts.join('，')}`)
  } else if (skipCount > 0 && failCount === 0) {
    ElMessage.warning(`${skipCount}个京东店铺均未登录，请先在「店铺管理」中登录京东后台`)
  } else {
    ElMessage.error(`同步失败：${failCount}个失败${skipCount > 0 ? `，${skipCount}个未登录跳过` : ''}`)
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
  filterForm.storeTag = ''
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

.header-right {
  display: flex;
  gap: 8px;
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

.update-time {
  font-size: 12px;
  color: #909399;
  font-weight: 400;
}

.alert-value {
  color: #f56c6c;
  font-weight: 600;
}

.clickable-value {
  color: #f56c6c;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
}

.clickable-value:hover {
  color: #e04040;
}

.muted-value {
  color: #c0c4cc;
}
</style>