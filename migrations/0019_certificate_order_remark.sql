-- 证书订单备注，用于区分同一域名下的多张证书；证书材料本身仍不可修改。
ALTER TABLE cert_orders ADD COLUMN remark TEXT;
