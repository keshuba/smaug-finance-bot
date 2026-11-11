-- Example only. Replace zero balances with a real, simultaneous reconciliation.
-- Never publish your edited copy. Apply it to your own D1 database.
INSERT INTO accounts(title,aliases_json,currency,kind,balance_minor,protected,sort_order)
VALUES ('Основная карта','["основная карта"]','RUB','debit',0,0,1),
       ('Наличные','["наличные"]','RUB','cash',0,0,2),
       ('Накопления','["накопления"]','RUB','savings',0,1,3);
INSERT INTO settings(key,value) VALUES ('default_account_id','1');
