-- A fresh installation has no accounts, balances, debts or personal settings.
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL UNIQUE,
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(aliases_json)),
  currency TEXT NOT NULL DEFAULT 'RUB',
  kind TEXT NOT NULL CHECK(kind IN ('debit','cash','savings','credit')),
  balance_minor INTEGER NOT NULL DEFAULT 0,
  balance_as_of TEXT NOT NULL DEFAULT (datetime('now')),
  balance_ledger_id INTEGER NOT NULL DEFAULT 0,
  protected INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 100
);
CREATE TABLE categories (
  code TEXT PRIMARY KEY, title TEXT NOT NULL UNIQUE,
  keywords_json TEXT NOT NULL CHECK(json_valid(keywords_json)),
  default_scope TEXT NOT NULL DEFAULT 'everyday'
    CHECK(default_scope IN ('everyday','outside'))
);
CREATE TABLE budget_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL,
  limit_minor INTEGER NOT NULL CHECK(limit_minor >= 0), currency TEXT NOT NULL DEFAULT 'RUB',
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','draft')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), CHECK(starts_on <= ends_on)
);
CREATE TABLE scheduled_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, due_on TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL DEFAULT 'RUB',
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','paid','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('owe','receivable')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0), currency TEXT NOT NULL DEFAULT 'RUB',
  due_on TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT NOT NULL UNIQUE,
  happened_on TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('expense','income')),
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0), currency TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id), category_code TEXT REFERENCES categories(code),
  budget_scope TEXT NOT NULL CHECK(budget_scope IN ('everyday','outside')),
  note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE dialogs (
  chat_id INTEGER PRIMARY KEY, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE notification_log (
  key TEXT PRIMARY KEY, sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ledger_date_idx ON ledger_entries(happened_on DESC,id DESC);
CREATE INDEX payment_due_idx ON scheduled_payments(due_on,status);
CREATE INDEX budget_dates_idx ON budget_periods(starts_on,ends_on,status);
INSERT INTO categories(code,title,keywords_json,default_scope) VALUES
 ('groceries','Продукты','["продукты","супермаркет","овощи","молоко"]','everyday'),
 ('dining','Еда вне дома','["кафе","ресторан","доставка еды","обед"]','everyday'),
 ('coffee','Кофе','["кофе","латте","капучино","эспрессо","зерна"]','everyday'),
 ('alcohol_tobacco','Алкоголь и табак','["алкоголь","вино","пиво","сигареты","табак"]','everyday'),
 ('pets','Питомцы','["собак","кошк","питом","ветеринар","корм для","шлейк"]','everyday'),
 ('psychologist','Психолог','["психолог","психотерап"]','outside'),
 ('medicine','Медицина','["врач","аптек","лекарств","стоматолог"]','outside'),
 ('carshare','Каршеринг','["каршеринг"]','everyday'),
 ('taxi','Такси','["такси"]','everyday'),
 ('public_transport','Общественный транспорт','["метро","тройк","электричк","автобус","трамвай"]','everyday'),
 ('housing','Жильё и связь','["аренд","коммунал","интернет","вайфай","мобильная связь"]','outside'),
 ('home','Для дома','["посуда","постельное","полотенц","порошок","чистящее"]','everyday'),
 ('care','Уход','["маникюр","стрижк","эпиляц","косметолог"]','everyday'),
 ('clothing','Одежда','["одежд","обув","куртк"]','everyday'),
 ('cosmetics','Косметика','["шампун","крем","зубная паста","косметик"]','everyday'),
 ('leisure','Досуг','["кино","театр","концерт","бар"]','everyday'),
 ('other','Другое','[]','everyday');
