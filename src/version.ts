import packageJson from '../package.json';

export const APP_VERSION: string = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';

export const MIGRATIONS = [
  '0001_core.sql', '0002_dns.sql', '0003_dns_aliases.sql', '0004_schedule.sql',
  '0005_failover.sql', '0006_domain_expiration_queue.sql', '0007_domain_periodic_expiration_queue.sql',
  '0008_domain_expiration_notices.sql', '0009_login_captcha.sql', '0010_certificates.sql',
  '0011_certificate_acme.sql', '0012_certificate_lifecycle.sql', '0013_certificate_ca.sql',
  '0014_notification_outbox.sql', '0015_certificate_cname.sql', '0016_certificate_deploy.sql',
  '0017_optimize_ip.sql',
] as const;

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;
