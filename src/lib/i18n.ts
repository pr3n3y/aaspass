export type I18nText = { en: string; hi: string; mr: string };

export function i18n(en: string, hi: string, mr: string): I18nText {
  return { en, hi, mr };
}

export function asI18n(value: unknown): I18nText {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const en = typeof record.en === 'string' ? record.en : '';
  const hi = typeof record.hi === 'string' ? record.hi : en;
  const mr = typeof record.mr === 'string' ? record.mr : en;
  return { en, hi, mr };
}

export function pickLang(value: unknown, lang: string): string {
  const text = asI18n(value);
  if (lang === 'hi') return text.hi || text.en;
  if (lang === 'mr') return text.mr || text.en;
  return text.en || text.hi || text.mr;
}

export function normalizeQuery(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}
