import { createRouter, createWebHashHistory } from 'vue-router'
import AppLayout from '@/layout/AppLayout.vue'

const routes = [
  {
    path: '/',
    component: AppLayout,
    redirect: '/home',
    children: [
      {
        path: '/home',
        name: 'Home',
        component: () => import('@/views/home/HomePage.vue'),
        meta: { title: '首页' }
      },
      {
        path: '/sales/orders',
        name: 'SalesOrders',
        component: () => import('@/views/sales/OrderList.vue'),
        meta: { title: '订单列表' }
      },
      {
        path: '/aftersale/returns',
        name: 'AftersaleReturns',
        component: () => import('@/views/aftersale/ReturnExchange.vue'),
        meta: { title: '退换货管理' }
      },
      {
        path: '/purchase/orders',
        name: 'PurchaseOrders',
        component: () => import('@/views/purchase/PurchaseOrder.vue'),
        meta: { title: '采购订单' }
      },
      {
        path: '/warehouse/goods',
        name: 'WarehouseGoods',
        component: () => import('@/views/warehouse/GoodsManage.vue'),
        meta: { title: '商品管理' }
      },
      {
        path: '/tasks/todo',
        name: 'TasksTodo',
        component: () => import('@/views/tasks/TodoTask.vue'),
        meta: { title: '代办任务' }
      },
      {
        path: '/supplier/store-shipment',
        name: 'StoreShipment',
        component: () => import('@/views/supplier/StoreShipment.vue'),
        meta: { title: '供店发货' }
      },
      {
        path: '/user/center',
        name: 'UserCenter',
        component: () => import('@/views/user/UserCenter.vue'),
        meta: { title: '用户中心' }
      }
    ]
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router
