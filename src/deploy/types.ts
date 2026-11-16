/** 部署账户 / 任务配置：字符串键值，逐字段由驱动校验。 */
export type DeployTaskConfig = Record<string, string>;

/** 部署账户字段：与 PHP DeployHelper 的 inputs 对应，前端据此动态渲染表单。 */
export type DeployFieldType = 'input' | 'password' | 'textarea' | 'select' | 'radio' | 'checkbox';

export interface DeployFieldOption {
  value: string;
  label: string;
}

/** 显示条件的最小单元：对应 PHP 的 `key==value` / `key!=value`。 */
export interface DeployFieldCondition {
  key: string;
  in?: string[];
  notIn?: string[];
}

/** 显示条件：与 PHP inputs 的 show 表达式等价（&& 优先于 ||）。 */
export type DeployFieldShow =
  | DeployFieldCondition
  | { all: DeployFieldShow[] }
  | { any: DeployFieldShow[] };

export interface DeployField {
  key: string;
  label: string;
  type?: DeployFieldType;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  note?: string;
  options?: DeployFieldOption[];
  defaultValue?: string;
  maxLength?: number;
  showWhen?: DeployFieldShow;
}

export interface DeployProviderMeta {
  type: string;
  name: string;
  category: 'panel' | 'cloud' | 'storage';
  description?: string;
  note?: string;
  taskNote?: string;
  fields: DeployField[];
  taskFields: DeployField[];
}

export interface DeployMaterial {
  fullchain: string;
  privateKey: string;
  domains: string[];
  commonName: string;
  issuer: string;
  expiresAt: number;
}

export interface DeployRuntime {
  fetch: typeof fetch;
  log(message: string): void;
  /** 跨次运行的驱动状态（对应 PHP 的 $info），在部署结束后写回 info_json。 */
  state: Record<string, string>;
  /** 覆盖任务配置（对应 PHP 的 $info['config']），在部署结束后写回 config_json。 */
  saveConfig(patch: Record<string, string>): void;
}

export interface DeployProvider {
  meta: DeployProviderMeta;
  check(config: DeployTaskConfig, runtime: DeployRuntime): Promise<void>;
  deploy(taskConfig: DeployTaskConfig, config: DeployTaskConfig, material: DeployMaterial, runtime: DeployRuntime): Promise<void>;
}

export function fieldValue(config: DeployTaskConfig, field: DeployField): string {
  const value = config[field.key];
  if (typeof value === 'string' && value !== '') return value;
  return field.defaultValue ?? '';
}

export function requireField(config: DeployTaskConfig, key: string, label: string): string {
  const value = config[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}

export function optionValue(config: DeployTaskConfig, field: DeployField): string {
  const value = fieldValue(config, field);
  if (!value) return field.defaultValue ?? '';
  if (field.options && !field.options.some((option) => option.value === value)) return field.defaultValue ?? '';
  return value;
}

/** 按 PHP show 表达式语义判断字段是否显示。 */
export function deployShowVisible(
  config: Record<string, string | undefined>,
  show?: DeployFieldShow,
): boolean {
  if (!show) return true;
  if ('all' in show) return show.all.every((item) => deployShowVisible(config, item));
  if ('any' in show) return show.any.some((item) => deployShowVisible(config, item));
  const value = config[show.key] ?? '';
  if (show.in) return show.in.includes(value);
  if (show.notIn) return !show.notIn.includes(value);
  return true;
}

/** 拆多行/逗号分隔的列表，去掉空项。 */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}
