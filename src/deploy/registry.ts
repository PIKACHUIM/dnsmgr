import { DEPLOY_META } from './metadata';
import type { DeployProvider, DeployProviderMeta } from './types';
import { amh } from './providers/amh';
import { lucky } from './providers/lucky';
import { safeline } from './providers/safeline';
import { samwaf } from './providers/samwaf';
import { ucloud } from './providers/ucloud';
import { uusec } from './providers/uusec';
import { xp } from './providers/xp';
import { axisnow } from './providers/axisnow';
import { doge } from './providers/doge';
import { lecdn } from './providers/lecdn';
import { mwpanel } from './providers/mwpanel';
import { west } from './providers/west';
import { aws } from './providers/aws';
import { btwaf } from './providers/btwaf';
import { cdnfly } from './providers/cdnfly';
import { goedge } from './providers/goedge';
import { qiniu } from './providers/qiniu';
import { upyun } from './providers/upyun';
import { acepanel } from './providers/acepanel';
import { baidu } from './providers/baidu';
import { huawei } from './providers/huawei';
import { kangleadmin } from './providers/kangleadmin';
import { ratpanel } from './providers/ratpanel';
import { synology } from './providers/synology';
import { btwin } from './providers/btwin';
import { kangle } from './providers/kangle';
import { opanel } from './providers/opanel';
import { s3storage } from './providers/s3storage';
import { btpanel } from './providers/btpanel';
import { baishan } from './providers/baishan';
import { cachefly } from './providers/cachefly';
import { gcore } from './providers/gcore';
import { ksyun } from './providers/ksyun';
import { kuocai } from './providers/kuocai';
import { proxmox } from './providers/proxmox';
import { rainyun } from './providers/rainyun';
import { tencent } from './providers/tencent';
import { aliyun } from './providers/aliyun';
import { cloudpanel } from './providers/cloudpanel';
import { ctyun } from './providers/ctyun';
import { directadmin } from './providers/directadmin';
import { huoshan } from './providers/huoshan';
import { k8s } from './providers/k8s';
import { nginxproxymanager } from './providers/nginxproxymanager';
import { qzyun } from './providers/qzyun';
import { unicloud } from './providers/unicloud';
import { wangsu } from './providers/wangsu';

export const WEBHOOK_DEPLOY_TYPE = 'webhook';
export const EXECUTOR_DEPLOY_TYPE = 'executor';

const builtinMeta: DeployProviderMeta[] = [
  {
    type: WEBHOOK_DEPLOY_TYPE,
    name: 'Webhook（推送证书）',
    category: 'panel',
    description: '把完整证书链与私钥以 JSON POST 到 HTTPS 地址。',
    fields: [
      { key: 'url', label: 'Webhook 地址', required: true, placeholder: 'https://deploy.example/hook', maxLength: 2000 },
      { key: 'token', label: 'Bearer Token（选填）', type: 'password', secret: true, maxLength: 500 },
      { key: 'headers', label: '附加请求头 JSON（选填）', maxLength: 2000, placeholder: '{"X-Source":"dnsmgr"}' },
    ],
    taskFields: [],
  },
  {
    type: EXECUTOR_DEPLOY_TYPE,
    name: '执行器（轮询领取）',
    category: 'panel',
    description: '把证书交给轮询式执行器，由执行器负责落盘与重载服务。',
    fields: [
      { key: 'label', label: '执行器标签（选填）', maxLength: 100, placeholder: 'node-1' },
      { key: 'path', label: '证书路径（选填）', maxLength: 500, placeholder: '/etc/ssl/dnsmgr' },
      { key: 'command', label: '部署后命令（选填）', maxLength: 500, placeholder: 'systemctl reload nginx' },
    ],
    taskFields: [],
  },
];

const providers: DeployProvider[] = [
  acepanel, aliyun, amh, aws, axisnow, baidu, baishan, btpanel, btwaf, btwin, cachefly, cdnfly,
  cloudpanel, ctyun, directadmin, doge, gcore, goedge, huoshan, huawei, k8s, kangle, kangleadmin,
  ksyun, kuocai, lecdn, lucky, mwpanel, nginxproxymanager, opanel, proxmox, qiniu, qzyun, rainyun,
  ratpanel, s3storage, safeline, samwaf, synology, tencent, ucloud, unicloud, upyun, uusec, wangsu,
  west, xp,
];

const byType = new Map(providers.map((provider) => [provider.meta.type, provider]));

export function deployBuiltinMeta(): DeployProviderMeta[] {
  return builtinMeta;
}

export function deployCatalog(): DeployProviderMeta[] {
  return [...builtinMeta, ...providers.map((provider) => provider.meta)];
}

export function deployProviderMeta(type: string): DeployProviderMeta | undefined {
  return deployCatalog().find((meta) => meta.type === type);
}

export function deployProvider(type: string): DeployProvider | undefined {
  return byType.get(type);
}

export function isBuiltinDeployType(type: string): boolean {
  return type === WEBHOOK_DEPLOY_TYPE || type === EXECUTOR_DEPLOY_TYPE;
}

export { DEPLOY_META };
