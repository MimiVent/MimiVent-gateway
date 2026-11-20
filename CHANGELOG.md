# 更新记录

## MimiVent NAS Gateway v0.2.0（2026-11-21）

- 数据库 schema v2：新增 `devices`、`phone_credentials`、`setup_sessions`；迁移使用 `CREATE TABLE IF NOT EXISTS`，可重复执行。
- 首配协议：`POST /api/v1/setup/sessions` 创建会话（Gateway 生成 `transactionId`/`serviceId`）；`POST .../service` 接收设备生成的服务 token；`POST .../verify` 用设备上报的 `service` 字段做无副作用核验；`POST .../complete` 签发手机凭据。
- 中断配置可用原会话令牌续期；保留未完成事务所需的服务凭据，允许在已激活/已核验阶段补存同一凭据后恢复。
- 手机凭据管理：`GET/POST /api/v1/devices/:id/phones`、`DELETE .../phones/:phoneId`；每台设备最多 32 部手机（代码固定上限）；最后一部手机不能自撤。
- 手机权限不再区分管理员：所有已加入手机均可查看成员、生成邀请并撤销成员；升级时把旧管理员角色归一为普通成员。
- 访问鉴权：Bearer 改为 Gateway 签发的手机凭据（`X-Phone-Id`，兼容旧 `X-Device-Token-Id`）；控制时服务 token 由 Gateway 从数据库读取，不再由手机携带。
- 保留旧模型兼容：手机凭据表无匹配时仍接受设备绑定 token，已有 NAS 配置继续工作。
- 修复：`GET /api/v1/devices` 对无效凭据返回 401（此前返回空列表 200）；`phoneId` 与 token 必须匹配同一设备，禁止跨设备混用凭据。
- 配置恢复：会话令牌有效性不依赖原 24 小时 TTL；中断后可续期恢复，保留未完成事务所需的候选服务凭据。
- 验证：Gateway 集成测试 17/17 通过；NAS 部署后续期路由、HTTPS 配置页和 HTTP 首配页已确认可用。

## MimiVent NAS Gateway v0.1.0（2026-11-13）

- 首次公开发布。
- 固定 MQTT 查询分片确认与查询槽生命周期，最后一片确认后可立即开始下一页，发送期间 ACK 回调不会被互斥锁阻塞。
- 控制 ACK 等待默认值为 6 秒，允许按配置调整至 10 秒；控制结果未知时保留原 requestId，不自动重发。
- 持久化 NAS 状态快照并标记重启后的缓存状态；保留 HTTP 首配页面、二维码导入、SQLite 数据卷及 NAS 时间健康检查。
