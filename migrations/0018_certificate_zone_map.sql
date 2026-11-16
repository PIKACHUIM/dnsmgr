-- 记录每个签发域名对应的已同步 Zone，避免每一步都重新解析。
ALTER TABLE cert_acme_orders ADD COLUMN zone_map_json TEXT NOT NULL DEFAULT '{}';
