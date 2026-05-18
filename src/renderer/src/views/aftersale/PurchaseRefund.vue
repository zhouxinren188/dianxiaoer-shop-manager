<template>
  <div class="aftersale-page">
    <!-- 顶部标题区 -->
    <div class="page-header-card">
      <div class="header-left">
        <div class="header-icon">
          <el-icon :size="22" color="#fff"><Money /></el-icon>
        </div>
        <div class="header-info">
          <h2 class="header-title">采购单退货退款</h2>
          <p class="header-desc">管理采购单售后，跟踪退款退货进度</p>
        </div>
      </div>
    </div>

    <!-- 筛选区 -->
    <el-card class="filter-card" shadow="never">
      <el-form :inline="true" :model="filterForm" size="small">
        <el-form-item label="售后状态">
          <el-select v-model="filterForm.aftersaleStatus" placeholder="全部" clearable style="width: 150px">
            <el-option v-for="s in aftersaleStatusOptions" :key="s.value" :label="s.label" :value="s.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购账号">
          <el-select v-model="filterForm.accountId" placeholder="全部" clearable style="width: 160px">
            <el-option v-for="acc in accountList" :key="acc.id" :label="acc.username || '未命名'" :value="acc.id">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <span>{{ acc.username || '未命名' }}</span>
                <el-tag :type="platformTagType(acc.platform)" size="small">{{ platformLabel(acc.platform) }}</el-tag>
              </div>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="采购平台">
          <el-select v-model="filterForm.platform" placeholder="全部" clearable style="width: 120px">
            <el-option label="淘宝" value="taobao" />
            <el-option label="拼多多" value="pinduoduo" />
            <el-option label="1688" value="1688" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购编号">
          <el-input v-model="filterForm.purchaseNo" placeholder="采购编号" clearable style="width: 140px" />
        </el-form-item>
        <el-form-item label="采购单号">
          <el-input v-model="filterForm.platformOrderNo" placeholder="平台订单号" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="loadData">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 状态 Tabs -->
    <div class="status-tabs">
      <div
        v-for="tab in statusTabs"
        :key="tab.value"
        :class="['status-tab', { active: activeTab === tab.value }]"
        @click="handleTabClick(tab.value)"
      >
        <span class="tab-label">{{ tab.label }}</span>
        <span v-if="tab.count > 0" class="tab-count">{{ tab.count }}</span>
      </div>
    </div>

    <!-- 全局表头 + 卡片列表 -->
    <div class="table-card" v-loading="loading">
      <el-empty v-if="!loading && tableData.length === 0" description="暂无售后采购单" />

      <template v-if="tableData.length > 0">
        <!-- 全局表头 -->
        <div class="order-table-header">
          <div class="ot-col ot-col-goods">商品信息</div>
          <div class="ot-col ot-col-price">单价/数量</div>
          <div class="ot-col ot-col-logistics">物流信息</div>
          <div class="ot-col ot-col-aftersale-status">售后状态</div>
          <div class="ot-col ot-col-aftersale-remark">售后处理日志</div>
          <div class="ot-col ot-col-action">操作</div>
        </div>

        <!-- 订单卡片 -->
        <div v-for="row in tableData" :key="row.id" class="order-card">
          <!-- 头部行：订单级信息 -->
          <div class="card-header">
            <div class="header-items">
              <span class="header-item">
                <span class="item-label">采购编号</span>
                <span class="item-value mono">{{ row.purchase_no || '--' }}</span>
              </span>
              <span class="header-divider">|</span>
              <span class="header-item">
                <span class="item-label">采购账号</span>
                <span class="item-value">{{ row.account_name || '--' }}</span>
              </span>
              <span class="header-divider">|</span>
              <span class="header-item">
                <span class="item-value mono">{{ row.platform_order_no || '--' }}</span>
              </span>
              <span class="header-divider">|</span>
              <span class="header-item">
                <span class="item-value">{{ formatTime(row.created_at) }}</span>
              </span>
              <span class="header-divider">|</span>
              <span class="header-item">
                <el-tag :type="orderStatusTagType(row.status)" size="small">{{ orderStatusLabel(row.status) }}</el-tag>
              </span>
              <span v-if="row.sales_order_status" class="header-item">
                <span class="header-divider">|</span>
                <span class="item-label">销售状态</span>
                <span class="item-value">{{ row.sales_order_status }}</span>
              </span>
            </div>
          </div>

          <!-- 数据行 -->
          <div class="card-body">
            <div class="ot-col ot-col-goods">
              <div class="product-info">
                <el-image
                  v-if="row.goods_image"
                  :src="row.goods_image"
                  fit="cover"
                  class="product-image"
                />
                <div v-else class="product-image placeholder">无图</div>
                <div class="product-detail">
                  <div class="product-name">{{ row.goods_name || '--' }}</div>
                  <el-tag :type="purchaseTypeTagType(row.purchase_type)" size="small" class="type-tag">
                    {{ purchaseTypeLabel(row.purchase_type) }}
                  </el-tag>
                </div>
              </div>
            </div>
            <div class="ot-col ot-col-price">
              <span class="price-line">{{ row.purchase_price ? '¥' + row.purchase_price : '--' }} x{{ row.quantity || 1 }}</span>
            </div>
            <div class="ot-col ot-col-logistics">
              <span class="logistics-text">{{ row.logistics_company || '' }} {{ row.logistics_no || '/' }}</span>
            </div>
            <div class="ot-col ot-col-aftersale-status">
              <el-tag :type="aftersaleTagType(row.aftersale_status)" size="small">
                {{ aftersaleStatusLabel(row.aftersale_status) }}
              </el-tag>
            </div>
            <div class="ot-col ot-col-aftersale-remark">
              <div v-if="parseRemarkLogs(row.aftersale_remark).length === 0" class="remark-empty">暂无日志</div>
              <div v-else class="remark-preview" @click="handleOpenLog(row)">
                <div v-for="(log, i) in parseRemarkLogs(row.aftersale_remark).slice(0, 3)" :key="i" class="remark-log-item">
                  <span class="log-dot" :class="{ 'latest': i === 0 }"></span>
                  <span class="log-content-preview">{{ log.content }}</span>
                </div>
                <span v-if="parseRemarkLogs(row.aftersale_remark).length > 3" class="remark-more">查看更多</span>
              </div>
            </div>
            <div class="ot-col ot-col-action">
              <div class="action-buttons">
                <el-button type="primary" size="small" @click="handleViewOrder(row)">查看订单</el-button>
                <el-button size="small" @click="handleOpenLog(row)">处理日志</el-button>
              </div>
            </div>
          </div>

          <!-- 收件人信息 -->
          <div v-if="row.shipping_name || row.shipping_address" class="card-footer">
            <el-icon :size="12"><Location /></el-icon>
            <span>收件人：{{ row.shipping_name || '' }} {{ row.shipping_phone || '' }}，{{ row.shipping_address || '' }}</span>
          </div>
        </div>
      </template>
    </div>

    <!-- 分页 -->
    <div class="pagination-wrap" v-if="pageInfo.total > 0">
      <el-pagination
        v-model:current-page="pageInfo.page"
        v-model:page-size="pageInfo.pageSize"
        :total="pageInfo.total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        @size-change="loadData"
        @current-change="loadData"
      />
    </div>

    <!-- 售后处理日志弹窗 -->
    <el-dialog v-model="logDialogVisible" title="售后处理日志" width="560px" :close-on-click-modal="false" destroy-on-close>
      <!-- 当前售后状态 -->
      <div class="log-status-bar">
        <span class="log-status-label">当前状态</span>
        <el-tag :type="aftersaleTagType(logRowAftersaleStatus)" size="default">
          {{ aftersaleStatusLabel(logRowAftersaleStatus) }}
        </el-tag>
      </div>

      <!-- 时间线 -->
      <div class="log-timeline">
        <div v-for="(log, i) in currentLogs" :key="i" class="log-timeline-item">
          <div class="timeline-left">
            <span class="timeline-dot" :class="{ 'latest': i === 0 }"></span>
            <div class="timeline-meta">
              <div class="timeline-user">{{ log.user }}</div>
              <div class="timeline-time">{{ log.time }}</div>
            </div>
          </div>
          <div class="timeline-content">{{ log.content }}</div>
        </div>
        <div v-if="currentLogs.length === 0" class="log-empty">暂无处理日志</div>
      </div>

      <!-- 输入区域 -->
      <div class="log-input-area">
        <el-input
          v-model="logInput"
          type="textarea"
          :rows="2"
          placeholder="输入处理日志..."
          clearable
        />
        <div class="log-input-footer">
          <el-select
            v-model="selectedPhrase"
            placeholder="快捷短语"
            size="small"
            clearable
            class="quick-select"
            @change="applyQuickPhrase"
          >
            <el-option
              v-for="phrase in quickPhrases"
              :key="phrase.label"
              :label="phrase.label"
              :value="phrase.label"
            />
          </el-select>
          <el-button type="primary" size="small" @click="submitLog" :loading="logSubmitting">提交</el-button>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Money, Location } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { fetchPurchaseAftersaleOrders, updatePurchaseStatus } from '@/api/purchaseOrder'
import { fetchPurchaseAccounts } from '@/api/purchaseAccount'

const router = useRouter()

// 售后状态选项
const aftersaleStatusOptions = [
  { label: '待申请退款', value: 'pending_refund' },
  { label: '待申请退货退款', value: 'pending_return_refund' },
  { label: '待退货上传单号', value: 'pending_return_tracking' },
  { label: '待商家处理', value: 'pending_merchant_handle' },
  { label: '售后关闭', value: 'closed' }
]

// 订单状态映射
const orderStatusMap = {
  ordered: '已下单', pending: '待发货', shipped: '已发货', in_transit: '运输中',
  received: '已签收', forwarded: '已转发', stocked: '已入库', completed: '已完成',
  rejected: '已拒收', cancelled: '已取消'
}
const orderStatusTagMap = {
  ordered: '', pending: 'info', shipped: '', in_transit: 'warning',
  received: 'success', forwarded: 'primary', stocked: 'success', completed: 'success',
  rejected: 'danger', cancelled: 'danger'
}

function orderStatusLabel(val) { return orderStatusMap[val] || val || '--' }
function orderStatusTagType(val) { return orderStatusTagMap[val] || 'info' }

function aftersaleStatusLabel(val) {
  const found = aftersaleStatusOptions.find(s => s.value === val)
  return found ? found.label : val || '--'
}
function aftersaleTagType(val) {
  const map = { pending_refund: 'danger', pending_merchant_handle: 'warning', pending_return_refund: 'warning', pending_return_tracking: '', closed: 'info' }
  return map[val] || 'info'
}

function purchaseTypeLabel(val) {
  const map = { dropship: '三方代发', warehouse: '仓库转发', warehouse_in: '仓库进货' }
  return map[val] || val || '--'
}
function purchaseTypeTagType(val) {
  const map = { dropship: 'warning', warehouse: 'primary', warehouse_in: 'success' }
  return map[val] || 'info'
}

function platformLabel(val) {
  const map = { taobao: '淘宝', pinduoduo: '拼多多', '1688': '1688' }
  return map[val] || val || '--'
}
function platformTagType(val) {
  const map = { taobao: 'warning', pinduoduo: 'danger', '1688': '' }
  return map[val] || 'info'
}

function formatTime(val) {
  if (!val) return '--'
  return val.replace('T', ' ').substring(0, 16)
}

// 数据状态
const loading = ref(false)
const tableData = ref([])
const accountList = ref([])
const activeTab = ref('all')
const aftersaleStatusCounts = ref({})

const pageInfo = reactive({ page: 1, pageSize: 20, total: 0 })
const filterForm = reactive({ aftersaleStatus: '', accountId: '', platform: '', purchaseNo: '', platformOrderNo: '' })

// 状态 Tabs
const statusTabs = computed(() => {
  const counts = aftersaleStatusCounts.value
  const total = pageInfo.total
  return [
    { label: '全部', value: 'all', count: total },
    { label: '待申请退款', value: 'pending_refund', count: counts.pending_refund || 0 },
    { label: '待申请退货退款', value: 'pending_return_refund', count: counts.pending_return_refund || 0 },
    { label: '待退货上传单号', value: 'pending_return_tracking', count: counts.pending_return_tracking || 0 },
    { label: '待商家处理', value: 'pending_merchant_handle', count: counts.pending_merchant_handle || 0 },
    { label: '售后关闭', value: 'closed', count: counts.closed || 0 }
  ]
})

function handleTabClick(val) {
  activeTab.value = val
  filterForm.aftersaleStatus = val === 'all' ? '' : val
  pageInfo.page = 1
  loadData()
}

function handleReset() {
  filterForm.aftersaleStatus = ''
  filterForm.accountId = ''
  filterForm.platform = ''
  filterForm.purchaseNo = ''
  filterForm.platformOrderNo = ''
  activeTab.value = 'all'
  pageInfo.page = 1
  loadData()
}

// 数据加载
async function loadData() {
  loading.value = true
  try {
    const params = {
      page: pageInfo.page,
      pageSize: pageInfo.pageSize,
      aftersaleStatus: filterForm.aftersaleStatus || undefined,
      accountId: filterForm.accountId || undefined,
      platform: filterForm.platform || undefined,
      purchaseNo: filterForm.purchaseNo || undefined,
      platformOrderNo: filterForm.platformOrderNo || undefined
    }
    const res = await fetchPurchaseAftersaleOrders(params)
    const data = res.data || res
    tableData.value = data.list || []
    pageInfo.total = data.total || 0
    aftersaleStatusCounts.value = data.aftersaleStatusCounts || {}
  } catch (err) {
    console.error('加载售后采购单失败:', err)
    ElMessage.error('加载数据失败')
  } finally {
    loading.value = false
  }
}

async function loadAccounts() {
  try {
    const res = await fetchPurchaseAccounts()
    accountList.value = res.data || res || []
  } catch (e) { /* ignore */ }
}

// 售后处理日志
function parseRemarkLogs(remark) {
  if (!remark) return []
  try {
    const parsed = JSON.parse(remark)
    if (Array.isArray(parsed)) return parsed
  } catch (e) { /* not JSON */ }
  // 旧格式纯文本，包装为单条日志
  return [{ user: '系统', time: '', content: remark }]
}

const logDialogVisible = ref(false)
const currentLogs = ref([])
const logRow = ref(null)
const logInput = ref('')
const logSubmitting = ref(false)
const logPendingStatus = ref('')

const logRowAftersaleStatus = computed(() => {
  if (!logRow.value) return ''
  return logPendingStatus.value || logRow.value.aftersale_status || ''
})

// 快捷短语
const quickPhrases = [
  { label: '京东客户退款，商品已拒收，等待申请退款。', status: 'pending_refund' },
  { label: '京东客户退款，等待申请退货退款。', status: 'pending_return_refund' },
  { label: '已申请退款，等待商家处理。', status: 'pending_merchant_handle' },
  { label: '退货信息：', status: 'pending_return_tracking' },
  { label: '已退货，单号：123456789，等待商家处理。', status: 'pending_merchant_handle' },
  { label: '经查询，售后单已退款成功，售后单关闭。', status: 'closed' }
]

const selectedPhrase = ref('')

function applyQuickPhrase(val) {
  if (!val) {
    logPendingStatus.value = ''
    return
  }
  const phrase = quickPhrases.find(p => p.label === val)
  if (phrase) {
    logInput.value = phrase.label
    logPendingStatus.value = phrase.status
  }
}

function handleOpenLog(row) {
  logRow.value = row
  currentLogs.value = parseRemarkLogs(row.aftersale_remark)
  logInput.value = ''
  logPendingStatus.value = ''
  selectedPhrase.value = ''
  logDialogVisible.value = true
}

async function submitLog() {
  if (!logInput.value.trim() || !logRow.value) return
  logSubmitting.value = true
  try {
    const username = localStorage.getItem('currentUser') || '未知用户'
    const now = new Date()
    const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const newEntry = { user: username, time: timeStr, content: logInput.value.trim() }
    const logs = parseRemarkLogs(logRow.value.aftersale_remark)
    logs.unshift(newEntry)
    const newRemark = JSON.stringify(logs)

    const updateData = { aftersale_remark: newRemark }
    if (logPendingStatus.value) {
      updateData.aftersale_status = logPendingStatus.value
    }
    await updatePurchaseStatus(logRow.value.id, updateData)

    logRow.value.aftersale_remark = newRemark
    if (logPendingStatus.value) {
      logRow.value.aftersale_status = logPendingStatus.value
    }
    currentLogs.value = logs
    logInput.value = ''
    logPendingStatus.value = ''
    selectedPhrase.value = ''
    ElMessage.success('日志已添加')
    loadData()
  } catch (err) {
    ElMessage.error('添加日志失败: ' + (err.message || ''))
  } finally {
    logSubmitting.value = false
  }
}

async function handleViewOrder(row) {
  let url = ''
  let title = ''
  if (row.platform === 'taobao' && row.platform_order_no) {
    url = `https://refund2.taobao.com/dispute/applyRouter.htm?bizOrderId=${row.platform_order_no}`
    title = `淘宝退款 - ${row.platform_order_no}`
  } else if (row.platform === 'pinduoduo' && row.platform_order_no) {
    url = `https://mobile.yangkeduo.com/order.html?order_sn=${row.platform_order_no}`
    title = `拼多多订单 - ${row.platform_order_no}`
  }
  if (!url) {
    router.push('/purchase/orders')
    return
  }
  try {
    await window.electronAPI.invoke('open-purchase-url', {
      accountId: row.account_id,
      url,
      title,
      platform: row.platform
    })
  } catch (err) {
    ElMessage.error('打开页面失败: ' + (err.message || ''))
  }
}

onMounted(() => {
  loadAccounts()
  loadData()
})
</script>

<style scoped>
.aftersale-page {
  min-height: 100%;
}

/* 页面头部 */
.page-header-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(135deg, #e65100 0%, #bf360c 100%);
  border-radius: 12px;
  padding: 24px 28px;
  margin-bottom: 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-icon {
  width: 44px;
  height: 44px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-title {
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  margin: 0;
}

.header-desc {
  color: rgba(255, 255, 255, 0.75);
  font-size: 13px;
  margin: 4px 0 0;
}

/* 筛选区 */
.filter-card {
  margin-bottom: 12px;
}

.filter-card :deep(.el-card__body) {
  padding: 16px 20px 0;
}

/* 状态 Tabs */
.status-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  background: #fff;
  border-radius: 8px;
  padding: 8px 12px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.status-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: #606266;
  transition: all 0.2s;
}

.status-tab:hover {
  background: #f5f7fa;
}

.status-tab.active {
  background: #ecf5ff;
  color: #409eff;
  font-weight: 500;
}

.tab-count {
  background: #e6e8eb;
  color: #606266;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 500;
}

.status-tab.active .tab-count {
  background: #409eff;
  color: #fff;
}

/* ====== 全局表头（参考OrderList.vue样式） ====== */
.table-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.order-table-header {
  display: flex;
  align-items: center;
  background: linear-gradient(180deg, #f8f9fb 0%, #f3f4f6 100%);
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 11px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #374151;
}

.order-table-header .ot-col {
  display: flex;
  align-items: center;
}

/* 列宽定义 - 表头和数据行共用 */
.ot-col-goods {
  width: 340px;
  flex-shrink: 0;
  padding-left: 0;
  padding-right: 8px;
}

.ot-col-price {
  width: 100px;
  flex-shrink: 0;
  justify-content: center !important;
  text-align: center;
}

.ot-col-logistics {
  width: 160px;
  flex-shrink: 0;
}

.ot-col-aftersale-status {
  width: 120px;
  flex-shrink: 0;
  justify-content: center !important;
}

.ot-col-aftersale-remark {
  flex: 1;
  min-width: 120px;
}

.ot-col-action {
  width: 200px;
  flex-shrink: 0;
  justify-content: center !important;
}

/* ====== 订单卡片 ====== */
.order-card {
  background: #fff;
  border-radius: 8px;
  border: 1px solid #ebeef5;
  overflow: hidden;
  transition: box-shadow 0.2s;
}

.order-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

/* 头部行 */
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #fafbfc;
  border-bottom: 1px solid #f0f2f5;
  font-size: 13px;
}

.header-items {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.header-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.header-divider {
  color: #dcdfe6;
  margin: 0 4px;
}

.item-label {
  color: #909399;
  font-size: 12px;
}

.item-value {
  color: #303133;
}

.item-value.mono {
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
}

.action-buttons {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
  width: 100%;
}

.action-buttons .el-button {
  margin-left: 0 !important;
}

/* 数据行 */
.card-body {
  display: flex;
  align-items: center;
  padding: 14px 16px;
}

.card-body .ot-col {
  display: flex;
  align-items: center;
}

.product-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.product-image {
  width: 52px;
  height: 52px;
  border-radius: 6px;
  flex-shrink: 0;
  border: 1px solid #ebeef5;
}

.product-image.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f7fa;
  color: #c0c4cc;
  font-size: 11px;
}

.product-detail {
  min-width: 0;
}

.product-name {
  font-size: 13px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}

.type-tag {
  margin-top: 4px;
}

.price-line {
  font-size: 13px;
  color: #303133;
}

.logistics-text {
  font-size: 12px;
  color: #606266;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}

/* 售后处理日志预览（列表中） */
.remark-empty {
  font-size: 12px;
  color: #c0c4cc;
}

.remark-preview {
  cursor: pointer;
  padding: 4px 0;
}

.remark-preview:hover {
  opacity: 0.8;
}

.remark-log-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 4px;
}

.remark-log-item:last-child {
  margin-bottom: 0;
}

.log-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #c0c4cc;
  flex-shrink: 0;
  margin-top: 5px;
}

.log-dot.latest {
  background: #67c23a;
}

.log-content-preview {
  font-size: 12px;
  color: #606266;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  max-width: 180px;
}

.remark-more {
  font-size: 11px;
  color: #409eff;
  margin-top: 4px;
  display: block;
}

/* 售后处理日志弹窗 - 状态栏 */
.log-status-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: #f5f7fa;
  border-radius: 6px;
  margin-bottom: 12px;
}

.log-status-label {
  font-size: 13px;
  color: #909399;
  font-weight: 500;
}

/* 售后处理日志弹窗 - 时间线 */
.log-timeline {
  max-height: 400px;
  overflow-y: auto;
  padding: 8px 0;
}

.log-timeline-item {
  display: flex;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid #f5f5f5;
}

.log-timeline-item:last-child {
  border-bottom: none;
}

.timeline-left {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
  width: 120px;
}

.timeline-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #dcdfe6;
  flex-shrink: 0;
  margin-top: 3px;
}

.timeline-dot.latest {
  background: #67c23a;
}

.timeline-meta {
  min-width: 0;
}

.timeline-user {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
}

.timeline-time {
  font-size: 12px;
  color: #909399;
  margin-top: 2px;
}

.timeline-content {
  flex: 1;
  font-size: 14px;
  color: #303133;
  line-height: 1.5;
  min-width: 0;
}

.log-empty {
  text-align: center;
  color: #c0c4cc;
  padding: 40px 0;
  font-size: 14px;
}

.log-input-area {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #ebeef5;
}

.log-input-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  gap: 12px;
}

.quick-select {
  flex: 1;
}

/* 底部收件人 */
.card-footer {
  padding: 8px 16px;
  background: #fafbfc;
  border-top: 1px solid #f0f2f5;
  font-size: 12px;
  color: #909399;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 分页 */
.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
