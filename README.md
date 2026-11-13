# MimiVent NAS 网关

当前首个公开发布版本：Gateway `v0.1.0`，配套 App `v0.7.0+11`、固件 `v0.7.0`。变更见 [CHANGELOG.md](CHANGELOG.md)。

局域网内的 HTTPS 控制 API 与 Mosquitto MQTT Broker。网关通过 App 绑定 token 转发请求；设备仍验证 token，并执行去重与控制租约检查。

本版本必须搭配 MQTT 控制消息 v2 固件。网关先做不执行控制的预检，获取设备签发的短时凭据后再提交控制。设备使用自身计时拒绝过期请求，不依赖联网校时。App 对结果未知的控制保留原请求，后续点击只查询；核对设备实际状态后，可通过页面上的“结束上次结果确认”解除等待。

## NAS Docker 部署

本节按全新部署编写，命令在 NAS 的 SSH 终端中执行。若使用飞牛 Docker 图形界面，先把项目目录上传到 NAS，再按相同目录和 `.env` 配置创建 Compose 项目。部署前准备：

- NAS 使用固定 IPv4，手机和 ESP32 能通过家庭局域网访问 NAS；记录这个地址，下面称为 `NAS_IP`。
- NAS 已启用 Docker Compose。部署账号可以进入项目目录，并可运行 `sudo docker`。
- TCP `1883`、`8444`、`18080` 没有被其他服务占用。只允许家庭局域网访问，不要配置路由器公网端口转发。
- 本项目使用 `compose.yaml`。若目录中另有本地 Compose 覆盖文件，先检查它没有把 Gateway 镜像标签覆盖成旧版本。

### 1. 上传项目并准备持久目录

将本发布版项目目录复制到 NAS，例如飞牛上的 `/vol1/1000/docker/mimivent`。之后在 SSH 终端执行：

```sh
cd /vol1/1000/docker/mimivent
mkdir -p tls mosquitto data/mosquitto data/gateway data/time-health logs/mosquitto
```

仅首次安装时从模板创建 `.env`：

```sh
cp .env.example .env
```

**更新版本时不要再次执行这条 `cp`**，以免覆盖已经配置的 NAS 地址和 MQTT 密码。证书、`.env`、Mosquitto 密码文件和 `data/` 是运行数据，更新项目文件时必须保留。

### 2. 配置 NAS 地址和 MQTT 凭据

编辑 `.env`，至少设置以下值：

```dotenv
NAS_IP=192.168.2.65
MQTT_USERNAME=mimivent
MQTT_PASSWORD=在这里填入随机生成的长密码
GATEWAY_UID=1000
GATEWAY_GID=1001
HOST_TIME_SYNC_HEALTH_DIR=./data/time-health
```

把 `NAS_IP` 换成自己的固定 IPv4。用 `id -u` 和 `id -g` 查看运行 Gateway 的 NAS 账号 UID/GID，并填入 `GATEWAY_UID`、`GATEWAY_GID`；示例值不保证适用于每台 NAS。生成密码可执行 `openssl rand -hex 24`，然后把输出粘贴到 `.env` 的 `MQTT_PASSWORD`。密码必须在本步骤和下一步完全相同；不要把真实密码提交到 Git、公开日志或截图中。

### 3. 创建 HTTPS 证书

证书必须把 NAS 的固定 IPv4 写入 IP SAN；App 首次导入配置时会固定这个证书的 SHA-256 指纹。

```sh
NAS_IP="$(awk -F= '$1 == "NAS_IP" { print $2; exit }' .env)"
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout tls/key.pem -out tls/cert.pem \
  -subj "/CN=${NAS_IP}" -addext "subjectAltName=IP:${NAS_IP}"
chmod 600 tls/key.pem .env
```

此证书是自签名证书，浏览器可能显示安全警告；App 通过固定指纹验证。**已经配网的 NAS 不要为了更新 Gateway 随意重建证书**，否则证书指纹会变化，需要重新导入 App 配置。

### 4. 创建 Mosquitto 用户密码文件

首次部署时运行以下命令。`mosquitto_passwd` 会交互式询问密码；输入与 `.env` 完全一致的 MQTT 密码：

```sh
sudo docker run --rm -it \
  -v "$PWD/mosquitto:/mosquitto/config" \
  eclipse-mosquitto:2.0.22 \
  mosquitto_passwd -c /mosquitto/config/passwords mimivent
sudo docker run --rm -v "$PWD/mosquitto:/config" alpine:3.22 \
  sh -c 'chmod 640 /config/passwords && chown 1883:1883 /config/passwords'
sudo docker run --rm -v "$PWD/data/mosquitto:/data" \
  -v "$PWD/logs/mosquitto:/logs" alpine:3.22 \
  chown -R 1883:1883 /data /logs
sudo chown 1883:1883 mosquitto/acl
sudo chmod 640 mosquitto/acl
```

成功后应存在 `mosquitto/passwords` 文件。**不要在已有部署上重复使用 `-c`**，它会重建密码文件；需要改密码时，应同时更新 `.env` 与 Mosquitto 密码文件，然后重启相关服务。

### 5. 校验并启动 Compose

确认当前目录是项目根目录，`.env`、证书、Mosquitto 密码文件都已准备好，再执行：

```sh
sudo docker compose -f compose.yaml config -q
sudo docker compose -f compose.yaml up -d --build
sudo docker compose -f compose.yaml ps
```

成功时，`mimivent-gateway` 和 `mimivent-mosquitto` 都应显示 `Up`。如果 NAS 上有本地覆盖文件 `compose.nas.yaml`，并且确实需要其中的运行参数，则以上命令都同时加上 `-f compose.nas.yaml`；检查覆盖文件中的 `gateway.image` 与本版标签相同。

查看启动日志：

```sh
sudo docker compose -f compose.yaml logs --tail=100 gateway mosquitto
```

首次启动后若 `data/mosquitto/mosquitto.db` 已生成，收紧数据库文件权限，避免 Mosquitto 提示文件可被其他用户读取：

```sh
sudo chown 1883:1883 data/mosquitto/mosquitto.db
sudo chmod 700 data/mosquitto/mosquitto.db
```

如果通过飞牛 Docker 图形界面启动，在 Docker 的 **Compose** 页面新建项目，项目目录选刚才上传的目录，Compose 文件选 `compose.yaml`，项目名可填 `mimivent`，再启动项目。`.env` 必须与 Compose 文件位于同一目录。更新现有项目时进入原项目执行更新/重建，不要新建第二个同名容器，也不要选择删除卷或清理项目数据。

### 6. 从局域网验证页面和端口

在 NAS 上先检查端口映射：

```sh
sudo docker compose -f compose.yaml ps
```

在同一局域网的电脑或手机浏览器打开：

```text
http://NAS_IP:18080/
https://NAS_IP:8444/
```

例如 `http://192.168.2.65:18080/`。两个入口都应返回首配二维码页面；HTTPS 使用自签名证书，浏览器警告是预期的。若用命令行检查，可执行：

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://NAS_IP:18080/
curl -k -sS -o /dev/null -w '%{http_code}\n' https://NAS_IP:8444/
```

两个请求都应返回 `200`。若端口映射正常但手机打不开，检查手机与 NAS 是否在可互访的同一局域网，以及路由器是否启用了无线客户端隔离。

### 7. 用 App 扫码完成设备配置

1. 先在 App 中连接目标 ESP32 的蓝牙，保持蓝牙连接。
2. 打开“设备网络与 NAS 控制”，选择“扫码或选择图片，快速配置 NAS”。可以扫描网页二维码，也可以选择页面截图。
3. 核对 NAS 地址后确认导入。App 保存 Gateway 地址和证书指纹，并通过当前蓝牙会话把 MQTT 地址、用户名和密码写入设备；MQTT 密码不会保存在 App 本地。
4. 等待设备 MQTT 状态变为已连接，再切换到“NAS MQTT 控制”并执行一次控制、打开统计页确认数据可读。

二维码/连接串包含 MQTT 凭据。首配页面的 `18080` 是局域网 HTTP 页面，不提供控制 API；不要把它或 `1883`、`8444` 暴露到公网，也不要把二维码发到公开群组。

### 8. 配置 NAS 校时健康状态（可选）

Gateway 只有在 NAS 时间健康检查通过时才向设备提供校时；没有完成此项时，控制和查询仍可用，但设备会拒绝采纳不可信的 NAS 时间。

```sh
python3 time_health_provider.py data/time-health/time-health.json --watch --interval-seconds 10
```

应将该命令配置为 NAS 支持的开机常驻任务。脚本优先读取 `chronyc tracking`；否则要求 `systemd-timesyncd` 处于 active、`NTPSynchronized=yes`，最近成功同步不超过 6 小时，且保守误差估计不超过 1 秒。若飞牛环境没有这些服务接口，健康文件会保持 unavailable，设备不会采纳该来源。`systemd/mimivent-time-health.service` 是 systemd 示例，部署前需改为 NAS 上的真实项目路径和运行用户。

## 更新、备份与回滚

- 更新前备份 `.env`、`tls/`、`mosquitto/passwords`、`data/gateway/` 和 `data/mosquitto/`。不要把这些含密钥或运行状态的内容提交到代码仓库。
- 将新版本源码同步到项目目录时保留上述文件和目录；然后在项目根目录运行 `sudo docker compose -f compose.yaml up -d --build gateway`。Mosquitto 配置未变时只重建 Gateway。
- 更新后运行 `sudo docker compose -f compose.yaml ps` 并检查 Gateway 日志和两个首配页面。若部署使用 `compose.nas.yaml`，所有命令都加上相同的覆盖参数。
- 回滚时恢复上一版源码与 Compose 配置，并使用对应旧镜像标签重建 Gateway；不要删除 SQLite 数据目录。
- `docker compose down -v` 会删除卷，禁止将它用作常规升级或故障排查命令。普通 `docker compose down` 不会删除本目录文件，但会让服务停机。

## 常见故障排查

| 现象 | 检查方式 | 处理方向 |
| --- | --- | --- |
| Compose 提示变量未设置 | `sudo docker compose -f compose.yaml config -q` | 检查 `.env` 是否位于项目根目录，核对 `NAS_IP`、`MQTT_USERNAME`、`MQTT_PASSWORD`。 |
| 容器启动后立刻退出 | `sudo docker compose -f compose.yaml logs --tail=200 gateway mosquitto` | 先看首个错误；检查证书文件、密码文件和数据目录权限。不要先删数据目录。 |
| 端口绑定失败 | `sudo ss -lntp` | 找到占用 `1883`、`8444` 或 `18080` 的服务；设备和 App 默认端口需保持一致。 |
| App 提示证书指纹错误 | `openssl x509 -in tls/cert.pem -outform der | sha256sum` | 与 NAS 设置页导入的指纹比较。证书重新生成后必须重新扫码导入。macOS 可用 `shasum -a 256` 替代 `sha256sum`。 |
| Broker 日志提示未授权 | `sudo docker compose -f compose.yaml logs --tail=100 mosquitto` | 检查 `.env` 中用户名/密码与 Mosquitto `passwords` 文件是否一致；确认密码文件没有被 `-c` 意外重置。 |
| Mosquitto 报告数据库或 ACL 权限为 world-readable | `ls -l data/mosquitto/mosquitto.db mosquitto/acl` | 数据库存在时执行 `sudo chown 1883:1883 data/mosquitto/mosquitto.db` 和 `sudo chmod 700 data/mosquitto/mosquitto.db`；ACL 按部署步骤设置为属主 `1883:1883`、权限 `640`。 |
| 设备没有 MQTT 数据 | 同时看 Gateway 和 Mosquitto 日志；核对设备 MQTT 状态与 NAS 地址/端口 | 确认 ESP32 与 NAS 在同一可互访网络，设备使用 TCP 1883，路由器没有客户端隔离。 |
| NAS Docker 拉镜像返回 401 | 确认报错来自基础镜像仓库，而不是 Gateway/MQTT 日志 | 在能拉取镜像的电脑、项目目录中执行下面的跨架构构建和传输命令；NAS 加载镜像后使用 Compose 启动，不要在 NAS 上再次触发在线构建。 |

## 安全边界

- App 到 NAS Gateway 的 HTTPS 使用 Gateway 固定证书指纹校验；设备 bearer token 只经此 HTTPS 交给 NAS 网关，再通过家庭局域网 MQTT 传给设备。Broker 账号凭据保存在 NAS `.env` 与设备 NVS，不写在源码中。
- Mosquitto ACL 只允许 `mimivent` 用户访问 MimiVent v1 topic。当前固件使用相同 Broker 凭据收发主题，所以此单设备/单家庭阶段的 ACL 范围是 `mimivent/v1/#`。Broker 只绑定家庭 LAN，不要暴露到公网。
- NAS 或 Broker 停机时，App 明确提示网关不可用并允许用户切换蓝牙；设备 HTTPS 控制已关闭，不执行直连回退。等待设备 ACK 超时则保留原 requestId，App 查询原结果，不自动重发。
- Broker 用户认证与 ACL 不能替代设备 token 校验。设备控制仍以固件绑定表中的 token hash 为准。

### Docker 仓库不可达时：跨架构镜像传入 NAS

以下示例假定 NAS SSH 用户为 `admin`，将 `NAS_IP` 替换为 NAS 固定地址。`--platform linux/amd64` 必须保留，因为飞牛 NAS 通常是 x86-64；不要把 Mac 本机 arm64 镜像直接传给 NAS。

在可拉取 Node 基础镜像的电脑上：

```sh
docker buildx build --platform linux/amd64 --load -t mimivent-gateway:0.1.0 .
docker save -o /tmp/mimivent-gateway-0.1.0-linux-amd64.tar mimivent-gateway:0.1.0
scp /tmp/mimivent-gateway-0.1.0-linux-amd64.tar admin@NAS_IP:/tmp/
```

再在 NAS 上：

```sh
sudo docker load -i /tmp/mimivent-gateway-0.1.0-linux-amd64.tar
cd /vol1/1000/docker/mimivent
sudo docker compose -f compose.yaml up -d gateway
sudo docker compose -f compose.yaml ps
```

如果 NAS 项目使用本地 Compose 覆盖文件，以上 Compose 命令都追加 `-f compose.nas.yaml`。镜像加载完成后，不要加 `--build`，否则 Compose 仍会尝试访问远程仓库。

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
