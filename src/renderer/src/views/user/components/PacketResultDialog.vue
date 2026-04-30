<template>
  <el-dialog
    :model-value="visible"
    title="抓包结果"
    width="900px"
    top="5vh"
    :append-to-body="true"
    @close="handleClose"
  >
    <div class="packet-header">
      <span class="packet-count">共捕获 <strong>{{ filteredData.length }}</strong> 个请求</span>
      <div class="packet-filters">
        <el-input
          v-model="filterUrl"
          placeholder="搜索 URL"
          clearable
          style="width: 260px;"
          size="small"
        />
        <el-select v-model="filterMethod" placeholder="方法" clearable size="small" style="width: 100px;">
          <el-option label="GET" value="GET" />
          <el-option label="POST" value="POST" />
          <el-option label="PUT" value="PUT" />
          <el-option label="DELETE" value="DELETE" />
          <el-option label="OPTIONS" value="OPTIONS" />
        </el-select>
        <el-select v-model="filterStatus" placeholder="状态码" clearable size="small" style="width: 110px;">
          <el-option label="2xx 成功" value="2" />
          <el-option label="3xx 重定向" value="3" />
          <el-option label="4xx 客户端错误" value="4" />
          <el-option label="5xx 服务端错误" value="5" />
        </el-select>
      </div>
    </div>

    <el-table :data="filteredData" stripe border max-height="500" size="small" @selection-change="handleSelectionChange" row-key="timestamp">
      <el-table-column type="expand" width="40">
        <template #default="{ row }">
          <div class="packet-expand-content">
            <div v-if="row.postBody" class="post-body-section">
              <strong>POST Body:</strong>
              <pre class="post-body-pre">{{ formatPostBody(row.postBody) }}</pre>
            </div>
            <div v-else class="post-body-section">
              <span class="text-muted">无请求体数据</span>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column type="selection" width="40" />
      <el-table-column type="index" label="#" width="50" />
      <el-table-column label="方法" width="80">
        <template #default="{ row }">
          <el-tag :type="methodType(row.method)" size="small">{{ row.method }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="url" label="URL" min-width="350" show-overflow-tooltip />
      <el-table-column label="状态码" width="80" align="center">
        <template #default="{ row }">
          <span :style="{ color: statusColor(row.statusCode) }">{{ row.statusCode }}</span>
        </template>
      </el-table-column>
      <el-table-column label="Body" width="60" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.postBody" type="warning" size="small">有</el-tag>
          <span v-else class="text-muted">-</span>
        </template>
      </el-table-column>
      <el-table-column prop="resourceType" label="类型" width="90" show-overflow-tooltip />
      <el-table-column label="时间" width="90" align="center">
        <template #default="{ row }">
          {{ formatTime(row.timestamp) }}
        </template>
      </el-table-column>
    </el-table>

    <template #footer>
      <el-button @click="handleCopySelected" :disabled="selectedRows.length === 0">
        复制选中 ({{ selectedRows.length }})
      </el-button>
      <el-button type="primary" @click="handleCopyAll">复制全部</el-button>
      <el-button @click="handleClose">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps({
  visible: { type: Boolean, default: false },
  data: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:visible'])

const filterUrl = ref('')
const filterMethod = ref('')
const filterStatus = ref('')
const selectedRows = ref([])

const filteredData = computed(() => {
  return props.data.filter(item => {
    if (filterUrl.value && !item.url.toLowerCase().includes(filterUrl.value.toLowerCase())) return false
    if (filterMethod.value && item.method !== filterMethod.value) return false
    if (filterStatus.value && !String(item.statusCode).startsWith(filterStatus.value)) return false
    return true
  })
})

function methodType(method) {
  const map = { GET: '', POST: 'success', PUT: 'warning', DELETE: 'danger', OPTIONS: 'info' }
  return map[method] || 'info'
}

function statusColor(code) {
  if (code >= 200 && code < 300) return '#67c23a'
  if (code >= 300 && code < 400) return '#e6a23c'
  if (code >= 400) return '#f56c6c'
  return '#909399'
}

function formatTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return d.toTimeString().slice(0, 8)
}

function formatPostBody(body) {
  if (!body) return ''
  try {
    // 尝试解析为 JSON 并格式化
    const parsed = JSON.parse(body)
    return JSON.stringify(parsed, null, 2)
  } catch {
    // 不是 JSON，原样返回
    return body
  }
}

function handleSelectionChange(rows) {
  selectedRows.value = rows
}

function formatForCopy(items) {
  return JSON.stringify(items.map(item => ({
    method: item.method,
    url: item.url,
    statusCode: item.statusCode,
    resourceType: item.resourceType,
    postBody: item.postBody || null,
    timestamp: new Date(item.timestamp).toISOString()
  })), null, 2)
}

async function handleCopyAll() {
  try {
    await navigator.clipboard.writeText(formatForCopy(filteredData.value))
    ElMessage.success(`已复制 ${filteredData.value.length} 条记录`)
  } catch {
    ElMessage.error('复制失败')
  }
}

async function handleCopySelected() {
  try {
    await navigator.clipboard.writeText(formatForCopy(selectedRows.value))
    ElMessage.success(`已复制 ${selectedRows.value.length} 条记录`)
  } catch {
    ElMessage.error('复制失败')
  }
}

function handleClose() {
  emit('update:visible', false)
}
</script>

<style scoped>
.packet-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.packet-count {
  font-size: 14px;
  color: #606266;
}

.packet-filters {
  display: flex;
  gap: 8px;
}

.packet-expand-content {
  padding: 8px 16px;
}

.post-body-section {
  font-size: 13px;
}

.post-body-pre {
  background: #f5f7fa;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  padding: 8px 12px;
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  max-height: 300px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.text-muted {
  color: #909399;
  font-size: 12px;
}
</style>
