/**
 * ha.js - HUB 双活高可用
 *
 * 原理：两台 HUB 节点都配 Keepalived，通过 VRRP 协议竞争一个 VIP（虚拟IP）
 * 客户端 WG 配置指向 VIP，主节点故障时备节点 3 秒内接管 VIP
 * 配合 WireGuard 的 Endpoint 保持连接不中断
 */

/**
 * 生成 Keepalived 主节点配置
 */
function generateKeepalivedMaster(hubGroup, masterNode, backupNode, vip, iface = 'eth0', password) {
  return {
    path: '/etc/keepalived/keepalived.conf',
    content: `# GJ-SDWAN HUB-HA Master Config
# 主节点: ${masterNode.name} (${masterNode.ip})
# 备节点: ${backupNode.name} (${backupNode.ip})
# VIP:    ${vip}
# Group:  ${hubGroup}

global_defs {
    router_id ${masterNode.name.replace(/[^a-zA-Z0-9]/g, '_')}_MASTER
    enable_script_security
    script_user root
}

# 健康检查：WG接口是否正常
vrrp_script check_wg {
    script "/etc/keepalived/check_wg.sh"
    interval 2      # 每2秒检查
    weight -30      # 失败则优先级降30
    fall 2          # 连续2次失败视为故障
    rise 2          # 连续2次成功恢复
}

vrrp_instance VI_${hubGroup} {
    state MASTER
    interface ${iface}
    virtual_router_id ${(hubGroup.charCodeAt(0) + hubGroup.charCodeAt(hubGroup.length-1)) % 200 + 50}
    priority 150    # 主节点优先级高
    advert_int 1    # 每秒通告一次
    nopreempt       # 主恢复后不抢占，避免切换震荡

    authentication {
        auth_type PASS
        auth_pass ${password.substring(0, 8)}
    }

    virtual_ipaddress {
        ${vip}/32 dev ${iface}
    }

    track_script {
        check_wg
    }

    # 状态变化通知
    notify_master "/etc/keepalived/notify.sh MASTER"
    notify_backup "/etc/keepalived/notify.sh BACKUP"
    notify_fault  "/etc/keepalived/notify.sh FAULT"
}
`,
  };
}

/**
 * 生成 Keepalived 备节点配置
 */
function generateKeepalivedBackup(hubGroup, masterNode, backupNode, vip, iface = 'eth0', password) {
  return {
    path: '/etc/keepalived/keepalived.conf',
    content: `# GJ-SDWAN HUB-HA Backup Config
# 主节点: ${masterNode.name} (${masterNode.ip})
# 备节点: ${backupNode.name} (${backupNode.ip})
# VIP:    ${vip}
# Group:  ${hubGroup}

global_defs {
    router_id ${backupNode.name.replace(/[^a-zA-Z0-9]/g, '_')}_BACKUP
    enable_script_security
    script_user root
}

vrrp_script check_wg {
    script "/etc/keepalived/check_wg.sh"
    interval 2
    weight -30
    fall 2
    rise 2
}

vrrp_instance VI_${hubGroup} {
    state BACKUP
    interface ${iface}
    virtual_router_id ${(hubGroup.charCodeAt(0) + hubGroup.charCodeAt(hubGroup.length-1)) % 200 + 50}
    priority 100    # 备节点优先级较低
    advert_int 1

    authentication {
        auth_type PASS
        auth_pass ${password.substring(0, 8)}
    }

    virtual_ipaddress {
        ${vip}/32 dev ${iface}
    }

    track_script {
        check_wg
    }

    notify_master "/etc/keepalived/notify.sh MASTER"
    notify_backup "/etc/keepalived/notify.sh BACKUP"
    notify_fault  "/etc/keepalived/notify.sh FAULT"
}
`,
  };
}

/**
 * WG 健康检查脚本
 */
function getCheckWgScript() {
  return `#!/bin/bash
# 检查 WireGuard 接口是否正常
# 返回 0 = 正常, 非0 = 故障

# 检查 wg0 接口是否 UP
if ! ip link show wg0 | grep -q "state UP"; then
  ip link show wg0 &>/dev/null && exit 1 || {
    # 接口不存在，尝试启动
    systemctl restart wg-quick@wg0 &>/dev/null
    sleep 2
    ip link show wg0 | grep -q "state UP" || exit 1
  }
fi

# 检查 wg show 是否有输出
wg show wg0 &>/dev/null || exit 1

# 检查是否有活跃 Peer（最近300秒内有握手）
NOW=$(date +%s)
LATEST=$(wg show wg0 latest-handshakes | awk '{print $2}' | sort -n | tail -1)
if [ -z "$LATEST" ] || [ "$LATEST" -eq 0 ]; then
  # 没有peer或未握手，视为未配置完成，不算故障
  exit 0
fi
DIFF=$((NOW - LATEST))
if [ $DIFF -gt 300 ]; then
  # 超过5分钟无握手
  exit 1
fi

exit 0
`;
}

/**
 * 状态变化通知脚本（可集成告警）
 */
function getNotifyScript(managerIP, managerPort, nodeToken) {
  return `#!/bin/bash
# VRRP 状态变化通知
# 参数1: MASTER | BACKUP | FAULT

STATE=$1
TIME=$(date "+%Y-%m-%d %H:%M:%S")
logger -t gj-sdwan-ha "HA状态变更: $STATE at $TIME"

# 上报给管理中心
curl -s -X POST "http://${managerIP}:${managerPort}/api/ha-notify" \\
  -H "Content-Type: application/json" \\
  -H "X-Node-Token: ${nodeToken}" \\
  -d "{\\"state\\":\\"$STATE\\",\\"time\\":\\"$TIME\\"}" &>/dev/null &

# 如果切换为 MASTER，主动重启 WG 确保 Endpoint 正常
if [ "$STATE" = "MASTER" ]; then
  sleep 1
  systemctl restart wg-quick@wg0 &
fi

exit 0
`;
}

/**
 * 生成一键安装脚本
 */
function generateHAInstallScript(role, keepalivedConf, managerIP, managerPort, nodeToken) {
  const isMaster = role === 'master';
  return `#!/bin/bash
# GJ-SDWAN HUB-HA ${isMaster ? '主节点' : '备节点'} 一键安装
set -e
[ "$(id -u)" = "0" ] || { echo "❌ 需要 root 权限"; exit 1; }

echo "▶ [1/5] 安装 Keepalived..."
if command -v apt-get &>/dev/null; then
  apt-get update -qq && apt-get install -y keepalived
elif command -v yum &>/dev/null; then
  yum install -y keepalived
fi

echo "▶ [2/5] 写入 Keepalived 配置..."
mkdir -p /etc/keepalived
cat > ${keepalivedConf.path} << 'KPEOF'
${keepalivedConf.content}
KPEOF
chmod 600 ${keepalivedConf.path}

echo "▶ [3/5] 写入健康检查脚本..."
cat > /etc/keepalived/check_wg.sh << 'CHKEOF'
${getCheckWgScript()}
CHKEOF
chmod +x /etc/keepalived/check_wg.sh

echo "▶ [4/5] 写入通知脚本..."
cat > /etc/keepalived/notify.sh << 'NOTIFYEOF'
${getNotifyScript(managerIP, managerPort, nodeToken)}
NOTIFYEOF
chmod +x /etc/keepalived/notify.sh

echo "▶ [5/5] 启动 Keepalived..."
# 允许 ip_nonlocal_bind，支持 VIP 漂移
echo "net.ipv4.ip_nonlocal_bind=1" >> /etc/sysctl.conf
sysctl -p -q

# 开放 VRRP 协议（协议号 112）
iptables -I INPUT -p vrrp -j ACCEPT 2>/dev/null || true
iptables -I INPUT -d 224.0.0.18 -j ACCEPT 2>/dev/null || true

systemctl daemon-reload
systemctl enable keepalived
systemctl restart keepalived

sleep 3
systemctl status keepalived --no-pager | head -15

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║  ✅ HUB-HA ${isMaster ? '主节点' : '备节点'} 已启动                 ║"
echo "╚═══════════════════════════════════════════════╝"
echo "★ 查看 VIP:  ip addr show | grep -A1 eth0"
echo "★ 查看日志:  journalctl -u keepalived -f"
echo "★ ${isMaster ? '主节点应持有VIP' : '备节点等待故障切换，VIP应在主节点'}"
`;
}

module.exports = {
  generateKeepalivedMaster,
  generateKeepalivedBackup,
  generateHAInstallScript,
};
