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

          <!-- 下载中：显示后台下载按钮 -->
          <template v-if="updateState === 'downloading'">
            <el-button @click="minimizeToBar">后台下载</el-button>
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

    <!-- 后台下载浮标 -->
    <transition name="float-fade">
      <div
        v-if="showFloatBar"
        class="download-float"
        @click="restoreDialog"
      >
        <el-icon :size="16"><Download /></el-icon>
        <span class="float-text">下载中 {{ downloadPercent }}%</span>
        <el-progress
          :percentage="downloadPercent"
          :stroke-width="3"
          :show-text="false"
          class="float-progress"
        />
      </div>
    </transition>

    <!-- 全屏安装遮罩（全量更新时显示，防止用户误以为软件没在更新） -->
    <transition name="install-fade">
      <div v-if="isInstalling" class="install-overlay">
        <div class="install-overlay-content">
          <div class="install-spinner">
            <el-icon :size="56" color="#409EFF"><Loading /></el-icon>
          </div>
          <p class="install-title">正在安装更新</p>
          <p class="install-desc">应用即将退出并启动安装程序，请稍候...</p>
          <p class="install-hint">安装完成后将自动重新启动</p>
        </div>
      </div>
    </transition>

    <!-- 下载完成浮标 -->
    <transition name="float-fade">
      <div
        v-if="showReadyFloat"
        class="download-float ready"
        @click="restoreDialog"
      >
        <el-icon :size="16" color="#67C23A"><CircleCheck /></el-icon>
        <span class="float-text">更新就绪，点击安装</span>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Download, CircleCheck, Loading } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const dialogVisible = ref(false)
const noUpdateVisible = ref(false)
const isMinimized = ref(false)
const isInstalling = ref(false)
const updateState = ref('idle') // idle | available | downloading | ready | error | installing
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

// 后台下载浮标：仅在最小化 + 下载中时显示
const showFloatBar = computed(() => isMinimized.value && updateState.value === 'downloading')
// 下载完成浮标：仅在最小化 + 就绪时显示
const showReadyFloat = computed(() => isMinimized.value && updateState.value === 'ready')

function minimizeToBar() {
  isMinimized.value = true
  dialogVisible.value = false
}

function restoreDialog() {
  isMinimized.value = false
  dialogVisible.value = true
}

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
    isMinimized.value = false
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
    if (isMinimized.value) {
      // 最小化状态：用浮标提示，不打断用户
      ElMessage.success('更新下载完成，点击右下角浮标安装')
    } else {
      ElMessage.success('更新下载完成')
    }
  }))

  removeListeners.push(window.electronAPI.onUpdate('um-update-error', (info) => {
    updateState.value = 'error'
    errorMsg.value = info.message || '更新失败'
    // 出错时自动恢复弹窗
    if (isMinimized.value) {
      isMinimized.value = false
      dialogVisible.value = true
    }
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
  if (updateInfo.value.type === 'full') {
    // 全量更新：先显示安装遮罩，让用户明确知道正在安装
    isInstalling.value = true
    dialogVisible.value = false
    // 等待遮罩渲染完成后再调用安装
    await new Promise(r => setTimeout(r, 800))
  }
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

/* 后台下载浮标 */
.download-float {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 2100;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 10px 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  cursor: pointer;
  transition: box-shadow 0.2s;
  min-width: 180px;
}

.download-float:hover {
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.18);
}

.download-float.ready {
  border-color: #67C23A;
  background: #f0f9eb;
}

.float-text {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
}

.download-float.ready .float-text {
  color: #67C23A;
  font-weight: 500;
}

.float-progress {
  flex: 1;
  min-width: 40px;
}

/* 浮标动画 */
.float-fade-enter-active {
  transition: all 0.3s ease-out;
}

.float-fade-leave-active {
  transition: all 0.2s ease-in;
}

.float-fade-enter-from {
  opacity: 0;
  transform: translateY(20px);
}

.float-fade-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

/* 全屏安装遮罩 */
.install-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
}

.install-overlay-content {
  text-align: center;
  background: #fff;
  border-radius: 16px;
  padding: 48px 56px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.install-spinner {
  margin-bottom: 20px;
}

.install-spinner .el-icon {
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.install-title {
  font-size: 20px;
  font-weight: 600;
  color: #303133;
  margin: 0 0 12px;
}

.install-desc {
  font-size: 14px;
  color: #606266;
  margin: 0 0 8px;
}

.install-hint {
  font-size: 13px;
  color: #909399;
  margin: 0;
}

.install-fade-enter-active {
  transition: opacity 0.3s ease;
}

.install-fade-leave-active {
  transition: opacity 0.2s ease;
}

.install-fade-enter-from,
.install-fade-leave-to {
  opacity: 0;
}
</style>
