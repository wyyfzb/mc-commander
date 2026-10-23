/**
 * 单端口双协议监听：同一端口同时接受明文 HTTP 与 TLS。
 *
 * 分流依据是 TLS 记录层首字节：握手记录固定以 0x16 开头，而明文 HTTP 方法名
 * （0x47 等）与 HTTP/2 前导（0x50）都不可能是 0x16，故读一个字节即可判定，
 * 无需等完整 ClientHello。
 */
import net from 'node:net';

const TLS_HANDSHAKE = 0x16;

/**
 * 创建分流监听器（尚未 listen）。两个回调各自把 socket 交给对应服务器的
 * connection 事件。
 *
 * @param {(socket: net.Socket) => void} onPlain
 * @param {(socket: net.Socket) => void} onTls
 * @returns {net.Server}
 */
export function createProtocolMux(onPlain, onTls) {
  return net.createServer((socket) => {
    // 单块可能为空（对端尚未发送），此时等下一块
    const onData = (chunk) => {
      if (chunk.length === 0) return;
      socket.pause();
      socket.removeListener('data', onData);
      // unshift 把已读字节放回：丢掉它明文请求会缺方法名、TLS 握手会缺记录头
      socket.unshift(chunk);
      (chunk[0] === TLS_HANDSHAKE ? onTls : onPlain)(socket);
      process.nextTick(() => socket.resume());
    };
    socket.on('data', onData);
    // 分流前就断开（端口扫描、就绪探测）：吞掉错误，否则 ECONNRESET 会冒泡成
    // 进程级 uncaughtException
    socket.on('error', () => socket.destroy());
  });
}
