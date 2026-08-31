# 店小二桌面远程任务通道 v1

该通道供微信小程序向同一账号已登录的店小二桌面端提交固定白名单任务。外部入口只使用：

    https://150.158.54.108/api/desktop-channel

请求统一携带小程序登录得到的：

    Authorization: Bearer <token>
    Content-Type: application/json

通道不接受脚本、Shell、模块名、任意 URL 或自定义动作。当前业务指令只有：

- purchase.exception.check：查询指定采购单关联订单的异常。
- purchase.exception.resolve：自动备注采购编号、处理异常并再次核验。

## 1. 查询在线桌面

    GET /api/desktop-channel/devices

响应中的 status=online 且对应 capabilities 为 true 时，才表示该桌面版本可领取相关指令。

## 2. 创建异常查询任务

    POST /api/desktop-channel/tasks

请求：

    {
      "command": "purchase.exception.check",
      "payload": {
        "purchase_order_id": 123
      },
      "idempotency_key": "exception-check:123:业务侧唯一编号"
    }

默认排队有效期为 300 秒。

## 3. 创建异常处理任务

    POST /api/desktop-channel/tasks

请求：

    {
      "command": "purchase.exception.resolve",
      "payload": {
        "purchase_order_id": 123,
        "confirmed": true
      },
      "idempotency_key": "exception-resolve:123:本次用户操作唯一编号"
    }

confirmed 必须为 true，表示用户已经在小程序明确确认写操作。默认排队有效期为 600 秒。

处理顺序固定为：

1. 服务端按当前账号校验采购单访问权限；
2. 桌面端读取采购编号及关联京东销售订单；
3. 复用店小二现有京东商家备注能力写入采购编号；
4. 记录自动备注结果；备注失败仍继续；
5. 提交一次异常处理；
6. 等待明确成功回执；
7. 提交一次异常复查并等待明确结果。

写操作超时或断线时不会自动生成新的处理请求。桌面端会保存执行日志；如果进程在结果落盘前异常退出，任务返回 execution_interrupted，要求人工核验，禁止盲目重放。

## 4. 查询任务状态

创建成功返回 HTTP 202，读取其中 data.task.task_id，之后轮询：

    GET /api/desktop-channel/tasks/<task_id>

状态：

- queued：等待同账号桌面领取。
- leased / executing：桌面处理中，可读取 progress.phase。
- succeeded：已完成，读取 result。
- failed：失败，读取 error_code 和 error_message。
- expired：有效期内没有桌面领取。

建议小程序每 2 秒查询一次，进入终态后停止。不要因为网络超时更换 idempotency_key 重复创建处理任务。

异常查询成功结果：

    {
      "purchase_order_id": 123,
      "state": "exception_found",
      "exception_count": 2,
      "message": "查询到 2 条待处理异常",
      "checked_at": "2026-08-31T10:00:00.000Z"
    }

异常处理成功结果：

    {
      "purchase_order_id": 123,
      "remark_succeeded": true,
      "remark_message": "采购编号已自动备注到京东订单",
      "resolve_state": "succeeded",
      "verification_state": "exception_clear",
      "remaining_exception_count": 0,
      "message": "异常处理成功，再次核验已无异常",
      "verified_at": "2026-08-31T10:01:00.000Z"
    }

## 5. 版本与发布

桌面端通道运行在 Electron 主进程，必须通过全量版本发布，不能只发 renderer 热更新。服务端必须先部署，再发布包含该通道的桌面全量版本。
