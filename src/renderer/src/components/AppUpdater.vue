<template>
  <div class="app-updater">
    <!-- 发现新版本提示 -->
    <el-dialog
      v-model="updateDialogVisible"
      title="发现新版本"
      width="420px"
      :close-on-click-modal="false"
      :show-close="!isDownloading"
      align-center
    >
      <div class="update-content">
        <el-icon class="update-icon" :size="48" color="#409EFF"><Download /></el-icon>
        <p class="update-version">新版本: <strong>{{ newVersion }}</strong></p>
        <p class="update-desc">检测到有新版本可用，建议立即更新以获得更好的体验。</p>

        <!-- 下载进度 -->
        <div v-if="isDownloading" class="download-progress">
          <el-progress :percentage="downloadPercent" :stroke-width="8" striped />
          <p class="progress-text">正在下载更新... {{ downloadPercent }}%</p>
        </div>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button v-if="!isDownloading && !isDownloaded" @click="updateDialogVisible = false">
            稍后提醒
          </el-button>
          <el-button
            v-if="!isDownloading && !isDownloaded"
            type="primary"
            @click="handleDownload"
          >
            立即下载
          </el-button>
          <el-button
            v-if="isDownloaded"
            type="success"
            @click="handleInstall"
          >
            立即安装并重启
          </el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 已是最新提示 -->
    <el-dialog v-model="noUpdateDialogVisible" title="检查更新" width="360px" align-center>
      <div class="no-update-content">
        <el-icon :size="40" color="#67C23A"><CircleCheck /></el-icon>
        <p>当前已是最新版本</p>
      </div>
    </el-dialog>

    <!-- 顶部更新提示条 -->
    <el-alert
      v-if="showTopAlert && !updateDialogVisible"
      :title="`发现新版本 ${newVersion} 可用`"
      type="info"
      :closable="true"
      @close="showTopAlert = false"
      class="top-update-alert"
    >
      <template #default>
        <el-button type="primary" link size="small" @click="updateDialogVisible = true">
          立即更新
        </el-button>
      </template>
    </el-alert>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { Download, CircleCheck } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const updateDialogVisible = ref(false)
const noUpdateDialogVisible = ref(false)
const showTopAlert = ref(false)
const isDownloading = ref(false)
const isDownloaded = ref(false)
const newVersion = ref('')
const downloadPercent = ref(0)

let removeListeners = []

function on(channel, callback) {
  if (window.electronAPI?.onUpdate) {
    window.electronAPI.onUpdate(channel, callback)
  } else if (window.electronAPI?.invoke) {
    // fallback: 使用原生 ipcRenderer.on 暴露的方式
  }
}

// 注册监听
function registerListeners() {
  // 使用 window.electronAPI.on 如果 preload 已暴露
  if (window.electronAPI?.onUpdate) {
    removeListeners.push(window.electronAPI.onUpdate('update-available', handleUpdateAvailable))
    removeListeners.push(window.electronAPI.onUpdate('update-not-available', handleNoUpdate))
    removeListeners.push(window.electronAPI.onUpdate('update-error', handleUpdateError))
    removeListeners.push(window.electronAPI.onUpdate('update-progress', handleDownloadProgress))
    removeListeners.push(window.electronAPI.onUpdate('update-downloaded', handleUpdateDownloaded))
  }
}

function handleUpdateAvailable(info) {
  newVersion.value = info.version
  showTopAlert.value = true
  updateDialogVisible.value = true
}

function handleNoUpdate() {
  noUpdateDialogVisible.value = true
  setTimeout(() => {
    noUpdateDialogVisible.value = false
  }, 2000)
}

function handleUpdateError(info) {
  ElMessage.error('更新检查失败: ' + info.message)
  isDownloading.value = false
}

function handleDownloadProgress(progress) {
  downloadPercent.value = progress.percent
}

function handleUpdateDownloaded(info) {
  isDownloading.value = false
  isDownloaded.value = true
  ElMessage.success('更新下载完成，请安装重启')
}

async function handleDownload() {
  isDownloading.value = true
  try {
    await window.electronAPI.invoke('start-download-update')
  } catch (err) {
    ElMessage.error('启动下载失败')
    isDownloading.value = false
  }
}

async function handleInstall() {
  await window.electronAPI.invoke('quit-and-install')
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
