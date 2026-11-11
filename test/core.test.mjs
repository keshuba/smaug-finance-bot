import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessPurchase, isWeeklyBudgetQuestion, monthlyDueDate, nextMonthlyDue,
  parseOperation, parsePurchase, parseRecurringPayment, recurringOccurrences,
} from '../src/core.js';
import worker, { weeklyBudgetReply } from '../src/index.js';

const account = { id: 1, title: 'Основная карта', aliases_json: '["карта","карты"]', currency: 'RUB' };
const category = { code: 'cosmetics', title: 'Косметика', keywords_json: '["шампунь"]', default_scope: 'everyday' };

test('понятная совершённая покупка разбирается без выдумывания данных', () => {
  const parsed = parseOperation('вчера купила шампунь за 500 с карты', {
    accounts: [account], categories: [category],
    now: new Date('2026-04-02T12:00:00Z'),
  });
  assert.equal(parsed.day, '2026-04-01');
  assert.equal(parsed.amount_minor, 50000);
  assert.equal(parsed.account_id, 1);
  assert.equal(parsed.category_code, 'cosmetics');
});

test('несколько сумм не превращаются в одну операцию', () => {
  const parsed = parseOperation('купила шампунь 500 и крем 800', {
    accounts: [account], categories: [category],
  });
  assert.match(parsed.error, /одну сумму/);
});

test('покупка остаётся оценкой и не проходит при нехватке лимита', () => {
  assert.deepEqual(parsePurchase('хочу купить книгу за 800'),
    { item: 'книгу', amount_minor: 80000 });
  const verdict = assessPurchase({
    amount_minor: 80000, available_minor: 300000,
    obligations_minor: 100000, budget_remaining_minor: 50000,
  });
  assert.equal(verdict.level, 'stop');
});

test('обычный вопрос о неделе распознаётся', () => {
  assert.equal(isWeeklyBudgetQuestion('какой лимит на неделю?'), true);
  assert.equal(isWeeklyBudgetQuestion('сколько можно потратить на этой неделе?'), true);
  assert.equal(isWeeklyBudgetQuestion('хочу купить книгу'), false);
});

function fakeBudgetDb(plan, spent = 500000) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('FROM budget_periods')) return plan;
              if (sql.includes('FROM ledger_entries')) return { total: spent };
              throw new Error('unexpected query');
            },
          };
        },
      };
    },
  };
}

test('недельная часть общего плана не пополняется оставшимися деньгами периода', async () => {
  const text = await weeklyBudgetReply(fakeBudgetDb({
    starts_on: '2026-04-01', ends_on: '2026-04-14',
    limit_minor: 1400000, spent_minor: 500000, remaining_minor: 900000,
  }), { OWNER_NAME: 'Тест', BASE_CURRENCY: 'RUB' }, new Date('2026-04-02T12:00:00Z'));
  const readable = text.replace(/\u00a0/g, ' ');
  assert.match(readable, /до 05\.04\.2026 по плану можешь потратить 0,00/);
  assert.match(readable, /Недельные 5 000,00.*уже потрачены/);
  assert.match(readable, /Общий лимит — 14 000,00/);
  assert.match(readable, /9 000,00.*06\.04\.2026–14\.04\.2026/);
  assert.doesNotMatch(readable, /продукты|кофе|косметик/);
});

test('без плана не обещает безопасную сумму', async () => {
  const text = await weeklyBudgetReply(fakeBudgetDb(null),
    { OWNER_NAME: 'Тест' }, new Date('2026-04-02T12:00:00Z'));
  assert.match(text, /общий план до выплаты ещё не утверждён/);
});

test('webhook отвергает запрос без секретного заголовка', async () => {
  const result = await worker.fetch(new Request('https://example.workers.dev/', {
    method: 'POST', body: '{}',
  }), { FINANCE_DB: {}, TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_WEBHOOK_SECRET: 'secret' });
  assert.equal(result.status, 403);
});

test('вечерний вопрос приходит лишь в день без записанных расходов', async () => {
  const queries = [];
  const fakeDb = expenseCount => ({
    prepare(sql) {
      queries.push(sql);
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('FROM ledger_entries')) return { n: expenseCount };
              if (sql.includes('FROM notification_log')) return null;
              throw new Error('unexpected query');
            },
            async run() { return { success: true }; },
          };
        },
      };
    },
  });
  const controller = { scheduledTime: Date.parse('2026-04-02T19:30:00Z') };
  const config = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_OWNER_ID: '123',
    OWNER_NAME: 'Тест', TIME_ZONE: 'Europe/Moscow', EVENING_HOUR: '22', EVENING_MINUTE: '30' };
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return new Response('{}', { status: 200 });
  };
  try {
    await worker.scheduled(controller, { ...config, FINANCE_DB: fakeDb(1) });
    assert.equal(sent.length, 0);
    await worker.scheduled(controller, { ...config, FINANCE_DB: fakeDb(0) });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /День был бесплатным/);
    assert.ok(queries.some(sql => sql.includes("kind='expense'")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('регулярный платёж разбирается без путаницы дня и суммы', () => {
  assert.deepEqual(parseRecurringPayment('20 800 Вайфай'),
    { day_of_month: 20, amount_minor: 80000, title: 'Вайфай' });
  assert.deepEqual(parseRecurringPayment('/remind 5 1299,50 Подписка'),
    { day_of_month: 5, amount_minor: 129950, title: 'Подписка' });
  assert.match(parseRecurringPayment('20 1 200 Вайфай').error, /Назови платёж/);
});

test('31-е число короткого месяца переносится на его последний день', () => {
  assert.equal(monthlyDueDate('2027-02', 31), '2027-02-28');
  assert.equal(nextMonthlyDue('2027-02-28', 31), '2027-02-28');
  assert.deepEqual(recurringOccurrences([{ title: 'Тест', day_of_month: 31 }],
    '2027-02-27', '2027-03-01').map(x => x.due_on), ['2027-02-28']);
});
