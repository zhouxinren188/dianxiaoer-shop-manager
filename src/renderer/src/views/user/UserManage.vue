<template>
  <div class="user-manage-page">
    <div class="page-header">
      <h2 class="page-title">用户管理</h2>
      <p class="page-desc">主账号可新建子账号，并为子账号分配店铺与仓库权限</p>
    </div>

    <el-card class="search-card">
      <el-form :model="searchForm" inline>
        <el-form-item label="用户名">
          <el-input v-model="searchForm.username" placeholder="请输入用户名" clearable />
        </el-form-item>
        <el-form-item label="真实姓名">
          <el-input v-model="searchForm.realName" placeholder="请输入真实姓名" clearable />
        </el-form-item>
        <el-form-item label="账号类型">
          <el-select v-model="searchForm.userType" placeholder="全部类型" clearable>
            <el-option label="主账号" value="master" />
            <el-option label="子账号" value="sub" />
          </el-select>
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="searchForm.role" placeholder="全部角色" clearable>
            <el-option label="超级管理员" value="super_admin" />
            <el-option label="管理员" value="admin" />
            <el-option label="普通员工" value="staff" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="searchForm.status" placeholder="全部状态" clearable>
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
    </el-card>

    <el-card class="table-card">
      <template #header>
        <div class="table-header">
          <span>用户列表</span>
          <el-button type="primary" @click="handleAdd" v-if="currentUser?.userType === 'master' || currentUser?.role === 'super_admin'">
            <el-icon><Plus /></el-icon>
            新增子账号
          </el-button>
        </div>
      </template>

      <el-table :data="tableData" stripe border v-loading="loading">
        <el-table-column prop="username" label="用户名" min-width="120" />
        <el-table-column prop="realName" label="真实姓名" min-width="100" />
        <el-table-column prop="phone" label="手机号" width="125" />
        <el-table-column label="账号类型" width="95" align="center">
          <template #default="{ row }">
            <el-tag :type="row.userType === 'master' ? 'danger' : 'info'" size="small">
              {{ row.userType === 'master' ? '主账号' : '子账号' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="role" label="角色" width="105">
          <template #default="{ row }">
            <el-tag :type="roleType(row.role)" size="small">{{ roleText(row.role) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="已分配店铺" min-width="140">
          <template #default="{ row }">
            <div class="assign-tags">
              <el-tag
                v-for="store in (row.assignedStores || []).slice(0, 2)"
                :key="store.id"
                size="small"
                type="success"
                style="margin-right: 4px; margin-bottom: 2px;"
              >{{ store.name }}</el-tag>
              <el-tag v-if="(row.assignedStores || []).length > 2" size="small" type="info">+{{ row.assignedStores.length - 2 }}</el-tag>
              <span v-if="!(row.assignedStores || []).length" style="color: #c0c4cc;">-</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="已分配仓库" min-width="140">
          <template #default="{ row }">
            <div class="assign-tags">
              <el-tag
                v-for="wh in (row.assignedWarehouses || []).slice(0, 2)"
                :key="wh.id"
                size="small"
                type="warning"
                style="margin-right: 4px; margin-bottom: 2px;"
              >{{ wh.name }}</el-tag>
              <el-tag v-if="(row.assignedWarehouses || []).length > 2" size="small" type="info">+{{ row.assignedWarehouses.length - 2 }}</el-tag>
              <span v-if="!(row.assignedWarehouses || []).length" style="color: #c0c4cc;">-</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="85" align="center">
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
        <el-table-column prop="createdAt" label="创建时间" width="160" />
        <el-table-column label="操作" width="240" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="handleEdit(row)">
              <el-icon><Edit /></el-icon>
              编辑
            </el-button>
            <el-button
              v-if="row.userType === 'sub'"
              link
              type="success"
              @click="handleAssignStore(row)"
            >
              <el-icon><Shop /></el-icon>
              分配店铺
            </el-button>
            <el-button
              v-if="row.userType === 'sub'"
              link
              type="warning"
              @click="handleAssignWarehouse(row)"
            >
              <el-icon><House /></el-icon>
              分配仓库
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
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'
import { Search, Plus, Edit, Delete, Shop, House } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { fetchUsers, deleteUser, toggleUserStatus } from '@/api/user'
import UserEditDialog from './components/UserEditDialog.vue'
import AssignStoreDialog from './components/AssignStoreDialog.vue'
import AssignWarehouseDialog from './components/AssignWarehouseDialog.vue'

const searchForm = reactive({
  username: '',
  realName: '',
  userType: '',
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
const selectedUser = ref(null)

// 当前登录用户（从 localStorage 中解析简单信息）
const currentUser = ref({
  userType: 'master',
  role: 'super_admin'
})

function roleType(role) {
  const map = { super_admin: 'danger', admin: 'warning', staff: '' }
  return map[role] || 'info'
}

function roleText(role) {
  const map = { super_admin: '超级管理员', admin: '管理员', staff: '普通员工' }
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
  searchForm.realName = ''
  searchForm.userType = ''
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

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(
      `确定要删除用户「${row.realName || row.username}」吗？删除后不可恢复。`,
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

.assign-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}
</style>
