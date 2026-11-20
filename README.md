# SubMeld

SubMeld 是面向 FlClash / Mihomo 的自托管订阅工作台。它把多个机场的保留节点、代理组和分流规则发布到一个可撤销的私有订阅地址。

## 启动

要求 Node.js 24 或以上版本。以下命令适用于 Windows、Linux 和 macOS。

```sh
npm ci
npm run core:install
npm run build
npm start
```

打开 [本机工作台](http://127.0.0.1:8787)，创建管理密码。部署已有 Mihomo 时，可以用 `SUBMELD_MIHOMO_BIN` 指定可执行文件的绝对路径。安装命令下载并验证固定版本的官方二进制文件；Windows 需要系统自带的 `tar.exe`。发布时，服务端先运行 `mihomo -t`，校验通过后再切换成品。 [Mihomo 官方版本](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.34)

## 从机场到 FlClash

1. 在「订阅源」填写机场地址和展示名称，按需添加 Tag。选择「测试并预览」，按地区或关键词筛选节点，也可逐项排除或恢复。
2. 在「代理组」新建出口。在「动态筛选」多选来源和地区，留空表示不限。包含、排除正则按带 Tag 的节点名匹配，使用 RE2 语法，默认忽略大小写。例如，包含 `IEPL|专线`、排除 `测试|过期`，即可在预览中看到符合条件的保留节点。多条筛选按成员顺序合并并去重，也可点选具体节点、子组或内置出口。拖动和上下按钮都可调整顺序。
3. 打开「分流规则」，在「添加规则集」中搜索服务名，例如 Gemini，点选 `geosite/google-gemini`，选择目标出口并点「添加规则集」。每项生成一条 `RULE-SET`，由客户端每 24 小时更新官方 MRS 文件。自己的 YAML 或纯文本规则集可用「从链接添加」。单个域名可用「手动添加规则」，多个域名可在其中打开「批量添加与高级设置」。规则表按实际优先级排列。
4. 在「配置发布」运行检查并确认发布。复制私有链接到 FlClash 的订阅管理页，之后在 FlClash 中更新同一地址即可。
5. 在「更新记录」查看刷新失败、节点增减和重试结果。在「配置发布」中可以回滚；在「安全与备份」中可撤销链接或导出加密备份。

## 发布与刷新

「订阅源」卡片显示机场最近上报的剩余流量、到期日和获取时间。机场通过 `Subscription-Userinfo` 响应头提供用量，剩余流量按总额度减去上传和下载计算。[机场响应头说明](https://github.com/alireza0/s-ui/wiki/Subscription-Service)

点击卡片上的「设置日期」可填写续费日期。概览按手填日期提醒，留空时采用机场到期日。从提前 7 天到当天，首次打开概览会看到这期提醒。多个机场按日期排列，可点击名称修改续费日期。

- 自动刷新使用当前订阅版本的筛选、Tag、组与规则。修改这些设置后，点击「发布配置」即可更新订阅。暂停定时刷新和更新间隔会立即影响调度。变更地址或删除来源时，当前成品可以继续使用先前的来源，直到发布新设置。
- 上游空结果、获取错误、节点重名和 Mihomo 校验失败都会保留可用成品。可导入节点或已保留节点减少超过一半，或已保留节点降至零时，需要确认候选结果。采纳后可在工作台预览候选节点，发布时写入订阅。回滚恢复历史成品的内容，下一次手动发布后恢复成品自动更新。
- 节点名称按订阅解析结果原样保留，最终名称仅添加用户设置的 Tag。地理位置依据节点名称推断。成品保留节点所需的认证和传输参数。发布检查拦截完整的机场订阅地址，以及出现在名称、Tag、规则等非连接字段中的下载令牌。
- 支持包含 `proxies` 的 Mihomo / Clash YAML、节点 YAML 列表及部分常见的明文 / Base64 节点分享链接。订阅只包含外部代理集合、节点依赖上游链式代理或使用无法保留的连接选项时，界面会报告原因。自定义规则集链接支持 YAML 或纯文本，由服务端获取并内嵌。内置搜索目录来自 [MetaCubeX 的 geo 目录](https://github.com/MetaCubeX/meta-rules-dat/tree/meta/geo)，维护者可运行 `node scripts/update-rule-sets.js` 更新索引后重新构建。
- 规则测试以域名为输入。测试内置 GeoSite 规则集时，服务端按需读取对应的官方域名列表并在本地匹配。上游暂不可用、需要解析 IP 的 GeoIP 条件和其他依赖运行环境的条件会标注为不确定。[Mihomo 规则与规则集文档](https://wiki.metacubex.one/en/config/rules/)

## 服务端部署

在持续运行的主机上启动进程，后台调度与管理页面是否打开无关。公网部署请用支持 HTTPS 的反向代理转发至 SubMeld，并传递访问域名的 `Host`。反向代理的访问日志应遮挡 `/sub/` 路径中的凭证。私有链接与成品 YAML 都能提供节点连接信息。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SUBMELD_HOST` | `127.0.0.1` | 服务监听地址 |
| `SUBMELD_PORT` | `8787` | 服务监听端口 |
| `SUBMELD_DATA_DIR` | `./data` | SQLite 数据、Mihomo 校验目录与地理数据 |
| `SUBMELD_MIHOMO_BIN` | `./bin/mihomo[.exe]` | Mihomo 校验核心的绝对路径 |
| `SUBMELD_ADMIN_PASSWORD` | 首次从本机设置 | 用于无人值守的首次初始化，设定密码后可移除此变量 |
| `SUBMELD_PUBLIC_URL` | 当前访问源 | 私有链接使用的公开 HTTP(S) 源，例如 `https://sub.example.com` |
| `SUBMELD_SECURE_COOKIES` | 公开地址为 HTTPS 时开启 | 通过 HTTPS 部署时可设为 `1` |
| `SUBMELD_ALLOW_PRIVATE_UPSTREAMS` | 关闭 | 设为 `1` 后可用内网订阅和规则集，仅适用于受信任的私有环境 |

每个数据目录运行一个 SubMeld 实例。管理数据目录包含机场令牌和节点凭证，请限制文件访问权限。界面备份使用口令加密，保留方案、历史和节点缓存。恢复会替换这些数据并撤销旧的订阅地址，当前管理密码继续有效。

## 验证

```sh
npm test
npm run build
npm run core:install
npx playwright install chromium
npm run test:ui
```

为 `SUBMELD_MIHOMO_BIN` 设置绝对路径后，`npm test` 中的 HTTP 集成用例也会调用真实 Mihomo。端到端浏览器测试使用合成订阅覆盖三机场、筛选、组装、分流、发布、下载与窄屏设置。可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已安装的 Chromium 或 Chrome。
