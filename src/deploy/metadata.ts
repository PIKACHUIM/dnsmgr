import type { DeployProviderMeta } from './types';

/**
 * 部署驱动的字段定义，逐项对应 PHP \app\lib\DeployHelper::$deploy_config。
 * 该文件由配置生成后固定维护：改字段时同步修改驱动实现与 tests/deploy-drivers.test.ts。
 * 不含 ssh / ftp / local / fnos（需要远程 shell 或落盘，只能走执行器）。
 */
export const DEPLOY_META: Record<string, DeployProviderMeta> = {
  btpanel: {
    type: 'btpanel',
    name: '宝塔面板',
    category: 'panel',
    description: '支持部署到宝塔Linux面板&aaPanel搭建的站点',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: '宝塔面板地址',
        note: '填写规则如：http://192.168.1.100:8888 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'key',
        label: '接口密钥',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '宝塔面板设置->面板设置->API接口',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'type',
        label: '部署类型',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '网站的证书',
          },
          {
            value: '1',
            label: '面板本身的证书',
          },
          {
            value: '2',
            label: '邮局域名的证书',
          },
          {
            value: '3',
            label: 'Docker网站的证书',
          },
          {
            value: '4',
            label: '反向代理的证书',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'sites',
        label: '网站名称列表',
        type: 'textarea',
        required: true,
        placeholder: '填写要部署证书的网站名称，每行一个',
        note: 'PHP项目和反代项目填写创建时绑定的第一个域名，Java/Node/Go等其他项目填写项目名称，邮局和IIS站点填写绑定的域名',
        maxLength: 4000,
        showWhen: {
          key: 'type',
          in: [
            '0',
            '2',
            '3',
            '4',
          ],
        },
      },
    ],
  },
  btwin: {
    type: 'btwin',
    name: '宝塔Win极速版',
    category: 'panel',
    description: '支持部署到宝塔Windows面板极速版',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: '宝塔面板地址',
        note: '填写规则如：http://192.168.1.100:8888 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'key',
        label: '接口密钥',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '宝塔面板设置->面板设置->API接口',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'type',
        label: '部署类型',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '网站的证书',
          },
          {
            value: '1',
            label: '面板本身的证书',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'sites',
        label: '网站名称列表',
        type: 'textarea',
        required: true,
        placeholder: '填写要部署证书的网站名称，每行一个',
        maxLength: 4000,
        showWhen: {
          key: 'type',
          in: [
            '0',
          ],
        },
      },
      {
        key: 'is_iis',
        label: '是否IIS站点',
        type: 'radio',
        options: [
          {
            value: '0',
            label: '否',
          },
          {
            value: '1',
            label: '是',
          },
        ],
        defaultValue: '0',
        showWhen: {
          key: 'type',
          in: [
            '0',
          ],
        },
      },
    ],
  },
  kangle: {
    type: 'kangle',
    name: 'Kangle用户',
    category: 'panel',
    description: '支持虚拟主机与CDN站点',
    note: '以上登录信息为Easypanel用户面板的，非管理员面板。如选网站密码认证类型，则用户面板登录不能开启验证码。',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: 'Easypanel面板地址',
        note: '填写规则如：http://192.168.1.100:3312 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'auth',
        label: '认证方式',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '网站密码',
          },
          {
            value: '1',
            label: '面板安全码',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'username',
        label: '网站用户名',
        required: true,
        maxLength: 500,
      },
      {
        key: 'password',
        label: '网站密码',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
        showWhen: {
          key: 'auth',
          in: [
            '0',
          ],
        },
      },
      {
        key: 'skey',
        label: '面板安全码',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '管理员面板->服务器设置->面板通信安全码',
        maxLength: 500,
        showWhen: {
          key: 'auth',
          in: [
            '1',
          ],
        },
      },
    ],
    taskFields: [
      {
        key: 'type',
        label: '部署类型',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '网站SSL证书',
          },
          {
            value: '1',
            label: '单域名SSL证书',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'domains',
        label: '域名列表',
        type: 'textarea',
        required: true,
        placeholder: '填写要部署证书的域名，每行一个',
        maxLength: 4000,
        showWhen: {
          key: 'type',
          in: [
            '1',
          ],
        },
      },
    ],
  },
  kangleadmin: {
    type: 'kangleadmin',
    name: 'Kangle管理员',
    category: 'panel',
    description: '支持虚拟主机与CDN站点',
    note: '以上登录信息为Easypanel管理员面板的，非用户面板。',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: 'Easypanel面板地址',
        note: '填写规则如：http://192.168.1.100:3312 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'path',
        label: '管理员面板路径',
        placeholder: '留空默认为/admin',
        maxLength: 500,
      },
      {
        key: 'username',
        label: '管理员用户名',
        required: true,
        maxLength: 500,
      },
      {
        key: 'skey',
        label: '面板安全码',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '管理员面板->服务器设置->面板通信安全码',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'target',
        label: '部署对象',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '网站',
          },
          {
            value: '1',
            label: 'EasyPanel面板',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'name',
        label: '网站用户名',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'target',
          in: [
            '0',
          ],
        },
      },
      {
        key: 'type',
        label: '部署类型',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '网站SSL证书',
          },
          {
            value: '1',
            label: '单域名SSL证书',
          },
        ],
        defaultValue: '0',
        showWhen: {
          key: 'target',
          in: [
            '0',
          ],
        },
      },
      {
        key: 'domains',
        label: '域名列表',
        type: 'textarea',
        required: true,
        placeholder: '填写要部署证书的域名，每行一个',
        maxLength: 4000,
        showWhen: {
          key: 'type',
          in: [
            '1',
          ],
        },
      },
    ],
  },
  safeline: {
    type: 'safeline',
    name: '雷池WAF',
    category: 'panel',
    taskNote: '系统会根据关联SSL证书的域名，自动更新对应证书',
    fields: [
      {
        key: 'url',
        label: '控制台地址',
        required: true,
        placeholder: '雷池WAF控制台地址',
        note: '填写规则如：https://192.168.1.100:9443 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'token',
        label: 'API Token',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [],
  },
  btwaf: {
    type: 'btwaf',
    name: '堡塔云WAF',
    category: 'panel',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: '堡塔云WAF面板地址',
        note: '填写规则如：http://192.168.1.100:8379 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'key',
        label: '接口密钥',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '面板设置->API接口',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'type',
        label: '部署类型',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '网站的证书',
          },
          {
            value: '1',
            label: '面板本身的证书',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'sites',
        label: '网站名称列表',
        type: 'textarea',
        required: true,
        placeholder: '填写要部署证书的网站名称，每行一个',
        maxLength: 4000,
        showWhen: {
          key: 'type',
          in: [
            '0',
          ],
        },
      },
    ],
  },
  cdnfly: {
    type: 'cdnfly',
    name: 'Cdnfly',
    category: 'panel',
    note: '登录Cdnfly控制台->账户中心->API密钥，点击开启后获取',
    fields: [
      {
        key: 'url',
        label: '控制台地址',
        required: true,
        placeholder: 'Cdnfly控制台地址',
        note: '填写示例：http://demo.cdnfly.cn',
        maxLength: 500,
      },
      {
        key: 'auth',
        label: '认证方式',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '接口密钥',
          },
          {
            value: '1',
            label: '模拟登录',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'api_key',
        label: 'api_key',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
        showWhen: {
          key: 'auth',
          in: [
            '0',
          ],
        },
      },
      {
        key: 'api_secret',
        label: 'api_secret',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
        showWhen: {
          key: 'auth',
          in: [
            '0',
          ],
        },
      },
      {
        key: 'username',
        label: '登录账号',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'auth',
          in: [
            '1',
          ],
        },
      },
      {
        key: 'password',
        label: '登录密码',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
        showWhen: {
          key: 'auth',
          in: [
            '1',
          ],
        },
      },
    ],
    taskFields: [
      {
        key: 'id',
        label: '证书ID',
        placeholder: '留空则为添加证书',
        note: '在网站管理->证书管理查看证书的ID，注意域名是否与证书匹配',
        maxLength: 500,
      },
    ],
  },
  lecdn: {
    type: 'lecdn',
    name: 'LeCDN',
    category: 'panel',
    fields: [
      {
        key: 'url',
        label: '控制台地址',
        required: true,
        placeholder: 'LeCDN控制台地址',
        note: '填写示例：http://demo.xxxx.cn',
        maxLength: 500,
      },
      {
        key: 'auth',
        label: '认证方式',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '账号密码(旧版)',
          },
          {
            value: '1',
            label: 'API访问令牌',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'api_key',
        label: 'API访问令牌',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
        showWhen: {
          key: 'auth',
          in: [
            '1',
          ],
        },
      },
      {
        key: 'email',
        label: '邮箱地址',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'auth',
          in: [
            '0',
          ],
        },
      },
      {
        key: 'password',
        label: '密码',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
        showWhen: {
          key: 'auth',
          in: [
            '0',
          ],
        },
      },
    ],
    taskFields: [
      {
        key: 'id',
        label: '证书ID',
        placeholder: '留空则为添加证书',
        note: '在站点->证书管理查看证书的ID，注意域名是否与证书匹配',
        maxLength: 500,
      },
    ],
  },
  goedge: {
    type: 'goedge',
    name: 'GoEdge',
    category: 'panel',
    description: '支持GoEdge与FlexCDN',
    note: '需要先<a href="https://goedge.cloud/docs/API/Settings.md" target="_blank" rel="noreferrer">开启HTTP API端口</a>',
    taskNote: '系统会根据关联SSL证书的域名，自动更新对应证书',
    fields: [
      {
        key: 'url',
        label: 'HTTP API地址',
        required: true,
        placeholder: 'HTTP API地址',
        note: 'http://你的IP:端口',
        maxLength: 500,
      },
      {
        key: 'accessKeyId',
        label: 'AccessKey ID',
        required: true,
        maxLength: 500,
      },
      {
        key: 'accessKey',
        label: 'AccessKey密钥',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
      {
        key: 'usertype',
        label: '用户类型',
        type: 'radio',
        required: true,
        options: [
          {
            value: 'user',
            label: '平台用户',
          },
          {
            value: 'admin',
            label: '系统用户',
          },
        ],
        defaultValue: 'user',
      },
      {
        key: 'systype',
        label: '系统类型',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: 'GoEdge',
          },
          {
            value: '1',
            label: 'FlexCDN',
          },
        ],
        defaultValue: '0',
      },
    ],
    taskFields: [],
  },
  uusec: {
    type: 'uusec',
    name: '南墙WAF',
    category: 'panel',
    fields: [
      {
        key: 'url',
        label: '控制台地址',
        required: true,
        placeholder: '南墙WAF控制台地址',
        note: '填写规则如：http://192.168.1.100:4443 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'username',
        label: '用户名',
        required: true,
        maxLength: 500,
      },
      {
        key: 'password',
        label: '密码',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'id',
        label: '证书ID',
        required: true,
        note: '在证书管理查看证书的ID，注意域名是否与证书匹配',
        maxLength: 500,
      },
      {
        key: 'name',
        label: '证书名称',
        required: true,
        note: '在证书管理查看证书的名称',
        maxLength: 500,
      },
    ],
  },
  samwaf: {
    type: 'samwaf',
    name: 'SamWaf',
    category: 'panel',
    description: '支持部署到SamWaf证书夹',
    note: '登录SamWaf控制台->开放平台->密钥管理，创建后获取API Key。需先在系统配置中开启开放平台。',
    fields: [
      {
        key: 'url',
        label: '控制台地址',
        required: true,
        placeholder: 'SamWaf控制台地址',
        note: '填写示例：http://192.168.1.100:26666 ，不要带其他后缀。若启用了安全访问路径，则填写 http://IP:端口/安全码',
        maxLength: 500,
      },
      {
        key: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        secret: true,
        note: '开放平台密钥，请求头 X-API-Key',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'id',
        label: '证书ID',
        placeholder: '留空则为添加证书',
        note: '在证书夹查看证书的ID，注意域名是否与证书匹配',
        maxLength: 500,
      },
    ],
  },
  opanel: {
    type: 'opanel',
    name: '1Panel',
    category: 'panel',
    description: '更新面板证书管理内的SSL证书',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: '1Panel面板地址',
        note: '填写规则如：http://192.168.1.100:8888 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'key',
        label: '接口密钥',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '1Panel面板设置->API接口',
        maxLength: 500,
      },
      {
        key: 'version',
        label: '1Panel版本',
        type: 'radio',
        required: true,
        options: [
          {
            value: 'v1',
            label: '1.x',
          },
          {
            value: 'v2',
            label: '2.x',
          },
        ],
        defaultValue: 'v2',
      },
    ],
    taskFields: [
      {
        key: 'type',
        label: '部署类型',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '更新已有证书',
          },
          {
            value: '3',
            label: '面板本身的证书',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'id',
        label: '证书ID',
        placeholder: '在证书列表查看ID',
        note: '留空为根据关联SSL证书的域名，自动更新对应证书',
        maxLength: 500,
        showWhen: {
          key: 'type',
          in: [
            '0',
          ],
        },
      },
      {
        key: 'node_name',
        label: '节点名称',
        type: 'textarea',
        placeholder: '每行一个子节点名称',
        note: '不填写时：只更新主节点证书；填写时：同时更新主节点和所有指定的子节点证书。每行填写一个子节点名称',
        maxLength: 4000,
        showWhen: {
          key: 'type',
          in: [
            '0',
          ],
        },
      },
    ],
  },
  mwpanel: {
    type: 'mwpanel',
    name: 'MW面板',
    category: 'panel',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: 'MW面板地址',
        note: '填写规则如：http://192.168.1.100:8888 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'appid',
        label: '应用ID',
        required: true,
        placeholder: 'MW面板设置->API接口',
        maxLength: 500,
      },
      {
        key: 'appsecret',
        label: '应用密钥',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '面板设置->API接口',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'type',
        label: '部署类型',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: 'MW面板站点的证书',
          },
          {
            value: '1',
            label: 'MW面板本身的证书',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'sites',
        label: '网站名称列表',
        type: 'textarea',
        required: true,
        placeholder: '填写要部署证书的网站名称，每行一个',
        note: '网站名称，即为网站创建时绑定的第一个域名',
        maxLength: 4000,
        showWhen: {
          key: 'type',
          in: [
            '0',
          ],
        },
      },
    ],
  },
  acepanel: {
    type: 'acepanel',
    name: 'AcePanel',
    category: 'panel',
    description: '支持 AcePanel 3.0+ 版本使用',
    note: '支持 AcePanel 3.0+ 版本使用',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: 'AcePanel 地址',
        note: '填写规则如：https://192.168.1.100:8888/xxxxxx ，带访问入口但不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'id',
        label: '访问令牌ID',
        required: true,
        placeholder: '1',
        note: 'AcePanel 设置->用户->访问令牌',
        maxLength: 500,
      },
      {
        key: 'token',
        label: '访问令牌',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '32位字符串',
        note: 'AcePanel 设置->用户->访问令牌',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'type',
        label: '部署类型',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: 'AcePanel 网站的证书',
          },
          {
            value: '1',
            label: 'AcePanel 本身的证书',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'sites',
        label: '网站名称列表',
        type: 'textarea',
        required: true,
        placeholder: '填写要部署证书的网站名称，每行一个',
        note: '填写创建网站时设置的网站唯一名称',
        maxLength: 4000,
        showWhen: {
          key: 'type',
          in: [
            '0',
          ],
        },
      },
    ],
  },
  ratpanel: {
    type: 'ratpanel',
    name: '耗子面板',
    category: 'panel',
    description: '支持耗子面板 v2.5+ 版本使用',
    note: '支持耗子面板 v2.5+ 版本使用',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: '耗子面板地址',
        note: '填写规则如：https://192.168.1.100:8888/xxxxxx ，带访问入口但不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'id',
        label: '访问令牌ID',
        required: true,
        placeholder: '1',
        note: '耗子面板设置->用户->访问令牌',
        maxLength: 500,
      },
      {
        key: 'token',
        label: '访问令牌',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '32位字符串',
        note: '耗子面板设置->用户->访问令牌',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'type',
        label: '部署类型',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '耗子面板网站的证书',
          },
          {
            value: '1',
            label: '耗子面板本身的证书',
          },
        ],
        defaultValue: '0',
      },
      {
        key: 'sites',
        label: '网站名称列表',
        type: 'textarea',
        required: true,
        placeholder: '填写要部署证书的网站名称，每行一个',
        note: '填写创建网站时设置的网站唯一名称',
        maxLength: 4000,
        showWhen: {
          key: 'type',
          in: [
            '0',
          ],
        },
      },
    ],
  },
  xp: {
    type: 'xp',
    name: '小皮面板',
    category: 'panel',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: '小皮面板地址',
        note: '填写规则如：http://192.168.1.100:8888 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'apikey',
        label: '接口密钥',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '设置->OpenAPI接口',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'sites',
        label: '网站名称列表',
        type: 'textarea',
        required: true,
        placeholder: '填写要部署证书的网站名称，每行一个',
        note: '网站名称，即为网站创建时绑定的第一个域名',
        maxLength: 4000,
      },
    ],
  },
  amh: {
    type: 'amh',
    name: 'AMH面板',
    category: 'panel',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: 'AMH面板地址',
        note: '填写规则如：http://192.168.1.100:8888 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'apikey',
        label: 'API接口密钥',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '安装amapi软件后查看，是密钥不是私钥',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'env_name',
        label: '环境名称',
        required: true,
        placeholder: '如：lnmp01',
        maxLength: 500,
      },
      {
        key: 'vhost_name',
        label: '网站名称列表',
        type: 'textarea',
        required: true,
        placeholder: '填写要部署证书的网站标识域名，每行一个',
        note: '网站标识域名一列的值，并非绑定域名',
        maxLength: 4000,
      },
    ],
  },
  cloudpanel: {
    type: 'cloudpanel',
    name: 'CloudPanel',
    category: 'panel',
    note: '使用管理员账号密码登录面板。暂不支持已开启双因素认证的账户。',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: 'CloudPanel 面板地址',
        note: '填写规则如：https://192.168.1.100:8443 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'username',
        label: '登录用户名',
        required: true,
        placeholder: '管理员用户名',
        maxLength: 500,
      },
      {
        key: 'password',
        label: '登录密码',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '管理员密码',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'sites',
        label: '网站域名列表',
        type: 'textarea',
        required: true,
        placeholder: '填写要部署证书的网站主域名，每行一个',
        note: '必须与 CloudPanel 站点列表中的主域名一致',
        maxLength: 4000,
      },
    ],
  },
  directadmin: {
    type: 'directadmin',
    name: 'DirectAdmin',
    category: 'panel',
    description: '通过 DirectAdmin 官方 API 自动部署域名 SSL 证书',
    note: '使用 HTTPS 和 HTTP Basic Authentication。认证密码可填写 DirectAdmin 账户密码；如服务商开放 Login Key，也可填写 Login Key。',
    taskNote: '填写 DirectAdmin 中已存在的目标域名。多个域名可用换行或逗号分隔；系统会分别调用 CMD_API_SSL 更新证书。',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: 'https://server.example.com:2222',
        note: '必须使用 HTTPS，不要带 CMD_API_SSL 等路径',
        maxLength: 500,
      },
      {
        key: 'username',
        label: '用户名',
        required: true,
        placeholder: 'DirectAdmin 登录用户名',
        maxLength: 500,
      },
      {
        key: 'password',
        label: '认证密码',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'DirectAdmin 账户密码或 Login Key',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'domain',
        label: 'DirectAdmin 域名',
        type: 'textarea',
        required: true,
        placeholder: "example.com\nsecond.example",
        note: '必须是该 DirectAdmin 账户中已存在的域名；多个域名可换行或用逗号分隔。',
        maxLength: 4000,
      },
    ],
  },
  synology: {
    type: 'synology',
    name: '群晖面板',
    category: 'panel',
    description: '支持群晖DSM 6.x/7.x版本',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: '群晖面板地址',
        note: '填写规则如：http://192.168.1.100:5000 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'username',
        label: '登录账号',
        required: true,
        placeholder: '必须是处于管理员用户组，不能开启双重认证',
        maxLength: 500,
      },
      {
        key: 'password',
        label: '登录密码',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
      {
        key: 'version',
        label: '群晖版本',
        type: 'radio',
        required: true,
        options: [
          {
            value: '0',
            label: '7.x',
          },
          {
            value: '1',
            label: '6.x',
          },
        ],
        defaultValue: '0',
      },
    ],
    taskFields: [
      {
        key: 'desc',
        label: '群晖证书描述',
        note: '根据证书描述匹配替换对应证书，留空则根据证书通用名匹配',
        maxLength: 500,
      },
    ],
  },
  lucky: {
    type: 'lucky',
    name: 'Lucky',
    category: 'panel',
    description: '更新Lucky证书',
    note: '在“设置->开发者设置”打开OpenToken开关',
    taskNote: '系统会根据关联SSL证书的域名，自动更新对应证书',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: 'Lucky 面板地址',
        note: '填写规则如：https://192.168.1.100:16601 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'path',
        label: '安全入口',
        note: '未设置请留空，参考Lucky设置中的安全入口设置',
        maxLength: 500,
      },
      {
        key: 'opentoken',
        label: 'OpenToken',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [],
  },
  nginxproxymanager: {
    type: 'nginxproxymanager',
    name: 'Nginx Proxy Manager',
    category: 'panel',
    description: '更新 Nginx Proxy Manager 的自定义证书并自动绑定 Proxy Host',
    note: '填写 Nginx Proxy Manager 面板地址与登录账号密码，系统将通过官方 API 登录并执行证书更新。',
    taskNote: '如填写证书ID则优先更新该自定义证书；留空时系统会根据当前证书订单的域名在 NPM 中匹配 Proxy Host，并在首次成功后自动保存证书ID，后续续期优先走该ID，不再依赖域名匹配。',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: 'Nginx Proxy Manager 面板地址',
        note: '填写规则如：http://192.168.1.100:81 ，不要带 /api 等后缀',
        maxLength: 500,
      },
      {
        key: 'email',
        label: '登录邮箱',
        required: true,
        placeholder: 'NPM 登录邮箱',
        maxLength: 500,
      },
      {
        key: 'password',
        label: '登录密码',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'NPM 登录密码',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'id',
        label: '证书ID',
        placeholder: '留空则按域名匹配 Proxy Host 并自动回填',
        note: '优先级最高。填写后将直接更新该自定义证书ID；仅支持 NPM 中 provider 为 other 的自定义证书。',
        maxLength: 500,
      },
      {
        key: 'host_id',
        label: 'Proxy Host ID',
        placeholder: '可留空，留空则按域名自动匹配',
        note: '可选。未填写证书ID时，若填写此项则仅处理指定 Proxy Host；若留空则按当前证书订单域名自动查找匹配的 Proxy Host。',
        maxLength: 500,
      },
    ],
  },
  proxmox: {
    type: 'proxmox',
    name: 'Proxmox VE',
    category: 'panel',
    description: '部署到PVE节点',
    note: '在“权限->API令牌”添加令牌，不要选特权分离',
    fields: [
      {
        key: 'url',
        label: '面板地址',
        required: true,
        placeholder: 'Proxmox VE 面板地址',
        note: '填写规则如：https://192.168.1.100:8006 ，不要带其他后缀',
        maxLength: 500,
      },
      {
        key: 'api_user',
        label: 'API令牌ID',
        required: true,
        placeholder: '用户!令牌名称',
        maxLength: 500,
      },
      {
        key: 'api_key',
        label: 'API令牌密钥',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'node',
        label: '节点名称',
        required: true,
        placeholder: '要部署证书的节点',
        maxLength: 500,
      },
    ],
  },
  k8s: {
    type: 'k8s',
    name: 'K8S',
    category: 'panel',
    description: '部署到K8S集群的Secret和Ingress',
    note: '支持部署到K8S集群的Secret和Ingress。必须使用 token 认证的 kubeconfig；当前部署环境无法携带客户端证书，且要求集群 API 使用受信任的 TLS 证书。',
    fields: [
      {
        key: 'name',
        label: '名称',
        required: true,
        placeholder: '仅用于区分',
        maxLength: 500,
      },
      {
        key: 'kubeconfig',
        label: 'kubeconfig',
        type: 'textarea',
        required: true,
        secret: true,
        maxLength: 20000,
      },
    ],
    taskFields: [
      {
        key: 'namespace',
        label: '命名空间',
        required: true,
        defaultValue: 'default',
        maxLength: 500,
      },
      {
        key: 'secret_name',
        label: 'Secret名称',
        required: true,
        placeholder: '如果Secret不存在，则自动创建',
        maxLength: 500,
      },
      {
        key: 'ingresses',
        label: 'Ingress名称',
        placeholder: '多个用英文逗号分隔，可留空，留空则只更新Secret',
        maxLength: 500,
      },
    ],
  },
  aliyun: {
    type: 'aliyun',
    name: '阿里云',
    category: 'cloud',
    description: '支持部署到阿里云CDN、ESA、SLB、OSS、WAF、FC等服务',
    note: '支持部署到阿里云CDN、ESA、SLB、OSS、WAF、FC等服务',
    fields: [
      {
        key: 'AccessKeyId',
        label: 'AccessKeyId',
        required: true,
        maxLength: 500,
      },
      {
        key: 'AccessKeySecret',
        label: 'AccessKeySecret',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'product',
        label: '要部署的产品',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
          {
            value: '2',
            label: '[object Object]',
          },
          {
            value: '3',
            label: '[object Object]',
          },
          {
            value: '4',
            label: '[object Object]',
          },
          {
            value: '5',
            label: '[object Object]',
          },
          {
            value: '6',
            label: '[object Object]',
          },
          {
            value: '7',
            label: '[object Object]',
          },
          {
            value: '8',
            label: '[object Object]',
          },
          {
            value: '9',
            label: '[object Object]',
          },
          {
            value: '10',
            label: '[object Object]',
          },
          {
            value: '11',
            label: '[object Object]',
          },
          {
            value: '12',
            label: '[object Object]',
          },
          {
            value: '13',
            label: '[object Object]',
          },
          {
            value: '14',
            label: '[object Object]',
          },
          {
            value: '15',
            label: '[object Object]',
          },
          {
            value: '16',
            label: '[object Object]',
          },
          {
            value: '17',
            label: '[object Object]',
          },
          {
            value: '18',
            label: '[object Object]',
          },
        ],
        defaultValue: 'cdn',
      },
      {
        key: 'esa_sitename',
        label: 'ESA站点域名',
        required: true,
        placeholder: 'ESA添加的站点主域名',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'esa',
            'esa_saas',
          ],
        },
      },
      {
        key: 'esa_saas_sitename',
        label: 'ESA SAAS站点域名',
        type: 'textarea',
        required: true,
        placeholder: '每行一个域名',
        maxLength: 4000,
        showWhen: {
          key: 'product',
          in: [
            'esa_saas',
          ],
        },
      },
      {
        key: 'oss_endpoint',
        label: 'Endpoint地址',
        required: true,
        placeholder: '填写示例：oss-cn-hangzhou.aliyuncs.com',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'oss',
          ],
        },
      },
      {
        key: 'oss_bucket',
        label: 'Bucket名称',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'oss',
          ],
        },
      },
      {
        key: 'region',
        label: '所属地域',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
        ],
        defaultValue: 'cn-hangzhou',
        showWhen: {
          key: 'product',
          in: [
            'waf',
            'waf2',
            'wafres',
            'ddoscoo',
            'esa',
            'esa_saas',
          ],
        },
      },
      {
        key: 'regionid',
        label: '所属地域ID',
        required: true,
        placeholder: '填写示例：cn-hangzhou',
        defaultValue: 'cn-hangzhou',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'api',
            'clb',
            'alb',
            'nlb',
          ],
        },
      },
      {
        key: 'api_groupid',
        label: 'API分组ID',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'api',
          ],
        },
      },
      {
        key: 'fc_cname',
        label: '域名CNAME地址',
        required: true,
        placeholder: '填写示例：<账号ID>.cn-shanghai.fc.aliyuncs.com',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'fc',
            'fc2',
          ],
        },
      },
      {
        key: 'clb_id',
        label: '负载均衡实例ID',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'clb',
          ],
        },
      },
      {
        key: 'clb_port',
        label: 'HTTPS监听端口',
        required: true,
        defaultValue: '443',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'clb',
          ],
        },
      },
      {
        key: 'alb_listener_id',
        label: '监听ID',
        required: true,
        note: '进入ALB实例详情->监听列表，复制监听ID（只支持HTTPS或QUIC监听协议）',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'alb',
          ],
        },
      },
      {
        key: 'nlb_listener_id',
        label: '监听ID',
        required: true,
        note: '进入NLB实例详情->监听列表，复制监听ID（只支持TCPSSL监听协议）',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'nlb',
          ],
        },
      },
      {
        key: 'ga_id',
        label: '全球加速实例ID',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'ga',
          ],
        },
      },
      {
        key: 'ga_listener_id',
        label: '监听ID',
        required: true,
        note: '进入实例详情->监听列表，复制监听ID（只支持HTTPS监听协议）',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'ga',
          ],
        },
      },
      {
        key: 'waf_resource_id',
        label: '云产品防护对象ID',
        required: true,
        placeholder: '多个ID可用,隔开',
        note: '进入查看防护对象，对象名称一列即为云产品防护对象ID',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'wafres',
          ],
        },
      },
      {
        key: 'deploy_type',
        label: '部署证书类型',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
        ],
        defaultValue: '0',
        showWhen: {
          key: 'product',
          in: [
            'clb',
            'alb',
            'nlb',
            'ga',
            'wafres',
          ],
        },
      },
      {
        key: 'clb_domain',
        label: '扩展域名',
        required: true,
        placeholder: '多个域名可使用,分隔',
        maxLength: 500,
        showWhen: {
          any: [
            {
              all: [
                {
                  key: 'product',
                  in: [
                    'clb',
                  ],
                },
                {
                  key: 'deploy_type',
                  in: [
                    '1',
                  ],
                },
              ],
            },
            {
              all: [
                {
                  key: 'product',
                  in: [
                    'ga',
                  ],
                },
                {
                  key: 'deploy_type',
                  in: [
                    '1',
                  ],
                },
              ],
            },
          ],
        },
      },
      {
        key: 'domain',
        label: '绑定的域名',
        required: true,
        placeholder: '多个域名可用,隔开',
        maxLength: 500,
        showWhen: {
          key: 'product',
          notIn: [
            'esa',
            'esa_saas',
            'clb',
            'alb',
            'nlb',
            'ga',
            'upload',
            'wafres',
          ],
        },
      },
    ],
  },
  tencent: {
    type: 'tencent',
    name: '腾讯云',
    category: 'cloud',
    description: '支持部署到腾讯云CDN、EO、CLB、COS、TKE、SCF等服务',
    note: '支持部署到腾讯云CDN、EO、CLB、COS、TKE、SCF等服务',
    fields: [
      {
        key: 'SecretId',
        label: 'SecretId',
        required: true,
        maxLength: 500,
      },
      {
        key: 'SecretKey',
        label: 'SecretKey',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'product',
        label: '要部署的产品',
        type: 'select',
        required: true,
        options: [
          {
            value: 'cdn',
            label: '内容分发网络CDN',
          },
          {
            value: 'teo',
            label: '边缘安全加速EO',
          },
          {
            value: 'waf',
            label: 'Web应用防火墙WAF',
          },
          {
            value: 'cos',
            label: '对象存储COS',
          },
          {
            value: 'clb',
            label: '负载均衡CLB',
          },
          {
            value: 'tke',
            label: '容器服务TKE',
          },
          {
            value: 'scf',
            label: '云函数SCF',
          },
          {
            value: 'ddos',
            label: 'DDoS防护',
          },
          {
            value: 'live',
            label: '云直播LIVE',
          },
          {
            value: 'vod',
            label: '云点播VOD',
          },
          {
            value: 'tse',
            label: '云原生API网关TSE',
          },
          {
            value: 'tcb',
            label: '云开发TCB',
          },
          {
            value: 'lighthouse',
            label: '轻量应用服务器',
          },
          {
            value: 'upload',
            label: '上传到证书管理',
          },
          {
            value: 'update',
            label: '更新证书内容（证书ID不变）',
          },
          {
            value: 'update_new',
            label: '更新证书内容（生成新的ID）',
          },
        ],
        defaultValue: 'cdn',
      },
      {
        key: 'regionid',
        label: '所属地域ID',
        required: true,
        placeholder: '填写示例：ap-guangzhou',
        defaultValue: '',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'clb',
            'cos',
            'tse',
            'tke',
            'lighthouse',
            'scf',
          ],
        },
      },
      {
        key: 'region',
        label: '所属地域',
        type: 'select',
        required: true,
        options: [
          {
            value: 'ap-guangzhou',
            label: '中国大陆',
          },
          {
            value: 'ap-seoul',
            label: '非中国大陆',
          },
        ],
        defaultValue: 'ap-guangzhou',
        showWhen: {
          key: 'product',
          in: [
            'waf',
          ],
        },
      },
      {
        key: 'clb_id',
        label: '负载均衡ID',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'clb',
          ],
        },
      },
      {
        key: 'clb_listener_id',
        label: '监听器ID',
        placeholder: '可留空，会自动根据域名或负载均衡ID查找',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'clb',
          ],
        },
      },
      {
        key: 'clb_domain',
        label: '绑定的域名',
        placeholder: '若监听器开启SNI，则域名必填；若关闭SNI，则域名留空',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'clb',
          ],
        },
      },
      {
        key: 'tke_cluster_id',
        label: '集群ID',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'tke',
          ],
        },
      },
      {
        key: 'tke_namespace',
        label: '命名空间',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'tke',
          ],
        },
      },
      {
        key: 'tke_secret',
        label: '证书的secret名称',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'tke',
          ],
        },
      },
      {
        key: 'cos_bucket',
        label: '存储桶名称',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'cos',
          ],
        },
      },
      {
        key: 'lighthouse_id',
        label: '实例ID',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'lighthouse',
            'ddos',
          ],
        },
      },
      {
        key: 'site_type',
        label: '站点类型',
        type: 'select',
        required: true,
        options: [
          {
            value: 'cn',
            label: '国内站',
          },
          {
            value: 'intl',
            label: '国际站',
          },
        ],
        defaultValue: 'cn',
        showWhen: {
          key: 'product',
          in: [
            'teo',
          ],
        },
      },
      {
        key: 'site_id',
        label: '站点ID',
        required: true,
        placeholder: '类似于zone-xxxx，在站点列表或概览页面查看',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'teo',
          ],
        },
      },
      {
        key: 'domain',
        label: '绑定的域名',
        required: true,
        note: 'CDN、EO、WAF多个域名可用,隔开，其他只能填写1个域名',
        maxLength: 500,
        showWhen: {
          key: 'product',
          notIn: [
            'clb',
            'tke',
            'upload',
            'update',
            'update_new',
          ],
        },
      },
      {
        key: 'cert_id',
        label: '证书ID',
        required: true,
        placeholder: '要更新的证书ID，在我的证书列表查看',
        note: '如果使用证书ID不变接口更新，则需联系加白使用',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'update',
            'update_new',
          ],
        },
      },
      {
        key: 'delete_old_cert',
        label: '更新成功后删除旧证书',
        type: 'checkbox',
        defaultValue: '0',
        showWhen: {
          key: 'product',
          in: [
            'update_new',
          ],
        },
      },
    ],
  },
  huawei: {
    type: 'huawei',
    name: '华为云',
    category: 'cloud',
    description: '支持部署到华为云CDN、ELB、WAF等服务',
    note: '支持部署到华为云CDN、ELB、WAF等服务',
    fields: [
      {
        key: 'AccessKeyId',
        label: 'AccessKeyId',
        required: true,
        maxLength: 500,
      },
      {
        key: 'SecretAccessKey',
        label: 'SecretAccessKey',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'product',
        label: '要部署的产品',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
          {
            value: '2',
            label: '[object Object]',
          },
          {
            value: '3',
            label: '[object Object]',
          },
          {
            value: '4',
            label: '[object Object]',
          },
        ],
        defaultValue: 'cdn',
      },
      {
        key: 'obs_endpoint',
        label: 'Endpoint地址',
        required: true,
        placeholder: '填写示例：obs.cn-north-4.myhuaweicloud.com',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'obs',
          ],
        },
      },
      {
        key: 'obs_bucket',
        label: '桶名称',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'obs',
          ],
        },
      },
      {
        key: 'domain',
        label: '绑定的域名',
        required: true,
        placeholder: '多个域名可使用,分隔',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'cdn',
            'obs',
          ],
        },
      },
      {
        key: 'project_id',
        label: '项目ID',
        required: true,
        note: '项目ID可在我的凭证->项目列表页面查看',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'elb',
            'waf',
          ],
        },
      },
      {
        key: 'region_id',
        label: '区域ID',
        required: true,
        note: '区域ID可在<a href="https://console.huaweicloud.com/apiexplorer/#/endpoint" target="_blank" rel="noreferrer">此页面查找</a>',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'elb',
            'waf',
          ],
        },
      },
      {
        key: 'cert_id',
        label: '要更新的证书ID',
        required: true,
        placeholder: '在ELB控制台->证书管理->查看已上传的证书ID',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'elb',
            'waf',
          ],
        },
      },
    ],
  },
  ucloud: {
    type: 'ucloud',
    name: 'UCloud',
    category: 'cloud',
    description: '支持部署到UCDN',
    note: '支持部署到UCDN',
    fields: [
      {
        key: 'PublicKey',
        label: '公钥',
        required: true,
        maxLength: 500,
      },
      {
        key: 'PrivateKey',
        label: '私钥',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'domain_id',
        label: '云分发资源ID',
        required: true,
        note: '在云分发-域名管理-域名基本信息页面查看',
        maxLength: 500,
      },
    ],
  },
  qiniu: {
    type: 'qiniu',
    name: '七牛云',
    category: 'cloud',
    description: '支持部署到七牛云CDN、OSS',
    note: '支持部署到七牛云CDN、OSS',
    fields: [
      {
        key: 'AccessKey',
        label: 'AccessKey',
        required: true,
        maxLength: 500,
      },
      {
        key: 'SecretKey',
        label: 'SecretKey',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'product',
        label: '要部署的产品',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
          {
            value: '2',
            label: '[object Object]',
          },
          {
            value: '3',
            label: '[object Object]',
          },
        ],
        defaultValue: 'cdn',
      },
      {
        key: 'pili_hub',
        label: '直播空间名称',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'pili',
          ],
        },
      },
      {
        key: 'domain',
        label: '绑定的域名',
        required: true,
        placeholder: '多个域名可使用,分隔',
        maxLength: 500,
        showWhen: {
          key: 'product',
          notIn: [
            'upload',
          ],
        },
      },
    ],
  },
  doge: {
    type: 'doge',
    name: '多吉云',
    category: 'cloud',
    description: '支持部署到多吉云融合CDN',
    note: '支持部署到多吉云融合CDN',
    fields: [
      {
        key: 'AccessKey',
        label: 'AccessKey',
        required: true,
        maxLength: 500,
      },
      {
        key: 'SecretKey',
        label: 'SecretKey',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'domain',
        label: 'CDN域名',
        required: true,
        placeholder: '多个域名可使用,分隔',
        maxLength: 500,
      },
    ],
  },
  axisnow: {
    type: 'axisnow',
    name: 'AxisNow',
    category: 'cloud',
    description: '支持上传证书到AxisNow平台',
    note: '支持上传证书到AxisNow平台',
    fields: [
      {
        key: 'name',
        label: '租户名',
        required: true,
        maxLength: 500,
      },
      {
        key: 'token',
        label: 'API 令牌',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [],
  },
  upyun: {
    type: 'upyun',
    name: '又拍云',
    category: 'cloud',
    description: '支持部署到又拍云CDN',
    note: '支持部署到又拍云CDN',
    taskNote: '系统会根据关联SSL证书的域名，进行证书的迁移操作',
    fields: [
      {
        key: 'username',
        label: '用户名',
        required: true,
        maxLength: 500,
      },
      {
        key: 'password',
        label: '密码',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [],
  },
  baidu: {
    type: 'baidu',
    name: '百度云',
    category: 'cloud',
    description: '支持部署到百度云CDN、BLB',
    note: '支持部署到百度云CDN、BLB',
    fields: [
      {
        key: 'AccessKeyId',
        label: 'AccessKeyId',
        required: true,
        maxLength: 500,
      },
      {
        key: 'SecretAccessKey',
        label: 'SecretAccessKey',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'product',
        label: '要部署的产品',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
          {
            value: '2',
            label: '[object Object]',
          },
          {
            value: '3',
            label: '[object Object]',
          },
        ],
        defaultValue: 'cdn',
      },
      {
        key: 'domain',
        label: '绑定的域名',
        required: true,
        placeholder: '多个域名可使用,分隔',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'cdn',
          ],
        },
      },
      {
        key: 'region',
        label: '所属地域',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
          {
            value: '2',
            label: '[object Object]',
          },
          {
            value: '3',
            label: '[object Object]',
          },
          {
            value: '4',
            label: '[object Object]',
          },
          {
            value: '5',
            label: '[object Object]',
          },
          {
            value: '6',
            label: '[object Object]',
          },
          {
            value: '7',
            label: '[object Object]',
          },
        ],
        defaultValue: 'bj',
        showWhen: {
          key: 'product',
          in: [
            'blb',
            'appblb',
          ],
        },
      },
      {
        key: 'blb_id',
        label: '负载均衡实例ID',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'blb',
            'appblb',
          ],
        },
      },
      {
        key: 'blb_port',
        label: 'HTTPS监听端口',
        required: true,
        defaultValue: '443',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'blb',
            'appblb',
          ],
        },
      },
    ],
  },
  ksyun: {
    type: 'ksyun',
    name: '金山云',
    category: 'cloud',
    description: '支持部署到金山云CDN',
    note: '支持部署到金山云CDN',
    fields: [
      {
        key: 'AccessKeyId',
        label: 'AccessKeyId',
        required: true,
        maxLength: 500,
      },
      {
        key: 'SecretAccessKey',
        label: 'SecretAccessKey',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'product',
        label: '要部署的产品',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
        ],
        defaultValue: 'cdn',
      },
      {
        key: 'domain',
        label: '绑定的域名',
        required: true,
        placeholder: '多个域名可使用,分隔',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'cdn',
          ],
        },
      },
    ],
  },
  huoshan: {
    type: 'huoshan',
    name: '火山引擎',
    category: 'cloud',
    description: '支持部署到火山引擎CDN、CLB、TOS、直播、veImageX',
    note: '支持部署到火山引擎CDN、CLB、TOS、直播、veImageX',
    fields: [
      {
        key: 'AccessKeyId',
        label: 'AccessKeyId',
        required: true,
        maxLength: 500,
      },
      {
        key: 'SecretAccessKey',
        label: 'SecretAccessKey',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'product',
        label: '要部署的产品',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
          {
            value: '2',
            label: '[object Object]',
          },
          {
            value: '3',
            label: '[object Object]',
          },
          {
            value: '4',
            label: '[object Object]',
          },
          {
            value: '5',
            label: '[object Object]',
          },
          {
            value: '6',
            label: '[object Object]',
          },
          {
            value: '7',
            label: '[object Object]',
          },
          {
            value: '8',
            label: '[object Object]',
          },
        ],
        defaultValue: 'cdn',
      },
      {
        key: 'bucket_domain',
        label: 'Bucket域名',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'tos',
          ],
        },
      },
      {
        key: 'vod_space_name',
        label: '点播空间名称',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'vod',
          ],
        },
      },
      {
        key: 'vod_domain_type',
        label: '点播域名类型',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
        ],
        showWhen: {
          key: 'product',
          in: [
            'vod',
          ],
        },
      },
      {
        key: 'domain',
        label: '绑定的域名',
        required: true,
        placeholder: '多个域名可使用,分隔',
        maxLength: 500,
        showWhen: {
          key: 'product',
          notIn: [
            'clb',
            'alb',
            'upload',
          ],
        },
      },
      {
        key: 'listener_id',
        label: '监听器ID',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'clb',
            'alb',
          ],
        },
      },
      {
        key: 'project_name',
        label: '证书上传项目名称',
        placeholder: '证书实例所属的火山引擎项目名称。如果不设置该参数，证书实例会属于default项目。',
        maxLength: 500,
      },
    ],
  },
  west: {
    type: 'west',
    name: '西部数码',
    category: 'cloud',
    description: '支持部署到西部数码虚拟主机',
    note: '支持部署到西部数码虚拟主机',
    fields: [
      {
        key: 'username',
        label: '用户名',
        required: true,
        maxLength: 500,
      },
      {
        key: 'api_password',
        label: 'API密码',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'sitename',
        label: 'FTP账号',
        required: true,
        maxLength: 500,
      },
    ],
  },
  wangsu: {
    type: 'wangsu',
    name: '网宿科技',
    category: 'cloud',
    description: '支持部署到网宿CDN',
    note: '适用产品：网页加速、下载分发、全站加速、点播分发、直播分发、上传加速、移动加速、上网加速、S-P2P、PCDN、应用性能管理、WEB应用防火墙、BotGuard爬虫管理、WSS、DMS、DDoS云清洗、应用加速、应用安全加速解决方案、IPv6一体化解决方案、电商安全加速解决方案、金融安全加速解决方案、政企安全加速解决方案、DDoS云清洗(非网站业务)、区块链安全加速解决方案、IPv6安全加速解决方案、CDN Pro。暂不支持AKSK鉴权。',
    fields: [
      {
        key: 'username',
        label: '账号',
        required: true,
        maxLength: 500,
      },
      {
        key: 'apiKey',
        label: 'APIKEY',
        required: true,
        placeholder: '自行联系提供商申请',
        maxLength: 500,
      },
      {
        key: 'spKey',
        label: '特殊KEY',
        type: 'password',
        secret: true,
        placeholder: '特殊场景下才需要使用的APIKEY，留空默认同APIKEY',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'product',
        label: '要部署的产品',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
          {
            value: '2',
            label: '[object Object]',
          },
          {
            value: '3',
            label: '[object Object]',
          },
        ],
        defaultValue: 'cdn',
      },
      {
        key: 'domains',
        label: '绑定的域名',
        required: true,
        placeholder: '多个域名可使用,分隔',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'cdn',
          ],
        },
      },
      {
        key: 'domain',
        label: '绑定的域名',
        required: true,
        placeholder: '不支持输入多个域名',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'cdnpro',
          ],
        },
      },
      {
        key: 'cert_id',
        label: '证书ID',
        required: true,
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'certificate',
            'cdnpro_certificate',
          ],
        },
      },
    ],
  },
  baishan: {
    type: 'baishan',
    name: '白山云',
    category: 'cloud',
    description: '替换白山云证书管理内的证书',
    fields: [
      {
        key: 'account',
        label: '账户名',
        required: true,
        placeholder: '仅用作标记',
        maxLength: 500,
      },
      {
        key: 'token',
        label: 'token',
        type: 'password',
        required: true,
        secret: true,
        note: '自行联系提供商申请',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'id',
        label: '证书ID',
        required: true,
        note: '在证书管理页面查看，注意域名是否与证书匹配',
        maxLength: 500,
      },
    ],
  },
  ctyun: {
    type: 'ctyun',
    name: '天翼云',
    category: 'cloud',
    description: '支持部署到天翼云CDN、边缘加速',
    note: '支持部署到天翼云CDN、边缘加速',
    fields: [
      {
        key: 'AccessKeyId',
        label: 'AccessKeyId',
        required: true,
        maxLength: 500,
      },
      {
        key: 'SecretAccessKey',
        label: 'SecretAccessKey',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'product',
        label: '要部署的产品',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
          {
            value: '2',
            label: '[object Object]',
          },
          {
            value: '3',
            label: '[object Object]',
          },
        ],
        defaultValue: 'cdn',
      },
      {
        key: 'region_id',
        label: '所属地域',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
        ],
        defaultValue: 'bb9fdb42056f11eda1610242ac110002',
        showWhen: {
          key: 'product',
          in: [
            'cf',
          ],
        },
      },
      {
        key: 'domain',
        label: '绑定的域名',
        required: true,
        placeholder: '多个域名可使用,分隔',
        maxLength: 500,
      },
    ],
  },
  kuocai: {
    type: 'kuocai',
    name: '括彩云',
    category: 'cloud',
    description: '替换括彩云证书管理内的证书',
    note: '支持括彩云及其代理商，填写控制台登录账号及密码',
    fields: [
      {
        key: 'username',
        label: '账号',
        required: true,
        placeholder: '控制台账号',
        note: '填写手机号或邮箱',
        maxLength: 500,
      },
      {
        key: 'password',
        label: '密码',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '控制台密码',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'id',
        label: '域名ID',
        required: true,
        note: '在控制台->我的域名->配置复制浏览器地址栏显示的域名ID（19位数字），注意域名是否与证书匹配',
        maxLength: 500,
      },
    ],
  },
  qzyun: {
    type: 'qzyun',
    name: '全栈云',
    category: 'cloud',
    description: '更新全栈云证书管理中的证书',
    note: '填写 panel.qzyun.cn 的登录邮箱和密码',
    fields: [
      {
        key: 'email',
        label: '登录邮箱',
        required: true,
        placeholder: '全栈云账号邮箱',
        maxLength: 500,
      },
      {
        key: 'password',
        label: '密码',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '全栈云登录密码',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'certificate',
        label: '证书名称或文档ID',
        required: true,
        placeholder: '例如 qzyun.cn',
        note: '填写全栈云“证书管理”中显示的证书名称；首次部署后会自动保存内部文档ID',
        maxLength: 500,
      },
      {
        key: 'domain',
        label: '绑定域名',
        placeholder: '例如 qzyun.cn，可留空',
        note: '填写后会将证书自动绑定到全栈云对应域名',
        maxLength: 500,
      },
    ],
  },
  rainyun: {
    type: 'rainyun',
    name: '雨云',
    category: 'cloud',
    description: '替换雨云证书管理内的证书',
    fields: [
      {
        key: 'account',
        label: '账号',
        required: true,
        placeholder: '仅用作标记',
        maxLength: 500,
      },
      {
        key: 'apikey',
        label: 'ApiKey',
        type: 'password',
        required: true,
        secret: true,
        note: '在 账户设置->API密钥 页面查看',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'id',
        label: '证书ID',
        placeholder: '留空则为添加证书',
        note: '在SSL证书->我的证书页面查看，注意域名是否与证书匹配',
        maxLength: 500,
      },
    ],
  },
  unicloud: {
    type: 'unicloud',
    name: 'uniCloud',
    category: 'cloud',
    description: '部署到uniCloud服务空间',
    fields: [
      {
        key: 'username',
        label: '账号',
        required: true,
        maxLength: 500,
      },
      {
        key: 'password',
        label: '密码',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'spaceId',
        label: '服务空间ID',
        required: true,
        placeholder: 'spaceId',
        maxLength: 500,
      },
      {
        key: 'provider',
        label: '空间提供商',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
          {
            value: '2',
            label: '[object Object]',
          },
        ],
        defaultValue: 'aliyun',
      },
      {
        key: 'domains',
        label: '空间域名',
        required: true,
        placeholder: '多个域名可使用,分隔',
        maxLength: 500,
      },
    ],
  },
  aws: {
    type: 'aws',
    name: 'AWS',
    category: 'cloud',
    description: '支持部署到Amazon CloudFront、AWS Certificate Manager',
    note: '支持部署到Amazon CloudFront、AWS Certificate Manager',
    fields: [
      {
        key: 'AccessKeyId',
        label: 'AccessKeyId',
        required: true,
        maxLength: 500,
      },
      {
        key: 'SecretAccessKey',
        label: 'SecretAccessKey',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'product',
        label: '要部署的产品',
        type: 'select',
        required: true,
        options: [
          {
            value: '0',
            label: '[object Object]',
          },
          {
            value: '1',
            label: '[object Object]',
          },
        ],
        defaultValue: 'acm',
      },
      {
        key: 'distribution_id',
        label: '分配ID',
        required: true,
        placeholder: 'distributions id',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'cloudfront',
          ],
        },
      },
      {
        key: 'acm_arn',
        label: 'ACM ARN',
        required: true,
        note: '在AWS Certificate Manager控制台查看证书的ARN',
        maxLength: 500,
        showWhen: {
          key: 'product',
          in: [
            'acm',
          ],
        },
      },
    ],
  },
  gcore: {
    type: 'gcore',
    name: 'Gcore',
    category: 'cloud',
    description: '替换Gcore CDN证书',
    note: '在 个人资料->API令牌 页面创建API令牌',
    fields: [
      {
        key: 'account',
        label: '账户名',
        required: true,
        placeholder: '仅用作标记',
        maxLength: 500,
      },
      {
        key: 'apikey',
        label: 'API令牌',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'id',
        label: '证书ID',
        required: true,
        note: '在CDN->SSL证书页面查看证书的ID，注意域名是否与证书匹配',
        maxLength: 500,
      },
      {
        key: 'name',
        label: '证书名称',
        required: true,
        maxLength: 500,
      },
    ],
  },
  cachefly: {
    type: 'cachefly',
    name: 'Cachefly',
    category: 'cloud',
    description: '替换Cachefly CDN证书',
    note: '在 API Tokens 页面生成 API Token',
    fields: [
      {
        key: 'account',
        label: '账户名',
        required: true,
        placeholder: '仅用作标记',
        maxLength: 500,
      },
      {
        key: 'apikey',
        label: 'API Token',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
    ],
    taskFields: [],
  },
  s3storage: {
    type: 's3storage',
    name: 'S3存储',
    category: 'storage',
    description: '支持将证书上传到S3兼容存储（AWS S3、MinIO等）',
    note: '支持AWS S3、MinIO、阿里云OSS（S3兼容模式）等S3协议兼容的对象存储服务',
    taskNote: '证书和私钥将以PEM格式上传到指定的存储桶路径',
    fields: [
      {
        key: 'AccessKeyId',
        label: 'AccessKeyId',
        required: true,
        maxLength: 500,
      },
      {
        key: 'SecretAccessKey',
        label: 'SecretAccessKey',
        type: 'password',
        required: true,
        secret: true,
        maxLength: 500,
      },
      {
        key: 'endpoint',
        label: 'S3 Endpoint',
        required: true,
        placeholder: '如：s3.amazonaws.com 或 minio.example.com:9000',
        note: 'AWS S3填写s3.区域.amazonaws.com，其他S3兼容服务填写对应地址',
        maxLength: 500,
      },
      {
        key: 'region',
        label: '区域',
        required: true,
        placeholder: '如：us-east-1',
        defaultValue: 'us-east-1',
        maxLength: 500,
      },
    ],
    taskFields: [
      {
        key: 'bucket',
        label: '存储桶名称',
        required: true,
        maxLength: 500,
      },
      {
        key: 'cert_path',
        label: '证书保存路径',
        required: true,
        placeholder: 'ssl/cert.pem',
        note: '在存储桶内的文件路径，如 ssl/domain.com/cert.pem',
        maxLength: 500,
      },
      {
        key: 'key_path',
        label: '私钥保存路径',
        required: true,
        placeholder: 'ssl/key.pem',
        note: '在存储桶内的文件路径，如 ssl/domain.com/key.pem',
        maxLength: 500,
      },
    ],
  },
};

/** 取驱动字段定义；类型写错时在启动阶段就失败，避免部署时才暴露问题。 */
export function deployMeta(type: string): DeployProviderMeta {
  const meta = DEPLOY_META[type];
  if (!meta) throw new Error(`未知的部署驱动：${type}`);
  return meta;
}
