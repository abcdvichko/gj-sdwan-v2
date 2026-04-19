#!/usr/bin/env node
/**
 * GJ-SDWAN Server v2.2 - 智能选路+HA+多路径+加速
 * 集成模块：
 *  ★ db.js       - 高性能内嵌存储（替代 better-sqlite3）
 *  ★ scheduler.js - 精准定时调度（替代 node-cron）
 *  ★ realtime.js  - SSE 实时推送（替代 socket.io）
 *  ★ routing.js   - 完整智能选路引擎
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { exec, execSync } = require('child_process');

const DB        = require('./db');
const Scheduler = require('./scheduler');
const SSEServer = require('./realtime');
const Routing   = require('./routing');
const Acceleration = require('./acceleration');
const HA           = require('./ha');
const MultiPath    = require('./mptcp');

// ─── 初始化各模块 ─────────────────────────────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

const db  = new DB(DATA_DIR);
const sse = new SSEServer();
const sch = new Scheduler();

// ─── 默认配置 ─────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  siteName:               'GJ-SDWAN',
  siteSubtitle:           '智能选路管理控制台',
  adminEmail:             '',
  trafficThreshold:       10,
  pingInterval:           30,
  sessionTimeout:         24,
  allowRegister:          true,
  maintenanceMode:        false,
  customCss:              '',
  announcement:           '',
  smartRouting:           true,
  latencyWeight:          50,
  lossWeight:             30,
  bandwidthWeight:        20,
  switchThresholdLatency: 200,
  switchThresholdLoss:    5,
  switchDebounce:         60,
  probeInterval:          30,
};

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(db.get('settings') || {}) };
}

// ─── 初始化数据库 ─────────────────────────────────────────────────────────────
function initDB() {
  const salt = crypto.randomBytes(16).toString('hex');
  const defaultAdmin = {
    id: 'admin-' + crypto.randomBytes(4).toString('hex'),
    username: 'admin', role: 'admin',
    passwordHash: hashPassword('admin123', salt), salt,
    createdAt: new Date().toISOString(),
  };
  if (!db.get('users'))      db.set('users',       [defaultAdmin]);
  if (!db.get('nodes'))      db.set('nodes',        []);
  if (!db.get('clients'))    db.set('clients',      []);
  if (!db.get('routes'))     db.set('routes',       []);
  if (!db.get('traffic'))    db.set('traffic',      {});
  if (!db.get('alerts'))     db.set('alerts',       []);
  if (!db.get('sessions'))   db.set('sessions',     {});
  if (!db.get('settings'))   db.set('settings',     DEFAULT_SETTINGS);
  if (!db.get('quality'))    db.set('quality',      {});
  if (!db.get('splitRules')) db.set('splitRules',   []);
  if (!db.get('iepl'))       db.set('iepl',         []);  // IEPL专线组
  if (!db.get('haConfigs'))  db.set('haConfigs',    []);  // HUB高可用配置
  if (!db.get('multiPaths')) db.set('multiPaths',   []);  // 多路径冗余配置
}

// ─── 加密工具 ─────────────────────────────────────────────────────────────────
function hashPassword(pw, salt) {
  return crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex');
}
function generateToken()    { return crypto.randomBytes(32).toString('hex'); }
function generateId(prefix) { return prefix + '-' + crypto.randomBytes(6).toString('hex'); }

// ─── Session ──────────────────────────────────────────────────────────────────
function createSession(userId, role) {
  const sessions = db.get('sessions') || {};
  const token    = generateToken();
  sessions[token] = { userId, role, createdAt: Date.now(), lastSeen: Date.now() };
  db.set('sessions', sessions);
  return token;
}
function getSession(token) {
  if (!token) return null;
  const sessions = db.get('sessions') || {};
  const s = sessions[token];
  if (!s) return null;
  const timeout = (getSettings().sessionTimeout || 24) * 3600 * 1000;
  if (Date.now() - s.lastSeen > timeout) {
    delete sessions[token]; db.set('sessions', sessions); return null;
  }
  s.lastSeen = Date.now(); db.set('sessions', sessions);
  return s;
}
function deleteSession(token) {
  const sessions = db.get('sessions') || {};
  delete sessions[token]; db.set('sessions', sessions);
}
function getSessionFromReq(req) {
  const cookie = req.headers.cookie || '';
  const match  = cookie.match(/session=([a-f0-9]+)/);
  return match ? getSession(match[1]) : null;
}

// ─── 告警 ─────────────────────────────────────────────────────────────────────
function addAlert(level, title, msg) {
  const alerts = db.get('alerts') || [];
  const alert  = { id: generateId('alert'), level, title, message: msg, time: new Date().toISOString(), read: false };
  alerts.unshift(alert);
  if (alerts.length > 200) alerts.splice(200);
  db.set('alerts', alerts);
  // 实时推送告警
  sse.broadcast('alerts', 'new_alert', alert);
}

// ─── Geo IP ───────────────────────────────────────────────────────────────────
const GEO_CACHE = {};
const COUNTRY_ZH = {
  US:'美国',GB:'英国',DE:'德国',FR:'法国',JP:'日本',KR:'韩国',
  SG:'新加坡',HK:'香港',TW:'台湾',CN:'中国',AU:'澳大利亚',
  CA:'加拿大',RU:'俄罗斯',IN:'印度',NL:'荷兰',SE:'瑞典',
  CH:'瑞士',IT:'意大利',ES:'西班牙',VN:'越南',TH:'泰国',
  MY:'马来西亚',ID:'印度尼西亚',PH:'菲律宾',TR:'土耳其',
  AE:'阿联酋',PL:'波兰',UA:'乌克兰',BR:'巴西',MX:'墨西哥',
};
async function geoIP(ip) {
  if (!ip || ip.startsWith('10.') || ip.startsWith('192.168.'))
    return { country: '内网', region: '', flag: '' };
  if (GEO_CACHE[ip]) return GEO_CACHE[ip];
  return new Promise(resolve => {
    const fallback = { country: '未知', region: '', flag: '' };
    const done = r => { GEO_CACHE[ip] = r; resolve(r); };
    const req = https.get(`https://ipinfo.io/${ip}/json`,
      { timeout: 6000, headers: { 'User-Agent': 'curl/7.88' } }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.country && !j.bogon)
              done({ country: COUNTRY_ZH[j.country] || j.country, region: j.region || '', flag: j.country });
            else done(fallback);
          } catch { done(fallback); }
        });
      });
    req.on('error', () => done(fallback));
    req.on('timeout', () => { req.destroy(); done(fallback); });
  });
}

// ─── WireGuard ────────────────────────────────────────────────────────────────
function generateWGKeys() {
  try {
    const priv = execSync('wg genkey').toString().trim();
    const pub  = execSync(`echo ${priv} | wg pubkey`).toString().trim();
    return { privateKey: priv, publicKey: pub };
  } catch {
    return { privateKey: crypto.randomBytes(32).toString('base64'), publicKey: crypto.randomBytes(32).toString('base64') };
  }
}

// ─── Agent 通信 ───────────────────────────────────────────────────────────────
function agentRequest(method, nodeIp, agentPort, agentToken, urlPath, body) {
  return new Promise(resolve => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: nodeIp, port: agentPort || 51821, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': agentToken,
        ...(data && { 'Content-Length': Buffer.byteLength(data) }) },
      timeout: 5000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ ok: res.statusCode < 300, body: JSON.parse(d) }); } catch { resolve({ ok: false, body: {} }); } });
    });
    r.on('error', e => resolve({ ok: false, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

// ─── 后台任务 ─────────────────────────────────────────────────────────────────

// 任务1：Ping 所有节点
async function taskCheckNodes() {
  const nodes   = db.get('nodes') || [];
  const results = await Promise.all(nodes.map(async n => {
    if (!n.agentToken && !n.everOnline) return { ...n, online: false, latency: null, loss: null };
    const probe = await Routing.probePing(n.ip);
    if (probe.online && !n.everOnline) n.everOnline = true;
    if (!probe.online && n.online) addAlert('danger', `节点离线: ${n.name}`, `节点 ${n.ip} 无法访问`);
    return { ...n, online: probe.online, latency: probe.latency, loss: probe.loss, lastCheck: new Date().toISOString() };
  }));
  db.set('nodes', results);
  // 实时推送节点状态
  sse.broadcast('nodes', 'nodes_updated', results.map(n => ({
    id: n.id, name: n.name, online: n.online, latency: n.latency, loss: n.loss,
  })));
}

// 任务2：探测线路质量 + 智能选路
async function taskProbeQuality() {
  const settings = getSettings();
  if (!settings.smartRouting) return;

  const nodes   = db.get('nodes')   || [];
  const quality = db.get('quality') || {};

  // 只探测 POP 和 VPS
  const targets = nodes.filter(n => n.type === 'pop' || n.type === 'vps');
  await Promise.all(targets.map(async node => {
    const probe = await Routing.probePing(node.ip, 4, 3);
    const score = Routing.calcScore(probe, settings);
    const level = Routing.qualityLevel(score);

    if (!quality[node.id]) quality[node.id] = { history: [] };
    quality[node.id] = {
      ...quality[node.id],
      latency:   probe.latency,
      maxLatency:probe.maxLatency,
      loss:      probe.loss || 0,
      jitter:    probe.jitter,
      score,
      level:     level.level,
      online:    probe.online,
      lastProbe: new Date().toISOString(),
    };
    quality[node.id].history.push({ t: Date.now(), latency: probe.latency, loss: probe.loss || 0, score });
    if (quality[node.id].history.length > 288) quality[node.id].history.shift();
  }));
  db.set('quality', quality);

  // 智能切换检查
  const routes   = db.get('routes') || [];
  const allQ     = targets.map(n => ({ nodeId: n.id, ...quality[n.id] }));
  let   changed  = false;
  const updatedRoutes = routes.map(route => {
    if (!route.exitNodeId) return route;
    const exitQ  = quality[route.exitNodeId];
    const exitNode = nodes.find(n => n.id === route.exitNodeId);
    const sw     = Routing.shouldSwitch(route, exitQ, allQ, settings);
    if (!sw) return route;
    const targetNode = nodes.find(n => n.id === sw.target.nodeId);
    if (!targetNode) return route;
    Routing.recordSwitch(route.name, exitNode?.name || '?', targetNode.name, sw.reason);
    addAlert('warning', `★ 智能切换: ${route.name}`,
      `${sw.reason} → 切换至 ${targetNode.name}（评分:${sw.target.score}）`);
    changed = true;
    return { ...route, exitNodeId: targetNode.id, autoSwitched: true, switchedAt: new Date().toISOString(), switchReason: sw.reason };
  });
  if (changed) db.set('routes', updatedRoutes);

  // 实时推送质量数据
  const qualityList = targets.map(n => ({
    nodeId: n.id, name: n.name, type: n.type, country: n.country, flag: n.flag,
    ...(quality[n.id] || {}),
  })).sort((a, b) => (b.score || 0) - (a.score || 0));
  sse.broadcast('quality', 'quality_updated', qualityList);
}

// 任务3：流量统计
async function taskTrafficStats() {
  const nodes   = db.get('nodes')   || [];
  const traffic = db.get('traffic') || {};
  let changed   = false;
  await Promise.all(nodes.map(async n => {
    if (!traffic[n.id]) traffic[n.id] = { up: 0, down: 0, history: [], peers: [] };
    if (n.agentToken && n.online) {
      const r = await agentRequest('GET', n.ip, n.agentPort || 51821, n.agentToken, '/peers');
      if (r.ok && r.body?.peers) {
        let rx = 0, tx = 0;
        r.body.peers.forEach(p => { rx += p.rxBytes || 0; tx += p.txBytes || 0; });
        const prevTx = traffic[n.id]._lastTx || 0;
        const prevRx = traffic[n.id]._lastRx || 0;
        if (tx >= prevTx) traffic[n.id].up   += tx - prevTx;
        if (rx >= prevRx) traffic[n.id].down += rx - prevRx;
        traffic[n.id]._lastTx = tx; traffic[n.id]._lastRx = rx;
        traffic[n.id].peers   = r.body.peers;
        traffic[n.id].history.push({ t: Date.now(), up: tx, down: rx });
        if (traffic[n.id].history.length > 144) traffic[n.id].history.shift();
        changed = true;
      }
    }
    const total     = traffic[n.id].up + traffic[n.id].down;
    const threshold = (getSettings().trafficThreshold || 10) * 1024 ** 3;
    if (total > threshold && !traffic[n.id].alerted) {
      addAlert('warning', `流量预警: ${n.name}`, `累计流量超过 ${getSettings().trafficThreshold}GB`);
      traffic[n.id].alerted = true;
    }
  }));
  if (changed) db.set('traffic', traffic);
}

// ─── 注册调度任务 ─────────────────────────────────────────────────────────────
function startScheduler() {
  const settings = getSettings();
  sch.every('check-nodes',   30000, taskCheckNodes,   { skipOnBusy: true }).start(true);
  sch.every('probe-quality', (settings.probeInterval || 30) * 1000, taskProbeQuality, { skipOnBusy: true }).start(false);
  sch.every('traffic-stats', 10000, taskTrafficStats, { skipOnBusy: true }).start(false);
  // 延迟5秒后首次探测
  setTimeout(() => taskProbeQuality().catch(console.error), 5000);
  console.log('[Scheduler] 所有定时任务已启动');
}

// ─── HTTP 工具 ────────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function send(res, status, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const ct   = typeof data === 'string' ? 'text/html; charset=utf-8' : 'application/json';
  res.writeHead(status, { 'Content-Type': ct });
  res.end(body);
}
function setCookie(res, token) { res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400`); }
function clearCookie(res)      { res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0'); }

// ─── 辅助：Agent 操作 ─────────────────────────────────────────────────────────
async function pushPeerToHub(client) {
  const routes = db.get('routes') || [];
  const nodes  = db.get('nodes')  || [];
  const route  = routes.find(r => r.id === client.routeId);
  const hub    = nodes.find(n => n.id === (route?.hubId) || n.type === 'hub');
  if (!hub?.agentToken) return { ok: false, error: 'No HUB' };
  let pubKey = client.publicKey;
  if (!pubKey && client.privateKey) {
    try { pubKey = execSync(`echo "${client.privateKey}" | wg pubkey`).toString().trim(); } catch {}
  }
  if (!pubKey) return { ok: false };
  return agentRequest('POST', hub.ip, hub.agentPort || 51821, hub.agentToken, '/peer/add', {
    publicKey: pubKey, allowedIPs: client.assignedIP, keepalive: 25,
  });
}

// ─── API Routes ───────────────────────────────────────────────────────────────
const API = {

  // ── SSE 实时推送连接 ────────────────────────────────────────────────────────
  'GET /api/sse': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, 'Unauthorized');
    sse.connect(req, res);
    // 立即推送当前数据
    const nodes   = db.get('nodes')   || [];
    const quality = db.get('quality') || {};
    setTimeout(() => {
      sse.broadcast('nodes',   'nodes_updated',   nodes.map(n => ({ id: n.id, name: n.name, online: n.online, latency: n.latency })));
      sse.broadcast('quality', 'quality_updated', nodes.filter(n => n.type !== 'hub').map(n => ({ nodeId: n.id, ...quality[n.id] })));
    }, 500);
  },

  // ── Auth ────────────────────────────────────────────────────────────────────
  'POST /api/login': async (req, res) => {
    const { username, password } = await parseBody(req);
    const users = db.get('users') || [];
    const user  = users.find(u => u.username === username);
    if (!user || hashPassword(password, user.salt) !== user.passwordHash)
      return send(res, 401, { error: '用户名或密码错误' });
    const token = createSession(user.id, user.role);
    setCookie(res, token);
    send(res, 200, { ok: true, role: user.role, username: user.username });
  },
  'POST /api/logout': (req, res) => {
    const match = (req.headers.cookie || '').match(/session=([a-f0-9]+)/);
    if (match) deleteSession(match[1]);
    clearCookie(res);
    send(res, 200, { ok: true });
  },
  'GET /api/me': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    const user = (db.get('users') || []).find(u => u.id === s.userId);
    if (!user) return send(res, 401, { error: 'Unauthorized' });
    send(res, 200, { id: user.id, username: user.username, role: user.role });
  },
  'POST /api/register': async (req, res) => {
    if (!getSettings().allowRegister) return send(res, 403, { error: '注册已关闭' });
    const { username, password } = await parseBody(req);
    if (!username || !password || password.length < 6) return send(res, 400, { error: '密码至少6位' });
    const users = db.get('users') || [];
    if (users.find(u => u.username === username)) return send(res, 400, { error: '用户名已存在' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.insert('users', { id: generateId('user'), username, role: 'user', passwordHash: hashPassword(password, salt), salt, createdAt: new Date().toISOString() });
    send(res, 200, { ok: true });
  },
  'POST /api/change-password': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    const { oldPassword, newPassword } = await parseBody(req);
    if (!newPassword || newPassword.length < 6) return send(res, 400, { error: '新密码至少6位' });
    const users = db.get('users') || [];
    const idx   = users.findIndex(u => u.id === s.userId);
    if (idx < 0) return send(res, 404, { error: '用户不存在' });
    if (hashPassword(oldPassword, users[idx].salt) !== users[idx].passwordHash) return send(res, 401, { error: '原密码错误' });
    const salt = crypto.randomBytes(16).toString('hex');
    users[idx] = { ...users[idx], salt, passwordHash: hashPassword(newPassword, salt) };
    db.set('users', users);
    send(res, 200, { ok: true });
  },

  // ── Nodes ───────────────────────────────────────────────────────────────────
  'GET /api/nodes': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    const nodes   = db.get('nodes')   || [];
    const traffic = db.get('traffic') || {};
    const quality = db.get('quality') || {};
    send(res, 200, nodes.map(n => ({
      ...n,
      traffic: traffic[n.id] || { up: 0, down: 0 },
      quality: quality[n.id] ? { latency: quality[n.id].latency, loss: quality[n.id].loss, score: quality[n.id].score, level: quality[n.id].level } : null,
    })));
  },
  'POST /api/nodes': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body = await parseBody(req);
    if (!body.name || !body.ip || !body.type) return send(res, 400, { error: '缺少必填字段' });
    const nodes = db.get('nodes') || [];
    const keys  = generateWGKeys();
    const geo   = await geoIP(body.ip);
    const node  = {
      id: generateId('node'), name: body.name, ip: body.ip, type: body.type,
      wgPort: body.wgPort || 51820, publicKey: keys.publicKey,
      country: geo.country, region: geo.region, flag: geo.flag,
      wgIP: body.wgIP || '', token: generateToken(),
      online: false, lastCheck: null, createdAt: new Date().toISOString(),
    };
    nodes.push(node); db.set('nodes', nodes);
    send(res, 200, node);
  },
  'DELETE /api/nodes/:id': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    db.delete('nodes', n => n.id === params.id);
    send(res, 200, { ok: true });
  },
  'POST /api/nodes/:id/check': async (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const nodes = db.get('nodes') || [];
    const node  = nodes.find(n => n.id === params.id);
    if (!node) return send(res, 404, { error: 'Not found' });
    const probe = await Routing.probePing(node.ip);
    db.update('nodes', n => n.id === params.id, () => ({
      online: probe.online, latency: probe.latency, loss: probe.loss,
      everOnline: probe.online || node.everOnline, lastCheck: new Date().toISOString(),
    }));
    send(res, 200, { online: probe.online, latency: probe.latency, loss: probe.loss });
  },
  'GET /api/nodes/all': (req, res) => {
    const token     = req.headers['x-node-token'] || '';
    const nodes     = db.get('nodes') || [];
    const validNode = nodes.find(n => n.token === token);
    if (!validNode) return send(res, 403, { error: 'Unauthorized' });
    send(res, 200, { nodes: nodes.map(n => ({ id: n.id, name: n.name, type: n.type, ip: n.ip, wgIP: n.wgIP, wgPort: n.wgPort, publicKey: n.publicKey, online: n.online })) });
  },
  'POST /api/node-heartbeat': async (req, res) => {
    const token = req.headers['x-node-token'] || '';
    const body  = await parseBody(req);
    const nodes = db.get('nodes') || [];
    const idx   = nodes.findIndex(n => n.token === token);
    if (idx < 0) return send(res, 403, { error: 'Unauthorized' });
    nodes[idx] = { ...nodes[idx], online: true, everOnline: true, lastCheck: new Date().toISOString(), ...(body.publicKey && { publicKey: body.publicKey }) };
    db.set('nodes', nodes);
    const others = nodes.filter((n, i) => i !== idx && n.publicKey && n.wgIP).map(n => ({ id: n.id, name: n.name, type: n.type, ip: n.ip, wgIP: n.wgIP, wgPort: n.wgPort, publicKey: n.publicKey }));
    send(res, 200, { ok: true, nodes: others });
  },
  'POST /api/nodes/sync-all': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const nodes   = db.get('nodes') || [];
    const results = [];
    for (const node of nodes) {
      if (!node.agentToken || !node.online) continue;
      const r = await agentRequest('POST', node.ip, node.agentPort || 51821, node.agentToken, '/sync');
      results.push({ name: node.name, ok: r.ok, error: r.error });
    }
    send(res, 200, { ok: true, results });
  },

  // ★ 新增：强制 Mesh 重建 - 修复已注册但未互通的节点
  'POST /api/nodes/repair-mesh': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const nodes = db.get('nodes') || [];
    const log   = [];
    let fixed = 0;

    // ★ Step 1: 修复缺失的 agentToken（Bug#1的历史遗留数据）
    let dbChanged = false;
    nodes.forEach(n => {
      if (!n.agentToken && n.token && n.everOnline) {
        n.agentToken = n.token;
        dbChanged = true;
        log.push(`🔧 ${n.name}: 补全agentToken`);
        fixed++;
      }
    });
    if (dbChanged) db.set('nodes', nodes);

    // Step 2: 对每个在线节点重新推送所有 peer
    const online = nodes.filter(n => n.online && n.agentToken && n.publicKey && n.wgIP);
    log.push(`📊 在线节点数: ${online.length}`);

    let pushSuccess = 0, pushFail = 0;
    for (const self of online) {
      for (const other of online) {
        if (self.id === other.id) continue;
        const otherWgIP = other.wgIP.split('/')[0] + '/32';
        const r = await agentRequest('POST', self.ip, self.agentPort || 51821, self.agentToken, '/peer/add', {
          publicKey: other.publicKey, allowedIPs: otherWgIP,
          endpoint: `${other.ip}:${other.wgPort || 51820}`,
        });
        if (r.ok) pushSuccess++;
        else {
          pushFail++;
          log.push(`❌ ${self.name}→${other.name}: ${r.error || JSON.stringify(r.body)}`);
        }
      }
    }
    log.push(`✅ Peer 推送: 成功${pushSuccess} / 失败${pushFail}`);
    send(res, 200, { ok: true, log, fixed, pushSuccess, pushFail });
  },

  // ★ 新增：诊断接口 - 检查节点连通性和配置完整性
  'GET /api/nodes/diagnose': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const nodes = db.get('nodes') || [];
    const report = [];
    for (const n of nodes) {
      const issues = [];
      if (!n.publicKey) issues.push('无公钥');
      if (!n.wgIP) issues.push('无WG隧道IP');
      if (!n.agentToken && n.everOnline) issues.push('缺失agentToken（点击"一键修复"）');
      if (!n.online) issues.push('节点离线');
      // 尝试连Agent
      let agentReachable = false;
      if (n.agentToken && n.online) {
        const r = await agentRequest('GET', n.ip, n.agentPort || 51821, n.agentToken, '/status');
        agentReachable = r.ok;
        if (!r.ok) issues.push(`Agent不可达: ${r.error || '端口51821被防火墙拦截?'}`);
      }
      // 查询当前peer数量
      let peerCount = 0;
      if (agentReachable) {
        const r = await agentRequest('GET', n.ip, n.agentPort || 51821, n.agentToken, '/peers');
        peerCount = r.ok && r.body?.peers ? r.body.peers.length : 0;
      }
      report.push({
        id: n.id, name: n.name, ip: n.ip, type: n.type,
        online: n.online, agentReachable, peerCount,
        expectedPeers: nodes.filter(x => x.id !== n.id && x.online).length,
        issues,
      });
    }
    send(res, 200, { nodes: report });
  },
  'POST /api/nodes/:id/refreshgeo': async (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const nodes = db.get('nodes') || [];
    const node  = nodes.find(n => n.id === params.id);
    if (!node) return send(res, 404, { error: 'Not found' });
    const geo = await geoIP(node.ip);
    db.update('nodes', n => n.id === params.id, () => geo);
    send(res, 200, { ok: true, ...geo });
  },
  'POST /api/nodes/:id/agent': async (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const { agentToken, agentPort } = await parseBody(req);
    db.update('nodes', n => n.id === params.id, n => ({
      agentToken: agentToken || n.agentToken,
      agentPort:  agentPort  || n.agentPort || 51821,
    }));
    send(res, 200, { ok: true });
  },
  'GET /api/nodes/:id/peers': async (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const node = (db.get('nodes') || []).find(n => n.id === params.id);
    if (!node) return send(res, 404, { error: 'Not found' });
    if (!node.agentToken) return send(res, 400, { error: 'Agent not configured' });
    const r = await agentRequest('GET', node.ip, node.agentPort || 51821, node.agentToken, '/peers');
    send(res, r.ok ? 200 : 500, r.body || { error: 'Agent unreachable' });
  },
  'GET /api/nodes/:id/install': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const nodes   = db.get('nodes') || [];
    const node    = nodes.find(n => n.id === params.id);
    if (!node) return send(res, 404, { error: 'Not found' });
    const hub     = nodes.find(n => n.type === 'hub');
    const script  = generateInstallScript(node, hub?.ip || 'HUB_IP', hub?.publicKey || 'HUB_KEY');
    send(res, 200, { script, token: node.token });
  },

  // ── ★ 线路质量 API ──────────────────────────────────────────────────────────
  'GET /api/quality': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    const nodes   = db.get('nodes')   || [];
    const quality = db.get('quality') || {};
    const list    = nodes
      .filter(n => n.type === 'pop' || n.type === 'vps')
      .map(n => ({ nodeId: n.id, name: n.name, type: n.type, ip: n.ip, country: n.country, flag: n.flag, ...(quality[n.id] || { latency: null, loss: 0, score: 0, online: false }) }))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    send(res, 200, list);
  },
  'GET /api/quality/:id/history': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    const quality = db.get('quality') || {};
    const q       = quality[params.id];
    send(res, q ? 200 : 404, q ? { history: q.history || [] } : { error: 'Not found' });
  },
  'POST /api/quality/probe': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    taskProbeQuality().catch(console.error);
    send(res, 200, { ok: true, message: '探测任务已启动' });
  },
  'GET /api/switch-history': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    send(res, 200, Routing.getSwitchHistory());
  },
  'GET /api/scheduler/status': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    send(res, 200, { jobs: sch.status(), clients: sse.clientCount() });
  },

  // ── ★ 分流规则 API ──────────────────────────────────────────────────────────
  'GET /api/split-rules': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    send(res, 200, db.get('splitRules') || []);
  },
  'POST /api/split-rules': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body  = await parseBody(req);
    const rules = db.get('splitRules') || [];
    const rule  = { id: generateId('rule'), name: body.name || '新规则', type: body.type || 'domain', match: body.match || '', action: body.action || 'route', routeId: body.routeId || null, priority: rules.length + 1, enabled: true, createdAt: new Date().toISOString() };
    rules.push(rule); db.set('splitRules', rules);
    send(res, 200, rule);
  },
  'DELETE /api/split-rules/:id': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const rules = (db.get('splitRules') || []).filter(r => r.id !== params.id).map((r, i) => ({ ...r, priority: i + 1 }));
    db.set('splitRules', rules);
    send(res, 200, { ok: true });
  },
  'PUT /api/split-rules/:id': async (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body  = await parseBody(req);
    db.update('splitRules', r => r.id === params.id, () => body);
    send(res, 200, { ok: true });
  },

  // ── ★ OpenWRT 配置生成 ──────────────────────────────────────────────────────
  'GET /api/openwrt-config': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const nodes      = db.get('nodes')      || [];
    const routes     = db.get('routes')     || [];
    const splitRules = db.get('splitRules') || [];
    const quality    = db.get('quality')    || {};
    const config     = Routing.generateOpenWRTConfig(nodes, routes, splitRules, quality);
    send(res, 200, { config, fileList: Routing.getOpenWRTFileList() });
  },

  // ═════════════════════════════════════════════════════════════════════════
  // ★★★ QUIC/BBR 加速 API
  // ═════════════════════════════════════════════════════════════════════════
  'GET /api/accel/bbr-script': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    send(res, 200, { script: Acceleration.generateBBRScript() });
  },

  'POST /api/accel/hysteria': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body = await parseBody(req);
    // role: server(香港POP) | client(国内HUB)
    // serverNodeId: 服务端节点ID
    // password: hysteria密码
    const nodes = db.get('nodes') || [];
    const iepls = db.get('iepl')  || [];
    const all   = [...nodes, ...iepls];
    const serverNode = all.find(n => n.id === body.serverNodeId);
    if (!serverNode) return send(res, 404, { error: '服务端节点不存在' });

    const password = body.password || generateToken().substring(0, 16);
    const config = body.role === 'server'
      ? Acceleration.generateHysteriaServerConfig(serverNode, password, body.port || 36712)
      : Acceleration.generateHysteriaClientConfig(serverNode, password, body.localPort || 1080);
    const script = Acceleration.generateHysteriaInstallScript(body.role, config, password);
    send(res, 200, { script, config: config.content, configPath: config.path, password });
  },

  // ═════════════════════════════════════════════════════════════════════════
  // ★★★ HUB 双活 HA API
  // ═════════════════════════════════════════════════════════════════════════
  'POST /api/ha/generate': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body = await parseBody(req);
    // masterId, backupId, vip, iface, password, group
    const nodes = db.get('nodes') || [];
    const master = nodes.find(n => n.id === body.masterId);
    const backup = nodes.find(n => n.id === body.backupId);
    if (!master || !backup) return send(res, 400, { error: '需指定主备节点' });
    if (!body.vip) return send(res, 400, { error: 'VIP地址不能为空' });

    const group = body.group || 'HUB_HA';
    const vip   = body.vip;
    const iface = body.iface || 'eth0';
    const pwd   = body.password || generateToken().substring(0, 8);

    const masterConf = HA.generateKeepalivedMaster(group, master, backup, vip, iface, pwd);
    const backupConf = HA.generateKeepalivedBackup(group, master, backup, vip, iface, pwd);
    const host       = (req.headers.host || 'MANAGER_IP').split(':')[0];
    const masterScript = HA.generateHAInstallScript('master', masterConf, host, PORT, master.token);
    const backupScript = HA.generateHAInstallScript('backup', backupConf, host, PORT, backup.token);

    // 保存HA配置到db
    const haConfigs = db.get('haConfigs') || [];
    const existing = haConfigs.findIndex(h => h.masterId === master.id);
    const haCfg = {
      id: existing >= 0 ? haConfigs[existing].id : generateId('ha'),
      group, vip, iface, password: pwd,
      masterId: master.id, masterName: master.name,
      backupId: backup.id, backupName: backup.name,
      masterState: 'unknown', backupState: 'unknown',
      createdAt: new Date().toISOString(),
    };
    if (existing >= 0) haConfigs[existing] = haCfg;
    else haConfigs.push(haCfg);
    db.set('haConfigs', haConfigs);

    send(res, 200, {
      ok: true, haCfg,
      masterScript, backupScript,
      masterConf: masterConf.content, backupConf: backupConf.content,
    });
  },

  'GET /api/ha/list': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    send(res, 200, db.get('haConfigs') || []);
  },

  'DELETE /api/ha/:id': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    db.delete('haConfigs', h => h.id === params.id);
    send(res, 200, { ok: true });
  },

  // HA 状态上报（Keepalived 状态变化时调用）
  'POST /api/ha-notify': async (req, res) => {
    const token = req.headers['x-node-token'] || '';
    const body  = await parseBody(req);
    const nodes = db.get('nodes') || [];
    const node  = nodes.find(n => n.token === token);
    if (!node) return send(res, 403, { error: 'Unauthorized' });

    const haConfigs = db.get('haConfigs') || [];
    const hc = haConfigs.find(h => h.masterId === node.id || h.backupId === node.id);
    if (hc) {
      const isMaster = hc.masterId === node.id;
      if (isMaster) hc.masterState = body.state;
      else          hc.backupState = body.state;
      hc.lastUpdate = new Date().toISOString();
      db.set('haConfigs', haConfigs);
      addAlert('info', `HA状态变更: ${node.name}`, `${isMaster?'主':'备'}节点切换为 ${body.state}`);
    }
    send(res, 200, { ok: true });
  },

  // ═════════════════════════════════════════════════════════════════════════
  // ★★★ MPTCP 多路径冗余 API
  // ═════════════════════════════════════════════════════════════════════════
  'GET /api/mptcp/script': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    send(res, 200, { script: MultiPath.generateMPTCPScript() });
  },

  'POST /api/mptcp/generate': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body = await parseBody(req);
    // nodeId: 要部署多路径的节点
    // tunnels: [{ name, wgIP, peerWgIP, weight }]
    const nodes = db.get('nodes') || [];
    const node  = nodes.find(n => n.id === body.nodeId);
    if (!node) return send(res, 404, { error: '节点不存在' });
    if (!body.tunnels || body.tunnels.length < 2)
      return send(res, 400, { error: '至少需要2条隧道才能做多路径' });

    const host = (req.headers.host || 'MANAGER_IP').split(':')[0];
    const script = MultiPath.generateMultiPathInstallScript(node, body.tunnels, host, PORT);

    // 保存配置
    const mps = db.get('multiPaths') || [];
    const cfg = {
      id: generateId('mpath'),
      nodeId: node.id, nodeName: node.name,
      tunnels: body.tunnels,
      createdAt: new Date().toISOString(),
    };
    mps.push(cfg);
    db.set('multiPaths', mps);

    send(res, 200, { ok: true, script, config: cfg });
  },

  'GET /api/mptcp/list': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    send(res, 200, db.get('multiPaths') || []);
  },

  'DELETE /api/mptcp/:id': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    db.delete('multiPaths', m => m.id === params.id);
    send(res, 200, { ok: true });
  },


  // ── Clients ─────────────────────────────────────────────────────────────────
  'GET /api/clients': (req, res) => {
    const s       = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    const clients = db.get('clients') || [];
    send(res, 200, s.role === 'admin' ? clients : clients.filter(c => c.userId === s.userId));
  },
  'POST /api/clients': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body    = await parseBody(req);
    if (!body.name || !body.userId) return send(res, 400, { error: '缺少必填字段' });
    const clients = db.get('clients') || [];
    const keys    = generateWGKeys();
    const client  = { id: generateId('client'), name: body.name, userId: body.userId, publicKey: keys.publicKey, privateKey: keys.privateKey, assignedIP: body.assignedIP || `10.8.0.${clients.length + 2}/32`, routeId: body.routeId || null, online: false, lastSeen: null, ip: '', country: '', createdAt: new Date().toISOString() };
    clients.push(client); db.set('clients', clients);
    pushPeerToHub(client).catch(() => {});
    send(res, 200, client);
  },
  'DELETE /api/clients/:id': async (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const client = (db.get('clients') || []).find(c => c.id === params.id);
    if (client) {
      const hub = (db.get('nodes') || []).find(n => n.type === 'hub');
      if (hub?.agentToken && client.publicKey)
        agentRequest('POST', hub.ip, hub.agentPort || 51821, hub.agentToken, '/peer/remove', { publicKey: client.publicKey }).catch(() => {});
    }
    db.delete('clients', c => c.id === params.id);
    send(res, 200, { ok: true });
  },
  'PUT /api/clients/:id/route': async (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body = await parseBody(req);
    const update = {};
    if (body.routeId   !== undefined) update.routeId    = body.routeId;
    if (body.dns       !== undefined) update.dns        = body.dns;
    if (body.allowedIPs!== undefined) update.allowedIPs = body.allowedIPs;
    db.update('clients', c => c.id === params.id, () => update);
    send(res, 200, { ok: true });
  },
  'GET /api/clients/:id/config': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    const client = (db.get('clients') || []).find(c => c.id === params.id);
    if (!client) return send(res, 404, { error: 'Not found' });
    if (s.role !== 'admin' && client.userId !== s.userId) return send(res, 403, { error: 'Forbidden' });
    const hub    = (db.get('nodes') || []).find(n => n.type === 'hub');
    const url    = new URL(req.url, 'http://localhost');
    const mode   = url.searchParams.get('mode') || 'global'; // global | split | custom
    send(res, 200, { config: generateClientConfig(client, hub, mode), mode });
  },

  // ── Routes ──────────────────────────────────────────────────────────────────
  'GET /api/routes': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    send(res, 200, db.get('routes') || []);
  },
  'POST /api/routes': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body   = await parseBody(req);
    const routes = db.get('routes') || [];
    const route  = { id: generateId('route'), name: body.name || '新线路', hubId: body.hubId, popId: body.popId || null, exitNodeId: body.exitNodeId, layers: body.popId ? 3 : 2, smartRouting: body.smartRouting !== false, createdAt: new Date().toISOString() };
    routes.push(route); db.set('routes', routes);
    send(res, 200, route);
  },
  'DELETE /api/routes/:id': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    db.delete('routes', r => r.id === params.id);
    send(res, 200, { ok: true });
  },

  // ── Users ───────────────────────────────────────────────────────────────────
  'GET /api/users': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    send(res, 200, (db.get('users') || []).map(u => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt })));
  },
  'POST /api/users': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const { username, password, role } = await parseBody(req);
    if (!username || !password) return send(res, 400, { error: '缺少字段' });
    const users = db.get('users') || [];
    if (users.find(u => u.username === username)) return send(res, 400, { error: '用户名已存在' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.insert('users', { id: generateId('user'), username, role: role || 'user', passwordHash: hashPassword(password, salt), salt, createdAt: new Date().toISOString() });
    send(res, 200, { ok: true });
  },
  'DELETE /api/users/:id': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const users = db.get('users') || [];
    if (users.find(u => u.id === params.id)?.role === 'admin') return send(res, 400, { error: '不能删除管理员' });
    db.delete('users', u => u.id === params.id);
    send(res, 200, { ok: true });
  },
  'PUT /api/users/:id/password': async (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const { password } = await parseBody(req);
    if (!password || password.length < 6) return send(res, 400, { error: '密码至少6位' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.update('users', u => u.id === params.id, () => ({ salt, passwordHash: hashPassword(password, salt) }));
    send(res, 200, { ok: true });
  },

  // ── Settings ─────────────────────────────────────────────────────────────────
  'GET /api/settings': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    const settings = getSettings();
    if (s.role !== 'admin') return send(res, 200, { siteName: settings.siteName, siteSubtitle: settings.siteSubtitle, announcement: settings.announcement });
    send(res, 200, settings);
  },
  'PUT /api/settings': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body    = await parseBody(req);
    const current = getSettings();
    const allowed = ['siteName','siteSubtitle','adminEmail','trafficThreshold','pingInterval','sessionTimeout','allowRegister','maintenanceMode','customCss','announcement','smartRouting','latencyWeight','lossWeight','bandwidthWeight','switchThresholdLatency','switchThresholdLoss','switchDebounce','probeInterval'];
    allowed.forEach(k => { if (body[k] !== undefined) current[k] = body[k]; });
    db.set('settings', current);
    // 动态调整探测间隔
    if (body.probeInterval) sch.getJob('probe-quality')?.setInterval(body.probeInterval * 1000);
    send(res, 200, { ok: true, settings: current });
  },

  // ── Traffic & Alerts ─────────────────────────────────────────────────────────
  'GET /api/traffic': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    send(res, 200, db.get('traffic') || {});
  },
  'GET /api/alerts': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    send(res, 200, db.get('alerts') || []);
  },
  'POST /api/alerts/read-all': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s) return send(res, 401, { error: 'Unauthorized' });
    db.set('alerts', (db.get('alerts') || []).map(a => ({ ...a, read: true })));
    send(res, 200, { ok: true });
  },


  // ═══════════════════════════════════════════════════════════════════════
  // ★★★ IEPL 专线管理 API
  // 数据结构：
  //   iepl[] = { id, name, type:'hub'|'pop', role:'domestic'|'hk',
  //              publicIP, privateIP, wgIP, wgPort, publicKey, privateKey,
  //              ieplGroup, peerPublicIP, peerPrivateIP, peerPublicKey,
  //              agentToken, online, latency, createdAt }
  // ═══════════════════════════════════════════════════════════════════════

  // 获取所有IEPL节点
  'GET /api/iepl': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const iepls  = db.get('iepl') || [];
    const traffic = db.get('traffic') || {};
    send(res, 200, iepls.map(n => ({ ...n, traffic: traffic[n.id] || { up:0, down:0 } })));
  },

  // 添加IEPL节点（自动生成WG密钥对）
  'POST /api/iepl': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body = await parseBody(req);
    if (!body.name || !body.publicIP || !body.role || !body.ieplGroup)
      return send(res, 400, { error: '缺少必填字段: name, publicIP, role, ieplGroup' });

    const keys = generateWGKeys();
    const geo  = await geoIP(body.publicIP);

    const node = {
      id:             generateId('iepl'),
      name:           body.name,
      role:           body.role,           // domestic（国内端）| hk（香港端）
      ieplGroup:      body.ieplGroup,      // 线路组名，如"深港IEPL"
      publicIP:       body.publicIP,       // 公网IP
      privateIP:      body.privateIP || '', // IEPL内网IP
      wgIP:           body.wgIP || '',     // WireGuard隧道IP
      wgPort:         body.wgPort || 51820,
      publicKey:      keys.publicKey,      // 自动生成
      privateKey:     keys.privateKey,     // 自动生成（安装脚本用）
      // 对端信息（填写后才能生成完整配置）
      peerPublicIP:   body.peerPublicIP   || '',
      peerPrivateIP:  body.peerPrivateIP  || '',  // IEPL对端内网IP（Endpoint用）
      peerPublicKey:  body.peerPublicKey  || '',
      peerWgIP:       body.peerWgIP       || '',  // 对端WG隧道IP
      // 落地VPS对接（仅香港POP端需要）
      landPubkey:     body.landPubkey     || '',
      landEndpoint:   body.landEndpoint   || '',
      landWgIP:       body.landWgIP       || '',
      // 元信息
      country:        geo.country,
      flag:           geo.flag,
      token:          generateToken(),     // 安装验证token
      agentToken:     null,
      online:         false,
      latency:        null,
      loss:           null,
      createdAt:      new Date().toISOString(),
    };

    const iepls = db.get('iepl') || [];
    iepls.push(node);
    db.set('iepl', iepls);
    // 不返回 privateKey，单独接口获取
    const { privateKey, ...safeNode } = node;
    send(res, 200, safeNode);
  },

  // 更新IEPL节点（填写对端信息、落地VPS信息）
  'PUT /api/iepl/:id': async (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body  = await parseBody(req);
    const iepls = db.get('iepl') || [];
    const idx   = iepls.findIndex(n => n.id === params.id);
    if (idx < 0) return send(res, 404, { error: 'Not found' });
    const allowed = ['name','peerPublicIP','peerPrivateIP','peerPublicKey','peerWgIP','landPubkey','landEndpoint','landWgIP','wgIP','wgPort','privateIP'];
    allowed.forEach(k => { if (body[k] !== undefined) iepls[idx][k] = body[k]; });
    db.set('iepl', iepls);
    send(res, 200, { ok: true });
  },

  // 删除IEPL节点
  'DELETE /api/iepl/:id': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    db.delete('iepl', n => n.id === params.id);
    send(res, 200, { ok: true });
  },

  // Ping检测
  'POST /api/iepl/:id/check': async (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const iepls = db.get('iepl') || [];
    const node  = iepls.find(n => n.id === params.id);
    if (!node) return send(res, 404, { error: 'Not found' });
    const probe = await Routing.probePing(node.publicIP);
    db.update('iepl', n => n.id === params.id, () => ({
      online: probe.online, latency: probe.latency, loss: probe.loss,
      lastCheck: new Date().toISOString(),
    }));
    send(res, 200, { online: probe.online, latency: probe.latency, loss: probe.loss });
  },

  // 获取完整安装脚本（含私钥，一次性）
  'GET /api/iepl/:id/install': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const iepls = db.get('iepl') || [];
    const node  = iepls.find(n => n.id === params.id);
    if (!node) return send(res, 404, { error: 'Not found' });
    const script = generateIEPLInstallScript(node);
    const conf   = generateIEPLWgConf(node);
    send(res, 200, { script, conf, token: node.token, publicKey: node.publicKey });
  },

  // 获取wg0.conf配置文件（不含私钥，用于预览）
  'GET /api/iepl/:id/config': (req, res, params) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const iepls = db.get('iepl') || [];
    const node  = iepls.find(n => n.id === params.id);
    if (!node) return send(res, 404, { error: 'Not found' });
    const conf = generateIEPLWgConf(node);
    send(res, 200, { conf, complete: isIEPLComplete(node) });
  },

  // Agent心跳（IEPL节点上报）
  'POST /api/iepl-heartbeat': async (req, res) => {
    const token = req.headers['x-node-token'] || '';
    const body  = await parseBody(req);
    const iepls = db.get('iepl') || [];
    const idx   = iepls.findIndex(n => n.token === token);
    if (idx < 0) return send(res, 403, { error: 'Unauthorized' });
    iepls[idx].online    = true;
    iepls[idx].lastCheck = new Date().toISOString();
    if (body.publicKey) iepls[idx].publicKey = body.publicKey;
    db.set('iepl', iepls);
    send(res, 200, { ok: true });
  },

  // ── Backup / Restore ─────────────────────────────────────────────────────────
  'GET /api/backup': (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const backup = { version: '2.2', exportedAt: new Date().toISOString(), data: {} };
    ['users','nodes','clients','routes','settings','alerts','splitRules','iepl','haConfigs','multiPaths'].forEach(key => {
      const d = db.get(key);
      // users：去掉密码哈希；iepl：去掉私钥（安全起见，安装时重新生成）
      if (key === 'users') {
        backup.data[key] = (d||[]).map(u => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt }));
      } else if (key === 'iepl') {
        backup.data[key] = (d||[]).map(n => { const { privateKey, ...safe } = n; return safe; });
      } else {
        backup.data[key] = d || [];
      }
    });
    const json = JSON.stringify(backup, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="gj-sdwan-backup-${new Date().toISOString().slice(0,10)}.json"`, 'Content-Length': Buffer.byteLength(json) });
    res.end(json);
  },
  'POST /api/restore': async (req, res) => {
    const s = getSessionFromReq(req);
    if (!s || s.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const body = await parseBody(req);
    if (!body.data) return send(res, 400, { error: '无效备份' });
    const restored = [];
    ['nodes','clients','routes','settings','alerts','splitRules','iepl','haConfigs','multiPaths'].forEach(key => {
      if (body.data[key] !== undefined) { db.set(key, body.data[key]); restored.push(key); }
    });
    const ieplCount = (body.data.iepl || []).length;
    send(res, 200, {
      ok: true,
      restored,
      notice: ieplCount > 0
        ? `已恢复 ${ieplCount} 个IEPL节点（私钥未备份，需重新点击「安装脚本」生成并部署）`
        : null,
    });
  },
};

// ─── 脚本生成 ─────────────────────────────────────────────────────────────────
function generateInstallScript(node, hubIP, hubKey) {
  return `#!/bin/bash
# GJ-SDWAN 节点一键安装脚本 v2.2
set -e
[ "$(id -u)" = "0" ] || { echo "❌ 需要 root 权限"; exit 1; }
MANAGER_IP="MANAGER_IP"
NODE_ID="${node.id}"
NODE_TOKEN="${node.token}"
WG_IP="${node.wgIP || '10.0.1.x/24'}"
WG_PORT="${node.wgPort || 51820}"
AGENT_PORT="51821"
echo "▶ 安装 WireGuard..."
apt-get update -qq && apt-get install -y wireguard wireguard-tools curl nodejs 2>/dev/null || yum install -y wireguard-tools curl nodejs
WG_PRIVATE=$(wg genkey)
WG_PUBLIC=$(echo "$WG_PRIVATE" | wg pubkey)
ETH=$(ip route show default | awk '/default/ {print $5}' | head -1)
cat > /etc/wireguard/wg0.conf << EOF
[Interface]
PrivateKey = $WG_PRIVATE
Address = $WG_IP
ListenPort = $WG_PORT
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o $ETH -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o $ETH -j MASQUERADE
EOF
chmod 600 /etc/wireguard/wg0.conf
echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf && sysctl -p -q
# ★ Bug#5修复：开放WG UDP端口 + Agent TCP端口
echo "▶ 配置防火墙规则..."
iptables -I INPUT -p udp --dport $WG_PORT -j ACCEPT 2>/dev/null || true
iptables -I INPUT -p tcp --dport $AGENT_PORT -j ACCEPT 2>/dev/null || true
# ufw（Ubuntu）
if command -v ufw &>/dev/null; then
  ufw allow $WG_PORT/udp 2>/dev/null || true
  ufw allow $AGENT_PORT/tcp 2>/dev/null || true
fi
# firewalld（CentOS/RHEL）
if command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port=$WG_PORT/udp 2>/dev/null || true
  firewall-cmd --permanent --add-port=$AGENT_PORT/tcp 2>/dev/null || true
  firewall-cmd --reload 2>/dev/null || true
fi
# 持久化iptables规则
command -v iptables-save &>/dev/null && iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
systemctl enable wg-quick@wg0 && systemctl restart wg-quick@wg0
curl -sf "http://$MANAGER_IP:${PORT}/agent.js" -o /usr/local/bin/wg-sdwan-agent.js
cat > /etc/wg-sdwan-agent.env << EOF
MANAGER_IP=$MANAGER_IP
MANAGER_PORT=${PORT}
NODE_ID=$NODE_ID
NODE_TOKEN=$NODE_TOKEN
AGENT_PORT=$AGENT_PORT
WG_IFACE=wg0
EOF
chmod 600 /etc/wg-sdwan-agent.env
cat > /etc/systemd/system/wg-sdwan-agent.service << EOF
[Unit]
Description=GJ-SDWAN Agent v2
After=network.target
[Service]
EnvironmentFile=/etc/wg-sdwan-agent.env
ExecStart=/usr/bin/node /usr/local/bin/wg-sdwan-agent.js
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable wg-sdwan-agent && systemctl start wg-sdwan-agent
sleep 3
curl -s -X POST "http://$MANAGER_IP:${PORT}/api/node-register" -H "Content-Type: application/json" -H "X-Node-Token: $NODE_TOKEN" -d "{\\"nodeId\\":\\"$NODE_ID\\",\\"publicKey\\":\\"$WG_PUBLIC\\",\\"agentPort\\":$AGENT_PORT}"
echo "✅ 节点安装完成！"`;
}

function generateClientConfig(client, hub, mode = 'global') {
  const endpoint  = hub ? `${hub.ip}:${hub.wgPort || 51820}` : 'HUB_IP:51820';
  const pubKey    = hub?.publicKey || 'HUB_PUBLIC_KEY';
  const dns       = client.dns || '1.1.1.1, 8.8.8.8';

  // AllowedIPs 按模式生成
  // global  = 全部流量走隧道（原有行为）
  // split   = 仅海外IP走隧道（国内直连），适合移动端
  // custom  = 使用 client.allowedIPs 自定义
  let allowedIPs;
  if (mode === 'global') {
    allowedIPs = '0.0.0.0/0, ::/0'; // 全局代理，所有流量走隧道
  } else if (mode === 'split') {
    // ★ 修复：使用 0.0.0.0/1 + 128.0.0.0/1 覆盖全部IPv4
    // WireGuard 最长前缀匹配原则：
    //   - 国内IP段由系统默认路由（直连）处理
    //   - 0.0.0.0/1 和 128.0.0.0/1 覆盖所有其他流量走隧道
    //   - 比 0.0.0.0/0 精确度低一位，不会覆盖系统默认路由
    // 优点：条目极少，二维码完全够用，谷歌/YouTube全部走隧道
    allowedIPs = [
      '0.0.0.0/1',      // 0.0.0.0 - 127.255.255.255 走隧道
      '128.0.0.0/1',    // 128.0.0.0 - 255.255.255.255 走隧道
      '::/1',           // IPv6 前半段走隧道
      '8000::/1',       // IPv6 后半段走隧道
    ].join(', ');
    // 注意：手机系统的国内直连路由（10.x、172.x、192.168.x等局域网）
    // 优先级高于上面的条目，局域网流量不会进入隧道
  } else if (mode === 'custom' && client.allowedIPs) {
    allowedIPs = client.allowedIPs;
  } else {
    allowedIPs = '0.0.0.0/0, ::/0';
  }

  const modeComment = {
    global: '# 模式：全局代理（所有流量走隧道）',
    split:  '# 模式：智能分流（国内直连，海外走隧道）',
    custom: '# 模式：自定义',
  }[mode] || '';

  return `[Interface]
PrivateKey = ${client.privateKey}
Address = ${client.assignedIP}
DNS = ${dns}
${modeComment}

[Peer]
# HUB 中心节点
PublicKey = ${pubKey}
Endpoint = ${endpoint}
AllowedIPs = ${allowedIPs}
PersistentKeepalive = 25
`;
}


// ─── IEPL 专线配置/脚本生成 ────────────────────────────────────────────────────

function isIEPLComplete(node) {
  // 判断配置是否完整（对端信息已填写）
  if (!node.peerPrivateIP && !node.peerPublicIP) return false;
  if (node.role === 'hk' && !node.peerPublicKey) return false;
  return true;
}

function generateIEPLWgConf(node) {
  const isHK       = node.role === 'hk';
  const isDomestic = node.role === 'domestic';

  // 确定本机地址
  const myAddr  = node.wgIP || (isHK ? '10.0.1.x/24' : '10.0.0.x/24');

  // IEPL段：国内→香港 用 IEPL内网IP 做Endpoint（不走公网）
  const peerEndpoint = node.peerPrivateIP
    ? `${node.peerPrivateIP}:${node.wgPort || 51820}`
    : `${node.peerPublicIP || 'PEER_IP'}:${node.wgPort || 51820}`;

  let conf = `[Interface]
PrivateKey = ${node.privateKey || '<私钥将在安装脚本中自动写入>'}
Address = ${myAddr}
ListenPort = ${node.wgPort || 51820}
`;

  if (isDomestic) {
    // 国内端（HUB）：转发流量到香港，路由到IEPL内网
    const peerWgIP = node.peerWgIP || '10.0.1.x/32';
    conf += `PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE; ip route add ${peerWgIP.split('/')[0]}/32 via ${node.peerPrivateIP || 'PEER_IEPL_IP'}
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE; ip route del ${peerWgIP.split('/')[0]}/32 via ${node.peerPrivateIP || 'PEER_IEPL_IP'}

# 香港POP（通过IEPL内网互联，不走公网）
[Peer]
PublicKey = ${node.peerPublicKey || '# 待填写：香港POP公钥'}
# AllowedIPs：香港WG隧道IP + 客户端网段 + 落地VPS网段
AllowedIPs = ${node.peerWgIP || '10.0.1.0/24'}, 10.8.0.0/24
# ★ 关键：使用IEPL内网IP，延迟极低，不走公网
Endpoint = ${peerEndpoint}
PersistentKeepalive = 25
`;
  } else if (isHK) {
    // 香港端（POP）：承接国内流量，转发到落地VPS
    const domesticWgIP = node.peerWgIP || '10.0.0.0/24';
    conf += `PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

# 国内HUB（IEPL内网连接）
[Peer]
PublicKey = ${node.peerPublicKey || '# 待填写：国内HUB公钥'}
AllowedIPs = ${domesticWgIP}, 10.8.0.0/24
# ★ IEPL段：用对端IEPL内网IP
Endpoint = ${peerEndpoint}
PersistentKeepalive = 25
`;
    // 如果配置了落地VPS
    if (node.landPubkey || node.landEndpoint) {
      conf += `
# 落地VPS（公网WireGuard）
[Peer]
PublicKey = ${node.landPubkey || '# 待填写：落地VPS公钥'}
AllowedIPs = ${node.landWgIP || '10.0.2.1/32'}
Endpoint = ${node.landEndpoint || '落地VPS公网IP:51820'}
PersistentKeepalive = 25
`;
    }
  }

  return conf;
}

function generateIEPLInstallScript(node) {
  const isHK       = node.role === 'hk';
  const isDomestic = node.role === 'domestic';
  const roleLabel  = isDomestic ? `国内HUB-${node.ieplGroup}` : `香港POP-${node.ieplGroup}`;
  const myAddr     = node.wgIP || (isHK ? '10.0.1.x/24' : '10.0.0.x/24');
  const wgConf     = generateIEPLWgConf(node);
  const managerIP  = 'MANAGER_IP'; // 安装时替换

  return `#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# GJ-SDWAN IEPL 专线节点一键安装脚本
# 节点:  ${node.name} (${roleLabel})
# 公网:  ${node.publicIP}
# 内网:  ${node.privateIP || '(未配置)'}
# WG地址: ${myAddr}
# 生成时间: ${new Date().toISOString()}
# ═══════════════════════════════════════════════════════════════════
set -e
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  GJ-SDWAN IEPL 专线节点安装 - ${roleLabel.padEnd(20)}║"
echo "╚══════════════════════════════════════════════════════╝"

[ "$(id -u)" = "0" ] || { echo "❌ 需要 root 权限"; exit 1; }

MANAGER_IP="${managerIP}"
MANAGER_PORT="${PORT}"
NODE_ID="${node.id}"
NODE_TOKEN="${node.token}"
WG_IFACE="wg0"
WG_IP="${myAddr}"
WG_PORT="${node.wgPort || 51820}"
AGENT_PORT="51821"

# ── [1/5] 安装依赖 ──────────────────────────────────────────────
echo "▶ [1/5] 安装 WireGuard 及依赖..."
if command -v apt-get &>/dev/null; then
  apt-get update -qq
  apt-get install -y wireguard wireguard-tools iptables iproute2 curl nodejs 2>/dev/null
elif command -v yum &>/dev/null; then
  yum install -y epel-release
  yum install -y wireguard-tools iptables iproute curl nodejs
fi
echo "   ✅ 依赖安装完成"

# ── [2/5] 写入 WireGuard 配置 ───────────────────────────────────
echo "▶ [2/5] 写入 WireGuard 配置..."
mkdir -p /etc/wireguard
chmod 700 /etc/wireguard

# 写入配置（私钥已内嵌）
cat > /etc/wireguard/$WG_IFACE.conf << 'WGEOF'
${wgConf}
WGEOF
chmod 600 /etc/wireguard/$WG_IFACE.conf
echo "   ✅ WireGuard 配置已写入"
echo "   公钥: ${node.publicKey}"

# ── [3/5] 启动 WireGuard ────────────────────────────────────────
echo "▶ [3/5] 启动 WireGuard..."
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf
sysctl -p -q

systemctl enable wg-quick@$WG_IFACE 2>/dev/null
systemctl restart wg-quick@$WG_IFACE && echo "   ✅ WireGuard 已启动" || {
  echo "   ❌ WireGuard 启动失败，查看日志："
  journalctl -u wg-quick@$WG_IFACE -n 20
  exit 1
}

# 验证
sleep 2
wg show $WG_IFACE && echo "   ✅ WireGuard 接口正常" || echo "   ⚠️ 请检查配置"

# ── [4/5] 安装 Agent ────────────────────────────────────────────
echo "▶ [4/5] 安装 GJ-SDWAN Agent..."
curl -sf "http://$MANAGER_IP:$MANAGER_PORT/agent.js" -o /usr/local/bin/wg-sdwan-agent.js 2>/dev/null || true

cat > /etc/wg-sdwan-agent.env << ENVEOF
MANAGER_IP=$MANAGER_IP
MANAGER_PORT=$MANAGER_PORT
NODE_ID=$NODE_ID
NODE_TOKEN=$NODE_TOKEN
AGENT_PORT=$AGENT_PORT
WG_IFACE=$WG_IFACE
HEARTBEAT_PATH=/api/iepl-heartbeat
ENVEOF
chmod 600 /etc/wg-sdwan-agent.env

cat > /etc/systemd/system/wg-sdwan-agent.service << SVCEOF
[Unit]
Description=GJ-SDWAN IEPL Agent - ${node.name}
After=network.target wg-quick@$WG_IFACE.service

[Service]
Type=simple
EnvironmentFile=/etc/wg-sdwan-agent.env
ExecStart=/usr/bin/node /usr/local/bin/wg-sdwan-agent.js
Restart=always
RestartSec=15
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable wg-sdwan-agent
systemctl start wg-sdwan-agent
echo "   ✅ Agent 已启动"

# ── [5/5] 注册到管理中心 ────────────────────────────────────────
echo "▶ [5/5] 向管理中心注册..."
sleep 3
RESULT=$(curl -s -X POST "http://$MANAGER_IP:$MANAGER_PORT/api/iepl-heartbeat" \
  -H "Content-Type: application/json" \
  -H "X-Node-Token: $NODE_TOKEN" \
  -d "{\"nodeId\":\"$NODE_ID\",\"publicKey\":\"${node.publicKey}\"}" 2>/dev/null)
echo "   注册结果: $RESULT"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅ IEPL节点安装完成！                               ║"
echo "╚══════════════════════════════════════════════════════╝"
echo "   节点名称: ${node.name}"
echo "   节点类型: ${roleLabel}"
echo "   公网IP:   ${node.publicIP}"
echo "   IEPL内网: ${node.privateIP || '未配置'}"
echo "   WG地址:   ${myAddr}"
echo "   公钥:     ${node.publicKey}"
echo ""
${isDomestic ? `echo "★ 下一步：在香港POP节点填写此公钥，生成香港POP的安装脚本"` : `echo "★ 下一步：在国内HUB节点填写此公钥完成互联配置"`}
echo ""
echo "验证IEPL连通性："
echo "  wg show wg0"
echo "  ping ${node.peerWgIP ? node.peerWgIP.split('/')[0] : '对端WG IP'}"
`;
}

// ─── 路由匹配 ─────────────────────────────────────────────────────────────────
function matchRoute(method, urlPath) {
  const key = `${method} ${urlPath}`;
  if (API[key]) return { handler: API[key], params: {} };
  for (const pattern of Object.keys(API)) {
    const [pm, pp] = pattern.split(' ');
    if (pm !== method) continue;
    const pParts = pp.split('/'), uParts = urlPath.split('/');
    if (pParts.length !== uParts.length) continue;
    const params = {}; let match = true;
    for (let i = 0; i < pParts.length; i++) {
      if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = uParts[i];
      else if (pParts[i] !== uParts[i]) { match = false; break; }
    }
    if (match) return { handler: API[pattern], params };
  }
  return null;
}

// ─── 静态文件 ─────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, urlPath) {
  const filePath = urlPath === '/' || !urlPath.includes('.') ? path.join(__dirname, 'public', 'index.html') : path.join(__dirname, 'public', urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
        if (e) return send(res, 404, '404 Not Found');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
      });
    } else {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' }); res.end(data);
    }
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url     = new URL(req.url, 'http://localhost');
  const urlPath = url.pathname;
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // 节点注册回调
  if (urlPath === '/api/node-register' && req.method === 'POST') {
    const token = req.headers['x-node-token'] || '';
    const body  = await parseBody(req);
    const nodes = db.get('nodes') || [];
    const idx   = nodes.findIndex(n => n.token === token);
    if (idx < 0) return send(res, 403, { error: 'Invalid token' });
    // ★ Bug#1修复：保存agentToken（关键！之前没保存导致后续所有推送都403）
    //   token本身作为agentToken使用，Agent用同一个token同时验证到manager和接收manager推送
    nodes[idx] = {
      ...nodes[idx],
      publicKey:  body.publicKey || nodes[idx].publicKey,
      agentPort:  body.agentPort || 51821,
      agentToken: nodes[idx].token,  // ★ 关键修复
      online:     true,
      everOnline: true,
      lastCheck:  new Date().toISOString(),
    };
    db.set('nodes', nodes);
    const newNodeId = nodes[idx].id;  // ★ Bug#2修复：用id定位而非idx
    addAlert('info', `节点上线: ${nodes[idx].name}`, `${nodes[idx].ip} 已注册`);
    // Mesh 组网（异步推送给所有已在线节点）
    setImmediate(async () => {
      const freshNodes = db.get('nodes') || [];
      const newNode    = freshNodes.find(n => n.id === newNodeId);
      if (!newNode || !newNode.publicKey || !newNode.wgIP) return;
      const newWgIP = newNode.wgIP.split('/')[0] + '/32';
      console.log(`[Mesh] 开始为节点 ${newNode.name} 推送 peer 配置...`);
      let successCount = 0, failCount = 0;
      for (const other of freshNodes) {
        if (other.id === newNode.id) continue;
        if (!other.agentToken || !other.online || !other.publicKey || !other.wgIP) continue;
        const otherWgIP = other.wgIP.split('/')[0] + '/32';
        // 把新节点推给其他节点
        const r1 = await agentRequest('POST', other.ip, other.agentPort || 51821, other.agentToken, '/peer/add', {
          publicKey: newNode.publicKey, allowedIPs: newWgIP,
          endpoint: `${newNode.ip}:${newNode.wgPort || 51820}`,
        });
        // 把其他节点推给新节点（★ Bug#3修复：用修复后的agentToken）
        const r2 = await agentRequest('POST', newNode.ip, newNode.agentPort || 51821, newNode.agentToken, '/peer/add', {
          publicKey: other.publicKey, allowedIPs: otherWgIP,
          endpoint: `${other.ip}:${other.wgPort || 51820}`,
        });
        if (r1.ok) successCount++; else { failCount++; console.log(`[Mesh] ❌ ${newNode.name}→${other.name}:`, r1.error || r1.body); }
        if (r2.ok) successCount++; else { failCount++; console.log(`[Mesh] ❌ ${other.name}→${newNode.name}:`, r2.error || r2.body); }
      }
      console.log(`[Mesh] 推送完成：成功 ${successCount}，失败 ${failCount}`);
      if (failCount > 0) {
        addAlert('warning', `节点 ${newNode.name} 组网部分失败`, `${failCount} 个 Peer 推送失败，请检查 Agent 端口 51821 是否开放`);
      }
    });
    return send(res, 200, { ok: true, nodeId: newNode.id, agentToken: nodes[idx].token });
  }

  // Agent 下载
  if (urlPath === '/agent.js') {
    const p = path.join(__dirname, 'agent.js');
    if (fs.existsSync(p)) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(fs.readFileSync(p)); }
    return send(res, 404, '# not found\n');
  }

  if (urlPath.startsWith('/api/')) {
    const m = matchRoute(req.method, urlPath);
    if (!m) return send(res, 404, { error: 'API not found' });
    try { await m.handler(req, res, m.params); }
    catch (e) { console.error(e); send(res, 500, { error: 'Internal server error' }); }
  } else {
    serveStatic(req, res, urlPath);
  }
});

// ─── 启动 ─────────────────────────────────────────────────────────────────────
process.on('SIGTERM', () => { sch.stopAll(); db.shutdown(); process.exit(0); });
process.on('SIGINT',  () => { sch.stopAll(); db.shutdown(); process.exit(0); });

initDB();
startScheduler();

server.listen(PORT, () => {
  console.log(`\n🚀 GJ-SDWAN 管理控制台 v2.2`);
  console.log(`   地址:      http://localhost:${PORT}`);
  console.log(`   默认账号:  admin / admin123`);
  console.log(`   数据目录:  ${DATA_DIR}`);
  console.log(`   ★ 智能选路:     已启用`);
  console.log(`   ★ SSE实时推送:  已启用`);
  console.log(`   ★ IEPL专线:     已启用`);
  console.log(`   ★ QUIC/BBR加速: 已启用`);
  console.log(`   ★ HUB双活HA:    已启用`);
  console.log(`   ★ 多路径冗余:   已启用`);
  console.log(`   ★ 组网诊断:     已启用\n`);
});
