/** Vitest 别名：Workers 的 cloudflare:sockets 在 Node 测试环境中不存在。 */
export function connect(): never {
  throw new Error('cloudflare:sockets is unavailable in tests');
}
