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

    <!-- 订单卡片列表 -->
    <div v-loading="loading" class="order-list">
      <el-empty v-if="!loading && tableData.length === 0" description="暂无售后采购单" />

      <div v-for="row in tableData" :key="row.id" class="order-card">
        <!-- 头部行：订单级信息 -->
        <div class="card-header">
          <div class="header-items">
            <span class="header-item">
              <span class="item-label">采购单号</span>
              <span class="item-value mono">{{ row.platform_order_no || '--' }}</span>
            </span>
            <span class="header-item">
              <span class="item-label">采购编号</span>
              <span class="item-value mono">{{ row.purchase_no || '--' }}</span>
            </span>
            <span class="header-item">
              <span class="item-label">卖家</span>
              <span class="item-value">{{ row.account_name || '--' }}</span>
            </span>
            <span class="header-item">
              <span class="item-label">下单时间</span>
              <span class="item-value">{{ formatTime(row.created_at) }}</span>
            </span>
            <span class="header-item">
              <el-tag :type="orderStatusTagType(row.status)" size="small">{{ orderStatusLabel(row.status) }}</el-tag>
            </span>
            <span v-if="row.logistics_no" class="header-item">
              <span class="item-label">物流</span>
              <span class="item-value mono">{{ row.logistics_company || '' }} {{ row.logistics_no }}</span>
            </span>
          </div>
          <el-button type="primary" size="small" @click="handleViewOrder(row)">查看订单</el-button>
        </div>

        <!-- 商品行 -->
        <div class="card-body">
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
          <div class="price-info">
            <div class="price-line">{{ row.purchase_price ? '¥' + row.purchase_price : '--' }} x{{ row.quantity || 1 }}</div>
          </div>
          <div class="aftersale-status-col">
            <el-tag :type="aftersaleTagType(row.aftersale_status)" size="small">
              {{ aftersaleStatusLabel(row.aftersale_status) }}
            </el-tag>
          </div>
          <div class="aftersale-remark-col">
            <span class="remark-text">{{ row.aftersale_remark || '/' }}</span>
          </div>
          <div class="action-col">
            <el-button size="small" @click="handleEditAftersale(row)">修改状态</el-button>
            <el-button size="small" type="danger" @click="handleCloseAftersale(row)">操作完成</el-button>
          </div>
        </div>

        <!-- 收件人信息 -->
        <div v-if="row.shipping_name || row.shipping_address" class="card-footer">
          <el-icon :size="12"><Location /></el-icon>
          <span>收件人：{{ row.shipping_name || '' }} {{ row.shipping_phone || '' }}，{{ row.shipping_address || '' }}</span>
        </div>
      </div>
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

    <!-- 售后编辑对话框 -->
    <el-dialog v-model="editDialogVisible" title="修改售后状态" width="480px" :close-on-click-modal="false" destroy-on-close>
      <el-form label-width="80px">
        <el-form-item label="售后状态">
          <el-select v-model="editForm.aftersale_status" style="width: 100%">
            <el-option v-for="s in aftersaleStatusOptions" :key="s.value" :label="s.label" :value="s.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="售后备注">
          <el-input type="textarea" v-model="editForm.aftersale_remark" :rows="3" placeholder="记录售后现状" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitEdit">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Money, Location } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
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

// 售后编辑
const editDialogVisible = ref(false)
const editForm = ref({ aftersale_status: '', aftersale_remark: '' })
const editingRow = ref(null)

function handleEditAftersale(row) {
  editingRow.value = row
  editForm.value = { aftersale_status: row.aftersale_status, aftersale_remark: row.aftersale_remark || '' }
  editDialogVisible.value = true
}

async function submitEdit() {
  if (!editingRow.value) return
  try {
    await updatePurchaseStatus(editingRow.value.id, {
      aftersale_status: editForm.value.aftersale_status,
      aftersale_remark: editForm.value.aftersale_remark
    })
    editingRow.value.aftersale_status = editForm.value.aftersale_status
    editingRow.value.aftersale_remark = editForm.value.aftersale_remark
    editDialogVisible.value = false
    ElMessage.success('已更新售后状态')
    loadData()
  } catch (err) {
    ElMessage.error('更新失败: ' + (err.message || ''))
  }
}

async function handleCloseAftersale(row) {
  try {
    await ElMessageBox.confirm('确定要关闭此售后吗？关闭后可在采购订单页面重新标记。', '关闭售后', { type: 'warning' })
    await updatePurchaseStatus(row.id, { aftersale_status: 'closed' })
    row.aftersale_status = 'closed'
    ElMessage.success('售后已关闭')
    loadData()
  } catch (e) { /* 取消 */ }
}

async function handleViewOrder(row) {
  if (row.platform === 'taobao' && row.platform_order_no) {
    const refundUrl = `https://refund2.taobao.com/dispute/applyRouter.htm?bizOrderId=${row.platform_order_no}`
    try {
      await window.electronAPI.invoke('open-purchase-url', {
        accountId: row.account_id,
        url: refundUrl,
        title: `淘宝退款 - ${row.platform_order_no}`
      })
    } catch (err) {
      ElMessage.error('打开退款页面失败: ' + (err.message || ''))
    }
  } else {
    router.push('/purchase/orders')
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

/* 订单卡片 */
.order-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.order-card {
  background: #fff;
  border-radius: 10px;
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
  gap: 20px;
  flex-wrap: wrap;
}

.header-item {
  display: flex;
  align-items: center;
  gap: 4px;
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

/* 商品行 */
.card-body {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  gap: 20px;
}

.product-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 2;
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

.price-info {
  flex: 0.5;
  text-align: center;
}

.price-line {
  font-size: 13px;
  color: #303133;
}

.aftersale-status-col {
  flex: 0.8;
  text-align: center;
}

.aftersale-remark-col {
  flex: 1;
  min-width: 0;
}

.remark-text {
  font-size: 12px;
  color: #606266;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  max-width: 200px;
}

.action-col {
  flex: 0.8;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
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
