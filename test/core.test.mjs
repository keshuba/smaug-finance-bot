import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessPurchase, isWeeklyBudgetQuestion, parseOperation, parsePurchase,
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
