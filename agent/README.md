# SubMeld PC 探针

把探针安装在经常开机的个人电脑上，即可从这台电脑测量订阅节点。同一方案可配对多台电脑，并为每台设置备注名。服务在开机后自动运行，空闲时通过最长 25 秒的 HTTP 长轮询等待派单。领取任务后启动 Mihomo。

## 安装和配对

在「节点管理 → 质量检测 → 安装并配对常驻探针」下载 `submeld-quality-probe.tgz`，再点击「复制电脑配对链接」。Windows 和 Linux 共用这个 npm 安装包，支持 x64 和 ARM64，需要 Node.js 24+ 和 npm。[npm 本地安装包说明](https://docs.npmjs.com/cli/v11/commands/npm-install/)

**Windows** 在安装包所在目录打开管理员 PowerShell，运行以下两条命令。

```powershell
npm install --global ./submeld-quality-probe.tgz
submeld-probe install
```

**Linux** 在使用 systemd 247 或更高版本的主机上，进入安装包所在目录运行以下命令。系统 Node.js 和 npm 需要在 sudo 的命令搜索路径中。

```sh
sudo npm install --global ./submeld-quality-probe.tgz
sudo submeld-probe install
```

安装器提示时粘贴配对链接。链接有效期为 15 分钟，远程工作台使用 HTTPS，本机可用回环 HTTP。探针会报告版本、Mihomo 版本、本机网卡的 IP 地址族，以及 IPinfo 返回的网络地区和运营商。此后即可关闭终端。

安装器会校验官方 Mihomo 核心的 SHA-256，并把 Node.js、探针程序与平台依赖复制到系统服务目录。使用已有 Mihomo 时，可在安装命令的环境中设置 `SUBMELD_MIHOMO_BIN` 为可执行文件的绝对路径。Windows 使用固定版本的 WinSW 2.12.0 注册延迟自动启动的 `SubMeldProbe` 服务，以 LocalService 运行。Linux 启用 `submeld-probe.service`，由 systemd 分配专用运行身份。[Mihomo 发行版](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.34) · [WinSW 服务配置](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md) · [systemd 运行环境](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)

## 创建检测任务

在「节点管理 → 质量检测」选择「已勾选」或「当前筛选」。筛选范围包括全部分页，单次最多 1,024 个节点。选择执行探针、采样轮数和可选的下载测速、AI 平台检测，再点击「创建检测任务」。开启下载测速时，面板会显示本批的下载流量上限。

每台在线且版本兼容的探针同时执行一个任务，最多另有 5 项排队。已入队的任务保留 24 小时，可以取消或改派。探针正常退出时主动通知工作台，失联 35 秒后显示离线。电脑恢复连接后继续领取排队任务。运行中断且两分钟没有进度的任务标记为失败。工作台提供检测进度、节点详情和 JSON 报告。

每次检测使用独立的临时 Mihomo 工作目录，一个节点对应一个带随机口令的回环 HTTP 端口。探针通过绑定的出站发送请求。若日常客户端启用了系统级 TUN，外层连接仍受系统路由影响。需要使用特定网卡时，可在运行 `submeld-probe install` 的环境中设置 `SUBMELD_PROBE_INTERFACE` 为网卡名称，并核对客户端的路由规则。[Mihomo 监听器配置](https://wiki.metacubex.one/en/config/inbound/listeners/)

## 状态、更新与卸载

- 在两种系统上运行 `submeld-probe status` 可查看服务状态和开机自启状态。
- Windows 的日志和本地报告分别位于 `%ProgramData%\SubMeldProbe\logs` 和 `%ProgramData%\SubMeldProbe\reports`。Linux 使用 `journalctl -u submeld-probe.service` 查看日志，本地报告在 `/var/lib/submeld-probe/reports/`。
- 更新时先升级工作台，再从工作台下载探针安装包，在任务空闲时重新运行本系统的两条安装命令。探针 2.0.0 使用协议 4 上报细分判据，需要工作台与探针同步升级，已有配对可以沿用。
- 要更换电脑，在工作台展开常驻探针并选择「解除配对」。这台探针的待执行和运行中任务会取消。新电脑使用新的配对链接。已安装的电脑可以运行 `submeld-probe install --pair` 重新登记。Linux 安装、更新和卸载命令前加 `sudo`。
- 卸载时先运行 `submeld-probe uninstall`，再运行 `npm uninstall --global submeld-quality-probe`。已有报告保存在数据目录。电脑离线卸载时，还需在工作台解除原配对。

## 检测口径

| 指标 | 测量方法 |
| --- | --- |
| 可用性与延迟 | 每个节点先预热一次，再建立 2–8 次新连接到 Google 的 `generate_204`。建连和 TLS 握手共用 6 秒预算，握手后另给响应 3 秒。任一正式采样取得 HTTPS 204 即判可用。 |
| TLS RTT | 完成 HTTP CONNECT 后开始计时，到 TLS 握手成功为止。报告保存每轮数据及成功握手的中位数，单位为毫秒。 |
| HTTPS 延迟 | 从建立本地代理连接到收到目标 204 响应头的耗时，汇总成功样本的中位数。失败详情区分未完成握手、握手后未收到响应头、收到其他 HTTP 状态码。 |
| 抖动与丢包率 | 抖动取相邻成功 HTTPS 样本耗时差的绝对值均值。丢包率采用失败 HTTPS 请求数除以正式采样数。样本不足时相应指标为 `null`。 |
| 出口 | 可用节点通过 Cloudflare trace 读取 IP 和地区，首次预算 5 秒，连接失败后可再试 3 秒，仍无结果时查询 IPinfo。缺少出口地区时，至少两个 AI 入口给出地区且所有已知地区一致，工作台才标为推定地区。原始报告保留实际采集到的 IP。 |
| 下载 | 在延迟阶段结束后，使用 1–2 路并发从 Cloudflare Speed Test 流式下载。读取响应正文达到字节上限或总耗时达到上限即关闭流。平均速度包含建连，最高速度取各时段速率的最大值，最后不足一秒按实际时长计算。 |
| 流量 | `speed.bytes` 是已读取的下载正文。TLS 与代理协议开销、延迟采样、出口查询和 AI 探测会产生额外网络流量。 |

## AI 平台判定

探针使用 Impit 逐节点访问公开入口。同一出口 IP 下的线路依次测量，各自保存结果。不同出口最多并行检测 6 路，每条隧道最多同时发出 2 个请求。丢包率达到 50% 或 HTTPS 中位延迟达到 4 秒时跳过 AI 检测，流量和到期提示条目在启动核心前跳过。[Impit 协议客户端](https://github.com/apify/impit)

平台 trace 首次预算 5 秒，断连或超时后可再试 3 秒。仍缺少该站点地区时，只有至少一个其他域名的地区与通用出口一致，且本节点所有已知观测均一致，才能在未决 403 上参考出口地区。详情标注推定依据，报告的 `providerRegion` 保留原始观测。

- **ChatGPT** 分别记录合规接口和移动网关。移动网关返回 403 时，只有命中已知的未签名网关 JSON 提示才记为入口可达。地区拒绝、机房限制和浏览器验证各有独立判据。[ChatGPT 支持地区](https://help.openai.com/en/articles/7947663-chatgpt-supported-countries)
- **Gemini Web** 测量个人账号的网页入口。探针最多跟随一次同域 `/app` 跳转，读到产品标题和 Google 地区标记后即停止下载。异常流量验证和同意页分别记录。Gemini API 的可用地区由 Google 单独列出。[网页版支持地区](https://support.google.com/gemini/answer/13575153?hl=en) · [API 支持地区](https://ai.google.dev/gemini-api/docs/available-regions)

全入口可达、部分入口可达、需要浏览器验证、地区受限、封禁或连接失败分别计 3、2、1、0、−1 分。Web 遇到验证而 API 可达时记 2 分。地区受限加浏览器验证记 0 分。可达与地区受限并存时，保留各入口读数并将平台等级留空。

综合排序先比较可达平台数，再比较总分。代理组启用「筛空时先放宽条件」后，先取消延迟上限，仍然为空才放宽 AI 等级。丢包、带宽和出口地区条件在这两步中持续生效。

「入口可达」表示本次请求观察到了产品入口。登录、账号资格和实际模型调用需要在对应产品中确认。

## JSON 报告

格式版本为 `schemaVersion: 1`。每份报告包含任务 ID、时间、测试配置和 `results` 数组。每行保留节点标识、来源、正式采样、聚合指标、出口、下载结果与各平台判定。时间单位为毫秒，`lossRate` 取值为 0–1，`averageBps`、`peakBps` 与 `perSecondBps` 的单位均为字节每秒。跳过或缺乏依据的字段使用 `null`。

工作台保留近期检测记录和所有活动任务。已发布版本单独保存所用报告 ID 和筛选所需指标，支持回滚与后续订阅刷新。关闭页面后探针继续运行。在工作台取消任务后，探针会停止本次测量并继续等待后续任务。检测记录通过 JSON 单独归档，配置备份保存订阅编排数据。
