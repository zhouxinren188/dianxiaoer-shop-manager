import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import router from './router'
import App from './App.vue'
import './styles/global.css'

// 应用启动时立即清除旧 token，确保每次启动都需要重新登录
// 必须在路由初始化之前清除，否则 beforeEach 会用旧 token 放行到主页
localStorage.removeItem('accessToken')
localStorage.removeItem('currentUser')
localStorage.removeItem('userInfo')

const app = createApp(App)
app.use(ElementPlus, { locale: zhCn })
app.use(router)
app.mount('#app')
