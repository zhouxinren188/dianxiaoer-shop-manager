<template>
  <el-dialog
    v-model="visible"
    :title="`为「${user?.realName || user?.username}」分配仓库`"
    width="560px"
    :close-on-click-modal="false"
  >
    <div v-loading="loading">
      <el-input
        v-model="searchName"
        placeholder="搜索仓库名称"
        clearable
        style="margin-bottom: 12px;"
        :prefix-icon="Search"
      />
      <el-table
        :data="filteredWarehouses"
        stripe
        border
        height="320"
        @selection-change="handleSelectionChange"
        ref="tableRef"
      >
        <el-table-column type="selection" width="55" align="center" />
        <el-table-column prop="name" label="仓库名称" min-width="160" />
        <el-table-column prop="code" label="仓库编码" width="120" show-overflow-tooltip />
        <el-table-column prop="location" label="所在地区" min-width="120" show-overflow-tooltip />
        <el-table-column label="状态" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'enabled' ? 'success' : 'info'" size="small">
              {{ row.status === 'enabled' ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="handleSubmit">
        确认分配
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { assignUserWarehouses, fetchUserWarehouses } from '@/api/user'

const props = defineProps({
  visible: Boolean,
  user: Object
})
const emit = defineEmits(['update:visible', 'saved'])

const visible = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val)
})

const loading = ref(false)
const submitting = ref(false)
const warehouseList = ref([])
const searchName = ref('')
const selectedIds = ref([])
const tableRef = ref()

const filteredWarehouses = computed(() => {
  if (!searchName.value) return warehouseList.value
  const kw = searchName.value.trim().toLowerCase()
  return warehouseList.value.filter(w => w.name?.toLowerCase().includes(kw))
})

function handleSelectionChange(selection) {
  selectedIds.value = selection.map(item => item.id)
}

async function loadWarehouses() {
  // 从本地模拟或全局获取仓库列表，实际应由后端接口提供
  // 这里先预留结构，等待后端 /api/warehouses 接口
  return [
    { id: 1, name: '默认仓库', code: 'WH001', location: '浙江省杭州市', status: 'enabled' },
    { id: 2, name: '华东仓', code: 'WH002', location: '江苏省苏州市', status: 'enabled' },
    { id: 3, name: '华南仓', code: 'WH003', location: '广东省深圳市', status: 'enabled' },
    { id: 4, name: '华北仓', code: 'WH004', location: '北京市', status: 'disabled' }
  ]
}

async function loadData() {
  if (!props.user?.id) return
  loading.value = true
  try {
    // 加载全部仓库
    const warehouses = await loadWarehouses()
    warehouseList.value = warehouses

    // 加载该用户已分配的仓库
    const userWarehouses = await fetchUserWarehouses(props.user.id)
    const assignedIds = (userWarehouses || []).map(w => w.id)

    // 回显选中状态
    await nextTick()
    warehouseList.value.forEach(row => {
      if (assignedIds.includes(row.id)) {
        tableRef.value?.toggleRowSelection(row, true)
      }
    })
  } catch (err) {
    ElMessage.error('加载仓库数据失败: ' + err.message)
  } finally {
    loading.value = false
  }
}

async function handleSubmit() {
  if (!props.user?.id) return
  submitting.value = true
  try {
    await assignUserWarehouses(props.user.id, selectedIds.value)
    ElMessage.success('仓库分配成功')
    visible.value = false
    emit('saved')
  } catch (err) {
    ElMessage.error(err.message || '分配失败')
  } finally {
    submitting.value = false
  }
}

watch(() => props.visible, (val) => {
  if (val) {
    searchName.value = ''
    selectedIds.value = []
    loadData()
  }
})
</script>
