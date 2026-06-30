import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBuddyPayload, atQuery, clampLimit } from '../src/worker.js';

test('validateBuddyPayload: корректная заявка проходит', () => {
  assert.equal(validateBuddyPayload({ Name: 'Аня', Telegram: '@anya_diver', Level: 'OWD', Location: 'Египет', About: 'Ищу бади' }), null);
  assert.equal(validateBuddyPayload({ Name: 'Аня', Telegram: 'anya_diver' }), null); // без @ тоже ок
});

test('validateBuddyPayload: имя обязательно и не короче 2', () => {
  assert.match(validateBuddyPayload({ Name: '', Telegram: '@anya_diver' }), /Имя/);
  assert.match(validateBuddyPayload({ Name: 'A', Telegram: '@anya_diver' }), /Имя/);
});

test('validateBuddyPayload: телеграм по формату', () => {
  assert.match(validateBuddyPayload({ Name: 'Аня', Telegram: '@ab' }), /Telegram/);        // слишком короткий
  assert.match(validateBuddyPayload({ Name: 'Аня', Telegram: '@плохой' }), /Telegram/);     // кириллица
  assert.match(validateBuddyPayload({ Name: 'Аня', Telegram: '' }), /Telegram/);            // пустой
});

test('validateBuddyPayload: недопустимый Level', () => {
  assert.match(validateBuddyPayload({ Name: 'Аня', Telegram: '@anya_diver', Level: 'Бог' }), /Level/);
});

test('validateBuddyPayload: лимиты длины', () => {
  assert.match(validateBuddyPayload({ Name: 'A'.repeat(101), Telegram: '@anya_diver' }), /длинн/);
  assert.match(validateBuddyPayload({ Name: 'Аня', Telegram: '@anya_diver', About: 'x'.repeat(1001) }), /длинн/);
});

test('atQuery: fields[] и sort[i] в формате Airtable, пробелы как %20', () => {
  const q = atQuery({
    filterByFormula: 'AND({Approved}=1, {Status}="Ищет бади")',
    sort: [{ field: 'Created', direction: 'desc' }],
    fields: ['Name', 'Level'],
    maxRecords: 3,
  });
  // URLSearchParams кодирует скобки (%5B%5D) — проверяем по декодированной строке
  const dq = decodeURIComponent(q);
  assert.ok(dq.includes('fields[]=Name'));
  assert.ok(dq.includes('fields[]=Level'));
  assert.ok(dq.includes('sort[0][field]=Created'));
  assert.ok(dq.includes('sort[0][direction]=desc'));
  assert.ok(dq.includes('maxRecords=3'));
  // в сырой строке пробелы — %20, не +
  assert.ok(!/\+/.test(q), 'пробелы должны кодироваться как %20, не +');
  assert.ok(q.includes('%20'));
});

test('atQuery: пустой вызов не падает', () => {
  assert.equal(typeof atQuery(), 'string');
});

test('clampLimit: число в [1,100], иначе дефолт 100', () => {
  assert.equal(clampLimit('2'), 2);
  assert.equal(clampLimit('99999'), 100);   // верхний потолок
  assert.equal(clampLimit('0'), 1);          // нижний потолок
  assert.equal(clampLimit('-5'), 1);
  assert.equal(clampLimit('abc'), 100);      // не число → дефолт
  assert.equal(clampLimit(null), 100);       // отсутствует → дефолт
});
