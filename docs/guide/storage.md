# 存储模型与一致性

应用将安全状态与活动版本指针放入 SQL 协调库；`map`/`key` 业务载荷存为不可变、带摘要的对象版本。最终发布由 SQL 事务执行 fencing 与 CAS。缺少或损坏的数据、过期的活动指针、外部对象存储不可用时，应用 fail closed，不返回空库或回退进程内状态。

## 驱动与格式

```text
DB_DRIVER=d1 | turso | kv | blob | auto
DB_FORMAT=sql | map | key
COORDINATOR_DRIVER=d1 | turso
```

| 驱动 | 协调数据库 | SQL 格式 | `map` | `key` |
| --- | --- | --- | --- | --- |
| `d1` | 同一个 D1 | 支持 | 支持 | 支持 |
| `turso` | 同一个 Turso/libSQL | 支持 | 支持 | 支持 |
| `kv` | 必须另有 D1 或 Turso | 不适用 | 支持 | 支持 |
| `blob` | 必须另有 D1 或 Turso | 不适用 | 支持 | 支持 |

`auto` 仅在尚未初始化时按实际 SQL 绑定解析；首次安装会记录存储身份。其后 URL/命名空间/驱动/格式发生变化，会返回身份不匹配错误，不会自动切库或迁移数据。

## 格式语义

- **SQL**：实体按需查询，分页由数据库完成。
- **map**：一个逻辑 namespace 对应一份完整 JSON 快照；每次更新会发布一个新不可变版本。
- **key**：实体分别保存为 `<namespace>/<entity>/<content-hash>` 不可变对象。每次批量更新会复用未变化的实体；单实体写入和删除只创建变更实体/新索引，并使用活动版本 CAS。`listKeys` 接受 cursor 和有上限的页长。

无论 `map` 还是 `key`，活动 pointer、任务租约和授权状态都由 SQL 管理；对象键的 UUID/内容哈希不可替代 SQL 协调。对象暂时读不到时必须报告不可用，不能把不一致误判为空库。

## 平台边界

- **Cloudflare Workers KV**：跨 POP 最终一致且没有 compare-and-swap。随机 UUID + 内容哈希键避免常规覆写，SQL pointer 决定已提交版本。KV 短暂旧读/漏读会 fail closed。
- **Cloudflare R2**：强一致，并使用 `If-None-Match: *` 做仅新建条件写。
- **EdgeOne Blob**：使用 strong text read。仓库锁定的 SDK `@edgeone/pages-blob@0.0.18` 类型声明将 `onlyIfNew` 标记为 unsupported；适配器不信任该条件参数，使用内容寻址对象键、读回校验与 SQL pointer。
- **ESA EdgeKV**：只能使用文档支持的 namespace、`get`、`put`；缺失值 `undefined` 转换为 null。不虚构 list/CAS API。单对象最大值按 ESA 文档限制在调用前验证。

Makers Node Cloud Function 尚不能直接使用 Makers 原生 Edge Function KV namespace；`DB_DRIVER=kv` 没有真实受认证 KV bridge 时会拒绝启动。ESA EdgeKV 是最终一致存储；已提交对象在某节点暂未传播时系统宁可报错，不会返回未经验证的旧内容。

## 配置身份与恢复限制

Cloudflare D1 协调模式要求配置稳定的 `COORDINATOR_ID`；对象模式还要给出稳定的 `PAYLOAD_STORE_ID`。ESA 的 payload ID 默认绑定 `ESA_KV_NAMESPACE`。Makers Blob 使用 `BLOB_NAMESPACE`；Cloudflare R2 使用 `BUCKET` binding。配置改变被认为指向不同数据集。

现在已实现 staging 写入、内容哈希校验和 SQL 活动指针提交基础协议；尚未完成跨存储恢复命令、孤立对象回收、活动版本回滚工具和受验证的格式导入导出工具。不得用手动改环境变量冒充迁移；不得在真实平台未经 smoke test 就接管生产数据。
