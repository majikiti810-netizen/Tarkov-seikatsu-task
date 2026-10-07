/*! ChatParser — rule-based Japanese chat parser for デイリー任務 (no DOM, no deps)
 * One natural sentence (or a bullet / multi-line list) -> structured items:
 *   任務(title) / 日時 or 期限(when) / 場所(location) / 持ち物(bring) / 買うもの(buy) / メモ(memo)
 * Kinds: main_task / todo / daily / shopping / medication  (+ correction / multi)
 * Exposed as global `ChatParser` (browser: window.ChatParser; node vm: globalThis.ChatParser).
 * Used by app.js and tests/parse.test.mjs.  Records only what the user typed (no medical advice).
 */
(function (root) {
  'use strict';

  const WEEKDAYS = { '日':0,'月':1,'火':2,'水':3,'木':4,'金':5,'土':6 };
  const WEEKDAY_NAMES = ['日','月','火','水','木','金','土'];
  const SLOT_TIMES = { '朝':'08:00', '昼':'12:00', '夜':'20:00' };
  const TIME_TO_SLOT = Object.fromEntries(Object.entries(SLOT_TIMES).map(([k,v]) => [v, k]));

  const KINDS = ['main_task', 'todo', 'daily', 'shopping', 'medication'];
  const KIND_LABEL = {
    main_task: 'メイン任務', todo: 'サブタスク', daily: '毎日の必須', shopping: '買い物', medication: '服薬'
  };

  // ---- time helpers (same semantics as app.js medication helpers) ----
  function canonicalizeTimeToken(t) {
    if (t == null) return null;
    const s = String(t).trim();
    if (!s) return null;
    if (SLOT_TIMES[s]) return SLOT_TIMES[s];
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const h = Math.min(23, parseInt(m[1], 10));
      const mi = Math.min(59, parseInt(m[2], 10));
      return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
    }
    return null;
  }
  function dedupeTimes(arr) {
    const out = []; const seen = new Set();
    (arr || []).forEach(t => {
      const c = canonicalizeTimeToken(t);
      if (!c || seen.has(c)) return;
      seen.add(c); out.push(c);
    });
    return out;
  }
  function normalizeTimeLabel(t) {
    const hhmm = canonicalizeTimeToken(t);
    if (!hhmm) return { key: String(t), hhmm: null, label: String(t) };
    const slot = TIME_TO_SLOT[hhmm];
    return { key: hhmm, hhmm, label: slot ? (slot + ' (' + hhmm + ')') : hhmm };
  }

  // ---- text normalization (single line) ----
  function normalize(text) {
    return String(text || '')
      .replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/：/g, ':').replace(/／/g, '/').replace(/[，,]/g, '、')
      .replace(/[＊✕✖]/g, '×')
      .replace(/(mg|mcg|μg|IU|\d)\s*[xX]\s*(\d)/g, '$1×$2')
      .replace(/[\r\n]+/g, '、')
      .replace(/　/g, ' ')
      .replace(/[。！!？?]+\s*$/, '')
      .trim();
  }

  // ---- WHEN ----
  const M_DATE = '\u0001D';
  const M_TIME = '\u0001T';
  const TIME_RE = /(午前|午後|毎?(?:朝|夜|晩)|夕方)?\s*(\d{1,2})\s*(?:時(?!間)\s*(?:(\d{1,2})\s*分|(半))?|:(\d{2}))/;

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

  const DATE_RULES = [
    { re: /(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})\s*日?/, fn: (m, today) => {
        const mo = +m[1], da = +m[2];
        if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
        let d = new Date(today.getFullYear(), mo - 1, da);
        if (d < today) d = new Date(today.getFullYear() + 1, mo - 1, da);
        return d;
      } },
    { re: /明後日|あさって/, fn: (m, today) => addDays(today, 2) },
    { re: /明日|あした/, fn: (m, today) => addDays(today, 1) },
    { re: /今日|本日/, fn: (m, today) => today },
    { re: /(再来週|来週|今週|今度|次)?\s*の?\s*([日月火水木金土])曜日?/, fn: (m, today) => {
        let diff = WEEKDAYS[m[2]] - today.getDay();
        if (m[1] === '来週') diff += 7;
        else if (m[1] === '再来週') diff += 14;
        else if (diff <= 0) diff += 7;
        return addDays(today, diff);
      } },
    { re: /(\d{1,2})\s*日(?!\s*\d*\s*回|間|分|おき|ごと)/, fn: (m, today) => {
        const da = +m[1];
        if (da < 1 || da > 31) return null;
        let d = new Date(today.getFullYear(), today.getMonth(), da);
        if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, da);
        return d;
      } }
  ];

  /** Extract date/time/deadline. Returns rest text with those tokens replaced by '、'. */
  function extractWhen(text, now) {
    now = now || new Date();
    const today = startOfDay(now);
    let s = String(text || '');
    let date = null, dateWord = false, hasTime = false, h = 0, mi = 0, isDeadline = false;

    for (const rule of DATE_RULES) {
      const m = s.match(rule.re);
      if (!m) continue;
      const v = rule.fn(m, today);
      if (!v) continue;
      date = v; dateWord = true;
      s = s.slice(0, m.index) + M_DATE + s.slice(m.index + m[0].length);
      break;
    }
    const tm = s.match(TIME_RE);
    if (tm) {
      h = Math.min(23, parseInt(tm[2], 10));
      mi = tm[3] != null ? Math.min(59, parseInt(tm[3], 10)) : (tm[4] ? 30 : (tm[5] != null ? Math.min(59, parseInt(tm[5], 10)) : 0));
      if (/午後|夜|夕方|晩/.test(tm[1] || '') && h < 12) h += 12;
      hasTime = true;
      s = s.slice(0, tm.index) + M_TIME + s.slice(tm.index + tm[0].length);
      if (!date) date = today;
    }
    const MK = '((?:\\u0001[DT]\\s*(?:の\\s*)?)+)';
    s = s.replace(new RegExp('(?:締め?切り?|〆切|しめきり|期限)\\s*(?:は|が|:)?\\s*' + MK), (all, g) => { isDeadline = true; return g; });
    s = s.replace(new RegExp(MK + '(?:まで(?:に|で)?|が?(?:締め?切り?|〆切|しめきり|期限)(?:は|で|の)?)'), (all, g) => { isDeadline = true; return g; });
    s = s.replace(/\u0001[DT]\s*(?:の|に|から|頃|ごろ|くらい|ぐらい|は|、|\s)*/g, '、');

    let when = null;
    if (date) {
      when = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hasTime ? h : 23, hasTime ? mi : 59, 0, 0);
    }
    const every = String(text || '').match(/毎(朝|昼|夜|晩)/);
    return {
      date: when, hasDate: !!when, dateWord, hasTime,
      timeStr: hasTime ? String(h).padStart(2,'0') + ':' + String(mi).padStart(2,'0') : null,
      isDeadline,
      recurringSlot: every ? (every[1] === '晩' ? '夜' : every[1]) : null,
      rest: s
    };
  }

  /** Backward-compatible parseWhen(text) */
  function parseWhen(text, now) {
    const w = extractWhen(normalize(text), now);
    return { date: w.date, timeStr: w.timeStr, recurringSlot: w.recurringSlot, hasDate: w.hasDate };
  }

  function whenLabel(d, hasTime) {
    if (!d) return '';
    return (d.getMonth() + 1) + '/' + d.getDate() + '(' + WEEKDAY_NAMES[d.getDay()] + ')' +
      (hasTime ? ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') : '');
  }

  // ---- WHERE ----
  const PLACE_SUFFIXES = [
    '市役所','区役所','町役場','村役場','役所','役場','市民センター','ホームセンター','センター','年金事務所','事務所',
    '病院','医院','クリニック','歯科','歯医者','眼科','皮膚科','内科','外科','耳鼻科','整形外科',
    '駅','バス停','空港','港','銀行','信用金庫','郵便局','学校','高校','大学','保育園','幼稚園',
    '図書館','公民館','会館','ホール','薬局','ドラッグストア','業務スーパー','スーパー','コンビニ','百貨店','デパート',
    'モール','店','屋','会社','オフィス','職場','ハローワーク','警察署','交番','税務署','法務局',
    'ジム','美容院','美容室','床屋','公園','ホテル','実家','自宅','家',
    'イオン','ダイソー','ニトリ','ユニクロ',
    'セブンイレブン','セブン-イレブン','セブン','ローソン','ファミリーマート','ファミマ','ミニストップ',
    'マツモトキヨシ','マツキヨ','ツルハ','ウエルシア','コスモス','ドン・キホーテ','ドンキ',
    'セリア','カインズ','コメリ','無印','Amazon','アマゾン','楽天'
  ];
  const PLACE_CHARS = '[一-龥々〆ヵヶァ-ヴーA-Za-z0-9]';
  const PLACE_RE = new RegExp('(' + PLACE_CHARS + '*?(?:' + PLACE_SUFFIXES.join('|') + ')(?:前|内|近く)?)(にて|まで|から|で|に|へ)');
  const PLACE_ONLY_RE = new RegExp('^' + PLACE_CHARS + '*?(?:' + PLACE_SUFFIXES.join('|') + ')$');
  function extractPlace(chunk) {
    const m = chunk.match(PLACE_RE);
    if (!m) return null;
    const left = chunk.slice(0, m.index).replace(/(?:近く|近所|最寄り|いつも|駅前)の?\s*$/, '');
    return {
      place: m[1], particle: m[2],
      rest: (left + chunk.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim()
    };
  }

  // ---- WHAT TO BRING / BUY ----
  const BRING_RE = /^(.*?)(?:を|も)?\s*(?:忘れずに\s*)?(?:持参(?:して|する|します)?|持って(?:い|行)?く|持ってく|持っていきます|持って)(.*)$/;
  const FORGET_PRE_RE = /^忘れずに\s*(.+?)(?:を|も)?$/;
  const FORGET_POST_RE = /^(.+?)(?:を|も)?\s*忘れ(?:ずに|ないように|ない)(.*)$/;
  const BRING_LIST_RE = /持ち物\s*(?:は|:)?\s*(.*)$/;
  const BUY_RE = /^(.*?)(?:を|も)?\s*(?:買い足す|買い(?:に行く|に行って)|買っ(?:て(?:く(?:る)?|おく|帰る)?|とく)|買います|買う|購入(?:して|する|します)?|調達(?:して|する|します)?|補充(?:して|する|します)?)(.*)$/;
  // 「〜が切れた / なくなった」= 買う意図
  const OUT_RE = /^(.+?)(?:が|も|を)?\s*(?:切れ(?:た|てる|ている|そう|かけ\S*)|切らし(?:た|てる|ている|ちゃった)|(?:な|無)くなっ(?:た|てる|ている|ちゃった|そう)|残り(?:わずか|少ない)|ストック(?:が)?(?:ない|切れ))(.*)$/;
  const INTENT_TAIL_RE = /^(?:予定|つもり|したい|しとく|しておく|しなきゃ|しないと|する|します|かな)?$/;
  const BUY_LIST_RE = /買い物(?:リスト)?\s*(?:は|:)\s*(.*)$/;
  const BUY_TIMING_RE = /^(?:.*?帰り(?:道)?に|ついでに|あとで|後で|途中で|その後|そのあと)\s*/;
  const MED_VERB_RE = /飲む|飲みます|服用/;
  const MED_NOUN_RE = /薬|ビタミン|サプリ/;
  const HAS_DOSE_RE = /\d+(?:\.\d+)?\s*(?:mg|mcg|μg|IU)|\d+\s*(?:錠|カプセル|包|粒|滴)|×\s*\d+\s*(?:錠|カプセル|包|粒|滴)/i;
  const MED_CMD_RE = /(?:服薬|お薬|薬)(?:タブ|リスト|欄|の登録)?\s*(?:を|に|へ|は)?\s*(?:変更|追加|登録|更新|修正|設定)(?:して|する|します|しといて)?(?:ください|お願い(?:します)?)?/g;

  // 毎日の必須タスク（繰り返し）
  const DAILY_WORD_RE = /毎日の必須タスク|毎日の必須|(?:は|を)?必須(?:タスク)?(?:で|に|の|として)?|毎日(?:の|に|は)?|毎朝|毎晩|毎夜|日課(?:で|に|の|として)?|ルー(?:ティ|チ)ン(?:で|に|の|として)?/g;
  const DAILY_TEST_RE = /毎日|毎朝|毎晩|毎夜|必須|日課|ルーティン|ルーチン/;

  function splitItems(str) {
    return String(str || '')
      .split(/[と、・&＆\s]|及び|および/)
      .map(x => x.trim().replace(/^(?:を|も|は|と)+/, '').replace(/(?:を|も|は|など|とか)+$/, '').trim())
      .filter(Boolean);
  }
  // "住民票の申請に印鑑と保険証" -> { lead: "住民票の申請", items: "印鑑と保険証" }
  function splitLead(str) {
    const m = String(str || '').match(/^(.*[一-龥々ァ-ヶーA-Za-z0-9](?:に|で|へ|は))(.+)$/);
    if (!m) return { lead: '', items: String(str || '').trim() };
    return { lead: m[1].replace(/(?:に|で|へ|は)$/, '').trim(), items: m[2].trim() };
  }
  const BARE_NOUN_RE = /^[^をにでへはがのもや\s]{1,12}$/;

  // ---- MEMO (who / why) ----
  const WITH_RE = /([^\s、をにでへはがの]{0,12}?(?:さん|くん|君|ちゃん|様|先生|母|父|家族|友達|友人|妻|夫|嫁|彼女|彼氏|子ども|子供|息子|娘|上司|同僚))と(?:一緒に|いっしょに)?/;
  const REASON_RE = /^(.+?)(?:のため(?:に)?|ために|なので|だから)\s*/;

  function cleanText(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .replace(/^(?:を|に|で|へ|は|が|の|と|も|、|\s)+/, '')
      .replace(/(?:を|に|で|へ|は|が|の|と|、|\s)+$/, '')
      .trim();
  }
  const GENERIC_VERB_RE = /^(行く|いく|行きます|行って|向かう|寄る|立ち寄る|帰る|戻る)?$/;
  const FILLER_TAIL_RE = /(?:する)?(?:予定|つもり)(?:です)?$|(?:し)?(?:たい|ないと|なきゃ)$|(?:して)?(?:ください|お願い(?:します)?)$/;

  function fallbackTitle(raw) {
    let t = String(raw || '').replace(DAILY_WORD_RE, ' ').replace(MED_CMD_RE, ' ');
    t = cleanText(t.replace(/、/g, ' '));
    for (let i = 0; i < 2; i++) t = cleanText(t.replace(FILLER_TAIL_RE, ''));
    return t || cleanText(raw) || String(raw || '');
  }

  /** Structured parse (pure). ctx.extraBring: extra 持ち物 (e.g. from bullet children). */
  function parseStructured(text, now, extraBring) {
    const raw = normalize(text);
    const w = extractWhen(raw, now);
    const daily = DAILY_TEST_RE.test(raw);
    const rest0 = w.rest.replace(DAILY_WORD_RE, '、');
    const chunks = rest0.split(/[、。]+/).map(c => c.trim()).filter(Boolean);

    const bring = [], buy = [], memo = [], taskChunks = [];
    let buyPlace = null, buyHint = null, listMode = null;

    // pass 1: classify chunks
    const cls = [];
    chunks.forEach(c0 => {
      if (listMode && BARE_NOUN_RE.test(c0.replace(/\s+/g, ''))) {
        cls.push({ type: listMode, text: '', items: splitItems(c0) });
        return;
      }
      listMode = null;
      let m;
      if ((m = c0.match(BRING_LIST_RE))) {
        const before = c0.slice(0, m.index).trim();
        if (before) cls.push({ type: 'task', text: before });
        cls.push({ type: 'bring', text: '', items: splitItems(m[1]) });
        listMode = 'bring';
        return;
      }
      if ((m = c0.match(BUY_LIST_RE))) {
        const before = c0.slice(0, m.index).trim();
        if (before) cls.push({ type: 'task', text: before });
        cls.push({ type: 'buy', text: '', items: splitItems(m[1]) });
        listMode = 'buy';
        return;
      }
      if ((m = c0.match(BRING_RE)) || (m = c0.match(FORGET_POST_RE))) {
        let itemsPart = m[1];
        const tail = String(m[2] || '').replace(/^(?:て|で|から|、|\s)+/, '').trim();
        const pl = extractPlace(itemsPart);
        let lead = '';
        if (pl) { lead = pl.place + pl.particle + ' '; itemsPart = pl.rest; }
        const sl = splitLead(itemsPart);
        lead += sl.lead;
        cls.push({ type: 'bring', text: sl.items, items: splitItems(sl.items), lead: cleanText(lead) });
        if (lead.trim()) cls.push({ type: 'task', text: lead.trim() });
        if (tail && !GENERIC_VERB_RE.test(tail)) cls.push({ type: 'task', text: tail });
        else if (tail) cls.push({ type: 'task', text: '', verb: tail });
        return;
      }
      if ((m = c0.match(FORGET_PRE_RE))) {
        cls.push({ type: 'bring', text: m[1], items: splitItems(m[1]) });
        return;
      }
      if ((m = c0.match(BUY_RE))) {
        let itemsPart = m[1];
        const t = itemsPart.match(BUY_TIMING_RE);
        if (t) { buyHint = t[0].trim(); itemsPart = itemsPart.slice(t[0].length); }
        const pl = extractPlace(itemsPart);
        if (pl) { buyPlace = buyPlace || pl.place; itemsPart = pl.rest; }
        const sl = splitLead(itemsPart);
        cls.push({ type: 'buy', text: sl.items, items: splitItems(sl.items) });
        if (sl.lead) cls.push({ type: 'task', text: sl.lead });
        const tail = cleanText(m[2] || '');
        if (tail && !INTENT_TAIL_RE.test(tail)) cls.push({ type: 'task', text: tail });
        return;
      }
      if ((m = c0.match(OUT_RE))) {
        const sl = splitLead(m[1]);
        cls.push({ type: 'buy', text: sl.items, items: splitItems(sl.items) });
        if (sl.lead) cls.push({ type: 'task', text: sl.lead });
        const tail = cleanText(m[2] || '');
        if (tail && !INTENT_TAIL_RE.test(tail)) cls.push({ type: 'task', text: tail });
        return;
      }
      cls.push({ type: 'task', text: c0 });
    });

    // pass 2: absorb 、-separated bare nouns right before a bring chunk ("印鑑、保険証を持っていく")
    for (let i = 0; i < cls.length; i++) {
      const c = cls[i];
      if (c.type !== 'bring' || c.lead || /[と・]/.test(c.text || '')) continue;
      let j = i - 1;
      while (j >= 0 && cls[j].type === 'task' && BARE_NOUN_RE.test(cls[j].text)) {
        const otherTasks = cls.filter((x, k) => k !== j && x.type === 'task' && cleanText(x.text)).length;
        if (otherTasks < 1) break;
        c.items = [cls[j].text].concat(c.items);
        cls[j] = { type: 'absorbed', text: '' };
        j--;
      }
    }

    // pass 3: collect
    let place = null, placeVerb = null;
    cls.forEach(c => {
      if (c.type === 'bring') c.items.forEach(x => { if (!bring.includes(x)) bring.push(x); });
      else if (c.type === 'buy') c.items.forEach(x => { if (!buy.includes(x)) buy.push(x); });
      else if (c.type === 'task') {
        if (c.verb) { placeVerb = placeVerb || c.verb; return; }
        let t = c.text;
        let m;
        if ((m = t.match(WITH_RE))) { memo.push(m[1] + 'と'); t = t.replace(m[0], ''); }
        if ((m = t.match(REASON_RE)) && cleanText(t.slice(m[0].length))) { memo.push(cleanText(m[1]) + 'のため'); t = t.slice(m[0].length); }
        const pl = extractPlace(t);
        if (pl && !place) { place = pl.place; t = pl.rest; }
        t = cleanText(t);
        for (let i = 0; i < 2; i++) t = cleanText(t.replace(FILLER_TAIL_RE, ''));
        if (t) taskChunks.push(t);
      }
    });
    (extraBring || []).forEach(x => { if (x && !bring.includes(x)) bring.push(x); });

    let title = '';
    if (taskChunks.length) {
      title = taskChunks[0];
      taskChunks.slice(1).forEach(x => memo.push(x));
      const gv = title.match(GENERIC_VERB_RE);
      if (gv && place) title = place + 'へ' + (gv[1] || '行く');
    } else if (place) {
      title = place + 'へ' + (placeVerb && !/^行/.test(placeVerb) ? placeVerb : '行く');
    }
    // 見出しが場所名だけ（例: 「明日市役所」「歯医者」）→ 場所としても記録
    if (!place && title && PLACE_ONLY_RE.test(title)) place = title;
    if (!place && buyPlace && title) memo.push('購入先: ' + buyPlace);

    return {
      raw, when: w, title, place, bring, buy, buyPlace, buyHint, daily,
      memo: memo.filter(Boolean).join(' / ')
    };
  }

  /** 任務名は抽出フィールドから要約（原文そのままは最後の手段） */
  function summarizeTitle(S) {
    if (S.title) return S.title;
    if (S.buy.length) return S.buy.join('・') + 'を買う';
    if (S.place) return S.place + 'へ行く';
    if (S.bring.length) return '持ち物を準備';
    return fallbackTitle(S.raw);
  }

  // ---- KIND GUESS ----
  function guessKind(S) {
    const w = S.when, raw = S.raw;
    if (HAS_DOSE_RE.test(raw) && !S.buy.length) return 'medication';
    if (S.buy.length && !S.bring.length && !S.title && !S.place) return 'shopping';
    const noTaskSignals = !S.place && !S.bring.length && !S.buy.length;
    if (noTaskSignals && (MED_VERB_RE.test(raw) || (MED_NOUN_RE.test(raw) && !w.dateWord && !w.isDeadline))) return 'medication';
    if (S.daily && !w.dateWord) return 'daily';
    if (w.hasDate || S.place || S.bring.length || S.buy.length) return 'main_task';
    return 'todo';
  }

  // ---- CORRECTION ("サブタスクではなくメイン任務" / "買い物にして") ----
  const TYPE_ALIASES = [
    ['daily', ['毎日の必須タスク','毎日の必須','毎日必須','必須タスク','毎日タスク','デイリー','日課','ルーティン','ルーチン','毎日']],
    ['todo', ['サブタスク','サブ','ToDo','TODO','todo','インボックス']],
    ['main_task', ['メイン任務','メインタスク','メイン','任務']],
    ['shopping', ['買い物リスト','買い物']],
    ['medication', ['服薬','お薬','薬']]
  ];
  const TYPE_WORDS = TYPE_ALIASES.flatMap(([k, ws]) => ws.map(wd => [wd, k])).sort((a, b) => b[0].length - a[0].length);
  const TW = TYPE_WORDS.map(x => x[0]).join('|');
  const kindOfWord = wd => (TYPE_WORDS.find(x => x[0] === wd) || [])[1] || null;
  const NEG_RE = new RegExp('(' + TW + ')\\s*(?:では|じゃ)\\s*(?:なく(?:て)?|ない)');
  const CHG_RE = new RegExp('(' + TW + ')\\s*(?:に|へ|で|として)\\s*(?:して|変更|変えて|直して|登録|追加|お願い|切り替え)');
  const TARGET_RE = new RegExp('^[\\s、]*(' + TW + ')(?:で|に|として)?');

  function parseCorrection(raw) {
    let s = raw, neg = null, target = null, m;
    if ((m = s.match(NEG_RE))) { neg = kindOfWord(m[1]); s = s.replace(m[0], ' '); }
    if ((m = s.match(CHG_RE))) { target = kindOfWord(m[1]); s = s.replace(m[0], ' '); }
    if (neg && !target && (m = s.match(TARGET_RE))) { target = kindOfWord(m[1]); s = s.replace(m[0], ' '); }
    if (!neg && !target) return null;
    const leftover = s.replace(/いや|違う|ちがう|そうじゃなくて|ください|お願い(?:します)?|です|にして|して|で|に|、|。|\s/g, '');
    if (leftover.length > 2) return null; // 内容を含む → 通常の入力として扱う
    if (target === neg) target = null;
    return {
      kind: 'correction', source: raw, targetKind: target, negatedKind: neg,
      summary: target ? ('種類を「' + KIND_LABEL[target] + '」に変更') : '種類の指定が不明'
    };
  }

  // ---- MEDICATION ----
  const SLOT_LEAD_RE = /^(?:毎)?(朝|昼|夜|晩)(?:食後|食前|食間)?(?:と|・|に|の|は)?|^(寝る前|就寝前)(?:に|の)?|^(\d{1,2})\s*(?:時\s*(?:(\d{1,2})\s*分|(半))?|:(\d{2}))(?:に|の)?/;
  const SLOT_TRAIL_RE = /(?:毎)?(朝|昼|夜|晩)(?:食後|食前|食間)?(?:に|の)?$|(寝る前|就寝前)(?:に)?$|(\d{1,2})\s*(?:時\s*(?:(\d{1,2})\s*分|(半))?|:(\d{2}))(?:に)?$/;
  const DOSE_TAIL_RE = /((?:\d+(?:\.\d+)?\s*(?:mg|mcg|μg|g|ml|mL|IU|単位))?\s*(?:×\s*\d+\s*(?:錠|カプセル|包|粒|滴|個|本)?|\d+\s*(?:錠|カプセル|包|粒|滴))?)\s*$/i;

  function slotFromMatch(m) {
    if (m[1]) return m[1] === '晩' ? '夜' : m[1];
    if (m[2]) return '22:00';
    const h = Math.min(23, +m[3]);
    const mi = m[4] != null ? Math.min(59, +m[4]) : (m[5] ? 30 : (m[6] != null ? Math.min(59, +m[6]) : 0));
    return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
  }
  function cleanMedName(s) {
    return cleanText(String(s || '')
      .replace(/(?:を|も)?\s*(?:飲む|飲みます|服用(?:する|します)?)/g, '')
      .replace(/^毎日/, ''));
  }

  /** 用量つきの複数薬: 「朝コンサータ27mg×2錠 ストラテラ40mg×1錠 亜鉛サプリ×1錠」 */
  function parseMedList(raw) {
    let s = String(raw).replace(MED_CMD_RE, ' ')
      .replace(/(?:を|も)?\s*(?:飲む|飲みます|服用(?:する|します)?)/g, ' ')
      .replace(/(錠|カプセル|包|粒|滴|mg|IU)\s*(?:と|、|・)/g, '$1 ');
    const segs = s.split(/[\s、・]+/).map(x => x.trim()).filter(Boolean);
    const meds = [];
    let sticky = [];
    segs.forEach(seg => {
      let t = seg, slots = [], m;
      while ((m = t.match(SLOT_LEAD_RE)) && m[0]) { slots.push(slotFromMatch(m)); t = t.slice(m[0].length); }
      let dose = '';
      const dm = t.match(DOSE_TAIL_RE);
      if (dm && dm[1] && dm[1].trim()) { dose = dm[1].replace(/\s+/g, ''); t = t.slice(0, dm.index); }
      while ((m = t.match(SLOT_TRAIL_RE)) && m[0]) { slots.push(slotFromMatch(m)); t = t.slice(0, m.index); }
      const name = cleanMedName(t);
      if (!name && !dose) {
        if (slots.length) {
          const last = meds[meds.length - 1];
          if (last && !last.slots.length) last.slots = slots.slice();
          sticky = slots.slice();
        }
        return;
      }
      if (!name && dose) {
        const last = meds[meds.length - 1];
        if (last && !last.dose) { last.dose = dose; if (slots.length && !last.slots.length) last.slots = slots; return; }
      }
      if (slots.length) sticky = slots.slice();
      meds.push({ name: name || '薬', dose, slots: slots.length ? slots : sticky.slice() });
    });
    return meds.map(x => ({ name: x.name, dose: x.dose || '1回分', times: dedupeTimes(x.slots).length ? dedupeTimes(x.slots) : ['08:00'] }));
  }

  /** 用量なし（従来）: 「朝と夜にビタミンを飲む」 */
  function parseLegacyMed(raw, w) {
    let name = w.rest.replace(MED_CMD_RE, ' ')
      .replace(/毎?(?:朝|昼|夜|晩)(?:食後|食前|寝る前)?\s*(?:と|・|、|\s)*/g, '')
      .replace(/(?:\d+\s*日\s*)?\d+\s*回|毎食後|食後|食前|寝る前/g, '')
      .replace(/(?:を|も)?\s*(?:飲む|飲みます|服用(?:する|します)?)/g, '')
      .replace(/[、\s]+/g, ' ');
    name = cleanText(name);
    const rawTimes = [];
    if (w.recurringSlot) rawTimes.push(w.recurringSlot);
    if (w.timeStr) rawTimes.push(w.timeStr);
    if (/朝/.test(raw)) rawTimes.push('朝');
    if (/昼/.test(raw)) rawTimes.push('昼');
    if (/夜|晩/.test(raw)) rawTimes.push('夜');
    let times = dedupeTimes(rawTimes);
    if (!times.length) times = ['08:00'];
    return { name, dose: '1回分', times };
  }

  const isGenericDose = d => !d || d === '1回分';
  function attachMerge(med, medications) {
    const existing = (medications || []).find(m =>
      m.enabled !== false && String(m.name || '').trim() === med.name &&
      (isGenericDose(med.dose) || isGenericDose(m.dose) || String(m.dose).replace(/\s+/g, '') === med.dose)
    );
    if (!existing) return med;
    const newTimes = med.times.filter(t => !dedupeTimes(existing.times).includes(t));
    return Object.assign({}, med, {
      mergeIntoId: existing.id, newTimes,
      dose: isGenericDose(med.dose) ? (existing.dose || '1回分') : med.dose
    });
  }
  const medLine = m => m.name + (isGenericDose(m.dose) ? '' : ' ' + m.dose) + ' ／ ' +
    m.times.map(t => normalizeTimeLabel(t).label).join('・') +
    (m.mergeIntoId ? (m.newTimes.length ? '（既存に時刻追加）' : '（登録済み・変更なし）') : '（新規）');

  // ---- BUILDERS ----
  function buildMedication(S, ctx, forced) {
    const raw = S.raw;
    let meds = HAS_DOSE_RE.test(raw) ? parseMedList(raw) : [];
    if (!meds.length) {
      const lm = parseLegacyMed(raw, S.when);
      if (!lm.name) {
        if (!forced) return null;
        lm.name = summarizeTitle(S);
      }
      meds = [lm];
    }
    meds = meds.map(m => attachMerge(m, ctx.medications));
    const p = {
      kind: 'medication', source: raw, meds,
      fields: meds.map(m => ({ k: '服薬', v: medLine(m) }))
    };
    if (meds.length === 1) {
      const m = meds[0];
      Object.assign(p, { name: m.name, dose: m.dose, times: m.times });
      if (m.mergeIntoId) {
        Object.assign(p, {
          label: '服薬（既存にマージ）', mergeIntoId: m.mergeIntoId, newTimes: m.newTimes,
          summary: m.name + (m.newTimes.length
            ? (' に ' + m.newTimes.map(t => normalizeTimeLabel(t).label).join('・') + ' を追加')
            : '（追加する新しい時刻なし）'),
          meta: m.newTimes.length ? '既存の「' + m.name + '」に時刻を追加' : '同じ薬・同じ時刻のため変更なし'
        });
      } else {
        Object.assign(p, {
          label: '服薬',
          summary: m.name + (isGenericDose(m.dose) ? '' : ' ' + m.dose) + '（' + m.times.map(t => normalizeTimeLabel(t).label).join('・') + '）',
          meta: '服薬リストに新規登録'
        });
      }
    } else {
      Object.assign(p, {
        label: '服薬（' + meds.length + '件）',
        summary: meds.map(medLine).join('\n'),
        meta: '入力どおりに服薬リストへ記録（同名は時刻をマージ）'
      });
    }
    return p;
  }

  function buildShopping(S) {
    const w = S.when;
    const items = S.buy.length ? S.buy.slice() : (S.bring.length ? S.bring.slice() : [summarizeTitle(S)]);
    const where = S.buyPlace || S.place || '';
    const notes = [];
    if (w.hasDate) notes.push(whenLabel(w.date, w.hasTime));
    if (where) notes.push(where);
    const fields = [{ k: '買うもの', v: items.join('、') }];
    if (where) fields.push({ k: '場所', v: where });
    if (w.hasDate) fields.push({ k: '日時', v: whenLabel(w.date, w.hasTime) });
    return {
      kind: 'shopping', label: '買い物リスト', source: S.raw,
      items, note: notes.join(' '), place: where, fields,
      summary: items.map(i => '・' + i).join('\n'),
      meta: '買い物リストに追加' + (notes.length ? '（' + notes.join(' ') + '）' : '')
    };
  }

  function buildMainTask(S) {
    const w = S.when;
    const title = summarizeTitle(S);
    const fields = [{ k: '任務', v: title }];
    const wl = whenLabel(w.date, w.hasTime);
    if (wl) fields.push({ k: w.isDeadline ? '期限' : '日時', v: wl });
    if (S.place) fields.push({ k: '場所', v: S.place });
    if (S.bring.length) fields.push({ k: '持ち物', v: S.bring.join('、') });
    if (S.buy.length) fields.push({ k: '買うもの', v: S.buy.join('、') + (S.buyHint ? '（' + S.buyHint + '）' : '') });
    if (S.memo) fields.push({ k: 'メモ', v: S.memo });
    const iso = w.date ? w.date.toISOString() : null;
    return {
      kind: 'main_task', label: 'メインタスク', source: S.raw,
      title,
      deadline: iso,
      deadlineKind: w.date ? (w.isDeadline ? 'deadline' : 'appointment') : null,
      start: (w.date && !w.isDeadline && w.hasTime) ? iso : null,
      whenLabel: wl,
      location: S.place || '',
      bring: S.bring.slice(),
      buy: S.buy.slice(),
      buyHint: S.buyHint || '',
      memo: S.memo || '',
      fields,
      summary: fields.map(f => f.k + ': ' + f.v).join('\n'),
      meta: '任務として追加（未受注）' + (S.buy.length ? '＋買い物リスト' : ''),
      trader: 'チャット'
    };
  }

  function buildDaily(S) {
    const w = S.when;
    const title = summarizeTitle(S);
    const time = w.timeStr || (w.recurringSlot ? SLOT_TIMES[w.recurringSlot] : null);
    const fields = [{ k: '任務', v: title }, { k: '繰り返し', v: '毎日（必須）' }];
    if (time) fields.push({ k: '時刻', v: time });
    if (S.place) fields.push({ k: '場所', v: S.place });
    if (S.bring.length) fields.push({ k: '持ち物', v: S.bring.join('、') });
    if (S.memo) fields.push({ k: 'メモ', v: S.memo });
    return {
      kind: 'daily', label: '毎日の必須タスク', source: S.raw,
      title, time, recurring: 'daily', required: true,
      location: S.place || '', bring: S.bring.slice(), memo: S.memo || '',
      fields,
      summary: fields.map(f => f.k + ': ' + f.v).join('\n'),
      meta: '毎日自動で再生成（未完了は必須表示）' + (time ? '・' + time + 'にリマインド' : '')
    };
  }

  function buildTodo(S) {
    const title = summarizeTitle(S);
    const fields = [{ k: '任務', v: title }];
    const wl = whenLabel(S.when.date, S.when.hasTime);
    if (wl) fields.push({ k: '日時', v: wl });
    if (S.place) fields.push({ k: '場所', v: S.place });
    if (S.bring.length) fields.push({ k: '持ち物', v: S.bring.join('、') });
    return {
      kind: 'todo', label: 'サブタスク / ToDo', source: S.raw,
      title, fields, summary: title,
      meta: '「インボックス」任務のサブタスクとして追加'
    };
  }

  function buildAs(kind, S, ctx, forced) {
    if (kind === 'medication') return buildMedication(S, ctx, forced);
    if (kind === 'shopping') return buildShopping(S);
    if (kind === 'daily') return buildDaily(S);
    if (kind === 'main_task') return buildMainTask(S);
    return buildTodo(S);
  }

  /**
   * parseChat(text, ctx) -> preview object (single line) or null.
   * ctx: { now?: Date, medications?: Medication[], forceKind?: string, guessKind?: string, extraBring?: string[] }
   */
  function parseChat(text, ctx) {
    ctx = ctx || {};
    const raw = normalize(text);
    if (!raw) return null;
    if (!ctx.forceKind) {
      const corr = parseCorrection(raw);
      if (corr) return corr;
    }
    const S = parseStructured(raw, ctx.now, ctx.extraBring);
    const guessed = guessKind(S);
    const kind = KINDS.includes(ctx.forceKind) ? ctx.forceKind : guessed;
    let p = buildAs(kind, S, ctx, !!ctx.forceKind);
    if (!p) {
      // 命令語だけ（例: 「服薬タブを変更」）→ 内容なし
      if (!fallbackTitle(raw.replace(MED_CMD_RE, ''))) return null;
      p = buildTodo(S);
    }
    p.guessKind = ctx.guessKind || guessed;
    if (ctx.extraBring && ctx.extraBring.length) p.extraBring = ctx.extraBring.slice();
    return p;
  }

  // ---- MULTI-LINE / BULLETS ----
  const BULLET_RE = /^([ \t\u3000]*)((?:[・\-\*•●○◦▪■□◆◇→>＞]|\d{1,2}[\.\)）](?!\d)|[①-⑳]|[（(]\d{1,2}[)）])\s*)?(.*)$/;
  function splitLines(text) {
    return String(text || '').replace(/\r/g, '').split('\n').map(l => {
      const m = l.match(BULLET_RE);
      return { indent: m[1].replace(/\t/g, '  ').length, bullet: !!m[2], text: m[3].trim() };
    }).filter(x => x.text);
  }
  const HEAD_BUY_RE = /^(?:買い物(?:リスト)?|買うもの|買う物)\s*[:：]?$/;
  const HEAD_BRING_RE = /^(?:持ち物|持っていくもの|持参(?:物|品)?)\s*[:：]?$/;
  const HEAD_MED_RE = /^(?:服薬|お薬|薬)\s*[:：]?$/;

  /**
   * parseMessage(text, ctx): 1行ならそのまま parseChat、複数行/箇条書きなら kind:'multi'
   * 見出し行（任務）直後の名詞だけの行 → その任務の持ち物。「買い物:」見出し直後 → 買うもの。
   */
  function parseMessage(text, ctx) {
    ctx = ctx || {};
    const lines = splitLines(text);
    if (lines.length <= 1) return parseChat(lines.length ? lines[0].text : text, ctx);

    const items = [];
    let lastTask = null, mode = null, buyItem = null;
    const isChild = t => BARE_NOUN_RE.test(t) && !extractWhen(t, ctx.now).hasDate && !HAS_DOSE_RE.test(t);
    const rebuild = (it, extra) => {
      const np = parseChat(it.source, Object.assign({}, ctx, { forceKind: it.kind, guessKind: it.guessKind, extraBring: extra }));
      if (np) Object.assign(it, np);
    };

    lines.forEach(line => {
      const t = normalize(line.text);
      if (!t) return;
      if (HEAD_BUY_RE.test(t)) { mode = 'buy'; buyItem = null; lastTask = null; return; }
      if (HEAD_BRING_RE.test(t)) { mode = 'bring'; return; }
      if (HEAD_MED_RE.test(t)) { mode = 'med'; lastTask = null; return; }

      if (mode === 'buy' && isChild(t)) {
        const names = buyItem ? buyItem.items.concat([t]) : [t];
        const np = parseChat(names.join('と') + 'を買う', ctx);
        if (buyItem) Object.assign(buyItem, np); else { buyItem = np; items.push(buyItem); }
        return;
      }
      if (mode === 'med') {
        const np = parseChat(t, Object.assign({}, ctx, { forceKind: 'medication' }));
        if (np) items.push(np);
        return;
      }
      // 任務行の直後の名詞だけの行（インデント有無を問わず）→ その任務の持ち物
      if (lastTask && isChild(t)) {
        lastTask.extraBring = (lastTask.extraBring || []).concat([t]);
        rebuild(lastTask, lastTask.extraBring);
        return;
      }
      mode = null; buyItem = null;
      const p = parseChat(t, ctx);
      if (!p || p.kind === 'correction') { if (p) items.push(Object.assign(buildTodo(parseStructured(t, ctx.now)), { guessKind: 'todo' })); return; }
      items.push(p);
      lastTask = (p.kind === 'main_task' || p.kind === 'daily') ? p : null;
    });

    if (items.length === 1) return items[0];
    if (!items.length) return null;
    return {
      kind: 'multi', label: 'まとめて追加（' + items.length + '件）', source: String(text || '').trim(),
      items,
      summary: items.map(it => '・' + (KIND_LABEL[it.kind] || it.kind) + ': ' + (it.title || it.name || (it.items || []).join('、') || it.summary)).join('\n'),
      meta: '各項目の種類を選んで「まとめて追加」'
    };
  }

  root.ChatParser = {
    KINDS, KIND_LABEL,
    normalize, extractWhen, parseWhen, parseStructured, parseChat, parseMessage, parseCorrection,
    parseMedList, splitLines, summarizeTitle, whenLabel,
    canonicalizeTimeToken, dedupeTimes, normalizeTimeLabel
  };
})(typeof window !== 'undefined' ? window : globalThis);
