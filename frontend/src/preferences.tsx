import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from './icons';
import { Menu } from './Menu';
import { de } from './locales/de';
import { en } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { it } from './locales/it';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { pt } from './locales/pt';
import { ru } from './locales/ru';
import { zhHant } from './locales/zh-Hant';

export type Theme = 'light' | 'dark';
export type Skin = 'classic' | 'tech' | 'elegant' | 'aurora';
export type Language = 'zh-Hans' | 'zh-Hant' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'it' | 'es' | 'pt' | 'ru';

export interface LanguageOption {
  id: Language;
  /** 选项使用的语言自身名称 */
  label: string;
  /** 写入 html lang 的 BCP 47 标签 */
  tag: string;
  /** 顶栏按钮上的短标识 */
  short: string;
}

export interface SkinOption {
  id: Skin;
  /** 主题名称（中文原文即词条 key） */
  label: string;
  /** 菜单色板的起止色 */
  from: string;
  to: string;
}

const THEME_KEY = 'dnsmgr-theme';
const SKIN_KEY = 'dnsmgr-skin';
const LANGUAGE_KEY = 'dnsmgr-language';

/** 界面语言清单；顺序即切换菜单的显示顺序。 */
const ZH_HANS: LanguageOption = { id: 'zh-Hans', label: '简体中文', tag: 'zh-CN', short: '简中' };

export const LANGUAGES: readonly LanguageOption[] = [
  ZH_HANS,
  { id: 'zh-Hant', label: '繁體中文', tag: 'zh-TW', short: '繁中' },
  { id: 'en', label: 'English', tag: 'en', short: 'EN' },
  { id: 'ja', label: '日本語', tag: 'ja', short: 'JA' },
  { id: 'ko', label: '한국어', tag: 'ko', short: 'KO' },
  { id: 'fr', label: 'Français', tag: 'fr', short: 'FR' },
  { id: 'de', label: 'Deutsch', tag: 'de', short: 'DE' },
  { id: 'it', label: 'Italiano', tag: 'it', short: 'IT' },
  { id: 'es', label: 'Español', tag: 'es', short: 'ES' },
  { id: 'pt', label: 'Português', tag: 'pt', short: 'PT' },
  { id: 'ru', label: 'Русский', tag: 'ru', short: 'RU' },
];

/** 主题色板；顺序即切换菜单的显示顺序，`classic` 为 styles.css 的默认 token。 */
export const SKINS: readonly SkinOption[] = [
  { id: 'classic', label: '经典蓝', from: '#2457c5', to: '#7fa7ff' },
  { id: 'tech', label: '科技深空', from: '#0b6f86', to: '#4fd0e3' },
  { id: 'elegant', label: '素雅暖砂', from: '#4a6b57', to: '#c4a46a' },
  { id: 'aurora', label: '极光幻紫', from: '#5b3fd0', to: '#f472b6' },
];

/** 简体中文即源码中的原始文案，其余语言查词典；缺少条目时回退到中文原文。 */
const DICTIONARIES: Partial<Record<Language, Record<string, string>>> = {
  'zh-Hant': zhHant,
  en,
  ja,
  ko,
  fr,
  de,
  it,
  es,
  pt,
  ru,
};

/** 旧版本只存过 zh / en，读取时映射到新的语言标识。 */
const LEGACY_LANGUAGES: Record<string, Language> = { zh: 'zh-Hans', en: 'en' };

/** 浏览器语言主标签到界面语言的映射；匹配不到时回退英文。 */
const BASE_LANGUAGES: Record<string, Language> = {
  en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de', it: 'it', es: 'es', pt: 'pt', ru: 'ru',
};

export interface Preferences {
  theme: Theme;
  skin: Skin;
  language: Language;
  t: (key: string, params?: Record<string, string | number>) => string;
  toggleTheme: () => void;
  setSkin: (skin: Skin) => void;
  setLanguage: (language: Language) => void;
}

const PreferencesContext = createContext<Preferences | null>(null);

function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function storedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* storage may be blocked */ }
  return null;
}

function storedSkin(): Skin | null {
  try {
    const saved = localStorage.getItem(SKIN_KEY);
    if (SKINS.some((item) => item.id === saved)) return saved as Skin;
  } catch { /* storage may be blocked */ }
  return null;
}

/** 按浏览器语言列表挑第一个可用的界面语言；都不匹配时用英文。 */
function detectLanguage(): Language {
  const tags = typeof navigator === 'undefined'
    ? []
    : [...(navigator.languages ?? []), navigator.language].filter((tag): tag is string => typeof tag === 'string');
  for (const raw of tags) {
    const tag = raw.toLowerCase().replace('_', '-');
    if (tag === 'zh' || tag.startsWith('zh-hans') || tag.startsWith('zh-cn') || tag.startsWith('zh-sg')) return 'zh-Hans';
    if (tag.startsWith('zh-')) return 'zh-Hant';
    const base = tag.split('-')[0] ?? '';
    const matched = BASE_LANGUAGES[base];
    if (matched) return matched;
  }
  return 'en';
}

function storedLanguage(): Language | null {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (saved) {
      if (LEGACY_LANGUAGES[saved]) return LEGACY_LANGUAGES[saved];
      if (LANGUAGES.some((item) => item.id === saved)) return saved as Language;
    }
  } catch { /* storage may be blocked */ }
  return null;
}

export function languageTag(language: Language): string {
  return LANGUAGES.find((item) => item.id === language)?.tag ?? 'en';
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [scheme, setScheme] = useState<{ theme: Theme; followsSystem: boolean }>(() => {
    const stored = storedTheme();
    return { theme: stored ?? systemTheme(), followsSystem: stored === null };
  });
  const [skin, setSkin] = useState<Skin>(() => storedSkin() ?? 'classic');
  const [locale, setLocale] = useState<{ value: Language; chosen: boolean }>(() => {
    const stored = storedLanguage();
    return { value: stored ?? detectLanguage(), chosen: stored !== null };
  });
  const { theme, followsSystem } = scheme;
  const language = locale.value;

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const changed = (event: MediaQueryListEvent) => setScheme((current) => (current.followsSystem
      ? { ...current, theme: event.matches ? 'dark' : 'light' }
      : current));
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    if (!followsSystem) { try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage may be blocked */ } }
  }, [theme, followsSystem]);

  useEffect(() => {
    document.documentElement.dataset.skin = skin;
    try { localStorage.setItem(SKIN_KEY, skin); } catch { /* storage may be blocked */ }
  }, [skin]);

  useEffect(() => {
    document.documentElement.lang = languageTag(language);
    if (locale.chosen) { try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* storage may be blocked */ } }
  }, [language, locale.chosen]);

  const toggleTheme = useCallback(() => {
    setScheme((current) => ({ theme: current.theme === 'dark' ? 'light' : 'dark', followsSystem: false }));
  }, []);

  const setLanguage = useCallback((next: Language) => {
    setLocale({ value: next, chosen: true });
  }, []);

  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    let text = DICTIONARIES[language]?.[key] ?? key;
    if (params) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  }, [language]);
  const value = useMemo<Preferences>(() => ({
    theme,
    skin,
    language,
    t,
    toggleTheme,
    setSkin,
    setLanguage,
  }), [theme, skin, language, t, toggleTheme, setLanguage]);

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): Preferences {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('usePreferences must be used inside PreferencesProvider');
  return value;
}

export function ThemeToggle() {
  const { theme, t, toggleTheme } = usePreferences();
  const label = theme === 'dark' ? t('切换到亮色') : t('切换到暗色');
  return <button type="button" className="icon-button preference-button" aria-label={label} title={label} onClick={toggleTheme}>
    <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
  </button>;
}

export function ThemeMenu() {
  const { skin, setSkin, t } = usePreferences();
  const label = t('切换主题');
  return <Menu label={label} className="theme-menu" trigger={<Icon name="palette" />}>
    {(close) => SKINS.map((item) => <button
      key={item.id} type="button" role="menuitemradio" aria-checked={item.id === skin}
      className="menu-item" onClick={() => { setSkin(item.id); close(); }}
    >
      <span className="theme-swatch" style={{ backgroundImage: `linear-gradient(135deg, ${item.from}, ${item.to})` }} aria-hidden="true" />
      {t(item.label)}
    </button>)}
  </Menu>;
}

export function LanguageToggle() {
  const { language, t, setLanguage } = usePreferences();
  const current = LANGUAGES.find((item) => item.id === language) ?? ZH_HANS;
  const label = t('切换语言');
  return <Menu label={label} className="language-menu" trigger={<><Icon name="globe" /><span className="language-code">{current.short}</span></>}>
    {(close) => LANGUAGES.map((item) => <button
      key={item.id} type="button" role="menuitemradio" aria-checked={item.id === language} lang={item.tag}
      className="menu-item" onClick={() => { setLanguage(item.id); close(); }}
    >{item.label}</button>)}
  </Menu>;
}

export function PreferenceToggles() {
  return <div className="preference-toggles"><ThemeToggle /><ThemeMenu /><LanguageToggle /></div>;
}
