# MimiVent NAS 网关

当前首个公开发布版本：Gateway `v0.1.0`，配套 App `v0.7.0+11`、固件 `v0.7.0`。变更见 [CHANGELOG.md](CHANGELOG.md)。

局域网内的 HTTPS 控制 API 与 Mosquitto MQTT Broker。网关通过 App 绑定 token 转发请求；设备仍验证 token，并执行去重与控制租约检查。

本版本必须搭配 MQTT 控制消息 v2 固件。网关先做不执行控制的预检，获取设备签发的短时凭据后再提交控制。设备使用自身计时拒绝过期请求，不依赖联网校时。App 对结果未知的控制保留原请求，后续点击只查询；核对设备实际状态后，可通过页面上的“结束上次结果确认”解除等待。

## NAS 首次部署

1. 把此目录复制到飞牛 NAS 的 Docker 项目目录，例如 `/vol1/1000/docker/mimivent`。先创建 `.env`，把 MQTT 密码换成随机长密码；同一组用户名和密码稍后填入 App 的 MQTT 设置。可用 `openssl rand -hex 24` 生成 48 位十六进制密码，避免 `.env` 特殊字符转义问题。
2. 创建 TLS 证书目录并生成本地证书（将 NAS 固定 IPv4 写入 SAN）：

   ```sh
   mkdir -p tls mosquitto data/mosquitto data/gateway data/time-health logs/mosquitto
   cp .env.example .env
   # 查看 NAS 当前账号的数字 UID/GID，并把 .env 中 GATEWAY_UID/GID 改成这两个值
   id -u
   id -g
   # 编辑 .env 设置 MQTT_PASSWORD、GATEWAY_UID/GID 和 NAS_IP
   NAS_IP="$(awk -F= '$1 == "NAS_IP" { print $2; exit }' .env)"
   openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
     -keyout tls/key.pem -out tls/cert.pem \
     -subj "/CN=${NAS_IP}" -addext "subjectAltName=IP:${NAS_IP}"
   chmod 600 tls/key.pem .env
   ```

3. 生成 Mosquitto 密码文件。命令会交互式提示输入与 `.env` 中完全相同的 MQTT 密码：

   ```sh
   docker run --rm -it \
     -v "$PWD/mosquitto:/mosquitto/config" \
     eclipse-mosquitto:2.0.22 \
     mosquitto_passwd -c /mosquitto/config/passwords mimivent
   docker run --rm -v "$PWD/mosquitto:/config" alpine:3.22 sh -c 'chmod 640 /config/passwords && chown 1883:1883 /config/passwords'
   docker run --rm -v "$PWD/data/mosquitto:/data" -v "$PWD/logs/mosquitto:/logs" alpine:3.22 chown -R 1883:1883 /data /logs
   ```

4. 启动服务：

   ```sh
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 gateway mosquitto
   ```

   只需在家庭局域网开放 NAS 的 TCP 1883、8444 与 18080；不要在路由器配置公网端口转发。1883 给 ESP32 连接 Broker，8444 给 App 连接 HTTPS 网关，18080 给 Docker/FN Connect 的 HTTP 首配页面。

5. NAS 首配二维码与设置页面会在 Gateway 启动后自动生成：

   ```sh
   docker compose logs --tail=80 gateway
   ```

   浏览器可打开 `https://NAS局域网IP:8444/` 或 `http://NAS局域网IP:18080/` 查看二维码、复制完整连接串，或直接显示连接串。18080 为 HTTP 首配页端口，方便飞牛 Docker/FN Connect 快捷入口打开；8444 仍为 App 的 HTTPS 控制 API。该连接串含 MQTT 用户名和密码；仅在自有 NAS 访问环境中使用，不要公开分享。启动日志只显示页面地址，不输出二维码或凭据。需要重新生成二维码时执行：

   ```sh
   ./print-app-config.sh
   ```

   在 App“设备网络与 NAS 控制”页点击“扫码或选择图片，快速配置 NAS”，可实时扫码，也可选择 NAS 页面截图。确认后 App 保存网关和证书指纹，并通过当前蓝牙连接将 MQTT 主机、端口和凭据下发到设备；MQTT 密码不写入 App 本地存储。设备 MQTT 状态应显示已连接。

6. 配置 NAS 主机时间健康提供器。网关不会把容器时间或“NAS 能联网”当作 NTP 健康；使用飞牛当前启用的时间服务，并通过 NAS 支持的开机任务/服务管理器持续运行：

   ```sh
   python3 time_health_provider.py data/time-health/time-health.json --watch --interval-seconds 10
   ```

   `systemd-timesyncd` NAS 可使用 `systemd/mimivent-time-health.service` 示例建立开机服务；部署前按 NAS 项目目录、执行账号和用户组调整路径，然后 `systemctl daemon-reload` 并启用该服务。没有 systemd 的 NAS 可用飞牛任务计划按其支持方式启动同一命令。

   脚本优先读取 `chronyc tracking`；没有 `chronyc` 时兼容 `systemd-timesyncd`，要求服务 active、`NTPSynchronized=yes`、`/run/systemd/timesync/synchronized` 最近一次成功同步不超过 6 小时，并且 `root distance + |offset| + jitter` 的保守估算不超过 1 秒。执行账号须能只读查询时间服务及成功同步标记，并写入 `data/time-health/`。Gateway 将该目录只读挂载；服务未适配、文件缺失/陈旧或字段未知时返回 `status: unavailable`，设备不会采纳时间。Gateway 的 `time-reply` 只下发 UTC 毫秒和时间质量，不含 NAS 时区；设备统计偏移由 BLE/授权流程首次固定，未固定前 WiFi 校时会延后，固定后设备沿用原偏移。设备串口出现 `[mqtt-time] synchronized source=nas` 表示校时已被设备接受；出现 `deferred` 时会等时区初始化或统计活动安全边界后重新取样。

## 安全边界

- App 到 NAS Gateway 的 HTTPS 使用 Gateway 固定证书指纹校验；设备 bearer token 只经此 HTTPS 交给 NAS 网关，再通过家庭局域网 MQTT 传给设备。Broker 账号凭据保存在 NAS `.env` 与设备 NVS，不写在源码中。
- Mosquitto ACL 只允许 `mimivent` 用户访问 MimiVent v1 topic。当前固件使用相同 Broker 凭据收发主题，所以此单设备/单家庭阶段的 ACL 范围是 `mimivent/v1/#`。Broker 只绑定家庭 LAN，不要暴露到公网。
- NAS 或 Broker 停机时，App 明确提示网关不可用并允许用户切换蓝牙；设备 HTTPS 控制已关闭，不执行直连回退。等待设备 ACK 超时则保留原 requestId，App 查询原结果，不自动重发。
- Broker 用户认证与 ACL 不能替代设备 token 校验。设备控制仍以固件绑定表中的 token hash 为准。

## 运维

App 可通过 `GET /api/v1/devices/{deviceId}/requests/{requestId}` 查询网关缓存的 `pending/applied/rejected`。必须使用发起该请求的原始 bearer token 和 `X-Device-Token-Id`，其他绑定不能查询。接口只读取结果，不发布 MQTT 命令；缓存默认保留 10 分钟，网关重启后或没有记录时返回 404，App 再查设备持久化记录。

最新设备状态保存在 Gateway 的 SQLite 持久卷中。进程重启后可以读取最后快照，但会明确标记为 `cached_unconfirmed`/stale，直到收到本次运行中的 MQTT 状态；持久快照不包含 `authTokens` 授权摘要。部署时必须保留 `./data/gateway:/app/data` 挂载。

固件升级后会保留旧去重记录供查询；没有正文摘要的旧记录无法通过执行接口复用，网关将结果保留为待确认并让 App 查询历史结果。新记录会持久化正文摘要，NAS 重启后相同请求 ID 携带不同正文仍会被设备拒绝。

开发验证可在 Node 22.22.2、Docker 和 OpenSSL 可用的环境执行 `npm run test:integration`，测试使用独立临时 Broker 容器，结束后自动清理。

```sh
docker compose logs -f gateway mosquitto
docker compose restart gateway
docker compose down
```

`docker compose down` 不会删除 MQTT 持久化数据。证书、`.env`、Mosquitto 密码文件及 `data/` 应纳入 NAS 自己的备份，但不要提交版本库。
