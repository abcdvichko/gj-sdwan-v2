/**
 * mptcp.js - 多路径 TCP（MPTCP）+ WireGuard 多链路冗余
 *
 * 策略：
 *  - 方案A: MPTCP（需要 Linux 5.6+ 内核支持，原生）
 *  - 方案B: 多WG隧道 + ECMP 路由，流量按流哈希分发
 *  - 方案C: 多WG隧道 + 策略路由，按源IP分发（适合分流场景）
 *
 * 推荐方案B，兼容性最好，任意Linux都能用
 */

/**
 * 方案A: MPTCP 启用脚本（内核原生支持）
 * 要求内核 5.6+，推荐 5.15+
 */
function generateMPTCPScript() {
  return `#!/bin/bash
# GJ-SDWAN MPTCP 启用脚本
# 要求 Linux 内核 5.6+（推荐 5.15+）
set -e

KERNEL=$(uname -r | awk -F. '{print $1*100+$2}')
if [ "$KERNEL" -lt 506 ]; then
  echo "❌ 内核版本 $(uname -r) 过低，MPTCP 需要 5.6+"
  echo "   建议升级到 Ubuntu 22.04 / Debian 12 / CentOS Stream 9"
  exit 1
fi

echo "▶ 启用 MPTCP..."
sysctl -w net.mptcp.enabled=1
echo "net.mptcp.enabled=1" > /etc/sysctl.d/99-mptcp.conf

# 安装 mptcpize（可选，帮助普通TCP应用启用MPTCP）
if command -v apt-get &>/dev/null; then
  apt-get install -y mptcpd iproute2 2>/dev/null || true
fi

# 添加多个路径（多网卡或多IP场景）
# ip mptcp endpoint add <IP1> dev eth0 subflow
# ip mptcp endpoint add <IP2> dev eth1 subflow

# 设置默认支持多子流
ip mptcp limits set subflows 4 add_addr_accepted 4

echo ""
echo "✅ MPTCP 已启用"
echo "   查看状态: ip mptcp endpoint show"
echo "   查看限制: ip mptcp limits show"
echo ""
echo "★ 使应用支持 MPTCP: mptcpize run ./your-program"
echo "★ 或: sysctl net.ipv4.tcp_mptcp_enabled=1"
`;
}

/**
 * 方案B: 多WG隧道 + ECMP（推荐，兼容所有Linux）
 *
 * 场景：一个客户端通过深港IEPL和广港IEPL两条路径同时到达落地VPS
 * 流量按5元组哈希分发到两条隧道，任意一条断开不影响业务
 */
function generateMultiTunnelConfig(node, tunnels) {
  // tunnels: [{ name: '深港', wgIP, peerWgIP, weight: 1 }, { name: '广港', wgIP, peerWgIP, weight: 1 }]

  const interfaces = tunnels.map((t, i) => `wg${i}`).join(' ');

  return {
    path: '/etc/gj-sdwan/multi-path.sh',
    content: `#!/bin/bash
# GJ-SDWAN 多路径冗余脚本（ECMP）
# 节点: ${node.name}
# 隧道数: ${tunnels.length}

set -e

# Step 1: 确保所有WG隧道已启动
${tunnels.map((t, i) => `
# 隧道 ${i+1}: ${t.name}
# WG IP: ${t.wgIP}
# 对端: ${t.peerWgIP}
ip link show wg${i} &>/dev/null || {
  echo "❌ wg${i} 接口未启动，请先配置 /etc/wireguard/wg${i}.conf"
  exit 1
}
`).join('')}

# Step 2: 清除旧的默认路由（只清除我们的，不动eth0）
${tunnels.map((_, i) => `ip route del default dev wg${i} 2>/dev/null || true`).join('\n')}
ip route del default table 200 2>/dev/null || true

# Step 3: 创建多路径 ECMP 路由
# 流量按源IP+目的IP+端口哈希，均匀分发到多个下一跳
ip route replace default \\
  ${tunnels.map((t, i) => `nexthop via ${t.peerWgIP.split('/')[0]} dev wg${i} weight ${t.weight || 1}`).join(' \\\n  ')}

# Step 4: 验证
echo "✅ 多路径路由已生效："
ip route show default
echo ""
echo "实时流量分布："
for i in ${tunnels.map((_, i) => i).join(' ')}; do
  IFACE="wg$i"
  RX=$(cat /sys/class/net/$IFACE/statistics/rx_bytes 2>/dev/null || echo 0)
  TX=$(cat /sys/class/net/$IFACE/statistics/tx_bytes 2>/dev/null || echo 0)
  echo "  $IFACE:  RX=$RX bytes  TX=$TX bytes"
done
`,
  };
}

/**
 * 方案C: 故障检测 + 自动剔除故障路径
 */
function generatePathMonitorScript(tunnels) {
  return `#!/bin/bash
# GJ-SDWAN 多路径监控脚本
# 每10秒检查一次所有隧道，自动剔除故障路径

while true; do
  sleep 10
  ACTIVE_PATHS=""
  ${tunnels.map((t, i) => `
  # 检测隧道 ${i+1}: ${t.name}
  PEER_IP="${t.peerWgIP.split('/')[0]}"
  if ping -c 2 -W 3 -I wg${i} $PEER_IP &>/dev/null; then
    ACTIVE_PATHS="$ACTIVE_PATHS nexthop via $PEER_IP dev wg${i} weight ${t.weight || 1}"
    STATE_${i}="UP"
  else
    STATE_${i}="DOWN"
    logger -t gj-sdwan "路径${t.name}(wg${i}) 故障"
  fi`).join('')}

  # 如果至少有一条路径活着，更新路由
  if [ -n "$ACTIVE_PATHS" ]; then
    ip route replace default $ACTIVE_PATHS 2>/dev/null
  else
    logger -t gj-sdwan "⚠️ 所有路径都故障！"
  fi

  # 输出状态（10秒一次，日志可能较多，生产环境可注释）
  # echo "[$(date +%H:%M:%S)] ${tunnels.map((t, i) => `${t.name}: $STATE_${i}`).join(' | ')}"
done
`;
}

/**
 * 生成多隧道一键安装脚本
 */
function generateMultiPathInstallScript(node, tunnels, managerIP, managerPort) {
  const multiPathConf = generateMultiTunnelConfig(node, tunnels);
  const monitorScript = generatePathMonitorScript(tunnels);

  return `#!/bin/bash
# GJ-SDWAN 多路径冗余 一键部署
# 节点: ${node.name}
# 路径数: ${tunnels.length}
set -e
[ "$(id -u)" = "0" ] || { echo "❌ 需要 root 权限"; exit 1; }

echo "▶ [1/4] 检查WireGuard隧道..."
MISSING=""
${tunnels.map((t, i) => `
[ -f /etc/wireguard/wg${i}.conf ] || MISSING="$MISSING wg${i}"`).join('')}
if [ -n "$MISSING" ]; then
  echo "❌ 缺少WG配置文件: $MISSING"
  echo "   请先完成各隧道的单独部署"
  exit 1
fi

echo "▶ [2/4] 启动所有WG隧道..."
${tunnels.map((_, i) => `systemctl enable --now wg-quick@wg${i} 2>/dev/null || true`).join('\n')}
sleep 2

echo "▶ [3/4] 安装多路径脚本..."
mkdir -p /etc/gj-sdwan
cat > ${multiPathConf.path} << 'MPEOF'
${multiPathConf.content}
MPEOF
chmod +x ${multiPathConf.path}

cat > /etc/gj-sdwan/path-monitor.sh << 'MONEOF'
${monitorScript}
MONEOF
chmod +x /etc/gj-sdwan/path-monitor.sh

echo "▶ [4/4] 创建 systemd 服务..."
cat > /etc/systemd/system/gj-sdwan-multipath.service << 'SVCEOF'
[Unit]
Description=GJ-SDWAN Multi-Path Routing
After=network.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=${multiPathConf.path}
ExecStart=/etc/gj-sdwan/path-monitor.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable gj-sdwan-multipath
systemctl restart gj-sdwan-multipath

sleep 3
systemctl status gj-sdwan-multipath --no-pager | head -10

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║  ✅ 多路径冗余已启用                          ║"
echo "╚═══════════════════════════════════════════════╝"
echo "  路径数: ${tunnels.length}"
${tunnels.map((t, i) => `echo "  路径${i+1}: ${t.name} (wg${i}) → ${t.peerWgIP}"`).join('\n')}
echo ""
echo "★ 查看路由: ip route show default"
echo "★ 查看日志: journalctl -u gj-sdwan-multipath -f"
echo "★ 验证负载均衡: 持续ping目标，观察wg0/wg1的流量分布"
`;
}

module.exports = {
  generateMPTCPScript,
  generateMultiTunnelConfig,
  generatePathMonitorScript,
  generateMultiPathInstallScript,
};
