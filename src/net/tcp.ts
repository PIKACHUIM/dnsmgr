export type TcpConnect = (hostname: string, port: number) => Promise<void>;

let connectImpl: TcpConnect | null = null;

/** 平台入口在启动时注册 TCP 连接实现；未注册表示当前运行时不支持 TCP 探测。 */
export function setTcpConnect(impl: TcpConnect | null): void {
  connectImpl = impl;
}

export function tcpProbeAvailable(): boolean {
  return connectImpl !== null;
}

export async function tcpConnect(hostname: string, port: number): Promise<void> {
  if (!connectImpl) throw new Error('当前运行时不支持 TCP 探测');
  await connectImpl(hostname, port);
}
