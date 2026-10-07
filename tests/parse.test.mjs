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
  const fn = opts.message ? CP.parseMessage : CP.parseChat;
  const p = fn(text, { now: opts.now || NOW, medications: opts.medications || [], forceKind: opts.forceKind });
  const errors = [];
  let res; try { res = checks(p); } catch (e) { res = [['threw: ' + e.message, false]]; }
  for (const [label, ok] of res) if (!ok) errors.push(label);
  if (errors.length) {
    fail++;
    console.log('FAIL', name, '「' + text + '」');
    errors.forEach(e => console.log('   ✗', e));
    console.log('   got:', JSON.stringify(p?.kind === 'multi' ? p.items.map(i => ({ kind: i.kind, fields: i.fields })) : { kind: p?.kind, title: p?.title, fields: p?.fields, items: p?.items, meds: p?.meds, targetKind: p?.targetKind }));
  } else {
    pass++;
    if (p === null) { console.log('PASS', name, '「' + text + '」 → null'); return; }
    const one = x => x.kind + ' ' + (x.fields ? x.fields.map(f => f.k + '=' + f.v).join(' / ') : (x.summary || '').replace(/\n/g, ' '));
    console.log('PASS', name, '「' + text.replace(/\n/g, '⏎') + '」 →', p.kind === 'multi' ? '\n      ' + p.items.map(one).join('\n      ') : one(p));
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

// ===== Phone feedback (2nd round) =====
test('12 切れた→買い物+場所', 'トイレットペーパーが切れた、近くのセブンで調達予定', p => [
  ['kind shopping', p.kind === 'shopping'],
  ['items [トイレットペーパー]', arr(p.items) === arr(['トイレットペーパー'])],
  ['場所 セブン', p.place === 'セブン' && field(p, '場所') === 'セブン'],
  ['title/items never raw sentence', !(p.items || []).some(x => /切れた|調達/.test(x))]
]);
test('13 なくなった→買い物', 'シャンプーがなくなった', p => [
  ['kind shopping', p.kind === 'shopping'], ['items [シャンプー]', arr(p.items) === arr(['シャンプー'])]
]);
test('14 ToDo強制でも要約タイトル', 'トイレットペーパーが切れた、近くのセブンで調達予定', p => [
  ['kind todo', p.kind === 'todo'], ['title トイレットペーパーを買う', p.title === 'トイレットペーパーを買う'],
  ['guessKind shopping', p.guessKind === 'shopping']
], { forceKind: 'todo' });
test('15 用量→服薬', '夜 ストラテラ10mg×2錠', p => [
  ['kind medication', p.kind === 'medication'],
  ['name ストラテラ', p.meds.length === 1 && p.meds[0].name === 'ストラテラ'],
  ['dose 10mg×2錠', p.meds[0].dose === '10mg×2錠'],
  ['times [20:00]', arr(p.meds[0].times) === arr(['20:00'])]
]);
test('16 複数薬+命令語除去', '服薬タブを変更、朝コンサータ27mg×2錠 ストラテラ40mg×1錠 亜鉛サプリ×1錠', p => [
  ['kind medication', p.kind === 'medication'],
  ['3 meds', p.meds.length === 3],
  ['names', arr(p.meds.map(m => m.name)) === arr(['コンサータ', 'ストラテラ', '亜鉛サプリ'])],
  ['doses', arr(p.meds.map(m => m.dose)) === arr(['27mg×2錠', '40mg×1錠', '×1錠'])],
  ['all 朝 08:00', p.meds.every(m => arr(m.times) === arr(['08:00']))],
  ['no command words in names', !p.meds.some(m => /服薬|タブ|変更/.test(m.name))]
]);
test('17 毎朝+必須→毎日の必須', '毎朝7時に散歩 必須', p => [
  ['kind daily', p.kind === 'daily'], ['title 散歩', p.title === '散歩'],
  ['time 07:00', p.time === '07:00'], ['recurring daily / required', p.recurring === 'daily' && p.required === true]
]);
test('18 毎日→毎日の必須', '毎日 筋トレ', p => [
  ['kind daily', p.kind === 'daily'], ['title 筋トレ', p.title === '筋トレ'], ['time null', p.time === null]
]);
test('19 訂正: サブタスクではなく〜', 'サブタスクではなくメイン任務', p => [
  ['kind correction (not a task)', p.kind === 'correction'], ['target main_task', p.targetKind === 'main_task']
]);
test('20 訂正: 買い物にして', '買い物にして', p => [
  ['kind correction', p.kind === 'correction'], ['target shopping', p.targetKind === 'shopping']
]);
test('21 訂正: 種類不明→確認', 'サブタスクじゃない', p => [
  ['kind correction', p.kind === 'correction'], ['target null (ask)', p.targetKind === null]
]);
test('22 箇条書き混在', '・明日10時 市役所で住民票\n・牛乳と卵を買う\n・夜 ストラテラ10mg×2錠\n・金曜 病院\n  ・診察券\n  ・保険証', p => {
  const it = p.items || [];
  return [
    ['kind multi / 4 items', p.kind === 'multi' && it.length === 4],
    ['1 main 住民票@市役所 10/8 10:00', it[0]?.kind === 'main_task' && it[0].title === '住民票' && it[0].location === '市役所' && field(it[0], '日時') === '10/8(木) 10:00'],
    ['2 shopping 牛乳,卵', it[1]?.kind === 'shopping' && arr(it[1].items) === arr(['牛乳', '卵'])],
    ['3 medication ストラテラ 10mg×2錠 夜', it[2]?.kind === 'medication' && it[2].meds[0].name === 'ストラテラ' && arr(it[2].meds[0].times) === arr(['20:00'])],
    ['4 main 病院 金 + 持ち物 診察券,保険証', it[3]?.kind === 'main_task' && it[3].title === '病院' && arr(it[3].bring) === arr(['診察券', '保険証'])]
  ];
}, { message: true });
test('23 見出し+持ち物', '明日市役所\n・印鑑\n・保険証', p => [
  ['single main_task (not multi)', p.kind === 'main_task'],
  ['場所 市役所', p.location === '市役所'],
  ['date 10/8', dayKey(new Date(p.deadline)) === '2026-10-08'],
  ['持ち物 [印鑑, 保険証]', arr(p.bring) === arr(['印鑑', '保険証'])]
], { message: true });
test('24 買い物見出し+番号付き', '買い物:\n1. 牛乳\n2. 卵\n3. 洗剤', p => [
  ['shopping', p.kind === 'shopping'], ['items 3', arr(p.items) === arr(['牛乳', '卵', '洗剤'])]
], { message: true });
test('25 番号リスト: 任務/切れた/毎晩', '1. 明日ゴミ出し\n2. シャンプーがなくなった\n3. 毎晩ストレッチ', p => {
  const it = p.items || [];
  return [
    ['3 items', p.kind === 'multi' && it.length === 3],
    ['main ゴミ出し', it[0]?.kind === 'main_task' && it[0].title === 'ゴミ出し'],
    ['shopping シャンプー', it[1]?.kind === 'shopping' && arr(it[1].items) === arr(['シャンプー'])],
    ['daily ストレッチ 20:00', it[2]?.kind === 'daily' && it[2].title === 'ストレッチ' && it[2].time === '20:00']
  ];
}, { message: true });
test('26 命令語だけ→null', '服薬タブを変更', p => [['null (ask user)', p === null]]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
