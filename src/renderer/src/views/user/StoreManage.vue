<template>
  <div class="store-manage-page">
    <div class="page-header">
      <h2 class="page-title">店铺管理</h2>
      <p class="page-desc">管理名下所有网店的基本信息与经营状态</p>
    </div>

    <el-card class="search-card">
      <el-form :model="searchForm" inline>
        <el-form-item label="店铺名称">
          <el-input v-model="searchForm.name" placeholder="请输入店铺名称" clearable />
        </el-form-item>
        <el-form-item label="平台类型">
          <el-select v-model="searchForm.platform" placeholder="全部平台" clearable>
            <el-option label="淘宝" value="taobao" />
            <el-option label="天猫" value="tmall" />
            <el-option label="京东" value="jd" />
            <el-option label="拼多多" value="pdd" />
            <el-option label="抖音小店" value="douyin" />
          </el-select>
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
    </el-card>

    <el-card class="table-card">
      <template #header>
        <div class="table-header">
          <span>店铺列表</span>
          <el-button type="primary" @click="handleAdd">
            <el-icon><Plus /></el-icon>
            新增店铺
          </el-button>
        </div>
      </template>

      <el-table :data="tableData" stripe border v-loading="loading">
        <el-table-column prop="name" label="店铺名称" min-width="150" />
        <el-table-column prop="platform" label="所属平台" width="110">
          <template #default="{ row }">
            <el-tag :type="platformType(row.platform)" size="small">{{ platformText(row.platform) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="account" label="登录账号" min-width="130" show-overflow-tooltip />
        <el-table-column prop="merchant_id" label="商家ID" width="120" show-overflow-tooltip />
        <el-table-column prop="shop_id" label="店铺ID" width="120" show-overflow-tooltip />
        <el-table-column label="标签" min-width="150">
          <template #default="{ row }">
            <el-tag
              v-for="tag in (row.tags || [])"
              :key="tag"
              size="small"
              type="info"
              style="margin-right: 4px; margin-bottom: 2px;"
            >{{ tag }}</el-tag>
            <span v-if="!row.tags || row.tags.length === 0" style="color: #c0c4cc;">-</span>
          </template>
        </el-table-column>
        <el-table-column label="在线状态" width="90" align="center">
          <template #default="{ row }">
            <span class="online-dot" :class="row.online ? 'online' : 'offline'"></span>
            {{ row.online ? '在线' : '离线' }}
          </template>
        </el-table-column>
        <el-table-column label="经营状态" width="90" align="center">
          <template #default="{ row }">
            <el-switch
              :model-value="row.status === 'enabled'"
              @change="(val) => handleToggleStatus(row, val)"
              inline-prompt
              active-text="启用"
              inactive-text="停用"
            />
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="handleLogin(row)">
              <el-icon><Connection /></el-icon>
              登录
            </el-button>
            <el-button link type="primary" @click="handleEdit(row)">
              <el-icon><Edit /></el-icon>
              编辑
            </el-button>
            <el-button link type="danger" @click="handleDelete(row)">
              <el-icon><Delete /></el-icon>
              删除
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
import { fetchStores, deleteStore, toggleStoreStatus } from '@/api/store'
import StoreEditDialog from './components/StoreEditDialog.vue'

const searchForm = reactive({
  name: '',
  platform: '',
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

function platformType(platform) {
  const map = { taobao: '', tmall: 'danger', jd: 'primary', pdd: 'success', douyin: 'warning' }
  return map[platform] || 'info'
}

function platformText(platform) {
  const map = { taobao: '淘宝', tmall: '天猫', jd: '京东', pdd: '拼多多', douyin: '抖音小店' }
  return map[platform] || platform
}

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
  searchForm.platform = ''
  searchForm.status = ''
  searchForm.online = ''
  handleSearch()
}

function handleAdd() {
  editStoreData.value = null
  editDialogVisible.value = true
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
  window.electronAPI.invoke('open-platform-window', {
    storeId: row.id,
    platform: row.platform
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
  margin-bottom: 8px;
}

.page-title {
  font-size: 20px;
  font-weight: 600;
  color: #1f2d3d;
  margin: 0 0 4px;
}

.page-desc {
  font-size: 13px;
  color: #909399;
  margin: 0;
}

.search-card {
  border-radius: 8px;
}

.table-card {
  border-radius: 8px;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

.online-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}

.online-dot.online {
  background-color: #67c23a;
  box-shadow: 0 0 4px rgba(103, 194, 58, 0.5);
}

.online-dot.offline {
  background-color: #c0c4cc;
}

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
