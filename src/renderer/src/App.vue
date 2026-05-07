<template>
  <router-view />
  <AppUpdater />
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import AppUpdater from './components/AppUpdater.vue'

// 清除主进程中的旧 token（localStorage 已在 main.js 中清除）
window.electronAPI?.invoke('set-auth-token', null).catch(() => {})

// 监听被踢下线事件（其他设备登录了同一账号）
function onForceLogout(e) {
  ElMessage.warning(e.detail || '账号在其他设备登录，请重新登录')
}
onMounted(() => window.addEventListener('force-logout', onForceLogout))
onUnmounted(() => window.removeEventListener('force-logout', onForceLogout))
</script>
