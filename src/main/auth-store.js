// 主进程全局 auth token 存储
// 被 cookie-heartbeat.js 和 platform-window.js 引用，避免循环依赖
let authToken = null

function setAuthToken(token) {
  authToken = token
}

function getAuthToken() {
  return authToken
}

module.exports = { setAuthToken, getAuthToken }
