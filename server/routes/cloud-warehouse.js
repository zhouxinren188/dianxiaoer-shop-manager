const express = require('express')
const {
  COMMANDS,
  assertMachineCode,
  canManageMachineBinding,
  getTenantOwnerId,
  normalizeCapabilities
} = require('../services/cloud-warehouse-protocol')

function ok(data) {
  return { code: 0, data }
}

function fail(message, reason) {
  const response = { code: 1, message }
  if (reason) response.reason = reason
  return response
}

function parseJsonObject(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function formatBindingRow(row, canManage) {
  if (!row) return { bound: false, machineCode: '', assistant: null, canManage }
  const online = Number(row.assistant_online || 0) === 1
  const hasAssistantRecord = !!row.assistant_status
  return {
    bound: true,
    machineCode: row.machine_code,
    bindingVersion: Number(row.binding_version || 1),
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
    canManage,
    assistant: hasAssistantRecord ? {
      online,
      status: online ? 'online' : (row.assistant_status || 'offline'),
      protocolVersion: row.protocol_version || '',
      executorVersion: row.executor_version || '',
      capabilities: normalizeCapabilities(parseJsonObject(row.capabilities_json)),
      printerAvailable: Number(row.printer_available || 0) === 1,
      loginEnvironmentAvailable: Number(row.login_environment_available || 0) === 1,
      lastHeartbeatAt: row.last_heartbeat_at || null,
      lastFailureReason: row.last_failure_reason || ''
    } : null
  }
}

async function readBinding(pool, ownerId, canManage) {
  const [rows] = await pool.execute(
    `SELECT b.machine_code, b.binding_version, b.bound_at, b.updated_at,
            m.status AS assistant_status, m.protocol_version, m.executor_version,
            m.capabilities_json, m.printer_available, m.login_environment_available,
            m.last_heartbeat_at, m.last_failure_reason,
            CASE WHEN m.status = 'online'
                   AND m.last_heartbeat_at >= DATE_SUB(NOW(3), INTERVAL 90 SECOND)
                 THEN 1 ELSE 0 END AS assistant_online
       FROM cloud_machine_bindings b
       LEFT JOIN cloud_executor_machines m ON m.machine_code = b.machine_code
      WHERE b.owner_id = ?`,
    [ownerId]
  )
  return formatBindingRow(rows[0], canManage)
}

module.exports = function createCloudWarehouseRouter(pool) {
  const router = express.Router()

  router.get('/machine-binding', async (req, res) => {
    try {
      res.json(ok(await readBinding(pool, getTenantOwnerId(req.user), canManageMachineBinding(req.user))))
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

  router.get('/protocol', (_req, res) => {
    res.json(ok({
      protocolVersion: '1.0',
      machineCodePattern: '^YC-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$',
      commands: COMMANDS,
      transportEnabled: false,
      paramsSchemaConfirmed: false
    }))
  })

  return router
}
