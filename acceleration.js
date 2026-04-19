/**
 * acceleration.js - QUIC/BBR/Hysteria2 加速引擎
 *
 * 功能：
 *  1. BBR 拥塞控制（内核级，无需额外进程）
 *  2. Hysteria2 隧道（QUIC based，高丢包场景救命）
 *  3. 生成/下发 Hysteria2 配置
 */

/**
 * 生成 BBR 启用脚本（内核层）
 * 适合在落地 VPS 执行，开启后 TCP 吞吐量提升，丢包恢复能力增强
 */
function generateBBRScript() {
  return `#!/bin/bash
# GJ-SDWAN BBR 加速脚本
# 在落地VPS执行，内核级TCP加速，丢包场景下速度提升显著
set -e

echo "▶ 检查内核版本..."
KERNEL_MAJOR=$(uname -r | cut -d. -f1)
KERNEL_MINOR=$(uname -r | cut -d. -f2)
if [ "$KERNEL_MAJOR" -lt 4 ] || ([ "$KERNEL_MAJOR" -eq 4 ] && [ "$KERNEL_MINOR" -lt 9 ]); then
  echo "❌ 内核版本 $(uname -r) 过低，BBR需要 4.9+"
  echo "   请先升级内核"
  exit 1
fi

echo "▶ 加载 BBR 模块..."
modprobe tcp_bbr 2>/dev/null || true

echo "▶ 写入 sysctl 配置..."
cat > /etc/sysctl.d/99-gj-sdwan-bbr.conf << 'EOF'
# GJ-SDWAN BBR 加速配置
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
# 增大 TCP 缓冲区，配合BBR效果更好
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.ipv4.tcp_rmem = 4096 87380 67108864
net.ipv4.tcp_wmem = 4096 65536 67108864
# 启用 TCP 快速打开
net.ipv4.tcp_fastopen = 3
# 增加最大连接数
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 8192
# 减小TIME_WAIT时间
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
EOF

sysctl -p /etc/sysctl.d/99-gj-sdwan-bbr.conf

echo ""
echo "✅ BBR 已启用，验证："
sysctl net.ipv4.tcp_congestion_control
sysctl net.core.default_qdisc
echo ""
lsmod | grep bbr && echo "✅ BBR 模块已加载" || echo "⚠️ BBR 模块未加载"
`;
}

/**
 * 生成 Hysteria2 服务端配置（香港POP侧）
 * 作为 WireGuard 的补充：高丢包跨境链路优先走 Hysteria2
 */
function generateHysteriaServerConfig(node, password, port = 36712) {
  return {
    path: '/etc/hysteria/config.yaml',
    content: `# Hysteria2 Server Config - GJ-SDWAN
# 部署位置: ${node.name} (${node.publicIP || node.ip})
# 生成时间: ${new Date().toISOString()}
listen: :${port}

tls:
  # 使用自签证书（生产建议用ACME或真实证书）
  cert: /etc/hysteria/cert.pem
  key: /etc/hysteria/key.pem

auth:
  type: password
  password: ${password}

# 带宽配置（按VPS实际带宽调整）
bandwidth:
  up: 500 mbps
  down: 500 mbps

# 伪装成Nginx，降低特征
masquerade:
  type: proxy
  proxy:
    url: https://www.bing.com
    rewriteHost: true

# 性能调优
ignoreClientBandwidth: false
disableUDP: false
quic:
  initStreamReceiveWindow: 8388608
  maxStreamReceiveWindow: 8388608
  initConnReceiveWindow: 20971520
  maxConnReceiveWindow: 20971520
`,
  };
}

/**
 * 生成 Hysteria2 客户端配置（国内HUB侧，作为WG的备用链路）
 */
function generateHysteriaClientConfig(serverNode, password, localSocksPort = 1080) {
  return {
    path: '/etc/hysteria/client.yaml',
    content: `# Hysteria2 Client Config - GJ-SDWAN
# 连接到: ${serverNode.name} (${serverNode.publicIP || serverNode.ip})
server: ${serverNode.publicIP || serverNode.ip}:36712

auth: ${password}

# 跳过证书验证（使用自签证书时）
tls:
  insecure: true

# 本地SOCKS5代理（可选，用于分流测试）
socks5:
  listen: 127.0.0.1:${localSocksPort}

# 传输层（TUN模式配合wg 路由）
transport:
  type: udp

# 带宽（客户端声明，服务端会限制）
bandwidth:
  up: 200 mbps
  down: 500 mbps
`,
  };
}

/**
 * 生成 Hysteria2 一键安装脚本
 */
function generateHysteriaInstallScript(role, config, password) {
  const isServer = role === 'server';
  return `#!/bin/bash
# GJ-SDWAN Hysteria2 ${isServer ? '服务端' : '客户端'} 一键安装
set -e
[ "$(id -u)" = "0" ] || { echo "❌ 需要root权限"; exit 1; }

echo "▶ [1/4] 安装 Hysteria2..."
bash <(curl -fsSL https://get.hy2.sh/) 2>/dev/null || {
  echo "官方源失败，使用GitHub直接下载..."
  ARCH=$(uname -m)
  case $ARCH in
    x86_64) ARCH=amd64;;
    aarch64) ARCH=arm64;;
    *) echo "不支持的架构: $ARCH"; exit 1;;
  esac
  curl -fsSL -o /usr/local/bin/hysteria "https://github.com/apernet/hysteria/releases/latest/download/hysteria-linux-$ARCH"
  chmod +x /usr/local/bin/hysteria
}

${isServer ? `echo "▶ [2/4] 生成自签证书..."
mkdir -p /etc/hysteria
if [ ! -f /etc/hysteria/cert.pem ]; then
  openssl req -x509 -nodes -newkey ec:<(openssl ecparam -name prime256v1) \\
    -keyout /etc/hysteria/key.pem -out /etc/hysteria/cert.pem \\
    -subj "/CN=bing.com" -days 36500 2>/dev/null
fi
chmod 600 /etc/hysteria/*.pem` : 'echo "▶ [2/4] 跳过证书（客户端模式）..."'}

echo "▶ [3/4] 写入配置文件..."
mkdir -p /etc/hysteria
cat > ${config.path} << 'HYSEOF'
${config.content}
HYSEOF
chmod 600 ${config.path}

echo "▶ [4/4] 创建 systemd 服务..."
cat > /etc/systemd/system/hysteria.service << 'SVCEOF'
[Unit]
Description=GJ-SDWAN Hysteria2 ${isServer ? 'Server' : 'Client'}
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hysteria ${isServer ? 'server' : 'client'} -c ${config.path}
Restart=always
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
SVCEOF

${isServer ? `iptables -I INPUT -p udp --dport 36712 -j ACCEPT 2>/dev/null || true
command -v ufw &>/dev/null && ufw allow 36712/udp 2>/dev/null || true` : ''}

systemctl daemon-reload
systemctl enable hysteria
systemctl restart hysteria
sleep 2
systemctl status hysteria --no-pager | head -10

echo ""
echo "╔════════════════════════════════════════╗"
echo "║  ✅ Hysteria2 ${isServer ? '服务端' : '客户端'} 已启动       ║"
echo "╚════════════════════════════════════════╝"
${isServer ? `echo "端口: UDP 36712"
echo "密码: ${password}"
echo ""
echo "★ 验证: ss -ulnp | grep 36712"` : `echo "连接: ${config.content.match(/server: (.+)/)?.[1] || '(见配置)'}"
echo "本地SOCKS5: 127.0.0.1:1080"
echo ""
echo "★ 验证: curl --socks5 127.0.0.1:1080 ip.sb"`}
`;
}

module.exports = {
  generateBBRScript,
  generateHysteriaServerConfig,
  generateHysteriaClientConfig,
  generateHysteriaInstallScript,
};
