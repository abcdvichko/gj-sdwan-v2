#!/bin/bash
# ╔══════════════════════════════════════════════════════════════╗
# ║              GJ-SDWAN 一键安装脚本 v2.2                     ║
# ║         本地部署 · 智能选路 · HA · 多路径                   ║
# ╚══════════════════════════════════════════════════════════════╝
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[→]${NC} $1"; }
step() { echo -e "\n${BOLD}${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${BOLD}${BLUE}  $1${NC}"; echo -e "${BOLD}${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

INSTALL_DIR="${INSTALL_DIR:-/opt/gj-sdwan}"
PORT="${PORT:-3000}"
SERVICE_NAME="gj-sdwan"
NODE_MIN_VER=16

# ★ 关键：获取脚本所在目录，用于本地复制
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

clear
echo -e "${BOLD}${CYAN}"
cat << 'LOGO'
  ╔══════════════════════════════════════╗
  ║         GJ-SDWAN  v2.2              ║
  ║  智能选路·HA·多路径·IEPL·加速       ║
  ╚══════════════════════════════════════╝
LOGO
echo -e "${NC}"
echo -e "  ${BOLD}WireGuard SD-WAN 管理控制台 — 一键安装${NC}"
echo -e "  安装目录: ${CYAN}${INSTALL_DIR}${NC}   端口: ${CYAN}${PORT}${NC}"
echo -e "  源码目录: ${CYAN}${SCRIPT_DIR}${NC}"
echo ""

[ "$(id -u)" = "0" ] || err "请使用 root 权限: sudo bash install.sh"

# ══ Step 0: 源码完整性检查 ═══════════════════════════════════
step "Step 0/7  检查源码完整性"

REQUIRED=("server.js" "agent.js" "db.js" "scheduler.js" "realtime.js" "routing.js" "public/index.html")
MISSING=""
for f in "${REQUIRED[@]}"; do
    [ -f "${SCRIPT_DIR}/${f}" ] || MISSING="${MISSING} ${f}"
done

if [ -n "$MISSING" ]; then
    err "在 ${SCRIPT_DIR} 找不到必需文件:${MISSING}

正确的使用方法：
  1. 下载: 把 gj-sdwan-v2.2.tar 上传到服务器
  2. 解压: tar -xf gj-sdwan-v2.2.tar
  3. 进入: cd gj-sdwan-v2
  4. 安装: sudo bash install.sh

如果你在其他目录执行，脚本找不到源码文件。"
fi
log "源码完整性验证通过"

# ══ Step 1: 系统检测 ═════════════════════════════════════════
step "Step 1/7  检测系统环境"
if   [ -f /etc/debian_version ];  then OS="debian"; log "Debian/Ubuntu"
elif [ -f /etc/redhat-release ];  then OS="redhat"; log "CentOS/RHEL"
elif [ -f /etc/arch-release ];    then OS="arch";   log "Arch Linux"
else OS="other"; warn "未知发行版"; fi

ARCH=$(uname -m)
case "$ARCH" in
    x86_64|amd64)   ARCH_NAME="x64" ;;
    aarch64|arm64)  ARCH_NAME="arm64" ;;
    *) ARCH_NAME="x64"; warn "未知架构 $ARCH" ;;
esac
log "架构: $ARCH"

# ══ Step 2: 依赖 ═════════════════════════════════════════════
step "Step 2/7  安装系统依赖"
if [ "$OS" = "debian" ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq 2>/dev/null || true
    apt-get install -y -qq curl wget iptables lsof ca-certificates procps 2>/dev/null || true
elif [ "$OS" = "redhat" ]; then
    yum install -y curl wget iptables lsof procps 2>/dev/null || true
elif [ "$OS" = "arch" ]; then
    pacman -Sy --noconfirm curl wget iptables 2>/dev/null || true
fi
log "依赖安装完成"

# ══ Step 3: Node.js ══════════════════════════════════════════
step "Step 3/7  Node.js"

install_node() {
    info "安装 Node.js 18..."
    if [ "$OS" = "debian" ]; then
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash - 2>/dev/null
        apt-get install -y nodejs 2>/dev/null
    elif [ "$OS" = "redhat" ]; then
        curl -fsSL https://rpm.nodesource.com/setup_18.x | bash - 2>/dev/null
        yum install -y nodejs 2>/dev/null
    else
        NODE_PKG="node-v18.20.4-linux-${ARCH_NAME}.tar.xz"
        wget -q "https://nodejs.org/dist/v18.20.4/${NODE_PKG}" -O /tmp/${NODE_PKG} \
            || err "Node.js 下载失败"
        tar -xJf /tmp/${NODE_PKG} -C /usr/local --strip-components=1
        rm -f /tmp/${NODE_PKG}
    fi
}

if command -v node &>/dev/null; then
    NVER=$(node -e "console.log(parseInt(process.version.slice(1)))" 2>/dev/null || echo "0")
    if [ "$NVER" -ge "$NODE_MIN_VER" ]; then
        log "Node.js $(node --version) OK"
    else
        warn "升级 Node.js..."
        install_node
    fi
else
    install_node
fi
command -v node &>/dev/null || err "Node.js 安装失败"
log "Node.js $(node --version) ✅"

# ══ Step 4: PM2 ══════════════════════════════════════════════
step "Step 4/7  PM2"
if command -v pm2 &>/dev/null; then
    log "PM2 $(pm2 --version) OK"
else
    npm install -g pm2 --silent 2>/dev/null || err "PM2 安装失败"
    log "PM2 安装成功"
fi

# ══ Step 5: 部署代码（核心修复） ═════════════════════════════
step "Step 5/7  部署代码"

# 备份旧数据
DATA_BAK=""
if [ -d "${INSTALL_DIR}/data" ] && [ "$(ls -A ${INSTALL_DIR}/data 2>/dev/null)" ]; then
    DATA_BAK="/tmp/gj-sdwan-data-$(date +%s)"
    info "备份旧数据到 ${DATA_BAK}"
    cp -r "${INSTALL_DIR}/data" "${DATA_BAK}"
fi

# 停旧服务
pm2 delete ${SERVICE_NAME} 2>/dev/null || true

# 清理旧目录（保留 data）
if [ -d "${INSTALL_DIR}" ]; then
    find "${INSTALL_DIR}" -maxdepth 1 -mindepth 1 ! -name 'data' -exec rm -rf {} + 2>/dev/null || true
fi
mkdir -p "${INSTALL_DIR}"

# ★ 直接从脚本所在目录复制全部文件
info "从 ${SCRIPT_DIR} 复制所有源码..."
cp "${SCRIPT_DIR}"/server.js      "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}"/agent.js       "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}"/db.js          "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}"/scheduler.js   "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}"/realtime.js    "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}"/routing.js     "${INSTALL_DIR}/"
[ -f "${SCRIPT_DIR}/acceleration.js" ] && cp "${SCRIPT_DIR}/acceleration.js" "${INSTALL_DIR}/"
[ -f "${SCRIPT_DIR}/ha.js" ]           && cp "${SCRIPT_DIR}/ha.js"           "${INSTALL_DIR}/"
[ -f "${SCRIPT_DIR}/mptcp.js" ]        && cp "${SCRIPT_DIR}/mptcp.js"        "${INSTALL_DIR}/"
[ -f "${SCRIPT_DIR}/package.json" ]    && cp "${SCRIPT_DIR}/package.json"    "${INSTALL_DIR}/"
[ -f "${SCRIPT_DIR}/CHANGELOG.md" ]    && cp "${SCRIPT_DIR}/CHANGELOG.md"    "${INSTALL_DIR}/"

# ★ public 目录必须完整复制（404 问题的关键修复）
mkdir -p "${INSTALL_DIR}/public"
cp -r "${SCRIPT_DIR}/public/"* "${INSTALL_DIR}/public/"

# ★ 立即验证文件到位
[ -f "${INSTALL_DIR}/server.js" ] || err "server.js 未到位"
[ -f "${INSTALL_DIR}/public/index.html" ] || err "public/index.html 未到位"

# ★ 验证文件大小（防止空文件）
SSIZE=$(wc -c < "${INSTALL_DIR}/server.js")
HSIZE=$(wc -c < "${INSTALL_DIR}/public/index.html")
if [ "$SSIZE" -lt 10000 ]; then
    err "server.js 文件异常（${SSIZE}B），请重新解压 tar 包"
fi
if [ "$HSIZE" -lt 50000 ]; then
    err "index.html 文件异常（${HSIZE}B），请重新解压 tar 包"
fi
log "代码部署完成（server.js: $((SSIZE/1024))KB, index.html: $((HSIZE/1024))KB）✅"

# 恢复旧数据
mkdir -p "${INSTALL_DIR}/data"
if [ -n "$DATA_BAK" ] && [ -d "$DATA_BAK" ]; then
    cp -r "${DATA_BAK}"/. "${INSTALL_DIR}/data/"
    rm -rf "${DATA_BAK}"
    log "历史数据已恢复 ✅"
fi

# ══ Step 6: 服务配置 ═════════════════════════════════════════
step "Step 6/7  配置服务"

cat > "${INSTALL_DIR}/ecosystem.config.js" << ECOEOF
module.exports = {
  apps: [{
    name: '${SERVICE_NAME}',
    script: 'server.js',
    cwd: '${INSTALL_DIR}',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      PORT: ${PORT},
    },
    error_file: '/var/log/gj-sdwan-error.log',
    out_file:   '/var/log/gj-sdwan-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
ECOEOF

# 开防火墙
info "配置防火墙..."
iptables -I INPUT -p tcp --dport ${PORT} -j ACCEPT 2>/dev/null || true
if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "active"; then
    ufw allow ${PORT}/tcp >/dev/null 2>&1 && log "UFW: ${PORT}/tcp"
fi
if command -v firewall-cmd &>/dev/null && firewall-cmd --state 2>/dev/null | grep -q running; then
    firewall-cmd --permanent --add-port=${PORT}/tcp >/dev/null 2>&1
    firewall-cmd --reload >/dev/null 2>&1
    log "Firewalld: ${PORT}/tcp"
fi

# 启动
cd "${INSTALL_DIR}"
PORT=${PORT} pm2 start ecosystem.config.js
pm2 save 2>/dev/null || true

PM2_STARTUP=$(pm2 startup 2>/dev/null | grep "sudo" | tail -1)
[ -n "$PM2_STARTUP" ] && eval "$PM2_STARTUP" 2>/dev/null || true
log "服务已启动并设为开机自启 ✅"

# ══ Step 7: 验证 ═════════════════════════════════════════════
step "Step 7/7  验证安装"
sleep 5

HTTP_CODE="0"
for i in 1 2 3; do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/" 2>/dev/null || echo "0")
    if [ "$HTTP_CODE" = "200" ]; then break; fi
    [ $i -lt 3 ] && sleep 3
done

if [ "$HTTP_CODE" = "200" ]; then
    log "HTTP 服务响应正常 (200) ✅"
else
    warn "HTTP 响应码: ${HTTP_CODE}"
    warn "查看日志: pm2 logs ${SERVICE_NAME} --lines 30"
fi

PUBLIC_IP=$(curl -s --max-time 5 https://ipinfo.io/ip 2>/dev/null \
          || curl -s --max-time 5 http://ip.sb 2>/dev/null \
          || hostname -I 2>/dev/null | awk '{print $1}' \
          || echo "YOUR_SERVER_IP")

echo ""
echo -e "${BOLD}${GREEN}"
echo "  ╔════════════════════════════════════════════════════╗"
echo "  ║         🎉  GJ-SDWAN v2.2 安装成功！              ║"
echo "  ╠════════════════════════════════════════════════════╣"
echo -e "  ║   访问:    ${CYAN}http://${PUBLIC_IP}:${PORT}${GREEN}"
echo "  ║   账号:    admin / admin123 (请立即修改)"
echo "  ║   目录:    ${INSTALL_DIR}"
echo "  ║   日志:    pm2 logs ${SERVICE_NAME}"
echo "  ║   重启:    pm2 restart ${SERVICE_NAME}"
echo "  ╚════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo -e "${BOLD}${YELLOW}★ v2.2 新功能（侧边栏「高级功能」）：${NC}"
echo "   🚀 QUIC/BBR 加速"
echo "   💎 HUB 双活 HA"
echo "   🔱 多路径冗余"
echo "   🔍 组网诊断 + 一键修复"
echo ""
