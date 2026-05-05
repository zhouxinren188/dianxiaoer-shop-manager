<template>
  <el-dialog
    v-model="visible"
    :title="`为「${user?.realName || user?.username}」分配采购账号`"
    width="560px"
    :close-on-click-modal="false"
  >
    <div v-loading="loading">
      <el-input
        v-model="searchName"
        placeholder="搜索采购账号"
        clearable
        style="margin-bottom: 12px;"
        :prefix-icon="Search"
      />
      <el-table
        :data="filteredAccounts"
        stripe
        border
        height="320"
        row-key="id"
        @selection-change="handleSelectionChange"
        ref="tableRef"
      >
        <el-table-column type="selection" width="55" align="center" :reserve-selection="true" />
        <el-table-column prop="account" label="账号" min-width="140" />
        <el-table-column label="平台" width="120" align="center">
          <template #default="{ row }">
            <el-tag :type="platformTagType(row.platform)" size="small">{{ platformLabel(row.platform) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.online ? 'success' : 'info'" size="small" effect="plain">{{ row.online ? '在线' : '离线' }}</el-tag>
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
import { assignUserPurchaseAccounts, fetchUserPurchaseAccounts } from '@/api/user'
import { fetchPurchaseAccounts } from '@/api/purchaseAccount'

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
const accountList = ref([])
const searchName = ref('')
const selectedIds = ref([])
const tableRef = ref()

const filteredAccounts = computed(() => {
  if (!searchName.value) return accountList.value
  const kw = searchName.value.trim().toLowerCase()
  return accountList.value.filter(a => a.account?.toLowerCase().includes(kw))
})

function platformTagType(val) {
  const map = { taobao: 'danger', pinduoduo: 'warning', '1688': '', douyin: 'success' }
  return map[val] || 'info'
}

function platformLabel(val) {
  const map = { taobao: '淘宝/天猫', pinduoduo: '拼多多', '1688': '1688', douyin: '抖音' }
  return map[val] || val || '未知'
}

function handleSelectionChange(selection) {
  selectedIds.value = selection.map(item => item.id)
}

async function loadData() {
  if (!props.user?.id) return
  loading.value = true
  try {
    // 加载全部采购账号
    const data = await fetchPurchaseAccounts()
    const list = data.list || data || []
    accountList.value = list

    // 加载该用户已分配的采购账号
    const userAccounts = await fetchUserPurchaseAccounts(props.user.id)
    const assignedIds = (userAccounts || []).map(a => a.id)

    // 回显选中状态
    await nextTick()
    accountList.value.forEach(row => {
      if (assignedIds.includes(row.id)) {
        tableRef.value?.toggleRowSelection(row, true)
      }
    })
  } catch (err) {
    ElMessage.error('加载采购账号数据失败: ' + err.message)
  } finally {
    loading.value = false
  }
}

async function handleSubmit() {
  if (!props.user?.id) return
  submitting.value = true
  try {
    await assignUserPurchaseAccounts(props.user.id, selectedIds.value)
    ElMessage.success('采购账号分配成功')
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
