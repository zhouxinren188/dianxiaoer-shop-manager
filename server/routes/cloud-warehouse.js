const express = require('express')
const {
  assertMachineCode,
  canManageMachineBinding,
  getTenantOwnerId
} = require('../services/cloud-warehouse-protocol')
const {
  getOrderConfiguration
} = require('../services/cloud-warehouse-order-service')
const { createCloudWarehouseApiClient } = require('../services/cloud-warehouse-api-client')
const {
  attachExternalCommands,
  queryMachineStatus,
  refreshCommandResult,
  submitOrderCommand
} = require('../services/cloud-warehouse-third-party-service')

function ok(data) {
  return { code: 0, data }
}

function fail(message, reason) {
  const response = { code: 1, message }
  if (reason) response.reason = reason
  return response
}

function statusForError(error) {
  if (['purchase_order_not_found'].includes(error?.code)) return 404
  if (['machine_binding_forbidden'].includes(error?.code)) return 403
  if (['machine_code_in_use', 'workflow_task_active', 'precondition_not_met',
    'machine_binding_changed', 'order_locator_changed', 'machine_busy'].includes(error?.code)) return 409
  if (['machine_offline', 'capability_unavailable', 'login_environment_unavailable',
    'cloud_api_not_configured', 'cloud_api_unavailable', 'cloud_api_timeout'].includes(error?.code)) return 503
  if (['cloud_api_request_failed', 'cloud_api_invalid_response',
    'cloud_api_response_too_large'].includes(error?.code)) return 502
  if (error?.code) return 400
  return 500
}

function formatBindingRow(row, canManage) {
  if (!row) return { bound: false, machineCode: '', assistant: null, canManage }
  return {
    bound: true,
    machineCode: row.machine_code,
    bindingVersion: Number(row.binding_version || 1),
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
    canManage,
    // 在线状态改由云仓助手第三方服务查询；响应契约确认前不读取旧执行器心跳表。
    assistant: null
  }
}

async function readBinding(pool, ownerId, canManage) {
  const [rows] = await pool.execute(
    `SELECT machine_code, binding_version, bound_at, updated_at
       FROM cloud_machine_bindings
      WHERE owner_id = ?`,
    [ownerId]
  )
  return formatBindingRow(rows[0], canManage)
}

function assertEmptyBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
    throw Object.assign(new Error('请求体必须为空对象'), { code: 'invalid_request' })
  }
}

module.exports = function createCloudWarehouseRouter(pool, options = {}) {
  const router = express.Router()
  const getApiClient = options.getApiClient || (() => createCloudWarehouseApiClient())

  router.get('/machine-binding', async (req, res) => {
    try {
      const binding = await readBinding(pool, getTenantOwnerId(req.user), canManageMachineBinding(req.user))
      if (binding.bound) {
        try {
          binding.assistant = await queryMachineStatus(pool, getApiClient(), req.user)
        } catch (error) {
          console.warn('[CloudWarehouse] 在线状态查询失败', {
            code: error.code || 'cloud_api_unavailable',
            httpStatus: Number(error.httpStatus || 0) || undefined
          })
          binding.assistant = {
            online: false,
            busy: false,
            status: 'unavailable',
            capabilities: {},
            checkedAt: new Date().toISOString(),
            lastFailureReason: error.code || 'cloud_api_unavailable',
            lastFailureHttpStatus: Number(error.httpStatus || 0) || null
          }
        }
      }
      res.json(ok(binding))
    } catch (error) {
      console.error('[CloudWarehouse] 查询机器码绑定失败:', error.message)
      res.status(500).json(fail('查询机器码绑定失败'))
    }
  })

  router.put('/machine-binding', async (req, res) => {
    if (!canManageMachineBinding(req.user)) {
      return res.status(403).json(fail('只有主账号或管理员才能绑定和更换机器码', 'machine_binding_forbidden'))
    }
    let machineCode
    let ownerId
    try {
      machineCode = assertMachineCode(req.body?.machine_code)
      ownerId = getTenantOwnerId(req.user)
    } catch (error) {
      return res.status(400).json(fail(error.message, error.code))
    }

    const actorUserId = Number(req.user.id)
    let connection
    try {
      connection = await pool.getConnection()
      await connection.beginTransaction()

      const [currentRows] = await connection.execute(
        'SELECT machine_code, binding_version FROM cloud_machine_bindings WHERE owner_id = ? FOR UPDATE',
        [ownerId]
      )
      const current = currentRows[0] || null

      const [occupiedRows] = await connection.execute(
        'SELECT owner_id FROM cloud_machine_bindings WHERE machine_code = ? AND owner_id <> ? FOR UPDATE',
        [machineCode, ownerId]
      )
      if (occupiedRows.length > 0) {
        await connection.rollback()
        return res.status(409).json(fail('该机器码已被其他主账号体系绑定', 'machine_code_in_use'))
      }

      if (current?.machine_code === machineCode) {
        await connection.commit()
        return res.json(ok(await readBinding(pool, ownerId, true)))
      }

      const action = current ? 'rebind' : 'bind'
      const oldMachineCode = current?.machine_code || ''
      if (current) {
        await connection.execute(
          `UPDATE cloud_machine_bindings
              SET machine_code = ?, binding_version = binding_version + 1,
                  bound_by = ?, bound_at = NOW(3), updated_at = NOW(3)
            WHERE owner_id = ?`,
          [machineCode, actorUserId, ownerId]
        )
      } else {
        await connection.execute(
          `INSERT INTO cloud_machine_bindings
             (owner_id, machine_code, binding_version, bound_by, bound_at)
           VALUES (?, ?, 1, ?, NOW(3))`,
          [ownerId, machineCode, actorUserId]
        )
      }
      await connection.execute(
        `INSERT INTO cloud_machine_binding_audit
           (owner_id, actor_user_id, action, old_machine_code, new_machine_code)
         VALUES (?, ?, ?, ?, ?)`,
        [ownerId, actorUserId, action, oldMachineCode, machineCode]
      )
      await connection.commit()
      res.json(ok(await readBinding(pool, ownerId, true)))
    } catch (error) {
      if (connection) {
        try { await connection.rollback() } catch { /* ignore rollback failure */ }
      }
      if (error?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json(fail('该机器码已被其他主账号体系绑定', 'machine_code_in_use'))
      }
      console.error('[CloudWarehouse] 保存机器码绑定失败:', error.message)
      res.status(500).json(fail('保存机器码绑定失败'))
    } finally {
      if (connection) connection.release()
    }
  })

  router.delete('/machine-binding', async (req, res) => {
    if (!canManageMachineBinding(req.user)) {
      return res.status(403).json(fail('只有主账号或管理员才能解除机器码绑定', 'machine_binding_forbidden'))
    }
    const actorUserId = Number(req.user.id)
    let ownerId
    try {
      ownerId = getTenantOwnerId(req.user)
    } catch (error) {
      return res.status(400).json(fail(error.message, error.code))
    }
    let connection
    try {
      connection = await pool.getConnection()
      await connection.beginTransaction()
      const [rows] = await connection.execute(
        'SELECT machine_code FROM cloud_machine_bindings WHERE owner_id = ? FOR UPDATE',
        [ownerId]
      )
      if (!rows.length) {
        await connection.commit()
        return res.json(ok({ bound: false, machineCode: '', assistant: null, canManage: true }))
      }
      const machineCode = rows[0].machine_code
      await connection.execute('DELETE FROM cloud_machine_bindings WHERE owner_id = ?', [ownerId])
      await connection.execute(
        `INSERT INTO cloud_machine_binding_audit
           (owner_id, actor_user_id, action, old_machine_code, new_machine_code)
         VALUES (?, ?, 'unbind', ?, '')`,
        [ownerId, actorUserId, machineCode]
      )
      await connection.commit()
      res.json(ok({ bound: false, machineCode: '', assistant: null, canManage: true }))
    } catch (error) {
      if (connection) {
        try { await connection.rollback() } catch { /* ignore rollback failure */ }
      }
      console.error('[CloudWarehouse] 解除机器码绑定失败:', error.message)
      res.status(500).json(fail('解除机器码绑定失败'))
    } finally {
      if (connection) connection.release()
    }
  })

  router.get('/orders/:purchaseOrderId/configuration', async (req, res) => {
    try {
      let config = await attachExternalCommands(
        pool,
        req.user,
        req.params.purchaseOrderId,
        await getOrderConfiguration(pool, req.user, req.params.purchaseOrderId)
      )
      const activeRequestId = config.workflow?.currentTask?.taskId
      if (activeRequestId) {
        try {
          await refreshCommandResult(pool, getApiClient(), req.user, activeRequestId)
          config = await attachExternalCommands(
            pool,
            req.user,
            req.params.purchaseOrderId,
            await getOrderConfiguration(pool, req.user, req.params.purchaseOrderId)
          )
        } catch (error) {
          if (!['cloud_api_timeout', 'cloud_api_unavailable'].includes(error?.code)) throw error
        }
      }
      res.json(ok(config))
    } catch (error) {
      console.error('[CloudWarehouse] 查询订单云仓配置失败:', error.message)
      res.status(statusForError(error)).json(fail(error.message || '查询订单云仓配置失败', error.code))
    }
  })

  router.post('/orders/:purchaseOrderId/exception/check', async (req, res) => {
    try {
      assertEmptyBody(req.body || {})
      res.json(ok(await submitOrderCommand(pool, getApiClient(), {
        user: req.user,
        purchaseOrderId: req.params.purchaseOrderId,
        command: 'exception.order.check'
      })))
    } catch (error) {
      console.error('[CloudWarehouse] 发送异常查询指令失败:', error.code || error.message)
      res.status(statusForError(error)).json(fail(error.message || '发送异常查询指令失败', error.code))
    }
  })

  router.post('/orders/:purchaseOrderId/exception/resolve', async (req, res) => {
    try {
      assertEmptyBody(req.body || {})
      res.json(ok(await submitOrderCommand(pool, getApiClient(), {
        user: req.user,
        purchaseOrderId: req.params.purchaseOrderId,
        command: 'exception.order.resolve'
      })))
    } catch (error) {
      console.error('[CloudWarehouse] 发送异常处理指令失败:', error.code || error.message)
      res.status(statusForError(error)).json(fail(error.message || '发送异常处理指令失败', error.code))
    }
  })

  return router
}
