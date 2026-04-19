# GJ-SDWAN v2.2 更新日志

发布日期: 2026-04-19

## 🐛 致命 Bug 修复（如果你的 VPS 无法互通，就是这些问题）

### Bug #1 · agentToken 丢失（最关键）
**现象：** 节点安装脚本执行完、注册成功，但 VPS 之间无法 ping 通内网 IP，Mesh 组网完全失败。

**根因：** `/api/node-register` 接口没保存 `agentToken`，导致后续所有 `/peer/add` 推送都返回 401 Unauthorized。

**修复：** 注册时自动把节点的 `token` 作为 `agentToken` 保存到数据库。

### Bug #2 · Mesh 推送索引错乱
**根因：** `setImmediate` 异步回调里使用了外层作用域的 `idx`，并发注册时可能推送错目标。

**修复：** 改用 `nodeId` 在异步内重新定位节点。

### Bug #3 · 新节点无法加入对端
**根因：** 因为 Bug #1，新节点的 `agentToken` 为空，管理中心无法把其他节点推给它。

**修复：** 依赖 Bug #1 的修复，同时明确验证 agentToken 存在后才推送。

### Bug #4 · Agent 端路由表未更新
**现象：** 即使 `wg show` 能看到 Peer，`ping 对端WG IP` 也不通。

**根因：** `wg set` 命令只配置 WireGuard 加密，不会自动在内核路由表中添加路由。`wg-quick` 才会，但我们用 `wg set` 动态加 peer 就丢了这一步。

**修复：** `addPeer` 执行完后自动 `ip route replace <allowedIP> dev wg0`，每个 AllowedIPs 都加路由。`removePeer` 同步清理路由。

### Bug #5 · 防火墙端口未开放
**现象：** 云厂商 VPS（阿里云/腾讯云/AWS）默认 ufw/firewalld 拦截所有入站端口。

**修复：** 安装脚本自动开放：
- `UDP 51820` (WireGuard)
- `TCP 51821` (Agent API)
- 兼容 iptables / ufw / firewalld / iptables-save 持久化

---

## 🆕 新增功能

### 1. 🚀 QUIC/BBR 加速中心
**路径：** 侧边栏 → 高级功能 → QUIC/BBR加速

**功能一：BBR 一键启用**
- 内核级 TCP 拥塞控制，5-15% 丢包场景下仍能保持高吞吐量
- 配合增大的 TCP 缓冲区（64MB）、TCP Fast Open 等优化
- 一键脚本在任何 VPS 执行即可

**功能二：Hysteria2 QUIC 隧道**
- 基于 QUIC 协议，**30% 丢包场景仍能维持正常速度**（WireGuard 在此场景会严重降速）
- 作为 WireGuard 的补充链路，架设在香港POP ↔ 落地VPS 之间
- 自动生成服务端/客户端配置 + 自签证书 + systemd 服务

### 2. 💎 HUB 双活高可用
**路径：** 侧边栏 → 高级功能 → HUB双活HA

- 基于 Keepalived + VRRP 协议
- 两台 HUB 竞争一个 VIP（虚拟IP），客户端 WG Endpoint 指向 VIP
- 主节点故障时备节点 **3秒内接管 VIP**，客户端无感知
- 自动生成主/备节点的完整安装脚本，包含：
  - Keepalived 配置（主/备优先级 150/100）
  - WG 健康检查脚本（wg0 接口+握手超时检测）
  - 状态变化通知（自动上报管理中心）
  - 防火墙 VRRP 协议放行
- 管理后台可视化查看主备状态

**前提：** 两台 HUB 在同一二层网络（同机房/同VPC），或使用云厂商 HAVIP 产品

### 3. 🔱 多路径冗余（ECMP）
**路径：** 侧边栏 → 高级功能 → 多路径冗余

- 同时建立深港 IEPL + 广港 IEPL 两条隧道
- 流量按5元组哈希分发（ECMP），天然负载均衡
- 内置路径监控脚本：每10秒 ping 每条路径的对端，故障路径自动从路由表剔除
- 任意一条线路断开，业务 0 中断
- 可配置权重（1-10），支持加权分发

### 4. 🔍 组网诊断中心
**路径：** 侧边栏 → 高级功能 → 组网诊断

**运行诊断：** 检查每个节点
- 节点在线状态
- Agent 端 51821 可达性
- 实际 Peer 数 vs 应有 Peer 数
- 问题列表（缺公钥/缺WG IP/缺agentToken/Agent不可达等）

**一键修复组网：**
- 自动补全历史版本中缺失的 `agentToken`（修复 Bug #1 的遗留数据）
- 强制重新推送所有 Peer 到所有在线节点
- 返回详细日志（成功/失败数量 + 错误原因）

---

## 📦 升级指南

### 从 v2.1 升级

**无需重装**，只需覆盖代码：

```bash
# 1. 备份数据（管理后台 → 网站设置 → 下载备份）

# 2. 备份代码
cd /opt/gj-sdwan
cp -r . ../gj-sdwan-backup

# 3. 覆盖新版本（解压 v2.2 包，覆盖到 /opt/gj-sdwan/）

# 4. 重启服务
pm2 restart gj-sdwan

# 5. 修复历史节点
# 管理后台 → 组网诊断 → 🔧 一键修复组网
```

### 全新安装

```bash
# 解压到服务器
tar -xf gj-sdwan-v2.2.tar
cd gj-sdwan-v2

# 启动
node server.js
# 或用 pm2: pm2 start server.js --name gj-sdwan

# 访问 http://服务器IP:3000
# 默认账号: admin / admin123 （请立即改密！）
```

---

## 🗂️ 文件清单

| 文件 | 功能 |
|------|------|
| `server.js` | 主服务器（1660行） |
| `agent.js` | 节点 Agent（已修复 Bug #4） |
| `db.js` | 内嵌存储引擎 |
| `scheduler.js` | 精准调度器 |
| `realtime.js` | SSE 实时推送 |
| `routing.js` | 智能选路引擎 |
| **`acceleration.js`** | **🆕 BBR/Hysteria2 加速** |
| **`ha.js`** | **🆕 Keepalived 双活HA** |
| **`mptcp.js`** | **🆕 多路径冗余** |
| `public/index.html` | 管理后台前端（3298行） |

---

## ⚠️ 已知注意事项

1. **HA 需要同一二层网络**：云厂商 VPC 之间的 HA 需要 HAVIP 产品支持（阿里云/腾讯云提供）
2. **MPTCP 需要内核 5.6+**：Ubuntu 22.04、Debian 12 原生支持；老系统用方案B（多WG+ECMP）无需内核支持
3. **Hysteria2 需要UDP端口**：默认 36712，安装脚本自动开放
4. **备份版本**：v2.2 的备份兼容 v2.1，但 v2.1 无法读取 v2.2 的 haConfigs/multiPaths 字段

---

## 📊 版本演进

- v1.0 → v2.0: 内嵌DB + SSE推送 + 智能选路
- v2.0 → v2.1: IEPL专线管理 + 手机分流配置 + 二维码下发
- **v2.1 → v2.2: 5个致命Bug修复 + 4个企业级新功能（QUIC/HA/多路径/诊断）**
