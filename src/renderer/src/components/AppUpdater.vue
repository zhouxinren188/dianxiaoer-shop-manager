<template>
  <div class="app-updater">
    <!-- 发现新版本提示 -->
    <el-dialog
      v-model="dialogVisible"
      title="发现新版本"
      width="420px"
      :close-on-click-modal="false"
      :show-close="!isDownloading && !updateInfo.force"
      align-center
    >
      <div class="update-content">
        <el-icon class="update-icon" :size="48" color="#409EFF"><Download /></el-icon>
        <p class="update-version">新版本: <strong>{{ updateInfo.version }}</strong></p>
        <p class="update-type" v-if="updateInfo.type === 'hot'">
          快速更新 · {{ formatSize(updateInfo.size) }}
        </p>
        <p class="update-type" v-else-if="updateInfo.type === 'full'">
          完整更新
        </p>
        <p class="update-desc">{{ updateInfo.changelog || '检测到有新版本可用，建议立即更新以获得更好的体验。' }}</p>

        <!-- 下载进度 -->
        <div v-if="isDownloading" class="download-progress">
          <el-progress :percentage="downloadPercent" :stroke-width="8" striped />
          <p class="progress-text">正在下载更新... {{ downloadPercent }}%</p>
        </div>

        <!-- 错误提示 -->
        <el-alert
          v-if="errorMsg"
          :title="errorMsg"
          type="error"
          :closable="false"
          show-icon
          class="error-alert"
        />
      </div>

      <template #footer>
        <div class="dialog-footer">
          <!-- 空闲状态：显示稍后提醒 + 立即下载 -->
          <template v-if="updateState === 'available'">
            <el-button v-if="!updateInfo.force" @click="dialogVisible = false">稍后提醒</el-button>
            <el-button type="primary" @click="handleDownload">立即下载</el-button>
          </template>

          <!-- 下载完成：显示安装按钮 -->
          <template v-if="updateState === 'ready'">
            <el-button type="success" @click="handleInstall">
              {{ updateInfo.type === 'hot' ? '重启生效' : '安装并重启' }}
            </el-button>
          </template>

          <!-- 错误状态：显示重试按钮 -->
          <template v-if="updateState === 'error'">
            <el-button @click="dialogVisible = false">关闭</el-button>
            <el-button type="primary" @click="handleRetry">重试</el-button>
          </template>
        </div>
      </template>
    </el-dialog>

    <!-- 已是最新提示 -->
    <el-dialog v-model="noUpdateVisible" title="检查更新" width="360px" align-center>
      <div class="no-update-content">
        <el-icon :size="40" color="#67C23A"><CircleCheck /></el-icon>
        <p>当前已是最新版本</p>
      </div>
    </el-dialog>

    <!-- 顶部更新提示条 -->
    <el-alert
      v-if="showTopAlert && !dialogVisible"
      :title="topAlertText"
      type="info"
      :closable="true"
      @close="showTopAlert = false"
      class="top-update-alert"
    >
      <template #default>
        <el-button type="primary" link size="small" @click="dialogVisible = true">立即更新</el-button>
      </template>
    </el-alert>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Download, CircleCheck } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const dialogVisible = ref(false)
const noUpdateVisible = ref(false)
const showTopAlert = ref(false)
const updateState = ref('idle') // idle | available | downloading | ready | error
const downloadPercent = ref(0)
const errorMsg = ref('')

const updateInfo = ref({
  version: '',
  type: '',     // 'hot' | 'full'
  size: 0,
  changelog: '',
  force: false
})

const isDownloading = computed(() => updateState.value === 'downloading')

const topAlertText = computed(() => {
  const v = updateInfo.value.version
  if (updateInfo.value.type === 'hot') return `发现新版本 ${v}（快速更新）`
  return `发现新版本 ${v}（完整更新）`
})

function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

let removeListeners = []

function registerListeners() {
  if (!window.electronAPI?.onUpdate) return

  removeListeners.push(window.electronAPI.onUpdate('um-update-available', (info) => {
    updateInfo.value = info
    updateState.value = 'available'
    errorMsg.value = ''
    downloadPercent.value = 0
    showTopAlert.value = true
    dialogVisible.value = true
  }))

  removeListeners.push(window.electronAPI.onUpdate('um-no-update', () => {
    noUpdateVisible.value = true
    setTimeout(() => { noUpdateVisible.value = false }, 2000)
  }))

  removeListeners.push(window.electronAPI.onUpdate('um-update-progress', (progress) => {
    downloadPercent.value = progress.percent
  }))

  removeListeners.push(window.electronAPI.onUpdate('um-update-ready', (info) => {
    updateState.value = 'ready'
    ElMessage.success('更新下载完成')
  }))

  removeListeners.push(window.electronAPI.onUpdate('um-update-error', (info) => {
    updateState.value = 'error'
    errorMsg.value = info.message || '更新失败'
    ElMessage.error('更新失败: ' + (info.message || '未知错误'))
  }))
}

async function handleDownload() {
  updateState.value = 'downloading'
  errorMsg.value = ''
  downloadPercent.value = 0
  try {
    await window.electronAPI.invoke('um-download')
  } catch (err) {
    updateState.value = 'error'
    errorMsg.value = err.message || '启动下载失败'
  }
}

async function handleInstall() {
  await window.electronAPI.invoke('um-install')
}

async function handleRetry() {
  errorMsg.value = ''
  updateState.value = 'available'
  await handleDownload()
}

onMounted(() => {
  registerListeners()
})

onUnmounted(() => {
  removeListeners.forEach(fn => fn && fn())
})
</script>

<style scoped>
.app-updater {
  position: relative;
}

.top-update-alert {
  position: fixed;
  top: 0;
  left: 240px;
  right: 0;
  z-index: 2000;
  border-radius: 0;
}

.update-content {
  text-align: center;
  padding: 10px 0;
}

.update-icon {
  margin-bottom: 12px;
}

.update-version {
  font-size: 16px;
  margin: 8px 0;
  color: #303133;
}

.update-type {
  font-size: 13px;
  color: #909399;
  margin: 4px 0;
}

.update-desc {
  font-size: 14px;
  color: #606266;
  margin: 8px 0 16px;
}

.download-progress {
  margin-top: 12px;
}

.progress-text {
  font-size: 12px;
  color: #909399;
  margin-top: 6px;
}

.error-alert {
  margin-top: 12px;
}

.no-update-content {
  text-align: center;
  padding: 16px 0;
}

.no-update-content p {
  margin-top: 12px;
  color: #606266;
  font-size: 14px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
