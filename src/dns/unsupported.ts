import { DnsError } from './types';

/** 平台确实没有该能力时必须显式失败；静默成功会让用户以为改动已生效。 */
export function unsupported(operation: string): never {
  throw new DnsError(`该服务商不支持${operation}`, 501, 'DNS_OPERATION_UNSUPPORTED');
}
