export const DEFAULT_TIME_ZONE = 'Europe/Moscow';

export function localDate(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function localHour(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', hourCycle: 'h23',
  }).format(now));
}

export function shiftDate(iso, days) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function displayDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? `${iso.slice(8)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso;
}

export function money(minor, currency = 'RUB') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency })
    .format(minor / 100);
}

export function normalize(text) {
  return String(text).toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').trim();
}

export function parseAmount(text) {
  const matches = [...String(text).matchAll(/(?:^|[^\d])(\d+(?:[ \u00a0]\d{3})*(?:[,.]\d{1,2})?)(?=\D|$)/g)];
  if (matches.length !== 1) return null;
  const value = Number(matches[0][1].replace(/[ \u00a0]/g, '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 && value <= 10_000_000
    ? Math.round(value * 100) : null;
}

export function parseDay(text, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const today = localDate(now, timeZone);
  const dates = [...String(text).matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g)];
  const relative = /\b(?:сегодня|вчера|позавчера)\b/i.exec(normalize(text));
  if (dates.length > 1 || (dates.length && relative)) return { error: 'Укажи одну дату операции.' };
  if (!dates.length) {
    const day = /позавчера/i.test(text) ? shiftDate(today, -2)
      : /вчера/i.test(text) ? shiftDate(today, -1) : today;
    return { day, withoutDate: String(text).replace(/\b(?:сегодня|вчера|позавчера)\b/gi, ' ') };
  }
  const match = dates[0];
  const day = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const parsed = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day)
    return { error: 'Проверь дату: такого дня нет.' };
  if (day > today) return { error: 'Будущую покупку оцениваю, но расход запишу после неё.' };
  return { day, withoutDate: String(text).replace(match[0], ' ') };
}

function aliases(account) {
  let extra = [];
  try { extra = JSON.parse(account.aliases_json || '[]'); } catch { /* malformed aliases do not authorize a guess */ }
  return [account.title, ...extra].filter(Boolean).map(normalize);
}

export function detectAccount(text, accounts) {
  const low = normalize(text);
  const hits = accounts.filter(account => aliases(account).some(alias => alias.length >= 3 && low.includes(alias)));
  return hits.length === 1 ? hits[0] : null;
}

export function detectCategory(text, categories) {
  const low = normalize(text);
  const hits = categories.filter(category => {
    let keywords = [];
    try { keywords = JSON.parse(category.keywords_json || '[]'); } catch { return false; }
    return [category.title, ...keywords].some(word => word && low.includes(normalize(word)));
  });
  return hits.length === 1 ? hits[0] : null;
}

export function isPurchaseIntent(text) {
  return /(?:^|[\s,.!?])(?:хочу|планирую|собираюсь|могу ли|можно ли|стоит ли)(?=$|[\s,.!?])/i.test(normalize(text));
}

export function isCompletedExpense(text) {
  return /(?:^|[\s,.!?])(?:купила|купил|оплатила|оплатил|потратила|потратил|заплатила|заплатил)(?=$|[\s,.!?])/i.test(normalize(text));
}

export function isWeeklyBudgetQuestion(text) {
  const low = normalize(text);
  return /(?:лимит|бюджет).{0,40}(?:день|сегодня|недел|период|аван|зарплат)|(?:день|сегодня|недел|период).{0,40}(?:лимит|бюджет)|сколько.{0,40}(?:потратить|тратить).{0,40}(?:сегодня|недел)/.test(low);
}

export function parseOperation(text, { accounts, categories, now = new Date(), timeZone = DEFAULT_TIME_ZONE, baseCurrency = 'RUB', forcedKind } = {}) {
  const low = normalize(text);
  if (isPurchaseIntent(text)) return { error: 'Это пока план. Спроси о покупке через /buy.' };
  if (/в долг|вернул|вернула|погасил|сплит|кредитк/i.test(low))
    return { error: 'Похоже на долг или кредит. В обычные расходы это автоматически не заношу.' };
  if (/перевод|перевел|перевела|снял|сняла/i.test(low))
    return { error: 'Похоже на перевод или снятие наличных. Расходом это не считаю.' };
  if (/usd|eur|kzt|доллар|евро|тенге|[$€₸]/i.test(low))
    return { error: 'Уточни валюту. Автоматическая запись сейчас работает только в основной валюте.' };
  const kind = forcedKind || (isCompletedExpense(text) ? 'expense'
    : /(?:^|[\s,.!?])(?:получила|получил|поступило|пришла зарплата|пришел аванс)(?=$|[\s,.!?])/i.test(low) ? 'income' : null);
  if (!kind) return { error: 'Напиши «купила», «оплатила» или «получила» и сумму.' };
  const date = parseDay(text, now, timeZone);
  if (date.error) return date;
  const amount_minor = parseAmount(date.withoutDate);
  if (!amount_minor) return { error: 'Напиши одну операцию и одну сумму.' };
  const account = detectAccount(text, accounts || []);
  const category = kind === 'expense' ? detectCategory(text, categories || []) : null;
  if (account && account.currency !== baseCurrency)
    return { error: `Счёт «${account.title}» в другой валюте. Уточни сумму в ${baseCurrency} или используй другой счёт.` };
  return {
    kind, day: date.day, amount_minor, account_id: account?.id || null,
    category_code: category?.code || null,
    budget_scope: category?.default_scope || 'everyday',
    currency: baseCurrency, note: String(text).slice(0, 500),
  };
}

export function parsePurchase(text) {
  const amount_minor = parseAmount(text);
  if (!amount_minor) return { error: 'Назови одну цену покупки.' };
  const item = String(text)
    .replace(/\d+(?:[ \u00a0]\d{3})*(?:[,.]\d{1,2})?\s*(?:₽|руб(?:лей|ля|ль)?)?/i, '')
    .replace(/(?<![\p{L}\p{N}])(?:хочу|купить|приобрести|за|могу|ли|можно|стоит)(?![\p{L}\p{N}])/giu, '')
    .replace(/[\s,.!?]+/g, ' ').trim();
  return item ? { item: item.slice(0, 100), amount_minor } : { error: 'Напиши, что хочешь купить.' };
}

export function assessPurchase({ amount_minor, available_minor, obligations_minor = 0, budget_remaining_minor = null }) {
  const after = available_minor - obligations_minor - amount_minor;
  if (after < 0) return { level: 'stop', after, reason: 'После известных обязательств денег не хватает.' };
  if (budget_remaining_minor === null)
    return { level: 'unknown', after, reason: 'Лимит ещё не утверждён; не называю покупку безопасной.' };
  if (amount_minor > budget_remaining_minor)
    return { level: 'stop', after, reason: 'Покупка превышает остаток лимита на обычные траты.' };
  if (amount_minor >= budget_remaining_minor * 0.3)
    return { level: 'caution', after, reason: 'Покупка заберёт заметную долю оставшегося лимита.' };
  return { level: 'ok', after, reason: 'Покупка помещается в текущий план.' };
}

export function parseRecurringPayment(text) {
  const match = /^(?:\/remind(?:@[a-z0-9_]+)?\s+)?(\d{1,2})\s+(\d+(?:[.,]\d{1,2})?)\s*(?:₽|руб(?:лей|ля|ль)?\.?)?\s+(.+)$/i.exec(String(text).trim());
  if (!match) return { error: 'Напиши день месяца, сумму без пробелов и название: 20 800 Вайфай.' };
  const day_of_month = Number(match[1]);
  const amount_minor = Math.round(Number(match[2].replace(',', '.')) * 100);
  const title = match[3].trim();
  if (day_of_month < 1 || day_of_month > 31)
    return { error: 'День месяца должен быть от 1 до 31.' };
  if (!Number.isSafeInteger(amount_minor) || amount_minor < 1 || amount_minor > 1_000_000_000)
    return { error: 'Проверь сумму платежа в рублях.' };
  if (title.length < 2 || title.length > 80 || /^\d/.test(title) || /[\r\n]/.test(title))
    return { error: 'Назови платёж после суммы, например: 20 800 Вайфай.' };
  return { day_of_month, amount_minor, title };
}

export function monthlyDueDate(yearMonth, dayOfMonth) {
  if (!/^\d{4}-\d{2}$/.test(yearMonth) || !Number.isInteger(dayOfMonth) ||
      dayOfMonth < 1 || dayOfMonth > 31) throw new RangeError('invalid_monthly_due');
  const [year, month] = yearMonth.split('-').map(Number);
  if (month < 1 || month > 12) throw new RangeError('invalid_monthly_due');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${yearMonth}-${String(Math.min(dayOfMonth, last)).padStart(2, '0')}`;
}

export function nextMonthlyDue(day, dayOfMonth) {
  let due = monthlyDueDate(day.slice(0, 7), dayOfMonth);
  if (due < day) {
    const [year, month] = day.slice(0, 7).split('-').map(Number);
    const next = new Date(Date.UTC(year, month, 1));
    due = monthlyDueDate(next.toISOString().slice(0, 7), dayOfMonth);
  }
  return due;
}

export function recurringOccurrences(rules, start, end) {
  const result = [];
  for (let day = start; day <= end; day = shiftDate(day, 1)) {
    for (const rule of rules) {
      if (monthlyDueDate(day.slice(0, 7), rule.day_of_month) === day)
        result.push({ ...rule, due_on: day });
    }
  }
  return result;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}
