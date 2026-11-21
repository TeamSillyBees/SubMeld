---
name: SubMeld
description: 面向代理订阅管理员的浅色工作台
colors:
  primary: "#4166eb"
  primary-hover: "#3152ce"
  accent: "#e9eeff"
  accent-foreground: "#304fc2"
  sidebar-selected: "#e2e7ff"
  success-ink: "#276c49"
  success-bg: "#eaf4ee"
  warning-ink: "#875416"
  warning-bg: "#fff4e5"
  destructive: "#a73530"
  danger-bg: "#fbedeb"
  background: "#f4f6fa"
  card: "#fff"
  panel-wash: "#fbfcfe"
  sidebar: "#f8fafc"
  muted: "#f3f6fa"
  secondary: "#eef2f7"
  sidebar-hover: "#edf1fa"
  foreground: "#10192c"
  muted-foreground: "#54647f"
  border: "#dfe5f0"
  input: "#8a97af"
  ring: "#4166cf"
typography:
  headline:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "clamp(1.35rem, 1.6vw, 1.65rem)"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-.025em"
  title:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "clamp(.975rem, .71vw, 1.13rem)"
    fontWeight: 500
    lineHeight: 1.35
  metric:
    fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", "Microsoft YaHei UI", monospace'
    fontSize: "clamp(1.24rem, 1.02vw, 1.65rem)"
    fontWeight: 500
    lineHeight: 1.25
  body:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "clamp(.875rem, .63vw, 1rem)"
    fontWeight: 400
    lineHeight: 1.55
  caption:
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", system-ui, sans-serif'
    fontSize: "clamp(.78rem, .55vw, .88rem)"
rounded:
  control: ".5rem"
  inset: ".65rem"
  panel: "clamp(.75rem, .6vw, .95rem)"
  pill: "2rem"
spacing:
  inline: ".5rem"
  panel-pad: "clamp(1rem, .82vw, 1.32rem)"
  panel-gap: "clamp(1rem, .95vw, 1.5rem)"
  workspace-gutter: "clamp(1rem, 1.8vw, 2rem)"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.card}"
    rounded: "{rounded.control}"
    padding: "0 .625rem"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-outline:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "0 .625rem"
  button-ghost:
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "0 .625rem"
  button-danger:
    textColor: "{colors.destructive}"
    rounded: "{rounded.control}"
    padding: "0 .625rem"
  input:
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: ".25rem .625rem"
  nav-current:
    backgroundColor: "{colors.sidebar-selected}"
    textColor: "{colors.accent-foreground}"
    height: "clamp(2.05rem, 1.58vw, 2.5rem)"
    rounded: "{rounded.inset}"
  badge-success:
    backgroundColor: "{colors.success-bg}"
    textColor: "{colors.success-ink}"
    rounded: "{rounded.pill}"
    typography: "{typography.caption}"
  panel:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
  metric-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
  retention-bar:
    backgroundColor: "{colors.secondary}"
    rounded: "{rounded.pill}"
    height: "clamp(.38rem, .3vw, .46rem)"
---

# Design System: SubMeld

## Overview

**Creative North Star: "订阅工作台"**

雾蓝灰画布托起白色面板，左侧导航按任务分组。管理员可以从指标看出保留了多少节点，再进入对应页面核对来源和筛选条件。

文字说明操作，等宽读数呈现版本、时间和比例。私有订阅地址显示遮挡后的路径，复制操作紧邻地址。

**Key Characteristics:**

- 桌面分组侧栏、固定在顶部的工作栏与居中的内容区。
- 相邻面板共用对齐线，面板内用细线区分标题、内容与操作。
- 状态标签写明结果，数字与进度条一起展示节点保留比例。

## Colors

- **操作与定位**　主操作、保留比例和指标图标用操作蓝。导航当前项用淡蓝底、深蓝字和较重字重。正文里的文字链接悬停时加下划线。
- **状态**　绿色表示可用或成功，琥珀色表示暂停与提醒，红色表示错误或破坏性操作，蓝色表示刷新中，灰色表示停用或待处理。
- **中性色**　画布、侧栏和面板底部分别使用雾蓝灰、浅灰和接近白色的底色。正文用墨蓝，解释与时间标签用灰蓝。输入框的边线深于面板分隔线。

**The Status Label Rule.** 每个状态标签写出具体结果，例如「可用」「更新已暂停」或「获取失败」，图标与颜色补充这段文字。

## Typography

中文界面沿用系统无衬线字族。一级标题较重，面板标题采用中等字重，指标读数比旁边的说明文字大一级。窄屏一级标题为 1.5rem。技术读数优先使用 Cascadia Mono，系统按字体栈回退。

**The Numeric Alignment Rule.** 并排比较的计数使用等宽数字，版本、节点比例和刷新时刻使用等宽字族。

## Layout

桌面侧栏宽度随视口变化（14–20rem），顶栏吸附在视口顶部。主区左右留出等宽边距，宽屏内容限制在 104rem 以内。概览指标有四列，下面按 1.41∶1 排列操作面板。

概览**容器**宽度 ≤50rem 时，指标改为两列，面板改为一列。可重排的表格在自身容器 ≤39rem 时逐行显示字段标签。视口小于 768px 时导航进入抽屉。宽度 ≤37rem 或使用粗指针时，常用按钮、输入框和选择框的最小高度增至 2.75rem（44px）。

## Elevation & Depth

指标卡和工作面板使用细边线与轻微向下的阴影。面板底部的浅色操作区靠上边线分隔。对话框出现时，半透明深蓝遮罩覆盖后方页面，标题与操作区留在原位，长表单在中间滚动。

## Shapes

按钮和表单控件用小圆角，内嵌的时间格与导航行稍圆，面板圆角随视口宽度变化。胶囊形用于短状态、版本、计数和细进度条。操作图标使用线性 SVG，状态点为实心圆。

## Components

- **按钮**　保存与发布使用蓝底白字。下载、预览和筛选使用浅灰底描边按钮。概览地址栏内的复制按钮和编辑器的取消按钮使用透明底，删除确认使用浅红底红字。键盘焦点显示焦点环，操作进行中可显示转圈图标并禁用重复提交。
- **输入框**　标签位于字段上方，示例和提示使用灰蓝字。获得焦点时边线变蓝，校验失败时显示红色边线及文字说明。
- **导航项**　左侧放图标与名称，右侧按需显示计数或版本。当前项保留选中底色并标记当前页面。移动端选择目的地后收起抽屉。
- **面板**　常规面板将标题和状态分列在标题栏两侧，整块内容的操作放在底部。列表可以贴着面板边线排列，表单和说明使用面板内边距。订阅源卡片在标题行显示名称、前缀和状态，编辑、排序与删除操作集中在卡片顶部。
- **指标与比例**　整张指标卡可进入相应管理页。概览的蓝色比例条配有保留数与总数。订阅源卡片在标题旁显示「保留数 / 总数」，点击可进入该来源的节点筛选。

## Do's and Don'ts

- **Do**　沿用「订阅源」「节点管理」「路由规则」作为导航名称。
- **Do**　在比例条旁显示保留数与总数，使进度条长度有明确含义。
- **Don't**　不要在概览、状态标签或提示中展示完整的私有订阅令牌。
- **Don't**　不要用「客户端已同步」描述服务端发布成功或上游刷新成功。
