declare module 'cloudflare:sockets' {
  interface SocketInfo {
    remoteAddress: string | null;
    localAddress: string | null;
  }
  interface Socket {
    readonly opened: Promise<SocketInfo>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
  }
  export function connect(
    address: { hostname: string; port: number },
    options?: { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean },
  ): Socket;
}
