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

const THEME_KEY = 'dnsmgr-theme';
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

interface Preferences {
  theme: Theme;
  language: Language;
  t: (key: string, params?: Record<string, string | number>) => string;
  toggleTheme: () => void;
  setLanguage: (language: Language) => void;
}

const PreferencesContext = createContext<Preferences | null>(null);

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* storage may be blocked */ }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (!saved) return 'zh-Hans';
    if (LEGACY_LANGUAGES[saved]) return LEGACY_LANGUAGES[saved];
    return LANGUAGES.some((item) => item.id === saved) ? (saved as Language) : 'zh-Hans';
  } catch {
    return 'zh-Hans';
  }
}

function languageTag(language: Language): string {
  return LANGUAGES.find((item) => item.id === language)?.tag ?? 'zh-CN';
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [language, setLanguage] = useState<Language>(initialLanguage);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage may be blocked */ }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = languageTag(language);
    try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* storage may be blocked */ }
  }, [language]);

  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    let text = DICTIONARIES[language]?.[key] ?? key;
    if (params) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  }, [language]);
  const value = useMemo<Preferences>(() => ({
    theme,
    language,
    t,
    toggleTheme: () => setTheme((current) => (current === 'dark' ? 'light' : 'dark')),
    setLanguage,
  }), [theme, language, t]);

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
  return <div className="preference-toggles"><ThemeToggle /><LanguageToggle /></div>;
}
