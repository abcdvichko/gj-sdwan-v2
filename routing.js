/**
 * routing.js - 智能选路引擎
 * 功能：
 *  1. 多维度线路质量探测（延迟/丢包/抖动）
 *  2. 综合评分算法
 *  3. 自动故障切换（防抖保护）
 *  4. 分流规则引擎（域名/CIDR匹配）
 *  5. 生成 OpenWRT 侧脚本（dnsmasq + iptables + ipset）
 */

const { exec } = require('child_process');
const https    = require('https');

// ─── 探测工具 ─────────────────────────────────────────────────────────────────

/**
 * 增强版 ping：发4包，返回 avg延迟、最大延迟、丢包率、抖动(jitter)
 */
function probePing(host, count = 4, timeout = 3) {
  return new Promise(resolve => {
    const fallback = { online: false, latency: null, maxLatency: null, loss: 100, jitter: null };
    if (!host || host === '0.0.0.0') return resolve(fallback);

    const cmd = process.platform === 'win32'
      ? `ping -n ${count} -w ${timeout * 1000} ${host}`
      : `ping -c ${count} -W ${timeout} ${host}`;

    exec(cmd, { timeout: (count * timeout + 3) * 1000 }, (err, stdout) => {
      if (err) return resolve(fallback);

      // 解析 avg 延迟
      let latency = null, maxLatency = null, jitter = null;
      const mRtt = stdout.match(/min\/avg\/max(?:\/mdev)?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))?/i);
      if (mRtt) {
        latency    = Math.round(parseFloat(mRtt[2]));
        maxLatency = Math.round(parseFloat(mRtt[3]));
        jitter     = mRtt[4] ? Math.round(parseFloat(mRtt[4])) : null;
      } else {
        const mTime = stdout.match(/time[=<]([\d.]+)\s*ms/i);
        if (mTime) latency = Math.round(parseFloat(mTime[1]));
      }

      // 解析丢包率
      let loss = 0;
      const mLoss = stdout.match(/([\d.]+)%\s+packet loss/i) || stdout.match(/([\d.]+)%\s+丢失/i);
      if (mLoss) loss = parseFloat(mLoss[1]);

      resolve({ online: true, latency, maxLatency, loss, jitter });
    });
  });
}

// ─── 评分算法 ─────────────────────────────────────────────────────────────────

/**
 * 综合评分 0-100
 * 权重可在设置里调整
 */
function calcScore(probe, settings = {}) {
  if (!probe || !probe.online || probe.latency === null) return 0;

  const latencyW  = (settings.latencyWeight   ?? 50) / 100;
  const lossW     = (settings.lossWeight      ?? 30) / 100;
  const jitterW   = (settings.bandwidthWeight ?? 20) / 100;

  // 延迟评分：100ms=100分，500ms=0分（线性）
  const latencyScore = Math.max(0, Math.min(100, (500 - probe.latency) / 4));

  // 丢包评分：0%=100分，10%+=0分
  const lossScore = Math.max(0, 100 - (probe.loss || 0) * 10);

  // 抖动评分：0ms=100分，100ms+=0分
  const jitter       = probe.jitter || 0;
  const jitterScore  = Math.max(0, 100 - jitter);

  return Math.round(latencyScore * latencyW + lossScore * lossW + jitterScore * jitterW);
}

/**
 * 质量等级
 */
function qualityLevel(score) {
  if (score >= 80) return { level: 'excellent', label: '优秀', color: '#10b981' };
  if (score >= 60) return { level: 'good',      label: '良好', color: '#3b82f6' };
  if (score >= 40) return { level: 'fair',      label: '一般', color: '#f59e0b' };
  if (score > 0)   return { level: 'poor',      label: '较差', color: '#ef4444' };
  return                  { level: 'offline',   label: '离线', color: '#6b7280' };
}

// ─── 智能选路引擎 ─────────────────────────────────────────────────────────────

const _lastSwitch   = {};   // routeId -> timestamp（防抖）
const _switchHistory = [];  // 切换历史记录（最近50条）

/**
 * 检查是否需要切换，返回建议切换目标
 */
function shouldSwitch(route, exitQuality, allNodeQualities, settings = {}) {
  if (!exitQuality) return null;

  const thresholdLatency = settings.switchThresholdLatency ?? 200;
  const thresholdLoss    = settings.switchThresholdLoss    ?? 5;
  const debounceMs       = (settings.switchDebounce        ?? 60) * 1000;

  const offline    = !exitQuality.online;
  const latencyBad = exitQuality.latency !== null && exitQuality.latency > thresholdLatency;
  const lossBad    = (exitQuality.loss || 0) > thresholdLoss;

  if (!offline && !latencyBad && !lossBad) return null;

  // 防抖
  if (_lastSwitch[route.id] && Date.now() - _lastSwitch[route.id] < debounceMs) return null;

  // 找出比当前节点评分高的候选
  const currentScore = exitQuality.score || 0;
  const candidates = allNodeQualities
    .filter(q => q.nodeId !== route.exitNodeId && q.online && q.score > currentScore + 10)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return null;

  const reason = offline    ? '节点离线'
               : latencyBad ? `延迟过高(${exitQuality.latency}ms > ${thresholdLatency}ms)`
               :               `丢包过高(${exitQuality.loss}% > ${thresholdLoss}%)`;

  return { target: candidates[0], reason };
}

function recordSwitch(routeName, fromNodeName, toNodeName, reason) {
  _lastSwitch[routeName] = Date.now();
  _switchHistory.unshift({
    time:     new Date().toISOString(),
    route:    routeName,
    from:     fromNodeName,
    to:       toNodeName,
    reason,
  });
  if (_switchHistory.length > 50) _switchHistory.pop();
}

function getSwitchHistory() {
  return _switchHistory;
}

// ─── 分流规则引擎 ─────────────────────────────────────────────────────────────

/**
 * 匹配分流规则
 * @param {string} domain  目标域名（如 www.google.com）
 * @param {string} ip      目标 IP
 * @param {Array}  rules   规则列表（已按 priority 排序）
 */
function matchSplitRule(domain, ip, rules) {
  for (const rule of rules) {
    if (!rule.enabled) continue;

    if (rule.type === 'default') return rule;

    if (rule.type === 'domain' && domain) {
      if (matchDomain(domain, rule.match)) return rule;
    }

    if (rule.type === 'cidr' && ip) {
      if (matchCIDR(ip, rule.match)) return rule;
    }
  }
  return null;
}

function matchDomain(domain, pattern) {
  // 支持通配符 *.google.com
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return domain === suffix || domain.endsWith('.' + suffix);
  }
  return domain === pattern;
}

function matchCIDR(ip, cidr) {
  try {
    const [network, prefixLen] = cidr.split('/');
    const prefix = parseInt(prefixLen);
    const ipNum  = ip2num(ip);
    const netNum = ip2num(network);
    const mask   = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipNum & mask) === (netNum & mask);
  } catch { return false; }
}

function ip2num(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
}

// ─── OpenWRT 侧脚本生成 ───────────────────────────────────────────────────────

/**
 * 生成完整的 OpenWRT 智能分流配置包
 * 包含：
 *  1. ipset 列表创建脚本
 *  2. dnsmasq 域名分流配置
 *  3. iptables/nftables 策略路由规则
 *  4. 一键安装脚本
 */
function generateOpenWRTConfig(nodes, routes, splitRules, quality) {
  const vpsCandidates = nodes
    .filter(n => n.type === 'vps')
    .map(n => ({ ...n, score: quality[n.id]?.score || 0 }))
    .sort((a, b) => b.score - a.score);

  const bestVPS = vpsCandidates[0];
  const defaultRoute = routes[0];

  // === 1. 主安装脚本 ===
  const installScript = `#!/bin/sh
# ═══════════════════════════════════════════════════════════════
# GJ-SDWAN OpenWRT 智能分流一键配置脚本
# 生成时间: ${new Date().toISOString()}
# 最优出口: ${bestVPS ? bestVPS.name + ' (' + bestVPS.ip + ')' : '未配置'}
# ═══════════════════════════════════════════════════════════════
set -e

echo "► 检查 OpenWRT 环境..."
[ -f /etc/openwrt_release ] || { echo "❌ 此脚本仅适用于 OpenWRT"; exit 1; }

echo "► [1/5] 安装依赖..."
opkg update 2>/dev/null
opkg install ipset kmod-ipt-ipset iptables-mod-conntrack-extra dnsmasq-full 2>/dev/null || true
# 停止原 dnsmasq，用 dnsmasq-full 替代（支持 ipset）
/etc/init.d/dnsmasq stop 2>/dev/null; /etc/init.d/dnsmasq start

echo "► [2/5] 创建路由表..."
grep -q "100 sdwan" /etc/iproute2/rt_tables || echo "100 sdwan" >> /etc/iproute2/rt_tables
grep -q "200 sdwan_direct" /etc/iproute2/rt_tables || echo "200 sdwan_direct" >> /etc/iproute2/rt_tables

echo "► [3/5] 配置 ipset..."
sh /etc/sdwan/ipset_setup.sh

echo "► [4/5] 配置 dnsmasq 分流..."
cp /etc/sdwan/dnsmasq_sdwan.conf /etc/dnsmasq.d/
/etc/init.d/dnsmasq restart

echo "► [5/5] 配置 iptables 策略路由..."
sh /etc/sdwan/iptables_setup.sh

echo ""
echo "✅ OpenWRT 智能分流配置完成！"
echo "   WireGuard 接口: wg0"
echo "   默认出口: ${bestVPS ? bestVPS.ip : 'N/A'}"
echo "   分流规则: ${splitRules.filter(r => r.enabled).length} 条"
echo ""
echo "验证分流是否生效："
echo "  curl --interface wg0 ip.sb   # 应显示 VPS IP"
echo "  curl ip.sb                   # 应显示本机 IP（直连规则）"
`;

  // === 2. ipset 创建脚本 ===
  const cidrRules = splitRules.filter(r => r.enabled && r.type === 'cidr');
  const ipsetScript = `#!/bin/sh
# ipset 配置脚本 - 自动生成，请勿手动修改

# 删除旧的 ipset
ipset destroy sdwan_bypass 2>/dev/null || true
ipset destroy sdwan_direct 2>/dev/null || true
ipset destroy sdwan_block  2>/dev/null || true

# 创建新的 ipset（hash:net 支持 CIDR）
ipset create sdwan_bypass hash:net comment
ipset create sdwan_direct hash:net comment
ipset create sdwan_block  hash:net comment

# 中国大陆 IP 段（走直连，避免绕路）
# 可从 https://github.com/17mon/china_ip_list 获取完整列表
ipset add sdwan_direct 10.0.0.0/8    comment "私有网络"
ipset add sdwan_direct 172.16.0.0/12 comment "私有网络"
ipset add sdwan_direct 192.168.0.0/16 comment "私有网络"
ipset add sdwan_direct 127.0.0.0/8   comment "本地回环"

${cidrRules.map(r => {
  const setName = r.action === 'direct' ? 'sdwan_direct'
                : r.action === 'block'  ? 'sdwan_block'
                :                         'sdwan_bypass';
  return `ipset add ${setName} ${r.match} comment "${r.name.replace(/"/g, '')}"`;
}).join('\n')}

echo "✅ ipset 配置完成"
ipset list | grep "Name:"
`;

  // === 3. dnsmasq 域名分流配置 ===
  const domainRules = splitRules.filter(r => r.enabled && r.type === 'domain');
  const dnsmasqConf = `# dnsmasq 智能分流配置 - 自动生成
# 生成时间: ${new Date().toISOString()}

# 启用 ipset 功能
# 匹配的域名 IP 自动加入对应 ipset

${domainRules.map(r => {
  const setName = r.action === 'direct' ? 'sdwan_direct'
                : r.action === 'block'  ? 'sdwan_block'
                :                         'sdwan_bypass';
  const domain  = r.match.replace(/^\*\./, '');
  return `# 规则: ${r.name}\nipset=/${domain}/${setName}`;
}).join('\n\n')}

# Google 常用域名（走 sdwan_bypass）
ipset=/google.com/sdwan_bypass
ipset=/googleapis.com/sdwan_bypass
ipset=/youtube.com/sdwan_bypass
ipset=/gmail.com/sdwan_bypass
ipset=/googleusercontent.com/sdwan_bypass

# GitHub
ipset=/github.com/sdwan_bypass
ipset=/githubusercontent.com/sdwan_bypass

# Twitter/X
ipset=/twitter.com/sdwan_bypass
ipset=/x.com/sdwan_bypass
ipset=/twimg.com/sdwan_bypass

# 使用上游 DNS（避免污染）
server=8.8.8.8
server=1.1.1.1
`;

  // === 4. iptables 策略路由 ===
  const wgIP = bestVPS ? bestVPS.wgIP || '10.0.0.1' : '10.0.0.1';
  const iptablesScript = `#!/bin/sh
# iptables + 策略路由脚本 - 自动生成

WG_IFACE="wg0"
LAN_IFACE="br-lan"
MARK_SDWAN=0x01
MARK_DIRECT=0x02
MARK_BLOCK=0x03

# ── 清除旧规则 ──
iptables -t mangle -F SDWAN_PREROUTING 2>/dev/null || true
iptables -t mangle -X SDWAN_PREROUTING 2>/dev/null || true
ip rule del fwmark $MARK_SDWAN table sdwan    2>/dev/null || true
ip rule del fwmark $MARK_DIRECT table main    2>/dev/null || true

# ── 策略路由表 ──
ip route flush table sdwan 2>/dev/null || true
ip route add default dev $WG_IFACE table sdwan

ip rule add fwmark $MARK_SDWAN lookup sdwan    priority 100
ip rule add fwmark $MARK_DIRECT lookup main    priority 101

# ── iptables mangle 链 ──
iptables -t mangle -N SDWAN_PREROUTING
iptables -t mangle -A PREROUTING -i $LAN_IFACE -j SDWAN_PREROUTING

# sdwan_bypass（走 WireGuard）
iptables -t mangle -A SDWAN_PREROUTING -m set --match-set sdwan_bypass dst -j MARK --set-mark $MARK_SDWAN

# sdwan_direct（直连，不走 VPN）
iptables -t mangle -A SDWAN_PREROUTING -m set --match-set sdwan_direct dst -j MARK --set-mark $MARK_DIRECT

# sdwan_block（拦截）
iptables -t mangle -A SDWAN_PREROUTING -m set --match-set sdwan_block  dst -j DROP

# 默认流量走 WireGuard
iptables -t mangle -A SDWAN_PREROUTING -j MARK --set-mark $MARK_SDWAN

# NAT（WireGuard 出口）
iptables -t nat -A POSTROUTING -o $WG_IFACE -j MASQUERADE

echo "✅ iptables 策略路由配置完成"
iptables -t mangle -L SDWAN_PREROUTING -n --line-numbers
`;

  // === 5. nftables 版本（现代 OpenWRT 21.02+）===
  const nftablesScript = `#!/usr/sbin/nft -f
# nftables 智能分流配置（适用于 OpenWRT 21.02+）
# 自动生成 - ${new Date().toISOString()}

flush ruleset

table inet sdwan_fw {
  # ipset 对应 nftables 的 named set
  set bypass_nets {
    type ipv4_addr
    flags interval
    elements = {
      8.8.8.0/24,      # Google DNS
      1.1.1.0/24,      # Cloudflare DNS
${cidrRules.filter(r => r.action === 'route').map(r => `      ${r.match},      # ${r.name}`).join('\n')}
    }
  }

  set direct_nets {
    type ipv4_addr
    flags interval
    elements = {
      10.0.0.0/8,
      172.16.0.0/12,
      192.168.0.0/16,
${cidrRules.filter(r => r.action === 'direct').map(r => `      ${r.match},      # ${r.name}`).join('\n')}
    }
  }

  chain prerouting {
    type filter hook prerouting priority mangle; policy accept;
    ip daddr @direct_nets accept
    ip daddr @bypass_nets meta mark set 0x01
  }
}
`;

  // === 6. 开机自启脚本 ===
  const rcScript = `#!/bin/sh /etc/rc.common
# OpenWRT 开机自启脚本
START=99

start() {
  sleep 5  # 等待网络就绪
  sh /etc/sdwan/ipset_setup.sh
  sh /etc/sdwan/iptables_setup.sh
  logger -t sdwan "智能分流规则已加载"
}

stop() {
  ipset destroy sdwan_bypass 2>/dev/null || true
  ipset destroy sdwan_direct 2>/dev/null || true
  ipset destroy sdwan_block  2>/dev/null || true
  iptables -t mangle -F SDWAN_PREROUTING 2>/dev/null || true
  logger -t sdwan "智能分流规则已清除"
}
`;

  return {
    installScript,
    ipsetScript,
    dnsmasqConf,
    iptablesScript,
    nftablesScript,
    rcScript,
  };
}

/**
 * 生成完整 tarball 内容说明（用于前端展示下载列表）
 */
function getOpenWRTFileList() {
  return [
    { path: '/etc/sdwan/install.sh',         desc: '一键安装入口' },
    { path: '/etc/sdwan/ipset_setup.sh',     desc: 'ipset IP段规则' },
    { path: '/etc/dnsmasq.d/sdwan.conf',     desc: 'dnsmasq 域名分流' },
    { path: '/etc/sdwan/iptables_setup.sh',  desc: 'iptables 策略路由' },
    { path: '/etc/sdwan/nftables.conf',      desc: 'nftables 版配置' },
    { path: '/etc/init.d/sdwan',             desc: '开机自启服务' },
  ];
}

module.exports = {
  probePing,
  calcScore,
  qualityLevel,
  shouldSwitch,
  recordSwitch,
  getSwitchHistory,
  matchSplitRule,
  matchDomain,
  matchCIDR,
  generateOpenWRTConfig,
  getOpenWRTFileList,
};
