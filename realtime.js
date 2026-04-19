/**
 * realtime.js - 实时数据推送
 * 替代 socket.io，使用 SSE（Server-Sent Events）
 * 纯 Node.js 实现，浏览器原生支持，无需客户端库
 * 特性：
 *  - 自动重连
 *  - 多频道（质量数据、告警、节点状态）
 *  - 心跳保活
 */

class SSEServer {
  constructor() {
    this._clients = new Map(); // clientId -> { res, channels }
    this._nextId  = 1;
    // 每30秒发心跳，防止连接超时
    this._heartbeat = setInterval(() => this._ping(), 30000);
  }

  /**
   * 处理 SSE 连接请求
   * 在路由里: if (urlPath === '/api/sse') sseServer.connect(req, res);
   */
  connect(req, res) {
    const url      = new URL(req.url, 'http://localhost');
    const channels = (url.searchParams.get('channels') || 'all').split(',');
    const clientId = this._nextId++;

    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲
    });

    // 发送初始连接确认
    this._sendTo(res, 'connected', { clientId, channels });

    this._clients.set(clientId, { res, channels });
    console.log(`[SSE] 客户端 #${clientId} 已连接，频道: ${channels.join(',')}`);

    req.on('close', () => {
      this._clients.delete(clientId);
      console.log(`[SSE] 客户端 #${clientId} 已断开`);
    });

    return clientId;
  }

  /**
   * 向指定频道广播事件
   * @param {string} channel  频道名 (quality|alerts|nodes|routes)
   * @param {string} event    事件名
   * @param {*}      data     数据
   */
  broadcast(channel, event, data) {
    const dead = [];
    this._clients.forEach((client, id) => {
      const inChannel = client.channels.includes('all') || client.channels.includes(channel);
      if (!inChannel) return;
      try {
        this._sendTo(client.res, event, data);
      } catch {
        dead.push(id);
      }
    });
    dead.forEach(id => this._clients.delete(id));
  }

  _sendTo(res, event, data) {
    const payload = JSON.stringify(data);
    res.write(`event: ${event}\ndata: ${payload}\n\n`);
  }

  _ping() {
    const dead = [];
    this._clients.forEach((client, id) => {
      try {
        client.res.write(': ping\n\n');
      } catch {
        dead.push(id);
      }
    });
    dead.forEach(id => this._clients.delete(id));
  }

  clientCount() {
    return this._clients.size;
  }

  destroy() {
    clearInterval(this._heartbeat);
    this._clients.forEach(c => { try { c.res.end(); } catch {} });
    this._clients.clear();
  }
}

module.exports = SSEServer;
