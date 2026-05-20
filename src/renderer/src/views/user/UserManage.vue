<template>
  <div class="user-manage-page">
    <div class="page-header">
      <h2 class="page-title">用户管理</h2>
      <p class="page-desc">主账号可新建子账号，并为子账号分配店铺与仓库权限</p>
    </div>

    <div class="search-card">
      <el-form :model="searchForm" inline>
        <el-form-item label="用户名">
          <el-input v-model="searchForm.username" placeholder="请输入用户名" clearable />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="searchForm.role" placeholder="全部角色" clearable style="width: 120px">
            <el-option label="管理员" value="admin" />
            <el-option label="普通员工" value="staff" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="searchForm.status" placeholder="全部状态" clearable style="width: 120px">
            <el-option label="启用" value="enabled" />
            <el-option label="停用" value="disabled" />
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
      <span class="list-title">用户列表 <span class="list-count">共 {{ pageInfo.total }} 人</span></span>
      <el-button type="primary" @click="handleAdd" v-if="currentUser?.userType === 'master'">
        <el-icon><Plus /></el-icon>
        新增子账号
      </el-button>
    </div>

    <div class="user-list" v-loading="loading">
      <div v-if="tableData.length === 0 && !loading" class="empty-state">
        <el-empty description="暂无用户，点击上方按钮新增" />
      </div>
      <div
        v-for="row in tableData"
        :key="row.id"
        class="user-card"
        :class="{ 'is-disabled': row.status !== 'enabled' }"
      >
        <div class="card-top">
          <div class="card-title-row">
            <div class="card-name-wrap">
              <span class="card-name">{{ row.username }}</span>
              <el-tag :type="row.userType === 'master' ? 'danger' : 'info'" size="small" effect="dark">
                {{ row.userType === 'master' ? '主账号' : '子账号' }}
              </el-tag>
              <el-tag :type="roleType(row.role)" size="small">{{ roleText(row.role) }}</el-tag>
              <el-tag
                v-if="row.status !== 'enabled'"
                size="small"
                type="info"
                effect="dark"
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
          <div class="info-grid" style="grid-template-columns: repeat(2, 1fr);">
            <div class="info-item">
              <span class="info-label">手机号</span>
              <span class="info-value">{{ row.phone || '-' }}</span>
            </div>
            <div class="info-item">
              <span class="info-label">创建时间</span>
              <span class="info-value">{{ row.createdAt || '-' }}</span>
            </div>
          </div>
          <div class="info-tags-section" v-if="row.userType === 'sub'">
            <div class="info-row">
              <span class="info-label">已分配店铺</span>
              <span class="info-value tags-value">
                <template v-if="(row.assignedStores || []).length">
                  <el-tag
                    v-for="store in row.assignedStores"
                    :key="store.id"
                    size="small"
                    type="success"
                  >{{ store.name }}</el-tag>
                </template>
                <span v-else class="no-data">-</span>
              </span>
            </div>
            <div class="info-row">
              <span class="info-label">已分配仓库</span>
              <span class="info-value tags-value">
                <template v-if="(row.assignedWarehouses || []).length">
                  <el-tag
                    v-for="wh in row.assignedWarehouses"
                    :key="wh.id"
                    size="small"
                    type="warning"
                  >{{ wh.name }}</el-tag>
                </template>
                <span v-else class="no-data">-</span>
              </span>
            </div>
            <div class="info-row">
              <span class="info-label">已分配采购账号</span>
              <span class="info-value tags-value">
                <template v-if="(row.assignedPurchaseAccounts || []).length">
                  <el-tag
                    v-for="acc in row.assignedPurchaseAccounts"
                    :key="acc.id"
                    size="small"
                    type="primary"
                  >{{ acc.account }}</el-tag>
                </template>
                <span v-else class="no-data">-</span>
              </span>
            </div>
          </div>
        </div>

        <div class="card-actions">
          <el-button size="small" type="primary" @click="handleEdit(row)">
            <el-icon><Edit /></el-icon>
            编辑
          </el-button>
          <el-button
            v-if="row.userType === 'sub'"
            size="small"
            type="success"
            @click="handleAssignStore(row)"
          >
            <el-icon><Shop /></el-icon>
            分配店铺
          </el-button>
          <el-button
            v-if="row.userType === 'sub'"
            size="small"
            type="warning"
            @click="handleAssignWarehouse(row)"
          >
            <el-icon><House /></el-icon>
            分配仓库
          </el-button>
          <el-button
            v-if="row.userType === 'sub'"
            size="small"
            @click="handleAssignPurchaseAccount(row)"
          >
            <el-icon><User /></el-icon>
            分配采购账号
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

    <!-- 新增/编辑弹窗 -->
    <UserEditDialog
      v-model:visible="editDialogVisible"
      :user-data="editUserData"
      :current-user="currentUser"
      @saved="loadUsers"
    />

    <!-- 分配店铺弹窗 -->
    <AssignStoreDialog
      v-model:visible="assignStoreVisible"
      :user="selectedUser"
      @saved="loadUsers"
    />

    <!-- 分配仓库弹窗 -->
    <AssignWarehouseDialog
      v-model:visible="assignWarehouseVisible"
      :user="selectedUser"
      @saved="loadUsers"
    />

    <!-- 分配采购账号弹窗 -->
    <AssignPurchaseAccountDialog
      v-model:visible="assignPurchaseAccountVisible"
      :user="selectedUser"
      @saved="loadUsers"
    />
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'
import { Search, Plus, Edit, Delete, Shop, House, User } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { fetchUsers, deleteUser, toggleUserStatus } from '@/api/user'
import UserEditDialog from './components/UserEditDialog.vue'
import AssignStoreDialog from './components/AssignStoreDialog.vue'
import AssignWarehouseDialog from './components/AssignWarehouseDialog.vue'
import AssignPurchaseAccountDialog from './components/AssignPurchaseAccountDialog.vue'

const searchForm = reactive({
  username: '',
  role: '',
  status: ''
})

const pageInfo = reactive({
  page: 1,
  pageSize: 10,
  total: 0
})

const tableData = ref([])
const loading = ref(false)

const editDialogVisible = ref(false)
const editUserData = ref(null)

const assignStoreVisible = ref(false)
const assignWarehouseVisible = ref(false)
const assignPurchaseAccountVisible = ref(false)
const selectedUser = ref(null)

// 当前登录用户（从 localStorage 中解析简单信息）
const currentUser = ref({
  userType: 'master',
  role: 'admin'
})

function roleType(role) {
  const map = { admin: 'warning', staff: '' }
  return map[role] || 'info'
}

function roleText(role) {
  const map = { admin: '管理员', staff: '普通员工' }
  return map[role] || role
}

async function loadUsers() {
  loading.value = true
  try {
    const params = {
      page: pageInfo.page,
      pageSize: pageInfo.pageSize,
      ...searchForm
    }
    const data = await fetchUsers(params)
    tableData.value = data.list || []
    pageInfo.total = data.total || 0
  } catch (err) {
    ElMessage.error('加载用户列表失败: ' + err.message)
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  pageInfo.page = 1
  loadUsers()
}

function handleReset() {
  searchForm.username = ''
  searchForm.role = ''
  searchForm.status = ''
  handleSearch()
}

function handleAdd() {
  editUserData.value = null
  editDialogVisible.value = true
}

function handleEdit(row) {
  editUserData.value = { ...row }
  editDialogVisible.value = true
}

function handleAssignStore(row) {
  selectedUser.value = row
  assignStoreVisible.value = true
}

function handleAssignWarehouse(row) {
  selectedUser.value = row
  assignWarehouseVisible.value = true
}

function handleAssignPurchaseAccount(row) {
  selectedUser.value = row
  assignPurchaseAccountVisible.value = true
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(
      `确定要删除用户「${row.username}」吗？删除后不可恢复。`,
      '删除确认',
      { confirmButtonText: '确定删除', cancelButtonText: '取消', type: 'warning' }
    )
    await deleteUser(row.id)
    ElMessage.success('删除成功')
    loadUsers()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error(err.message || '删除失败')
    }
  }
}

async function handleToggleStatus(row, val) {
  const newStatus = val ? 'enabled' : 'disabled'
  try {
    await toggleUserStatus(row.id, newStatus)
    row.status = newStatus
    ElMessage.success(val ? '已启用' : '已停用')
  } catch (err) {
    ElMessage.error(err.message || '操作失败')
  }
}

function handleSizeChange() {
  pageInfo.page = 1
  loadUsers()
}

function handlePageChange() {
  loadUsers()
}

onMounted(() => {
  // 尝试从 localStorage 获取当前用户信息
  try {
    const userInfo = JSON.parse(localStorage.getItem('userInfo') || '{}')
    if (userInfo.userType) currentUser.value.userType = userInfo.userType
    if (userInfo.role) currentUser.value.role = userInfo.role
  } catch {
    // ignore
  }
  loadUsers()
})
</script>

<style scoped>
.user-manage-page {
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
.user-list {
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

/* 单个用户卡片 */
.user-card {
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  transition: box-shadow 0.25s, border-color 0.25s;
}

.user-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
  border-color: #e0e0e0;
}

.user-card.is-disabled {
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

/* 信息区域 */
.card-info {
  margin-bottom: 16px;
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
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

/* 分配标签区域 */
.info-tags-section {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed #f0f0f0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.info-row .info-label {
  flex-shrink: 0;
  padding-top: 4px;
  min-width: 90px;
}

.tags-value {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.no-data {
  color: #d1d5db;
  font-size: 14px;
}

/* 操作按钮 */
.card-actions {
  display: flex;
  gap: 8px;
  padding-top: 16px;
  border-top: 1px solid #f5f5f5;
}

/* 分页 */
.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
</style>
