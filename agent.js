#!/usr/bin/env node
/**
 * WireGuard SD-WAN Node Agent v2
 * 安装在每个节点上，负责：
 * 1. 自动注册到管理控制台
 * 2. 接收配置下发，自动更新 WireGuard
 * 3. 自动与其他节点建立 Peer
 * 4. 心跳保活
 */

const http   = require('http');
const https  = require('https');
const { exec, execSync } = require('child_process');
const fs     = require('fs');
const crypto = require('crypto');

// ─── 配置（由安装脚本注入）────────────────────────────────────────────────────
const MANAGER_IP    = process.env.MANAGER_IP    || 'MANAGER_IP';
const MANAGER_PORT  = process.env.MANAGER_PORT  || '3000';
const NODE_ID       = process.env.NODE_ID       || '';
const NODE_TOKEN    = process.env.NODE_TOKEN    || '';
const AGENT_PORT    = parseInt(process.env.AGENT_PORT || '51821');
const WG_IFACE      = process.env.WG_IFACE      || 'wg0';
const WG_CONF       = `/etc/wireguard/${WG_IFACE}.conf`;

if (!NODE_TOKEN) { console.error('❌ 缺少 NODE_TOKEN'); process.exit(1); }

// ─── 工具函数 ─────────────────────────────────────────────────────────────────
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message);
      else resolve(stdout.trim());
    });
  });
}
function runSync(cmd) {
  try { return execSync(cmd, { timeout: 5000 }).toString().trim(); }
  catch { return ''; }
}

function managerReq(method, path, body) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: MANAGER_IP, port: MANAGER_PORT, path, method,
      headers: {
        'Content-Type': 'application/json',
        'X-Node-Token': NODE_TOKEN,
        ...(data && { 'Content-Length': Buffer.byteLength(data) }),
      },
      timeout: 8000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ ok: res.statusCode < 300, data: JSON.parse(d) }); } catch { resolve({ ok: false, data: {} }); } });
    });
    r.on('error', e => resolve({ ok: false, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function parseBody(req) {
  return new Promise(resolve => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
  });
}

// ─── WireGuard 操作 ───────────────────────────────────────────────────────────
function getPublicKey() {
  try {
    const privKey = runSync(`grep PrivateKey ${WG_CONF} | awk '{print $3}'`);
    if (!privKey) return '';
    return runSync(`echo "${privKey}" | wg pubkey`);
  } catch { return ''; }
}

async function addPeer(publicKey, allowedIPs, endpoint) {
  try {
    // ★ Bug#4修复：先确保Peer存在后再设置，避免"wg set peer xxx"失败
    //   同时加上路由表更新，保证内核路由指向wg0
    let cmd = `wg set ${WG_IFACE} peer "${publicKey}" allowed-ips ${allowedIPs} persistent-keepalive 25`;
    if (endpoint) cmd += ` endpoint ${endpoint}`;
    await run(cmd);
    // ★ 手动添加路由（wg set 不会自动加路由，wg-quick 才会）
    const ips = allowedIPs.split(',').map(s => s.trim()).filter(Boolean);
    for (const ip of ips) {
      // 清除可能的旧路由（避免冲突），再添加
      await run(`ip route replace ${ip} dev ${WG_IFACE}`).catch(e => {
        console.log(`⚠️  路由更新 ${ip}: ${e}`);
      });
    }
    await run(`wg-quick save ${WG_IFACE}`).catch(() => {});
    console.log(`✅ Peer 已添加: ${publicKey.substring(0,16)}... → ${allowedIPs}${endpoint?' via '+endpoint:''}`);
    return true;
  } catch (e) {
    console.error(`❌ 添加 Peer 失败: ${e}`);
    return false;
  }
}

async function removePeer(publicKey) {
  try {
    // 删除前先查出该peer的AllowedIPs，用于清理路由
    const dump = await run(`wg show ${WG_IFACE} dump`).catch(() => '');
    const peerLine = dump.split('\n').find(l => l.startsWith(publicKey));
    const allowedIPs = peerLine ? peerLine.split('\t')[3] : '';
    await run(`wg set ${WG_IFACE} peer "${publicKey}" remove`);
    // 清理路由
    if (allowedIPs) {
      for (const ip of allowedIPs.split(',').map(s => s.trim()).filter(Boolean)) {
        await run(`ip route del ${ip} dev ${WG_IFACE}`).catch(() => {});
      }
    }
    await run(`wg-quick save ${WG_IFACE}`).catch(() => {});
    console.log(`🗑️  Peer 已删除: ${publicKey.substring(0,16)}...`);
    return true;
  } catch { return false; }
}

async function getPeers() {
  try {
    const out = await run(`wg show ${WG_IFACE} dump`);
    return out.split('\n').slice(1).filter(Boolean).map(l => {
      const [pubkey, , endpoint, allowedIPs, lastHandshake, rxBytes, txBytes] = l.split('\t');
      return { pubkey, endpoint: endpoint === '(none)' ? null : endpoint, allowedIPs, lastHandshake: parseInt(lastHandshake) || 0, rxBytes: parseInt(rxBytes) || 0, txBytes: parseInt(txBytes) || 0 };
    });
  } catch { return []; }
}

async function syncAllPeers(nodes) {
  // 获取当前已有的 peers
  const currentPeers = await getPeers();
  const currentKeys = new Set(currentPeers.map(p => p.pubkey));

  for (const node of nodes) {
    if (!node.publicKey || !node.wgIP) continue;
    const allowedIPs = node.wgIP.includes('/') ? node.wgIP.split('/')[0] + '/32' : node.wgIP + '/32';
    const endpoint = node.ip ? `${node.ip}:${node.wgPort || 51820}` : null;

    if (!currentKeys.has(node.publicKey)) {
      await addPeer(node.publicKey, allowedIPs, endpoint);
    }
  }

  // 清理不再存在的 peers（排除管理员手动添加的）
  const nodeKeys = new Set(nodes.map(n => n.publicKey).filter(Boolean));
  for (const peer of currentPeers) {
    if (!nodeKeys.has(peer.pubkey)) {
      console.log(`⚠️  未知 Peer ${peer.pubkey.substring(0,16)}... 保留（可能是客户端）`);
    }
  }
}

// ─── 注册并同步 ───────────────────────────────────────────────────────────────
async function register() {
  const publicKey = getPublicKey();
  if (!publicKey) { console.log('⚠️  无法获取公钥，跳过注册'); return; }

  console.log(`📡 向管理中心注册... (${MANAGER_IP}:${MANAGER_PORT})`);
  const r = await managerReq('POST', '/api/node-register', {
    nodeId: NODE_ID,
    publicKey,
    agentPort: AGENT_PORT,
  });

  if (r.ok) {
    console.log('✅ 注册成功');
    // 获取所有节点并同步 Peers
    await syncFromManager();
  } else {
    console.error('❌ 注册失败:', r.error || JSON.stringify(r.data));
  }
}

async function syncFromManager() {
  const r = await managerReq('GET', '/api/nodes/all');
  if (!r.ok || !r.data.nodes) return;
  const otherNodes = r.data.nodes.filter(n => n.id !== NODE_ID && n.publicKey && n.wgIP);
  console.log(`🔄 同步 ${otherNodes.length} 个节点的 Peer 配置...`);
  await syncAllPeers(otherNodes);
  console.log('✅ Peer 同步完成');
}

// ─── Agent HTTP 服务 ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // 验证来自管理中心的请求
  const token = req.headers['x-agent-token'] || '';
  if (token !== NODE_TOKEN) return send(res, 403, { error: 'Unauthorized' });

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/status') {
    const peers = await getPeers();
    const pubKey = getPublicKey();
    return send(res, 200, { ok: true, nodeId: NODE_ID, publicKey: pubKey, peers, iface: WG_IFACE });
  }

  if (req.method === 'POST' && url.pathname === '/peer/add') {
    const { publicKey, allowedIPs, endpoint } = await parseBody(req);
    if (!publicKey || !allowedIPs) return send(res, 400, { error: '缺少参数' });
    const ok = await addPeer(publicKey, allowedIPs, endpoint);
    return send(res, ok ? 200 : 500, { ok });
  }

  if (req.method === 'POST' && url.pathname === '/peer/remove') {
    const { publicKey } = await parseBody(req);
    if (!publicKey) return send(res, 400, { error: '缺少 publicKey' });
    const ok = await removePeer(publicKey);
    return send(res, ok ? 200 : 500, { ok });
  }

  if (req.method === 'POST' && url.pathname === '/sync') {
    await syncFromManager();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/peers') {
    const peers = await getPeers();
    return send(res, 200, { ok: true, peers });
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(AGENT_PORT, () => {
  console.log(`\n🤖 WireGuard SD-WAN Agent v2.2`);
  console.log(`   节点 ID:   ${NODE_ID}`);
  console.log(`   Agent 端口: ${AGENT_PORT}`);
  console.log(`   管理中心:  ${MANAGER_IP}:${MANAGER_PORT}`);
  console.log(`   WG 接口:   ${WG_IFACE}\n`);
});

// 启动后注册（等WG起来）
setTimeout(register, 3000);

// ★ 心跳缩短到60s，故障时更快检测
// ★ 每次心跳都重新同步Peer，防止因Mesh推送失败导致配置漂移
setInterval(async () => {
  const pk = getPublicKey();
  await managerReq('POST', '/api/node-heartbeat', { nodeId: NODE_ID, publicKey: pk });
  await syncFromManager();
}, 60 * 1000);
