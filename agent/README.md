# SubMeld PC 探针

把探针安装在经常开机的个人电脑上，即可从这台电脑测量订阅节点。每个方案配对一台电脑。服务在开机后自动运行，空闲时每 15 秒向工作台查询任务，领取任务后才启动 Mihomo。

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

安装器提示时粘贴配对链接。链接有效期为 15 分钟，远程工作台使用 HTTPS，本机可用回环 HTTP。登记成功后，工作台显示电脑名称、在线状态和最近联系时间。此后即可关闭终端。

安装器会校验官方 Mihomo 核心的 SHA-256，并把 Node.js、探针程序与平台依赖复制到系统服务目录。使用已有 Mihomo 时，可在安装命令的环境中设置 `SUBMELD_MIHOMO_BIN` 为可执行文件的绝对路径。Windows 使用固定版本的 WinSW 2.12.0 注册延迟自动启动的 `SubMeldProbe` 服务，以 LocalService 运行。Linux 启用 `submeld-probe.service`，由 systemd 分配专用运行身份。[Mihomo 发行版](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.34) · [WinSW 服务配置](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md) · [systemd 运行环境](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)

## 创建检测任务

在「节点管理 → 质量检测」选择「已勾选」或「当前筛选」。筛选范围包括全部分页，单次最多 1,024 个节点。选择采样轮数和可选的下载测速、AI 平台检测，再点击「创建检测任务」。开启下载测速时，面板会显示本批的下载流量上限。

同一方案可保留一个待领取或运行中的任务。离线期间新建的任务最多等待 24 小时。电脑恢复连接后自动领取，断网期间会逐步延长重试间隔，最长为 5 分钟。工作台显示检测进度、节点详情和可导出的 JSON 报告。运行中断后，两分钟没有进度的任务会标记为失败，需要重新创建才会再次消耗检测流量。

每次检测使用独立的临时 Mihomo 工作目录，一个节点对应一个带随机口令的回环 HTTP 端口。探针通过绑定的出站发送请求。若日常客户端启用了系统级 TUN，外层连接仍受系统路由影响。需要使用特定网卡时，可在运行 `submeld-probe install` 的环境中设置 `SUBMELD_PROBE_INTERFACE` 为网卡名称，并核对客户端的路由规则。[Mihomo 监听器配置](https://wiki.metacubex.one/en/config/inbound/listeners/)

## 状态、更新与卸载

- 在两种系统上运行 `submeld-probe status` 可查看服务状态和开机自启状态。
- Windows 的日志和本地报告分别位于 `%ProgramData%\SubMeldProbe\logs` 和 `%ProgramData%\SubMeldProbe\reports`。Linux 使用 `journalctl -u submeld-probe.service` 查看日志，本地报告在 `/var/lib/submeld-probe/reports/`。
- 更新时下载新版安装包，在任务空闲时再次运行本系统的两条安装命令。已有配对会沿用，服务运行文件和 Node.js 副本会更新。
- 要更换电脑，在工作台展开常驻探针并选择「解除配对」。当前常驻任务会取消。新电脑使用新的配对链接。已安装的电脑可以运行 `submeld-probe install --pair` 重新登记。Linux 安装、更新和卸载命令前加 `sudo`。
- 卸载时先运行 `submeld-probe uninstall`，再运行 `npm uninstall --global submeld-quality-probe`。已有报告保存在数据目录。电脑离线卸载时，还需在工作台解除原配对。

## 检测口径

| 指标 | 测量方法 |
| --- | --- |
| 可用性与延迟 | 每个节点先做一次预热，再建立 2–8 次新连接到 Google 的 `generate_204`。任一正式采样取得预期的 HTTPS 204 即判可用。每次最长等待 6 秒。 |
| TLS RTT | 完成 HTTP CONNECT 后开始计时，到 TLS 握手成功为止。报告保存每轮数据及成功握手的中位数，单位为毫秒。 |
| HTTPS 延迟 | 从建立本地代理连接到收到目标 204 响应头的耗时，汇总成功样本的中位数。 |
| 抖动与丢包率 | 抖动取相邻成功 HTTPS 样本耗时差的绝对值均值。丢包率采用失败 HTTPS 请求数除以正式采样数。样本不足时相应指标为 `null`。 |
| 出口 | 可用节点通过 Cloudflare trace 取得出口 IP 与两位地区代码。读取失败时保留已有延迟结果。 |
| 下载 | 在延迟阶段结束后，使用 1–2 路并发从 Cloudflare Speed Test 流式下载。读取响应正文达到字节上限或总耗时达到上限即关闭流。平均速度包含建连，最高速度取各时段速率的最大值，最后不足一秒按实际时长计算。 |
| 流量 | `speed.bytes` 是已读取的下载正文。TLS 与代理协议开销、延迟采样、出口查询和 AI 探测会产生额外网络流量。 |

## AI 平台判定

探针使用 Impit 的固定 Chrome TLS 配置访问公开入口。每个已知出口 IP 只检测一次，未知 IP 的节点分别检测。每次最多并行检测两个出口，每个出口最多三个入口请求。结果记录响应状态、判定依据和 `needsReview`。[Impit 协议客户端](https://github.com/apify/impit)

- **ChatGPT** 分别检查 Web 首页与官方 Android App 域名。App 入口只返回通用 404 或拒绝响应时标记待复核。[OpenAI 网络域名说明](https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps)
- **Gemini** 检查 Web 入口，并用相同出站读取 YouTube 页面中 Google 的地区标记。Google 识别地区与出口不一致、个人账号适用性待确认或地区缺失时，标记人工复核。[Gemini 支持地区](https://support.google.com/gemini/answer/13575153)
- **Claude** 分别检查 Web 首页与 Models API。未携带密钥收到明确的认证错误，会显示「需要登录」并保留 HTTP 状态。[Claude API 错误说明](https://platform.claude.com/docs/en/api/errors)
- **Grok** 区分明确地区限制、Cloudflare 挑战、明确 IP 封禁、限频及未知拒绝。遇到挑战时记录该响应，交由浏览器复核。[Cloudflare 挑战响应](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)

「入口可达」表示本次请求观察到了产品入口。登录、账号资格和实际模型调用需要在对应产品中确认。

## JSON 报告

格式版本为 `schemaVersion: 1`。每份报告包含任务 ID、时间、测试配置和 `results` 数组。每行保留节点标识、来源、正式采样、聚合指标、出口、下载结果与各平台判定。时间单位为毫秒，`lossRate` 取值为 0–1，`averageBps`、`peakBps` 与 `perSecondBps` 的单位均为字节每秒。跳过或缺乏依据的字段使用 `null`。

工作台为每个配置方案保存最近 12 次任务。关闭页面后探针继续运行。在工作台取消任务后，探针会停止本次测量并继续等待后续任务。检测记录通过 JSON 单独归档，配置备份保存订阅编排数据。
