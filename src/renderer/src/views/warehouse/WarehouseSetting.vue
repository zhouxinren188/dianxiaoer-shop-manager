<template>
  <div class="warehouse-setting-page">
    <!-- 顶部标题区 -->
    <div class="page-header-card">
      <div class="header-left">
        <div class="header-icon">
          <el-icon :size="22" color="#fff"><OfficeBuilding /></el-icon>
        </div>
        <div class="header-info">
          <h2 class="header-title">仓库信息管理</h2>
          <p class="header-desc">管理所有仓库的基本信息与联系方式</p>
        </div>
      </div>
      <div class="header-actions">
        <el-button @click="handleRefresh">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
        <el-button type="primary" @click="handleAdd">
          <el-icon><Plus /></el-icon>
          新增仓库
        </el-button>
      </div>
    </div>

    <!-- 仓库列表 -->
    <div v-if="warehouseList.length > 0" class="warehouse-list">
      <div
        v-for="(item, index) in warehouseList"
        :key="item.id"
        class="info-card"
      >
        <div class="card-header">
          <div class="card-title">
            <el-tag type="primary" effect="plain" size="small">仓库 {{ index + 1 }}</el-tag>
            <span class="warehouse-name">{{ item.name }}</span>
          </div>
          <div class="card-actions">
            <el-button link type="primary" @click="handleView(item)">
              <el-icon><View /></el-icon>
              查看
            </el-button>
            <el-button link type="primary" @click="handleEdit(item)">
              <el-icon><Edit /></el-icon>
              编辑
            </el-button>
            <el-button link type="danger" @click="handleDelete(item)">
              <el-icon><Delete /></el-icon>
              删除
            </el-button>
          </div>
        </div>

        <div class="card-body">
          <div class="info-row">
            <div class="info-item">
              <div class="info-label">仓库名称</div>
              <div class="info-value">{{ item.name }}</div>
            </div>
            <div class="info-item">
              <div class="info-label">收件人</div>
              <div class="info-value">{{ item.contact }}</div>
            </div>
            <div class="info-item">
              <div class="info-label">手机号码</div>
              <div class="info-value">{{ item.phone }}</div>
            </div>
          </div>
          <div class="info-row">
            <div class="info-item info-item-full">
              <div class="info-label">仓库地址</div>
              <div class="info-value">{{ item.address }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="empty-state">
      <el-empty description="暂无仓库信息">
        <el-button type="primary" @click="handleAdd">
          <el-icon><Plus /></el-icon>
          新增仓库
        </el-button>
      </el-empty>
    </div>

    <!-- 新增/编辑对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="560px"
      align-center
      destroy-on-close
      :close-on-click-modal="false"
    >
      <el-form
        ref="formRef"
        :model="formData"
        :rules="formRules"
        label-width="90px"
        class="warehouse-form"
      >
        <el-form-item label="仓库名称" prop="name">
          <el-input
            v-model="formData.name"
            placeholder="请输入仓库名称"
            maxlength="50"
            show-word-limit
          />
        </el-form-item>
        <el-form-item label="收件人" prop="contact">
          <el-input v-model="formData.contact" placeholder="请输入收件人姓名" />
        </el-form-item>
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="formData.phone" placeholder="请输入手机号码" maxlength="11" />
        </el-form-item>
        <el-form-item label="仓库地址" prop="address">
          <el-input
            v-model="formData.address"
            type="textarea"
            :rows="3"
            placeholder="请输入详细仓库地址"
            maxlength="200"
            show-word-limit
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleSubmit">确定</el-button>
      </template>
    </el-dialog>

    <!-- 查看详情对话框 -->
    <el-dialog
      v-model="viewVisible"
      title="仓库详情"
      width="560px"
      destroy-on-close
    >
      <div class="view-detail">
        <div class="detail-row">
          <div class="detail-item">
            <div class="detail-label">仓库名称</div>
            <div class="detail-value">{{ viewData.name }}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">收件人</div>
            <div class="detail-value">{{ viewData.contact }}</div>
          </div>
        </div>
        <div class="detail-row">
          <div class="detail-item">
            <div class="detail-label">手机号码</div>
            <div class="detail-value">{{ viewData.phone }}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">创建时间</div>
            <div class="detail-value">{{ viewData.createTime }}</div>
          </div>
        </div>
        <div class="detail-row">
          <div class="detail-item detail-item-full">
            <div class="detail-label">仓库地址</div>
            <div class="detail-value">{{ viewData.address }}</div>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import {
  Plus,
  Refresh,
  OfficeBuilding,
  View,
  Edit,
  Delete
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

// 仓库列表数据
const warehouseList = ref([
  {
    id: 'WH001',
    name: '杭州主仓库',
    address: '浙江省杭州市萧山区靖江街道保税大道999号',
    contact: '王建国',
    phone: '13800138001',
    createTime: '2026-01-15 09:30:00'
  },
  {
    id: 'WH002',
    name: '广州分仓',
    address: '广东省广州市白云区石井街道物流园路88号',
    contact: '李晓明',
    phone: '13900139002',
    createTime: '2026-03-20 14:20:00'
  }
])

// 对话框控制
const dialogVisible = ref(false)
const dialogTitle = ref('新增仓库')
const isEdit = ref(false)
const currentId = ref('')

// 查看详情
const viewVisible = ref(false)
const viewData = reactive({
  name: '',
  address: '',
  contact: '',
  phone: '',
  createTime: ''
})

// 表单
const formRef = ref()
const formData = reactive({
  name: '',
  address: '',
  contact: '',
  phone: ''
})

const formRules = {
  name: [
    { required: true, message: '请输入仓库名称', trigger: 'blur' },
    { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
  ],
  contact: [
    { required: true, message: '请输入收件人姓名', trigger: 'blur' }
  ],
  phone: [
    { required: true, message: '请输入手机号码', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号码', trigger: 'blur' }
  ],
  address: [
    { required: true, message: '请输入仓库地址', trigger: 'blur' }
  ]
}

function resetForm() {
  formData.name = ''
  formData.address = ''
  formData.contact = ''
  formData.phone = ''
}

function handleAdd() {
  isEdit.value = false
  currentId.value = ''
  dialogTitle.value = '新增仓库'
  resetForm()
  dialogVisible.value = true
}

function handleEdit(item) {
  isEdit.value = true
  currentId.value = item.id
  dialogTitle.value = '编辑仓库'
  formData.name = item.name
  formData.address = item.address
  formData.contact = item.contact
  formData.phone = item.phone
  dialogVisible.value = true
}

function handleView(item) {
  viewData.name = item.name
  viewData.address = item.address
  viewData.contact = item.contact
  viewData.phone = item.phone
  viewData.createTime = item.createTime
  viewVisible.value = true
}

function handleDelete(item) {
  ElMessageBox.confirm(
    `确定要删除仓库 "${item.name}" 吗？删除后不可恢复。`,
    '删除确认',
    {
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
      type: 'warning'
    }
  ).then(() => {
    const index = warehouseList.value.findIndex(w => w.id === item.id)
    if (index !== -1) {
      warehouseList.value.splice(index, 1)
      ElMessage.success('删除成功')
    }
  }).catch(() => {})
}

function handleSubmit() {
  formRef.value.validate((valid) => {
    if (!valid) return

    if (isEdit.value) {
      const item = warehouseList.value.find(w => w.id === currentId.value)
      if (item) {
        item.name = formData.name
        item.address = formData.address
        item.contact = formData.contact
        item.phone = formData.phone
        ElMessage.success('修改成功')
      }
    } else {
      const newId = 'WH' + String(Date.now()).slice(-6)
      warehouseList.value.push({
        id: newId,
        name: formData.name,
        address: formData.address,
        contact: formData.contact,
        phone: formData.phone,
        createTime: new Date().toLocaleString()
      })
      ElMessage.success('新增成功')
    }
    dialogVisible.value = false
  })
}

function handleRefresh() {
  ElMessage.success('刷新成功')
}
</script>

<style scoped>
.warehouse-setting-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 顶部标题卡片 */
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

.header-actions {
  display: flex;
  gap: 10px;
}

/* 仓库列表 */
.warehouse-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 信息卡片 */
.info-card {
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  transition: box-shadow 0.2s;
}

.info-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid #f0f0f0;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.warehouse-name {
  font-size: 16px;
  font-weight: 600;
  color: #1f2d3d;
}

.card-actions {
  display: flex;
  gap: 4px;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.info-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.info-item-full {
  grid-column: span 3;
}

.info-label {
  font-size: 13px;
  color: #909399;
  line-height: 1.4;
}

.info-value {
  font-size: 14px;
  color: #1f2d3d;
  font-weight: 500;
  line-height: 1.5;
  word-break: break-all;
}

/* 空状态 */
.empty-state {
  background: #fff;
  border-radius: 12px;
  padding: 60px 0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

/* 表单 */
.warehouse-form :deep(.el-input__wrapper),
.warehouse-form :deep(.el-textarea__inner) {
  border-radius: 6px;
}

/* 查看详情 */
.view-detail {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.detail-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24px;
}

.detail-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-item-full {
  grid-column: span 2;
}

.detail-label {
  font-size: 13px;
  color: #909399;
}

.detail-value {
  font-size: 14px;
  color: #1f2d3d;
  font-weight: 500;
  word-break: break-all;
}
</style>
