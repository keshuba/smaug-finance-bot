import {
  DEFAULT_TIME_ZONE, assessPurchase, detectAccount, detectCategory, displayDate,
  isCompletedExpense, isPurchaseIntent, isWeeklyBudgetQuestion, localDate, localHour, money,
  parseOperation, parsePurchase, shiftDate,
} from './core.js';
import { infographicHtml } from './infographic.js';

const MAX_UPDATE_BYTES = 65536;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const response = (chatId, text, extra = {}) =>
  json({ method: 'sendMessage', chat_id: chatId, text, ...extra });
const setting = (env, key, fallback) => env[key] || fallback;
const nameOf = env => setting(env, 'OWNER_NAME', 'Хранитель казны');
const zoneOf = env => setting(env, 'TIME_ZONE', DEFAULT_TIME_ZONE);
const currencyOf = env => setting(env, 'BASE_CURRENCY', 'RUB');
const commandOf = text => /^\/([a-z_]+)(?:@[a-z_]+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase();

async function boundedUpdate(request) {
  const length = Number(request.headers.get('content-length'));
  if (length > MAX_UPDATE_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPDATE_BYTES) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

// Telegram's configured secret is compared across the whole fixed-length value.
function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' ||
      actual.length !== expected.length || !expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function rows(db, sql, ...args) {
  return (await db.prepare(sql).bind(...args).all()).results || [];
}
async function one(db, sql, ...args) { return db.prepare(sql).bind(...args).first(); }
async function accounts(db) {
  const list = await rows(db, `SELECT a.*,
    COALESCE(SUM(CASE WHEN l.kind='income' THEN l.amount_minor ELSE -l.amount_minor END),0) delta_minor
    FROM accounts a LEFT JOIN ledger_entries l ON l.account_id=a.id AND l.id>a.balance_ledger_id
    GROUP BY a.id ORDER BY a.sort_order,a.id`);
  return list.map(a => ({ ...a, current_minor: a.balance_minor + a.delta_minor }));
}
async function categories(db) { return rows(db, 'SELECT * FROM categories ORDER BY title'); }
async function dialog(db, chatId) {
  const row = await one(db, 'SELECT state_json,updated_at FROM dialogs WHERE chat_id=?', chatId);
  if (!row || Date.now() - Date.parse(row.updated_at + 'Z') > 86400000) return null;
  try { return JSON.parse(row.state_json); } catch { return null; }
}
async function setDialog(db, chatId, state) {
  await db.prepare(`INSERT INTO dialogs(chat_id,state_json,updated_at) VALUES(?,?,datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at`)
    .bind(chatId, JSON.stringify(state)).run();
}
async function clearDialog(db, chatId) {
  await db.prepare('DELETE FROM dialogs WHERE chat_id=?').bind(chatId).run();
}
async function defaultAccount(db, list, baseCurrency) {
  const configured = await one(db, "SELECT value FROM settings WHERE key='default_account_id'");
  const candidate = list.find(a => a.id === Number(configured?.value));
  if (candidate?.currency === baseCurrency) return candidate;
  const eligible = list.filter(a => a.currency === baseCurrency && ['debit','cash'].includes(a.kind));
  return eligible.length === 1 ? eligible[0] : null;
}
async function currentBudget(db, day, currency) {
  const budget = await one(db, `SELECT * FROM budget_periods
    WHERE status='confirmed' AND currency=? AND starts_on<=? AND ends_on>=?
    ORDER BY starts_on DESC,id DESC LIMIT 1`, currency, day, day);
  if (!budget) return null;
  const spent = await one(db, `SELECT COALESCE(SUM(amount_minor),0) total FROM ledger_entries
    WHERE kind='expense' AND budget_scope='everyday' AND currency=?
    AND happened_on BETWEEN ? AND ?`, currency, budget.starts_on, day);
  return { ...budget, spent_minor: spent.total, remaining_minor: budget.limit_minor - spent.total };
}
async function budgetBreakdown(db, day, currency) {
  const budget = await currentBudget(db, day, currency);
  if (!budget) return null;
  const mondayOffset = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  const monday = shiftDate(day, -mondayOffset);
  const sunday = shiftDate(monday, 6);
  const weekStart = budget.starts_on > monday ? budget.starts_on : monday;
  const weekEnd = budget.ends_on < sunday ? budget.ends_on : sunday;
  const days = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000) + 1;
  const totalDays = days(budget.starts_on, budget.ends_on);
  const beforeWeek = days(budget.starts_on, weekStart) - 1;
  const throughWeek = days(budget.starts_on, weekEnd);
  const beforeDay = days(budget.starts_on, day) - 1;
  const weekLimit = Math.floor(budget.limit_minor * throughWeek / totalDays)
    - Math.floor(budget.limit_minor * beforeWeek / totalDays);
  const dayLimit = Math.floor(budget.limit_minor * (beforeDay + 1) / totalDays)
    - Math.floor(budget.limit_minor * beforeDay / totalDays);
  const spent = async from => (await one(db, `SELECT COALESCE(SUM(amount_minor),0) total
    FROM ledger_entries WHERE kind='expense' AND budget_scope='everyday'
    AND currency=? AND happened_on BETWEEN ? AND ?`, currency, from, day)).total;
  return { budget, day, weekStart, weekEnd, dayLimit, weekLimit,
    daySpent: await spent(day), weekSpent: await spent(weekStart) };
}
export async function weeklyBudgetReply(db, env, now = new Date(), question = '') {
  const day = localDate(now, zoneOf(env));
  const currency = currencyOf(env);
  const b = await budgetBreakdown(db, day, currency);
  if (!b) return `${nameOf(env)}, безопасную сумму пока не назову: общий план до выплаты ещё не утверждён.`;
  const dayLeft = Math.max(0, b.dayLimit - b.daySpent);
  const weekLeft = Math.max(0, b.weekLimit - b.weekSpent);
  const periodLeft = Math.max(0, b.budget.remaining_minor);
  const periodLabel = setting(env, 'PERIOD_LABEL', 'конца периода');
  const next = shiftDate(b.weekEnd, 1);
  const laterAmount = Math.max(0, periodLeft - weekLeft);
  const later = next <= b.budget.ends_on
    ? ` ${money(laterAmount,currency)} оставлено на ${displayDate(next)}–${displayDate(b.budget.ends_on)}.` : '';
  const focus = /сегодня|день/i.test(question)
    ? `сегодня по плану можешь потратить ${money(Math.min(dayLeft, weekLeft),currency)}`
    : /период|аван|зарплат/i.test(question)
      ? `до ${periodLabel} в общем лимите осталось ${money(periodLeft,currency)}`
      : `до ${displayDate(b.weekEnd)} по плану можешь потратить ${money(weekLeft,currency)}`;
  const weekly = weekLeft === 0
    ? `Недельные ${money(b.weekLimit,currency)} уже потрачены.`
    : `На эту неделю выделено ${money(b.weekLimit,currency)}, осталось ${money(weekLeft,currency)}.`;
  return `${nameOf(env)}, ${focus}.\n\n` +
    `${weekly} Общий лимит — ${money(b.budget.limit_minor,currency)}.${later}` +
    (weekLeft === 0 ? '\n\nЕсли покупка нужна сейчас, напиши что и за сколько — пересчитаем план.' : '');
}
async function obligations(db, start, end, currency) {
  const row = await one(db, `SELECT COALESCE(SUM(amount_minor),0) total FROM scheduled_payments
    WHERE status='planned' AND currency=? AND due_on BETWEEN ? AND ?`, currency, start, end);
  return row.total;
}
async function overview(db, env, kind, now = new Date()) {
  const day = localDate(now, zoneOf(env));
  const currency = currencyOf(env);
  const greeting = nameOf(env);
  if (kind === 'treasury') {
    const list = await accounts(db);
    if (!list.length) return { text: `${greeting}, добавь счета и сверенные остатки. Пока казна пуста.`, card: null };
    const own = list.filter(a => a.currency === currency && ['debit','cash'].includes(a.kind));
    const available = own.reduce((n, a) => n + a.current_minor, 0);
    const lines = list.map(a => `• ${a.title}: ${money(a.current_minor, a.currency)}${a.protected ? ' · защищено' : ''}`);
    return {
      text: `${greeting}, казна по последней сверке:\n${lines.join('\n')}\n\nДоступно на дебетовых счетах и наличными: ${money(available, currency)}. Банки автоматически не обновляются.`,
      card: { eyebrow: 'СМАУГ · КАЗНА', title: 'Казна', subtitle: `На ${displayDate(day)} · по последней сверке`,
        total: money(available, currency), sections: [
          { heading: 'Счета', rows: list.slice(0, 7).map(a => ({ label: a.title, value: money(a.current_minor, a.currency), muted: Boolean(a.protected) })) },
        ], footer: 'Кредитные деньги и ожидаемые возвраты не считаются свободными.' },
    };
  }
  if (kind === 'debts') {
    const list = await rows(db, "SELECT * FROM debts WHERE status='open' ORDER BY due_on,title");
    const lines = list.map(d => `• ${d.direction === 'owe' ? 'Вернуть' : 'Получить'}: ${d.title} — ${money(d.amount_minor,d.currency)}${d.due_on ? ' · ' + displayDate(d.due_on) : ''}`);
    return {
      text: `${greeting}, долговая книга:\n${lines.join('\n') || 'Открытых долгов нет.'}\n\nОжидаемые возвраты не считаю доступными деньгами.`,
      card: { eyebrow: 'СМАУГ · ДОЛГИ', title: 'Долговая книга', subtitle: `На ${displayDate(day)}`,
        total: '', sections: [{ heading: 'Открытые долги', rows: list.slice(0, 8).map(d => ({
          label: `${d.direction === 'owe' ? 'Вернуть' : 'Получить'} · ${d.title}`,
          value: money(d.amount_minor, d.currency),
        })) }], footer: 'Поступление учитывается только после подтверждения.' },
    };
  }
  if (kind === 'plan') {
    const budget = await budgetBreakdown(db, day, currency);
    const payments = await rows(db, "SELECT * FROM scheduled_payments WHERE status='planned' AND due_on>=? ORDER BY due_on LIMIT 8", day);
    const lines = payments.map(p => `• ${displayDate(p.due_on)} · ${p.title}: ${money(p.amount_minor,p.currency)}`);
    const budgetLine = budget ? `На эту неделю до ${displayDate(budget.weekEnd)} осталось ${money(Math.max(0,budget.weekLimit-budget.weekSpent),currency)} из ${money(budget.weekLimit,currency)}. На весь период ${displayDate(budget.budget.starts_on)}–${displayDate(budget.budget.ends_on)} осталось ${money(Math.max(0,budget.budget.remaining_minor),currency)} из ${money(budget.budget.limit_minor,currency)}.`
      : 'Утверждённый лимит на сегодня не задан.';
    return {
      text: `${greeting}, план казны:\n${budgetLine}\n\nБлижайшие платежи:\n${lines.join('\n') || 'Записанных платежей нет.'}`,
      card: { eyebrow: 'СМАУГ · ПЛАН', title: 'План казны', subtitle: `На ${displayDate(day)}`,
        total: budget ? money(Math.max(0,budget.weekLimit-budget.weekSpent),currency) : 'Лимит не задан',
        sections: [{ heading: 'Лимиты из одного плана', rows: budget ? [
          { label: 'Осталось на эту неделю', value: money(Math.max(0,budget.weekLimit-budget.weekSpent),currency) },
          { label: 'Осталось до конца периода', value: money(Math.max(0,budget.budget.remaining_minor),currency) },
        ] : [] }, { heading: 'Ближайшие платежи', rows: payments.slice(0, 6).map(p => ({
          label: `${displayDate(p.due_on)} · ${p.title}`, value: money(p.amount_minor,p.currency),
        })) }], footer: 'Ожидаемые доходы не считаются деньгами на карте.' },
    };
  }
  const mondayOffset = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  const weekStart = shiftDate(day, -mondayOffset);
  const monthStart = day.slice(0, 7) + '-01';
  const totals = await one(db, `SELECT
    COALESCE(SUM(CASE WHEN happened_on=? THEN amount_minor ELSE 0 END),0) today,
    COALESCE(SUM(CASE WHEN happened_on>=? THEN amount_minor ELSE 0 END),0) week,
    COALESCE(SUM(CASE WHEN happened_on>=? THEN amount_minor ELSE 0 END),0) month
    FROM ledger_entries WHERE kind='expense' AND currency=? AND happened_on<=?`,
    day, weekStart, monthStart, currency, day);
  const recent = await rows(db, `SELECT l.happened_on,l.note,l.amount_minor,l.currency,c.title category,a.title account
    FROM ledger_entries l LEFT JOIN categories c ON c.code=l.category_code
    JOIN accounts a ON a.id=l.account_id WHERE l.kind='expense'
    ORDER BY l.happened_on DESC,l.id DESC LIMIT 10`);
  const byCategory = await rows(db, `SELECT COALESCE(c.title,'Без категории') title,SUM(l.amount_minor) total
    FROM ledger_entries l LEFT JOIN categories c ON c.code=l.category_code
    WHERE l.kind='expense' AND l.currency=? AND l.happened_on BETWEEN ? AND ?
    GROUP BY l.category_code ORDER BY total DESC LIMIT 8`, currency, monthStart, day);
  const budget = await currentBudget(db, day, currency);
  const assessment = budget ? budget.remaining_minor < 0
    ? `Лимит превышен на ${money(-budget.remaining_minor,currency)}. Необязательные покупки отложи.`
    : `По плану осталось ${money(budget.remaining_minor,currency)}.`
    : 'Утверждённого лимита нет; соответствие плану пока не оцениваю.';
  const lines = recent.map(x => `• ${displayDate(x.happened_on)} · ${x.note} — ${money(x.amount_minor,x.currency)} · ${x.category || 'Без категории'} · ${x.account}`);
  return {
    text: `${greeting}, расходы: сегодня ${money(totals.today,currency)}, за неделю ${money(totals.week,currency)}, за месяц ${money(totals.month,currency)}.\n\n${assessment}\n\nПоследние записи:\n${lines.join('\n') || 'Записей пока нет.'}`,
    card: { eyebrow: 'СМАУГ · ИСТОРИЯ', title: 'Расходы', subtitle: `Месяц на ${displayDate(day)}`,
      total: money(totals.month,currency), sections: [
        { heading: 'Периоды', rows: [
          { label: 'Сегодня', value: money(totals.today,currency) },
          { label: 'Неделя', value: money(totals.week,currency) },
          { label: 'Месяц', value: money(totals.month,currency) },
        ] },
        { heading: 'Категории за месяц', rows: byCategory.slice(0, 5).map(x => ({ label: x.title, value: money(x.total,currency) })) },
      ], footer: assessment,
      pie: byCategory.map(x => ({ label: x.title, value: x.total })) },
  };
}

async function record(db, env, chatId, draft) {
  const result = await db.prepare(`INSERT OR IGNORE INTO ledger_entries
    (source_key,happened_on,kind,amount_minor,currency,account_id,category_code,budget_scope,note)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      draft.source_key, draft.day, draft.kind, draft.amount_minor, draft.currency,
      draft.account_id, draft.category_code, draft.budget_scope, draft.note,
    ).run();
  await clearDialog(db, chatId);
  if (!result.meta?.changes) return 'Эта операция уже записана. Повторно деньги не считаю.';
  const base = `${draft.kind === 'expense' ? 'Расход' : 'Доход'} ${money(draft.amount_minor,draft.currency)} записан на ${displayDate(draft.day)}.`;
  return draft.kind === 'expense' && draft.budget_scope === 'everyday'
    ? `${base}\n${await weeklyBudgetReply(db, env)}`
    : `${base} Дракон пересчитал казну.`;
}
async function completeDraft(db, env, chatId, draft, text = '') {
  const list = await accounts(db);
  const cats = await categories(db);
  const account = detectAccount(text, list) || list.find(a => a.id === draft.account_id)
    || await defaultAccount(db, list, draft.currency);
  const category = detectCategory(text, cats) || cats.find(c => c.code === draft.category_code);
  draft.account_id = account?.id || null;
  draft.category_code = draft.kind === 'expense' ? category?.code || null : null;
  draft.budget_scope = category?.default_scope || 'outside';
  if (!draft.account_id) {
    await setDialog(db, chatId, draft);
    return `Укажи счёт: ${list.map(a => a.title).join(', ') || 'сначала добавь счёт в D1'}.`;
  }
  if (draft.kind === 'expense' && !draft.category_code) {
    await setDialog(db, chatId, draft);
    return `К какой категории отнести? ${cats.map(c => c.title).join(', ')}.`;
  }
  if (account.currency !== draft.currency) return 'Валюта счёта и операции не совпадает. Уточни счёт.';
  return record(db, env, chatId, draft);
}

async function offer(db, env, chatId, text, updateId, now) {
  const purchase = parsePurchase(text);
  if (purchase.error) return 'Напиши, что хочешь купить и сколько это стоит. Дракон оценит.';
  const day = localDate(now, zoneOf(env));
  const baseCurrency = currencyOf(env);
  const list = await accounts(db);
  const available = list.filter(a => a.currency === baseCurrency && ['debit','cash'].includes(a.kind))
    .reduce((n, a) => n + a.current_minor, 0);
  const budget = await budgetBreakdown(db, day, baseCurrency);
  const until = budget?.budget.ends_on || day;
  const due = await obligations(db, day, until, baseCurrency);
  let assessment = assessPurchase({
    amount_minor: purchase.amount_minor, available_minor: available,
    obligations_minor: due, budget_remaining_minor: budget?.budget.remaining_minor ?? null,
  });
  if (budget && purchase.amount_minor > budget.weekLimit - budget.weekSpent)
    assessment = { ...assessment, level: 'stop', reason: `На эту неделю выделено ${money(budget.weekLimit,baseCurrency)}, уже потрачено ${money(budget.weekSpent,baseCurrency)}. Остаток всего периода не тратим раньше времени.` };
  else if (budget && purchase.amount_minor > budget.dayLimit - budget.daySpent && assessment.level === 'ok')
    assessment = { ...assessment, level: 'caution', reason: 'Покупка превышает средний дневной ориентир внутри недельного лимита.' };
  const state = { type: 'buy_offer', id: crypto.randomUUID(), source_key: `buy:${updateId}`,
    day, item: purchase.item, amount_minor: purchase.amount_minor,
    currency: baseCurrency };
  await setDialog(db, chatId, state);
  const lead = assessment.level === 'stop' ? 'Казна возражает. Эту покупку лучше отложить.'
    : assessment.level === 'unknown' ? 'Без утверждённого лимита безопасной эту покупку не назову.'
    : assessment.level === 'caution' ? 'Осторожно: покупка заберёт заметную часть лимита.'
    : 'Покупка помещается в текущий план.';
  return { text: `${nameOf(env)}, ${purchase.item} за ${money(purchase.amount_minor,baseCurrency)}.\n${lead}\n${assessment.reason}\nПосле покупки и известных платежей осталось бы ${money(assessment.after,baseCurrency)}. Это оценка, расход ещё не записан.`,
    markup: { inline_keyboard: [[
      { text: 'Покупка совершена ✅', callback_data: `buy:done:${state.id}` },
      { text: 'Отмена', callback_data: `buy:cancel:${state.id}` },
    ]] } };
}

async function answerCallback(env, id) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id }),
  }).catch(() => {});
}
async function renderCard(env, token, chatId, card, fallback) {
  try {
    if (!env.BROWSER) throw new Error('no_renderer');
    const image = await env.BROWSER.quickAction('screenshot', {
      html: infographicHtml(card), viewport: { width: 620, height: 790 },
      screenshotOptions: { type: 'png' },
    });
    if (!image.ok) throw new Error('render_failed');
    const bytes = await image.arrayBuffer();
    if (bytes.byteLength > 5_000_000) throw new Error('image_too_large');
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([bytes], { type: 'image/png' }), 'smaug.png');
    form.append('caption', 'Подробности доступны в команде с окончанием _list.');
    const sent = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    if (!sent.ok) throw new Error('send_failed');
  } catch {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: fallback }),
    });
  }
}

async function handleMessage(update, env, ctx) {
  const message = update.message;
  const callback = update.callback_query;
  const source = callback?.from || message?.from;
  const chat = callback?.message?.chat || message?.chat;
  if (!source || !chat || chat.type !== 'private' ||
      source.id !== chat.id || String(source.id) !== String(env.TELEGRAM_OWNER_ID)) return json({ ok: true });
  const db = env.FINANCE_DB;
  const chatId = chat.id;
  if (callback) {
    ctx?.waitUntil?.(answerCallback(env, callback.id));
    const match = /^buy:(done|cancel):([a-f0-9-]{36})$/.exec(callback.data || '');
    const state = await dialog(db, chatId);
    if (!match || state?.type !== 'buy_offer' || state.id !== match[2])
      return response(chatId, 'Эта кнопка уже не действует. Начни новую проверку через /buy.');
    if (match[1] === 'cancel') {
      await clearDialog(db, chatId);
      return response(chatId, 'Покупку отменил. В казне ничего не менял.');
    }
    const draft = { kind: 'expense', source_key: state.source_key, day: state.day,
      amount_minor: state.amount_minor, currency: state.currency, note: state.item };
    return response(chatId, await completeDraft(db, env, chatId, draft, state.item));
  }
  if (typeof message?.text !== 'string') return response(chatId, 'Напиши сообщение текстом.');
  const text = message.text.trim();
  const command = commandOf(text);
  const now = new Date();
  if (command === 'cancel' || /^отмена$/i.test(text)) {
    await clearDialog(db, chatId);
    return response(chatId, 'Отменено. Новых записей нет.');
  }
  if (['start','help'].includes(command)) return response(chatId,
    `Я Смауг, хранитель казны. /treasury, /plan, /debts, /history — карточки; добавь _list для списка. /buy — оценить покупку, /expense и /income — записать операцию. Можно писать «купила шампунь 500 ₽» или «хочу купить книгу за 800 ₽». Неясный счёт или категорию уточню. /cancel отменяет диалог.`);
  if (command === 'settings') return response(chatId,
    `Имя: ${nameOf(env)}. Часовой пояс: ${zoneOf(env)}. Валюта: ${currencyOf(env)}. Счета, лимиты и напоминания настраиваются в D1; смотри README.`);
  if (isWeeklyBudgetQuestion(text)) return response(chatId, await weeklyBudgetReply(db, env, now, text));
  const kinds = { treasury: 'treasury', treasury_list: 'treasury', plan: 'plan',
    plan_list: 'plan', plan_overview: 'plan', debts: 'debts', debts_list: 'debts',
    history: 'history', history_list: 'history', report: 'history' };
  if (kinds[command]) {
    const data = await overview(db, env, kinds[command], now);
    if (command.endsWith('_list') || !data.card) return response(chatId, data.text);
    if (!ctx?.waitUntil) return response(chatId, data.text);
    ctx.waitUntil(renderCard(env, env.TELEGRAM_BOT_TOKEN, chatId, data.card, data.text));
    return json({ ok: true });
  }
  if (command === 'buy' || isPurchaseIntent(text)) {
    const detail = command === 'buy' ? text.replace(/^\/buy(?:@[a-z_]+)?/i, '').trim() : text;
    if (!detail) {
      await setDialog(db, chatId, { type: 'buy_prompt' });
      return response(chatId, 'Пиши, что хочешь купить и сколько это стоит. Дракон оценит.');
    }
    const result = await offer(db, env, chatId, detail, update.update_id, now);
    return typeof result === 'string' ? response(chatId, result)
      : response(chatId, result.text, { reply_markup: result.markup });
  }
  const state = await dialog(db, chatId);
  if (state?.type === 'buy_prompt') {
    const result = await offer(db, env, chatId, text, update.update_id, now);
    return typeof result === 'string' ? response(chatId, result)
      : response(chatId, result.text, { reply_markup: result.markup });
  }
  if (state?.type === 'entry') return response(chatId, await completeDraft(db, env, chatId, state, text));
  const forcedKind = command === 'expense' ? 'expense' : command === 'income' ? 'income' : null;
  const detail = forcedKind ? text.replace(/^\/[a-z_]+(?:@[a-z_]+)?/i, '').trim() : text;
  if (forcedKind && !detail) {
    await setDialog(db, chatId, { type: 'entry_prompt', kind: forcedKind });
    return response(chatId, forcedKind === 'expense' ? 'Напиши, что купила и сколько заплатила.' : 'Напиши, сколько и на какой счёт пришло.');
  }
  const intent = forcedKind || (state?.type === 'entry_prompt' ? state.kind : null);
  if (intent || isCompletedExpense(text) || /получил[аи]?|пришла зарплата|пришел аванс/i.test(text)) {
    const parsed = parseOperation(detail, {
      accounts: await accounts(db), categories: await categories(db), now,
      timeZone: zoneOf(env), baseCurrency: currencyOf(env), forcedKind: intent,
    });
    if (parsed.error) return response(chatId, parsed.error);
    const draft = { type: 'entry', source_key: `message:${update.update_id}`,
      ...parsed };
    return response(chatId, await completeDraft(db, env, chatId, draft, text));
  }
  return response(chatId, 'Расскажи о покупке или поступлении с суммой, либо открой /help. Ничего не записал.');
}

async function sendScheduled(env, text) {
  const result = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: Number(env.TELEGRAM_OWNER_ID), text }),
  });
  if (!result.ok) throw new Error('telegram_send_failed');
}
async function scheduled(controller, env) {
  if (!env.FINANCE_DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OWNER_ID) return;
  const now = new Date(controller.scheduledTime);
  const day = localDate(now, zoneOf(env));
  const hour = localHour(now, zoneOf(env));
  const minute = Number(new Intl.DateTimeFormat('en-GB', { timeZone: zoneOf(env), minute: '2-digit' }).format(now));
  const morning = Number(setting(env, 'MORNING_HOUR', '9'));
  const evening = Number(setting(env, 'EVENING_HOUR', '21'));
  const eveningMinute = Number(setting(env, 'EVENING_MINUTE', '0'));
  let text = null, key = null;
  if (hour === morning && minute === 0) {
    const due = await rows(env.FINANCE_DB, `SELECT * FROM scheduled_payments
      WHERE status='planned' AND due_on BETWEEN ? AND ? ORDER BY due_on`, day, shiftDate(day, 3));
    const reminders = due.filter(p => [0,1,3].includes(Math.round(
      (Date.parse(p.due_on + 'T12:00:00Z') - Date.parse(day + 'T12:00:00Z')) / 86400000,
    ))).map(p => `• ${p.title}: ${money(p.amount_minor,p.currency)} · ${displayDate(p.due_on)}`);
    const budget = await currentBudget(env.FINANCE_DB, day, currencyOf(env));
    text = `${nameOf(env)}, доброе утро. ${budget ? 'На этот период осталось ' + money(budget.remaining_minor,currencyOf(env)) + '.' : 'Лимит на сегодня ещё не задан.'}${reminders.length ? '\n\nПлатежи на подходе:\n' + reminders.join('\n') : ''}`;
    key = `morning:${day}`;
  } else if (hour === evening && minute === eveningMinute) {
    const count = await one(env.FINANCE_DB, 'SELECT COUNT(*) n FROM ledger_entries WHERE happened_on=?', day);
    const variants = ['Дракон пересчитывает монеты. Все сегодняшние траты записаны?', 'Вечерняя сверка казны: не забылись ли мелкие покупки?', 'Казна готовится ко сну. Что сегодня изменилось?'];
    text = `${nameOf(env)}, ${variants[Number(day.replaceAll('-','')) % variants.length]}${!count.n ? '\nЗа день нет записей. День был бесплатным или что-то забылось?' : ''}`;
    key = `evening:${day}`;
  }
  if (!key || await one(env.FINANCE_DB, 'SELECT key FROM notification_log WHERE key=?', key)) return;
  await sendScheduled(env, text);
  await env.FINANCE_DB.prepare('INSERT OR IGNORE INTO notification_log(key) VALUES(?)').bind(key).run();
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return json({ ok: true, service: 'smaug' });
    if (request.method !== 'POST') return json({ ok: false }, 405);
    if (!env.FINANCE_DB || !env.TELEGRAM_BOT_TOKEN ||
        !sameSecret(request.headers.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_WEBHOOK_SECRET))
      return json({ ok: false }, 403);
    const update = await boundedUpdate(request);
    if (!update || !Number.isSafeInteger(update.update_id)) return json({ ok: false }, 400);
    try { return await handleMessage(update, env, ctx); }
    catch { return json({ ok: false, error: 'internal_error' }, 500); }
  },
  scheduled,
};
