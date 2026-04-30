<template>
  <div class="purchase-page">
    <!-- 顶部标题区 -->
    <div class="page-header-card">
      <div class="header-left">
        <div class="header-icon">
          <el-icon :size="22" color="#fff"><Document /></el-icon>
        </div>
        <div class="header-info">
          <h2 class="header-title">采购订单管理</h2>
          <p class="header-desc">管理所有采购订单，跟踪物流状态，关联入库操作</p>
        </div>
      </div>
      <div class="header-right">
        <div class="header-account">
          <span class="account-label">采购账号</span>
          <el-select v-model="selectedAccount" placeholder="请选择" size="small" style="width: 160px">
            <el-option v-for="acc in accountList" :key="acc.id" :label="acc.username || '未命名'" :value="acc.id">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <span>{{ acc.username || '未命名' }}</span>
                <el-tag :type="acc.status === 'online' ? 'success' : 'info'" size="small">{{ acc.status === 'online' ? '在线' : '离线' }}</el-tag>
              </div>
            </el-option>
          </el-select>
        </div>
        <el-button type="danger" size="small" @click="handleAccountManage">账号管理</el-button>
        <el-button type="primary" size="small" @click="handleAddAccount">新增账号</el-button>
        <el-button size="small" @click="handleImportAccount">导入账号</el-button>
        <el-button type="primary" @click="handleSync" :loading="syncing">
          <el-icon><Refresh /></el-icon>
          同步采购订单
        </el-button>
      </div>
    </div>

    <!-- 筛选区 -->
    <el-card class="filter-card" shadow="never">
      <el-form :model="filterForm" inline class="filter-form">
        <el-form-item label="采购编号">
          <el-input v-model="filterForm.purchaseNo" placeholder="请输入采购编号" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item label="平台订单号">
          <el-input v-model="filterForm.platformOrderNo" placeholder="请输入平台订单号" clearable style="width: 180px" />
        </el-form-item>
        <el-form-item label="关联销售单号">
          <el-input v-model="filterForm.salesOrderNo" placeholder="请输入销售单号" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item label="采购平台">
          <el-select v-model="filterForm.platform" placeholder="全部" clearable style="width: 130px">
            <el-option label="淘宝/天猫" value="taobao" />
            <el-option label="拼多多" value="pinduoduo" />
            <el-option label="1688" value="1688" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购状态">
          <el-select v-model="filterForm.status" placeholder="全部" clearable style="width: 130px">
            <el-option v-for="s in statusOptions" :key="s.value" :label="s.label" :value="s.value" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">
            <el-icon><Search /></el-icon>
            查询
          </el-button>
          <el-button @click="handleReset">
            <el-icon><RefreshRight /></el-icon>
            重置
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 状态Tab统计 -->
    <div class="status-tabs">
      <span
        v-for="tab in statusTabs"
        :key="tab.value"
        class="status-tab-item"
        :class="{ active: filterForm.status === tab.value }"
        @click="handleStatusTab(tab.value)"
      >
        {{ tab.label }}
        <span class="tab-count">({{ tab.count }})</span>
      </span>
    </div>

    <!-- 数据表格 -->
    <el-card class="table-card" shadow="never">
      <el-table
        :data="pagedData"
        stripe
        border
        v-loading="loading"
        :header-cell-style="{ background: '#f5f7fa', fontWeight: 600 }"
        row-key="id"
      >
        <el-table-column prop="purchase_no" label="采购编号" width="160" align="center">
          <template #default="{ row }">
            <span class="purchase-no">{{ row.purchase_no }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="platform_order_no" label="平台订单号" width="180" align="center">
          <template #default="{ row }">
            <span v-if="row.platform_order_no">{{ row.platform_order_no }}</span>
            <el-tag v-else type="info" size="small">未绑定</el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="goods_name" label="商品名称" min-width="200" show-overflow-tooltip />

        <el-table-column prop="quantity" label="数量" width="70" align="center" />

        <el-table-column prop="purchase_price" label="采购单价" width="100" align="right">
          <template #default="{ row }">
            <span v-if="row.purchase_price" style="color: #f56c6c; font-weight: 600">¥{{ row.purchase_price.toFixed(2) }}</span>
            <span v-else class="text-muted">--</span>
          </template>
        </el-table-column>

        <el-table-column prop="platform" label="采购平台" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="platformTagType(row.platform)" size="small" effect="plain">{{ platformLabel(row.platform) }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="sales_order_no" label="关联销售单号" width="160" align="center">
          <template #default="{ row }">
            <span class="sales-order-link">{{ row.sales_order_no }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="status" label="采购状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="logistics_no" label="物流单号" width="150" align="center">
          <template #default="{ row }">
            <span v-if="row.logistics_no">{{ row.logistics_no }}</span>
            <span v-else class="text-muted">--</span>
          </template>
        </el-table-column>

        <el-table-column prop="created_at" label="创建时间" width="160" align="center">
          <template #default="{ row }">
            <span>{{ formatTime(row.created_at) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="200" align="center" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'shipped'" link type="primary" size="small" @click="handleConfirmReceive(row)">
              确认签收
            </el-button>
            <el-button v-if="row.status === 'received'" link type="success" size="small" @click="handleConfirmStock(row)">
              确认入库
            </el-button>
            <el-button link type="primary" size="small" @click="handleViewDetail(row)">
              详情
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="pageInfo.page"
          v-model:page-size="pageInfo.pageSize"
          :total="pageInfo.total"
          layout="total, sizes, prev, pager, next, jumper"
          :page-sizes="[10, 20, 50]"
          @size-change="handleSizeChange"
          @current-change="handlePageChange"
        />
      </div>
    </el-card>

    <!-- 详情抽屉 -->
    <el-drawer v-model="detailVisible" title="采购订单详情" size="540px" direction="rtl">
      <template v-if="currentRow">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="采购编号">
            <span style="font-weight: 600; color: #e6a23c">{{ currentRow.purchase_no }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="平台订单号">{{ currentRow.platform_order_no || '--' }}</el-descriptions-item>
          <el-descriptions-item label="采购平台">{{ platformLabel(currentRow.platform) }}</el-descriptions-item>
          <el-descriptions-item label="商品名称">{{ currentRow.goods_name }}</el-descriptions-item>
          <el-descriptions-item label="规格">{{ currentRow.sku || '--' }}</el-descriptions-item>
          <el-descriptions-item label="采购数量">{{ currentRow.quantity }}</el-descriptions-item>
          <el-descriptions-item label="采购单价">
            <span v-if="currentRow.purchase_price">¥{{ currentRow.purchase_price.toFixed(2) }}</span>
            <span v-else>--</span>
          </el-descriptions-item>
          <el-descriptions-item label="采购总额">
            <span v-if="currentRow.purchase_price" style="color: #f56c6c; font-weight: 600">¥{{ (currentRow.purchase_price * currentRow.quantity).toFixed(2) }}</span>
            <span v-else>--</span>
          </el-descriptions-item>
          <el-descriptions-item label="关联销售单号">{{ currentRow.sales_order_no }}</el-descriptions-item>
          <el-descriptions-item label="采购状态">
            <el-tag :type="statusTagType(currentRow.status)" size="small">{{ statusLabel(currentRow.status) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="物流公司">{{ currentRow.logistics_company || '--' }}</el-descriptions-item>
          <el-descriptions-item label="物流单号">{{ currentRow.logistics_no || '--' }}</el-descriptions-item>
          <el-descriptions-item label="货源链接">
            <el-link v-if="currentRow.source_url" type="primary" :href="currentRow.source_url" target="_blank">{{ currentRow.source_url }}</el-link>
            <span v-else>--</span>
          </el-descriptions-item>
          <el-descriptions-item label="备注">{{ currentRow.remark || '--' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatTime(currentRow.created_at) }}</el-descriptions-item>
          <el-descriptions-item label="更新时间">{{ formatTime(currentRow.updated_at) }}</el-descriptions-item>
        </el-descriptions>
      </template>
    </el-drawer>

    <!-- 同步采购订单弹窗 -->
    <el-dialog
      v-model="syncDialogVisible"
      title="同步采购订单"
      width="500px"
      align-center
      :close-on-click-modal="false"
    >
      <el-alert
        type="info"
        :closable="false"
        style="margin-bottom: 16px"
        title="同步说明"
        description="系统将通过采购账号Cookie从对应平台获取购买记录，仅匹配已绑定采购编号的订单进行状态同步（物流信息等）。"
      />
      <el-form label-width="100px">
        <el-form-item label="采购平台">
          <el-radio-group v-model="syncForm.platform">
            <el-radio value="taobao">淘宝/天猫</el-radio>
            <el-radio value="pinduoduo">拼多多</el-radio>
            <el-radio value="1688">1688</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="采购账号">
          <el-select v-model="syncForm.accountId" placeholder="请选择采购账号" style="width: 100%">
            <el-option v-for="acc in accountList" :key="acc.id" :label="acc.username || '未命名'" :value="acc.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="syncDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="syncing" @click="handleSyncSubmit">开始同步</el-button>
      </template>
    </el-dialog>

    <!-- 新增账号弹窗 -->
    <el-dialog
      v-model="addAccountVisible"
      title="新增采购账号"
      width="420px"
      align-center
      destroy-on-close
    >
      <el-form label-width="80px">
        <el-form-item label="采购平台">
          <el-select v-model="addAccountForm.platform" placeholder="请选择平台" style="width: 100%">
            <el-option label="淘宝/天猫" value="taobao" />
            <el-option label="拼多多" value="pinduoduo" />
            <el-option label="抖音" value="douyin" />
          </el-select>
        </el-form-item>
        <el-form-item label="账号">
          <el-input v-model="addAccountForm.account" placeholder="请输入登录账号" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="addAccountForm.password" placeholder="请输入登录密码" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addAccountVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!addAccountForm.platform" @click="handleAddAccountSubmit">前往登录</el-button>
      </template>
    </el-dialog>

    <!-- 账号管理弹窗 -->
    <el-dialog
      v-model="accountManageVisible"
      title="采购账号管理"
      width="720px"
      align-center
      destroy-on-close
    >
      <el-table :data="accountList" stripe border size="small" :header-cell-style="{ background: '#f5f7fa', fontWeight: 600 }">
        <el-table-column prop="username" label="账号" width="160" />
        <el-table-column prop="password" label="密码" width="140">
          <template #default="{ row }">
            <span v-if="row.showPwd">{{ row.password }}</span>
            <span v-else>******</span>
            <el-button link size="small" @click="row.showPwd = !row.showPwd" style="margin-left: 4px">
              {{ row.showPwd ? '隐藏' : '查看' }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column prop="platform" label="平台" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="platformTagType(row.platform)" size="small">{{ platformLabel(row.platform) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'online' ? 'success' : 'info'" size="small" effect="light">
              {{ row.status === 'online' ? '在线' : '离线' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" align="center">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="handleLoginAccount(row)">登录</el-button>
            <el-button link type="warning" size="small" @click="handleEditAccount(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDeleteAccount(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="accountManageVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 编辑账号弹窗 -->
    <el-dialog
      v-model="editAccountVisible"
      title="编辑账号"
      width="420px"
      align-center
      destroy-on-close
      :close-on-click-modal="false"
    >
      <el-form label-width="80px">
        <el-form-item label="平台">
          <el-select v-model="editAccountForm.platform" style="width: 100%">
            <el-option label="淘宝/天猫" value="taobao" />
            <el-option label="拼多多" value="pinduoduo" />
            <el-option label="抖音" value="douyin" />
          </el-select>
        </el-form-item>
        <el-form-item label="账号">
          <el-input v-model="editAccountForm.username" placeholder="请输入账号" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="editAccountForm.password" placeholder="请输入密码" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editAccountVisible = false">取消</el-button>
        <el-button type="primary" @click="handleEditAccountSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Document,
  Search,
  Refresh,
  RefreshRight
} from '@element-plus/icons-vue'
import { fetchPurchaseOrders, updatePurchaseStatus, syncPlatformOrders } from '@/api/purchaseOrder'
import { fetchPurchaseAccounts, createPurchaseAccount, updatePurchaseAccount, deletePurchaseAccount } from '@/api/purchaseAccount'

// ==================== 常量配置 ====================

const statusOptions = [
  { label: '待发货', value: 'pending' },
  { label: '已发货', value: 'shipped' },
  { label: '运输中', value: 'in_transit' },
  { label: '已签收', value: 'received' },
  { label: '已入库', value: 'stocked' }
]

// ==================== 状态 ====================

const loading = ref(false)
const syncing = ref(false)
const tableData = ref([])
const selectedAccount = ref('')

// ==================== 账号管理 ====================

const accountManageVisible = ref(false)
const addAccountVisible = ref(false)
const editAccountVisible = ref(false)
const addAccountForm = reactive({ platform: '', account: '', password: '' })
const editAccountForm = reactive({ id: '', platform: '', username: '', password: '' })

const accountList = ref([])

// 从服务器加载采购账号列表
async function loadAccounts() {
  try {
    const data = await fetchPurchaseAccounts()
    accountList.value = (data.list || data || []).map(a => ({
      ...a,
      username: a.account || a.username || '',
      status: a.online ? 'online' : 'offline',
      showPwd: false
    }))
    // 自动选中第一个在线账号
    if (!selectedAccount.value && accountList.value.length > 0) {
      const onlineAcc = accountList.value.find(a => a.status === 'online')
      selectedAccount.value = (onlineAcc || accountList.value[0]).id
    }
  } catch (err) {
    console.warn('加载采购账号失败:', err.message)
  }
}

function handleAccountManage() {
  accountManageVisible.value = true
}

function handleAddAccount() {
  addAccountForm.platform = ''
  addAccountForm.account = ''
  addAccountForm.password = ''
  addAccountVisible.value = true
}

async function handleAddAccountSubmit() {
  if (!addAccountForm.platform) {
    ElMessage.warning('请选择平台')
    return
  }

  try {
    // 先在服务器创建账号记录（包含账号密码），获取ID
    const result = await createPurchaseAccount({
      platform: addAccountForm.platform,
      account: addAccountForm.account,
      password: addAccountForm.password
    })
    const accountId = result.id || result.insertId || Date.now().toString()

    // 通过 Electron 打开平台登录窗口
    if (window.electronAPI) {
      await window.electronAPI.invoke('open-purchase-login-window', {
        accountId: String(accountId),
        platform: addAccountForm.platform
      })
      ElMessage.success('已打开登录窗口，登录完成后关闭窗口即可自动保存')
    } else {
      ElMessage.warning('请在 Electron 环境中使用此功能')
    }

    addAccountVisible.value = false
    // 立即刷新列表，显示刚创建的账号（离线状态）
    await loadAccounts()
  } catch (err) {
    ElMessage.error('创建账号失败: ' + err.message)
  }
}

function handleLoginAccount(row) {
  if (window.electronAPI) {
    window.electronAPI.invoke('open-purchase-login-window', {
      accountId: String(row.id),
      platform: row.platform,
      account: row.username,
      password: row.password
    })
    ElMessage.info('已打开登录窗口')
  } else {
    ElMessage.warning('请在 Electron 环境中使用此功能')
  }
}

function handleEditAccount(row) {
  editAccountForm.id = row.id
  editAccountForm.platform = row.platform
  editAccountForm.username = row.username
  editAccountForm.password = row.password
  editAccountVisible.value = true
}

async function handleEditAccountSubmit() {
  try {
    await updatePurchaseAccount(editAccountForm.id, {
      platform: editAccountForm.platform,
      account: editAccountForm.username,
      password: editAccountForm.password
    })
    editAccountVisible.value = false
    ElMessage.success('账号信息已更新')
    await loadAccounts()
  } catch (err) {
    ElMessage.error('更新失败: ' + err.message)
  }
}

async function handleDeleteAccount(row) {
  try {
    await ElMessageBox.confirm(`确定删除账号 ${row.username}？`, '删除确认', { type: 'warning' })
    await deletePurchaseAccount(row.id)
    ElMessage.success('已删除')
    await loadAccounts()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败: ' + (err.message || ''))
    }
  }
}

function handleImportAccount() {
  ElMessage.info('导入账号功能开发中')
}

// 监听 Electron 主进程登录成功事件，自动刷新列表
let unsubLoginSuccess = null

const filterForm = reactive({
  purchaseNo: '',
  platformOrderNo: '',
  salesOrderNo: '',
  platform: '',
  status: ''
})

const pageInfo = reactive({
  page: 1,
  pageSize: 20,
  total: 0
})

// ==================== 工具方法 ====================

function platformLabel(val) {
  const map = { taobao: '淘宝/天猫', pinduoduo: '拼多多', '1688': '1688', douyin: '抖音' }
  return map[val] || val || '--'
}

function platformTagType(val) {
  const map = { taobao: 'danger', pinduoduo: 'warning', '1688': '', douyin: 'success' }
  return map[val] || 'info'
}

function statusLabel(val) {
  const found = statusOptions.find(s => s.value === val)
  return found ? found.label : val || '--'
}

function statusTagType(val) {
  const map = { pending: 'info', shipped: '', in_transit: 'warning', received: 'success', stocked: 'success' }
  return map[val] || 'info'
}

function formatTime(val) {
  if (!val) return '--'
  const d = new Date(val)
  if (isNaN(d.getTime())) return val
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ==================== 状态Tab ====================

const statusTabs = computed(() => {
  const all = tableData.value.length
  const counts = {}
  for (const row of tableData.value) {
    if (row.status) {
      counts[row.status] = (counts[row.status] || 0) + 1
    }
  }
  return [
    { label: '全部', value: '', count: all },
    ...statusOptions.map(s => ({ label: s.label, value: s.value, count: counts[s.value] || 0 }))
  ]
})

function handleStatusTab(val) {
  filterForm.status = val
  pageInfo.page = 1
}

// ==================== 筛选与分页 ====================

const filteredData = computed(() => {
  let data = tableData.value

  if (filterForm.purchaseNo) {
    data = data.filter(r => r.purchase_no && r.purchase_no.includes(filterForm.purchaseNo))
  }
  if (filterForm.platformOrderNo) {
    data = data.filter(r => r.platform_order_no && r.platform_order_no.includes(filterForm.platformOrderNo))
  }
  if (filterForm.salesOrderNo) {
    data = data.filter(r => r.sales_order_no && r.sales_order_no.includes(filterForm.salesOrderNo))
  }
  if (filterForm.platform) {
    data = data.filter(r => r.platform === filterForm.platform)
  }
  if (filterForm.status) {
    data = data.filter(r => r.status === filterForm.status)
  }

  pageInfo.total = data.length
  return data
})

const pagedData = computed(() => {
  const start = (pageInfo.page - 1) * pageInfo.pageSize
  return filteredData.value.slice(start, start + pageInfo.pageSize)
})

function handleSearch() {
  pageInfo.page = 1
}

function handleReset() {
  filterForm.purchaseNo = ''
  filterForm.platformOrderNo = ''
  filterForm.salesOrderNo = ''
  filterForm.platform = ''
  filterForm.status = ''
  pageInfo.page = 1
}

function handleSizeChange(val) {
  pageInfo.pageSize = val
}

function handlePageChange(val) {
  pageInfo.page = val
}

// ==================== 数据加载 ====================

async function loadData() {
  loading.value = true
  try {
    const data = await fetchPurchaseOrders({ pageSize: 500 })
    tableData.value = data.list || data || []
  } catch (err) {
    console.warn('加载采购订单失败:', err.message)
    tableData.value = []
  } finally {
    loading.value = false
  }
}

// ==================== 操作 ====================

const detailVisible = ref(false)
const currentRow = ref(null)

function handleViewDetail(row) {
  currentRow.value = row
  detailVisible.value = true
}

async function handleConfirmReceive(row) {
  try {
    await ElMessageBox.confirm(`确认签收采购单 ${row.purchase_no}？`, '确认签收', { type: 'info' })
    await updatePurchaseStatus(row.id, { status: 'received' })
    row.status = 'received'
    ElMessage.success('已确认签收')
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('操作失败: ' + (err.message || ''))
    }
  }
}

async function handleConfirmStock(row) {
  try {
    await ElMessageBox.confirm(`确认将采购单 ${row.purchase_no} 的商品入库？入库后将增加对应仓库库存。`, '确认入库', { type: 'warning' })
    await updatePurchaseStatus(row.id, { status: 'stocked' })
    row.status = 'stocked'
    ElMessage.success('已确认入库，库存已更新')
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('操作失败: ' + (err.message || ''))
    }
  }
}

// ==================== 同步功能 ====================

const syncDialogVisible = ref(false)
const syncForm = reactive({
  platform: 'taobao',
  accountId: 'default'
})

function handleSync() {
  syncDialogVisible.value = true
}

async function handleSyncSubmit() {
  syncing.value = true
  try {
    const result = await syncPlatformOrders({
      platform: syncForm.platform,
      account_id: syncForm.accountId
    })
    const count = result?.matched_count || 0
    if (count > 0) {
      ElMessage.success(`同步完成，匹配到 ${count} 条采购订单已更新`)
    } else {
      ElMessage.info('同步完成，暂无新的匹配订单')
    }
    syncDialogVisible.value = false
    await loadData()
  } catch (err) {
    ElMessage.error('同步失败: ' + err.message)
  } finally {
    syncing.value = false
  }
}

// ==================== 生命周期 ====================

onMounted(() => {
  loadData()
  loadAccounts()

  // 监听采购账号登录成功事件
  if (window.electronAPI) {
    unsubLoginSuccess = window.electronAPI.onUpdate('purchase-account-login-success', () => {
      loadAccounts()
    })
  }
})

onUnmounted(() => {
  if (unsubLoginSuccess) {
    unsubLoginSuccess()
    unsubLoginSuccess = null
  }
})
</script>

<style scoped>
.purchase-page {
  min-height: 100%;
  padding: 0;
}

.page-header-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
  color: rgba(255, 255, 255, 0.8);
  font-size: 13px;
  margin: 4px 0 0;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-account {
  display: flex;
  align-items: center;
  gap: 6px;
}

.account-label {
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  white-space: nowrap;
}

.filter-card {
  margin-bottom: 16px;
}

.filter-form :deep(.el-form-item) {
  margin-bottom: 12px;
}

.status-tabs {
  display: flex;
  gap: 4px;
  padding: 10px 16px;
  background: #fff;
  border-radius: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.status-tab-item {
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  color: #606266;
  cursor: pointer;
  transition: all 0.2s;
}

.status-tab-item:hover {
  background: #f0f2f5;
}

.status-tab-item.active {
  background: #409eff;
  color: #fff;
}

.tab-count {
  font-size: 12px;
  opacity: 0.8;
}

.table-card {
  margin-bottom: 16px;
}

.purchase-no {
  color: #e6a23c;
  font-weight: 600;
  font-size: 12px;
}

.sales-order-link {
  color: #409eff;
  font-size: 12px;
}

.text-muted {
  color: #c0c4cc;
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}

.platform-select-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.platform-card {
  border: 2px solid #e4e7ed;
  border-radius: 8px;
  padding: 20px 12px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
}

.platform-card:hover {
  border-color: #409eff;
  background: #f0f7ff;
}

.platform-card.active {
  border-color: #409eff;
  background: #ecf5ff;
}

.platform-card-name {
  display: block;
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 4px;
}

.platform-card-desc {
  display: block;
  font-size: 12px;
  color: #909399;
}
</style>
