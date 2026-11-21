# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

SubMeld 面向自行编排代理订阅的管理员。管理员在工作台编排配置，再从客户端拉取同一个私有订阅地址。

## Product Purpose

把多个订阅源的保留节点、代理组和路由规则合并为可更新、可回滚的订阅成品。

## Operating Context

管理员添加订阅源，预览和筛选节点，配置出站策略与路由规则，再检查并发布配置。服务端负责定时刷新，工作台通过状态与更新记录呈现结果。

## Capabilities and Constraints

- 导航使用「订阅源」「节点管理」「路由规则」。
- 在工作台调整配置，确认发布后更新订阅，客户端再拉取该版本。工作台可以确认服务端发布和上游刷新。
- Mihomo 校验在服务端执行。订阅链接和节点连接参数属于私有数据。

## Evidence on Hand

README.md 记录部署及订阅流程。端到端用例使用三个合成订阅验证筛选、组装、发布、下载和窄屏操作。
