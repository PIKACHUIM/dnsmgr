import { describe, expect, it } from 'vitest';
import { de } from '../frontend/src/locales/de';
import { en } from '../frontend/src/locales/en';
import { es } from '../frontend/src/locales/es';
import { fr } from '../frontend/src/locales/fr';
import { it as itLocale } from '../frontend/src/locales/it';
import { ja } from '../frontend/src/locales/ja';
import { ko } from '../frontend/src/locales/ko';
import { pt } from '../frontend/src/locales/pt';
import { ru } from '../frontend/src/locales/ru';
import { zhHant } from '../frontend/src/locales/zh-Hant';

const DICTIONARIES: Record<string, Record<string, string>> = {
  'zh-Hant': zhHant, en, ja, ko, fr, de, it: itLocale, es, pt, ru,
};

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

describe('locale dictionaries', () => {
  const baseKeys = Object.keys(en).sort();

  for (const [name, dictionary] of Object.entries(DICTIONARIES)) {
    it(`${name} covers every key of en`, () => {
      expect(Object.keys(dictionary).sort()).toEqual(baseKeys);
    });

    it(`${name} keeps the placeholders of en`, () => {
      const mismatched = baseKeys.filter((key) => placeholders(dictionary[key] ?? '').join() !== placeholders(en[key] ?? '').join());
      expect(mismatched).toEqual([]);
    });
  }
});
