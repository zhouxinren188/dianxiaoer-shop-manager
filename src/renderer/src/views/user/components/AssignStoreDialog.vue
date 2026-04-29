<template>
  <el-dialog
    v-model="visible"
    :title="`为「${user?.realName || user?.username}」分配店铺`"
    width="560px"
    :close-on-click-modal="false"
  >
    <div v-loading="loading">
      <el-input
        v-model="searchName"
        placeholder="搜索店铺名称"
        clearable
        style="margin-bottom: 12px;"
        :prefix-icon="Search"
      />
      <el-table
        :data="filteredStores"
        stripe
        border
        height="320"
        @selection-change="handleSelectionChange"
        ref="tableRef"
      >
        <el-table-column type="selection" width="55" align="center" />
        <el-table-column prop="name" label="店铺名称" min-width="140" />
        <el-table-column prop="platform" label="所属平台" width="100">
          <template #default="{ row }">
            <el-tag :type="platformType(row.platform)" size="small">{{ platformText(row.platform) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="account" label="登录账号" min-width="120" show-overflow-tooltip />
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
import { fetchStores } from '@/api/store'
import { assignUserStores, fetchUserStores } from '@/api/user'

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
const storeList = ref([])
const searchName = ref('')
const selectedIds = ref([])
const tableRef = ref()

const filteredStores = computed(() => {
  if (!searchName.value) return storeList.value
  const kw = searchName.value.trim().toLowerCase()
  return storeList.value.filter(s => s.name?.toLowerCase().includes(kw))
})

function platformType(platform) {
  const map = { taobao: '', tmall: 'danger', jd: 'primary', pdd: 'success', douyin: 'warning' }
  return map[platform] || 'info'
}

function platformText(platform) {
  const map = { taobao: '淘宝', tmall: '天猫', jd: '京东', pdd: '拼多多', douyin: '抖音小店' }
  return map[platform] || platform
}

function handleSelectionChange(selection) {
  selectedIds.value = selection.map(item => item.id)
}

async function loadData() {
  if (!props.user?.id) return
  loading.value = true
  try {
    // 加载全部店铺
    const storesData = await fetchStores({ pageSize: 1000 })
    storeList.value = storesData.list || []

    // 加载该用户已分配的店铺
    const userStores = await fetchUserStores(props.user.id)
    const assignedIds = (userStores || []).map(s => s.id)

    // 回显选中状态
    await nextTick()
    storeList.value.forEach(row => {
      if (assignedIds.includes(row.id)) {
        tableRef.value?.toggleRowSelection(row, true)
      }
    })
  } catch (err) {
    ElMessage.error('加载店铺数据失败: ' + err.message)
  } finally {
    loading.value = false
  }
}

async function handleSubmit() {
  if (!props.user?.id) return
  submitting.value = true
  try {
    await assignUserStores(props.user.id, selectedIds.value)
    ElMessage.success('店铺分配成功')
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
