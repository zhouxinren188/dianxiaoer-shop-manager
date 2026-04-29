<template>
  <div class="store-manage-page">
    <div class="page-header">
      <h2 class="page-title">店铺管理</h2>
      <p class="page-desc">管理名下所有网店的基本信息与经营状态</p>
    </div>

    <div class="search-card">
      <el-form :model="searchForm" inline>
        <el-form-item label="店铺名称">
          <el-input v-model="searchForm.name" placeholder="请输入店铺名称" clearable />
        </el-form-item>
        <el-form-item label="经营状态">
          <el-select v-model="searchForm.status" placeholder="全部状态" clearable>
            <el-option label="启用" value="enabled" />
            <el-option label="停用" value="disabled" />
          </el-select>
        </el-form-item>
        <el-form-item label="在线状态">
          <el-select v-model="searchForm.online" placeholder="全部" clearable>
            <el-option label="在线" :value="1" />
            <el-option label="离线" :value="0" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">
            <el-icon><Search /></el-icon>
            查询
          </el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>
    </div>

    <div class="list-header">
      <span class="list-title">店铺列表 <span class="list-count">共 {{ pageInfo.total }} 家</span></span>
      <el-button type="primary" @click="handleAdd">
        <el-icon><Plus /></el-icon>
        新增店铺
      </el-button>
    </div>

    <div class="store-list" v-loading="loading">
      <div v-if="tableData.length === 0 && !loading" class="empty-state">
        <el-empty description="暂无店铺，点击上方按钮新增" />
      </div>
      <div
        v-for="row in tableData"
        :key="row.id"
        class="store-card"
        :class="{ 'is-disabled': row.status !== 'enabled' }"
      >
        <div class="card-top">
          <div class="card-title-row">
            <div class="card-name-wrap">
              <span class="online-dot" :class="row.online ? 'online' : 'offline'"></span>
              <span class="card-name">{{ row.name }}</span>
              <el-tag
                v-if="row.status !== 'enabled'"
                size="small"
                type="info"
                effect="dark"
                class="status-tag"
              >已停用</el-tag>
            </div>
            <el-switch
              :model-value="row.status === 'enabled'"
              @change="(val) => handleToggleStatus(row, val)"
              inline-prompt
              active-text="启用"
              inactive-text="停用"
            />
          </div>
        </div>

        <div class="card-info">
          <div class="info-grid">
            <div class="info-item">
              <span class="info-label">登录账号</span>
              <span class="info-value">{{ row.account || '-' }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">密码</span>
              <span class="info-value">{{ row.password ? '******' : '-' }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">商家ID</span>
              <span class="info-value">{{ row.merchant_id || '-' }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">店铺ID</span>
              <span class="info-value">{{ row.shop_id || '-' }}</span>
            </div>
          </div>
          <div class="info-row" v-if="row.tags && row.tags.length">
            <span class="info-label">标签</span>
            <span class="info-value tags-value">
              <el-tag
                v-for="tag in row.tags"
                :key="tag"
                size="small"
                type="info"
              >{{ tag }}</el-tag>
            </span>
          </div>
        </div>

        <div class="card-actions">
          <el-button size="small" type="primary" @click="handleLogin(row)">
            <el-icon><Connection /></el-icon>
            登录后台
          </el-button>
          <el-button size="small" @click="handleEdit(row)">
            <el-icon><Edit /></el-icon>
            编辑
          </el-button>
          <el-button size="small" type="danger" plain @click="handleDelete(row)">
            <el-icon><Delete /></el-icon>
            删除
          </el-button>
        </div>
      </div>
    </div>

    <div class="pagination-wrap" v-if="pageInfo.total > 0">
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

    <!-- 登录确认提示条 -->
    <el-alert
      v-if="loginPending.storeId"
      :title="`正在登录「${loginPending.storeName}」，请在弹出的浏览器窗口中完成登录`"
      type="info"
      show-icon
      :closable="false"
      class="login-alert"
    >
      <el-button type="primary" size="small" @click="handleConfirmLogin">确认已登录</el-button>
      <el-button size="small" @click="handleCancelLogin">取消</el-button>
    </el-alert>

    <!-- 新增/编辑弹窗 -->
    <StoreEditDialog
      v-model:visible="editDialogVisible"
      :store-data="editStoreData"
      @saved="loadStores"
    />
  </div>
</template>

<script setup>
import { reactive, ref, onMounted, onUnmounted } from 'vue'
import { Search, Plus, Connection, Edit, Delete } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { fetchStores, createStore, deleteStore, toggleStoreStatus } from '@/api/store'
import StoreEditDialog from './components/StoreEditDialog.vue'

const searchForm = reactive({
  name: '',
  status: '',
  online: ''
})

const pageInfo = reactive({
  page: 1,
  pageSize: 10,
  total: 0
})

const tableData = ref([])
const loading = ref(false)

// 编辑弹窗
const editDialogVisible = ref(false)
const editStoreData = ref(null)

// 登录状态
const loginPending = reactive({
  storeId: null,
  storeName: '',
  platform: ''
})

// IPC 监听取消函数
const removeListeners = []

async function loadStores() {
  loading.value = true
  try {
    const params = {
      page: pageInfo.page,
      pageSize: pageInfo.pageSize,
      ...searchForm
    }
    const data = await fetchStores(params)
    tableData.value = data.list || []
    pageInfo.total = data.total || 0
  } catch (err) {
    ElMessage.error('加载店铺列表失败: ' + err.message)
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  pageInfo.page = 1
  loadStores()
}

function handleReset() {
  searchForm.name = ''
  searchForm.status = ''
  searchForm.online = ''
  handleSearch()
}

async function handleAdd() {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }

  try {
    const now = new Date()
    const timeStr = now.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).replace(/[\/\s:]/g, '')

    // 自动创建店铺（默认京东）
    const result = await createStore({
      name: `京东店铺${timeStr}`,
      platform: 'jd'
    })
    const newStoreId = result.id

    // 直接打开 shop.jd.com
    const openResult = await window.electronAPI.invoke('open-platform-window', {
      storeId: newStoreId,
      platform: 'jd'
    })
    if (!openResult || !openResult.success) {
      throw new Error(openResult?.message || '打开平台窗口失败')
    }

    ElMessage.success('已创建店铺并打开 shop.jd.com，请在弹出的浏览器窗口中登录')
    loadStores()
  } catch (err) {
    ElMessage.error('操作失败: ' + err.message)
  }
}

function handleEdit(row) {
  editStoreData.value = { ...row }
  editDialogVisible.value = true
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(
      `确定要删除店铺「${row.name}」吗？删除后不可恢复。`,
      '删除确认',
      { confirmButtonText: '确定删除', cancelButtonText: '取消', type: 'warning' }
    )
    await deleteStore(row.id)
    ElMessage.success('删除成功')
    loadStores()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.message || '删除失败')
    }
  }
}

async function handleToggleStatus(row, val) {
  const newStatus = val ? 'enabled' : 'disabled'
  try {
    await toggleStoreStatus(row.id, newStatus)
    row.status = newStatus
    ElMessage.success(val ? '已启用' : '已停用')
  } catch (err) {
    ElMessage.error(err.message || '操作失败')
  }
}

function handleLogin(row) {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }
  loginPending.storeId = row.id
  loginPending.storeName = row.name
  loginPending.platform = row.platform
  // 登录按钮保留已有 cookie，并传递账号密码供自动填充
  window.electronAPI.invoke('open-platform-window', {
    storeId: row.id,
    platform: row.platform,
    keepCookie: true,
    account: row.account || '',
    password: row.password || ''
  }).catch(err => {
    ElMessage.error('打开平台窗口失败: ' + err.message)
    loginPending.storeId = null
  })
}

function handleConfirmLogin() {
  if (!loginPending.storeId) return
  window.electronAPI.invoke('confirm-platform-login', {
    storeId: loginPending.storeId,
    platform: loginPending.platform
  }).then(() => {
    ElMessage.success('登录成功，Cookie 已保存')
    loginPending.storeId = null
    loginPending.storeName = ''
    loginPending.platform = ''
    loadStores()
  }).catch(err => {
    ElMessage.error('确认登录失败: ' + err.message)
  })
}

function handleCancelLogin() {
  if (loginPending.storeId) {
    window.electronAPI.invoke('close-platform-window', {
      storeId: loginPending.storeId
    }).catch(() => {})
  }
  loginPending.storeId = null
  loginPending.storeName = ''
  loginPending.platform = ''
}

function handleSizeChange() {
  pageInfo.page = 1
  loadStores()
}

function handlePageChange() {
  loadStores()
}

onMounted(() => {
  loadStores()

  // 监听平台登录成功事件
  if (window.electronAPI?.onUpdate) {
    removeListeners.push(
      window.electronAPI.onUpdate('platform-login-success', ({ storeId }) => {
        loginPending.storeId = null
        loginPending.storeName = ''
        loginPending.platform = ''
        loadStores()
      })
    )
    // 监听心跳状态变化
    removeListeners.push(
      window.electronAPI.onUpdate('store-status-changed', ({ storeId, online }) => {
        const row = tableData.value.find(item => item.id === storeId)
        if (row) row.online = online ? 1 : 0
      })
    )
  }
})

onUnmounted(() => {
  removeListeners.forEach(fn => fn && fn())
})
</script>

<style scoped>
.store-manage-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header {
  margin-bottom: 4px;
}

.page-title {
  font-size: 20px;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 4px;
}

.page-desc {
  font-size: 13px;
  color: #9ca3af;
  margin: 0;
}

/* 搜索区域 */
.search-card {
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}

.search-card :deep(.el-form-item) {
  margin-bottom: 0;
}

/* 列表头部 */
.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.list-title {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}

.list-count {
  font-size: 13px;
  font-weight: 400;
  color: #9ca3af;
  margin-left: 8px;
}

/* 卡片列表 */
.store-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 200px;
}

.empty-state {
  background: #fff;
  border-radius: 12px;
  padding: 48px 24px;
  border: 1px solid #f0f0f0;
}

/* 单个店铺卡片 */
.store-card {
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  transition: box-shadow 0.25s, border-color 0.25s;
}

.store-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  border-color: #e0e0e0;
}

.store-card.is-disabled {
  background: #fafafa;
}

/* 卡片顶部 */
.card-top {
  margin-bottom: 16px;
}

.card-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-name-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-name {
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

.status-tag {
  font-size: 11px;
}

/* 信息区域 */
.card-info {
  margin-bottom: 16px;
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px 24px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-label {
  font-size: 12px;
  color: #9ca3af;
  line-height: 1;
}

.info-value {
  font-size: 14px;
  color: #1f2937;
  font-weight: 500;
  word-break: break-all;
}

.info-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-top: 12px;
}

.info-row .info-label {
  flex-shrink: 0;
  padding-top: 4px;
}

.tags-value {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 操作按钮 */
.card-actions {
  display: flex;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid #f5f5f5;
}

/* 在线状态点 */
.online-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.online-dot.online {
  background-color: #10b981;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
}

.online-dot.offline {
  background-color: #d1d5db;
}

/* 分页 */
.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

/* 登录提示 */
.login-alert {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  width: auto;
  max-width: 600px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  border-radius: 8px;
}

.login-alert .el-button {
  margin-left: 12px;
}
</style>
