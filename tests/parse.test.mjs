// Self-test for the chat parser (parser.js). No deps.  Run:  node tests/parse.test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(here, '..', 'parser.js'), 'utf8'), ctx, { filename: 'parser.js' });
const CP = ctx.ChatParser;

// Fixed "now": Wed 2026-10-07 14:00 local
const NOW = new Date(2026, 9, 7, 14, 0, 0);
const dayKey = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const hm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
const field = (p, k) => (p.fields || []).find(f => f.k === k)?.v;
const arr = a => JSON.stringify(Array.from(a || []));

let pass = 0, fail = 0;
function test(name, text, checks, opts = {}) {
  const p = CP.parseChat(text, { now: opts.now || NOW, medications: opts.medications || [] });
  const errors = [];
  for (const [label, ok] of checks(p)) if (!ok) errors.push(label);
  if (errors.length) {
    fail++;
    console.log('FAIL', name, '「' + text + '」');
    errors.forEach(e => console.log('   ✗', e));
    console.log('   got:', JSON.stringify({ kind: p?.kind, fields: p?.fields, items: p?.items, name: p?.name, times: p?.times, deadline: p?.deadline }));
  } else {
    pass++;
    console.log('PASS', name, '「' + text + '」 →', p.fields ? p.fields.map(f => f.k + '=' + f.v).join(' / ') : (p.kind + ' ' + (p.summary || '').replace(/\n/g, ' ')));
  }
}

// 1. 日時 + 場所 + 持ち物
test('1 市役所/持ち物', '明日10時に市役所で住民票、印鑑と保険証を持っていく', p => {
  const d = new Date(p.deadline);
  return [
    ['kind main_task', p.kind === 'main_task'],
    ['任務 contains 住民票', /住民票/.test(p.title)],
    ['日時 label present (not 期限)', !!field(p, '日時') && !field(p, '期限')],
    ['date = tomorrow 2026-10-08', dayKey(d) === '2026-10-08'],
    ['time 10:00', hm(d) === '10:00'],
    ['場所 市役所', p.location === '市役所'],
    ['持ち物 [印鑑, 保険証]', arr(p.bring) === arr(['印鑑', '保険証'])],
    ['no 買うもの', p.buy.length === 0],
    // bath: deadline local day == tomorrow → hasOutingOn(tomorrow) → 入浴必須
    ['bath: deadline is tomorrow', dayKey(d) === dayKey(new Date(2026, 9, 8))]
  ];
});

// 2. 曜日+時刻 + 買うもの
test('2 歯医者/買い物', '金曜15時歯医者、帰りに牙ブラシを買う', p => {
  const d = new Date(p.deadline);
  return [
    ['kind main_task', p.kind === 'main_task'],
    ['任務 歯医者', p.title === '歯医者'],
    ['Fri', d.getDay() === 5],
    ['date 2026-10-09', dayKey(d) === '2026-10-09'],
    ['time 15:00', hm(d) === '15:00'],
    ['買うもの [牙ブラシ]', arr(p.buy) === arr(['牙ブラシ'])],
    ['no 持ち物', p.bring.length === 0]
  ];
});

// 3. 期限 + 場所
test('3 期限/郵便局', '10/20までに年金の書類を郵便局で出す', p => {
  const d = new Date(p.deadline);
  return [
    ['kind main_task', p.kind === 'main_task'],
    ['期限 field', !!field(p, '期限') && !field(p, '日時')],
    ['deadlineKind deadline', p.deadlineKind === 'deadline'],
    ['date 2026-10-20', dayKey(d) === '2026-10-20'],
    ['場所 郵便局', p.location === '郵便局'],
    ['任務 年金の書類を出す', p.title === '年金の書類を出す']
  ];
});

// 4. 純粋な買い物（従来通り）
test('4 買い物のみ', '牛乳と卵を買う', p => [
  ['kind shopping', p.kind === 'shopping'],
  ['items [牛乳, 卵]', arr(p.items) === arr(['牛乳', '卵'])]
]);

// 5. 服薬（従来通り）
test('5 服薬', '朝と夜にビタミンを飲む', p => [
  ['kind medication', p.kind === 'medication'],
  ['name ビタミン', p.name === 'ビタミン'],
  ['times [08:00, 20:00]', arr(p.times) === arr(['08:00', '20:00'])]
]);

// --- extra regression checks ---
test('6 服薬マージ', 'ビタミンを夜に飲む', p => [
  ['kind medication (merge)', p.kind === 'medication' && p.mergeIntoId === 'm1'],
  ['newTimes [20:00]', arr(p.newTimes) === arr(['20:00'])]
], { medications: [{ id: 'm1', name: 'ビタミン', times: ['08:00'], enabled: true }] });

test('6b 毎朝8時', '毎朝8時にビタミンを飲む', p => [
  ['kind medication', p.kind === 'medication'],
  ['name ビタミン', p.name === 'ビタミン'],
  ['times [08:00]', arr(p.times) === arr(['08:00'])]
]);

test('7 薬を買う→買い物', '薬を買う', p => [
  ['kind shopping', p.kind === 'shopping'],
  ['items [薬]', arr(p.items) === arr(['薬'])]
]);

test('8 ToDo', '部屋の電球を替える', p => [
  ['kind todo', p.kind === 'todo']
]);

test('9 場所まで+同行メモ', '明日母と西条駅まで迎えに行く', p => [
  ['kind main_task', p.kind === 'main_task'],
  ['場所 西条駅', p.location === '西条駅'],
  ['メモ 母と', /母/.test(p.memo)],
  ['任務 迎えに行く', p.title === '迎えに行く']
]);

test('10 、区切りの持ち物', '来週月曜14時半に病院、診察券、お薬手帳、保険証を持っていく', p => {
  const d = new Date(p.deadline);
  return [
    ['date 2026-10-12 14:30', dayKey(d) === '2026-10-12' && hm(d) === '14:30'],
    ['持ち物 3件', arr(p.bring) === arr(['診察券', 'お薬手帳', '保険証'])],
    ['任務 病院', p.title === '病院']
  ];
});

test('11 実時刻の明日', '明日9時に銀行で振込', p => {
  const real = new Date();
  const tmr = new Date(real.getFullYear(), real.getMonth(), real.getDate() + 1);
  return [['deadline is real tomorrow', dayKey(new Date(p.deadline)) === dayKey(tmr)], ['場所 銀行', p.location === '銀行']];
}, { now: new Date() });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
