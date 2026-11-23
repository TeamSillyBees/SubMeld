# SubMeld PC 探针

探针在个人电脑上测量所选代理节点。Windows 与 Linux 下载包支持 x64 和 ARM64，需要 Node.js 24 或更高版本和 npm。

## 开始检测

1. 在 SubMeld 的「节点管理」勾选节点，或使用来源、地区和搜索条件确定范围。打开「质量检测」，选择「已勾选」或「当前筛选」。当前筛选包含全部分页，单次最多 1,024 个节点。
2. 选择采样轮数。开启下载测速后，面板会显示这批节点的下载流量上限。创建任务，再下载并解压对应系统的 ZIP。
3. Windows 双击 `start.cmd`。Linux 在解压目录运行 `sh start.sh`。首次启动会通过 npm 安装锁定版本的协议客户端，并从 Mihomo 官方发行版下载核心、校验 SHA-256。已有核心时，可设置 `SUBMELD_MIHOMO_BIN` 指向其可执行文件。[Mihomo 发行版](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.34)
4. 将工作台复制的配对链接粘贴到探针窗口，按回车。远程服务使用 HTTPS，本机开发可使用回环 HTTP 地址。链接有效期为 15 分钟，一台探针领取后绑定本次任务。
5. 在「质量检测」查看进度。完成后可以按延迟、速度、出口 IP 或 AI 平台比较节点，查看单节点详情并导出 JSON。解压目录的 `reports/` 也会保存报告。

探针主动向服务端领取这一批节点的连接参数。每次运行创建独立的临时 Mihomo 工作目录，一个节点对应一个带随机口令的回环 HTTP 监听端口。延迟、下载和平台请求均通过绑定的出站发出。任务结束或正常取消时会关闭子进程并清理临时配置。[Mihomo 监听器配置](https://wiki.metacubex.one/en/config/inbound/listeners/)

若日常客户端启用了系统级 TUN，外层连接仍受操作系统路由影响。需要从特定物理网卡出站时，可在启动前设置 `SUBMELD_PROBE_INTERFACE` 为本机网卡名称，并核对日常客户端的 TUN 路由或进程排除规则。探针使用自身的监听端口与临时配置，保留系统代理设置。

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

工作台为每个配置方案保存最近 12 次任务。关闭页面后探针继续运行。在工作台取消任务或在终端按 Ctrl+C 可以停止检测。服务端超过两分钟收不到探针进度，会将任务标记为中断。检测记录通过 JSON 单独归档，配置备份保存订阅编排数据。
