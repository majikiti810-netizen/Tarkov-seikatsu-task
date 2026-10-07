/*! ChatParser — rule-based Japanese chat parser for デイリー任務 (no DOM, no deps)
 * One natural sentence -> structured fields (5W1H-style):
 *   任務(title) / 日時 or 期限(when) / 場所(location) / 持ち物(bring) / 買うもの(buy) / メモ(memo)
 * Exposed as global `ChatParser` (browser: window.ChatParser; node vm: globalThis.ChatParser).
 * Used by app.js and tests/parse.test.mjs.
 */
(function (root) {
  'use strict';

  const WEEKDAYS = { '日':0,'月':1,'火':2,'水':3,'木':4,'金':5,'土':6 };
  const WEEKDAY_NAMES = ['日','月','火','水','木','金','土'];
  const SLOT_TIMES = { '朝':'08:00', '昼':'12:00', '夜':'20:00' };
  const TIME_TO_SLOT = Object.fromEntries(Object.entries(SLOT_TIMES).map(([k,v]) => [v, k]));

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

  // ---- text normalization ----
  function normalize(text) {
    return String(text || '')
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/：/g, ':').replace(/／/g, '/').replace(/[，,]/g, '、')
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
    // deadline markers adjacent to date/time:  締切は10/20 / 10/20までに / 金曜締切
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
    '市役所','区役所','町役場','村役場','役所','役場','市民センター','センター','年金事務所','事務所',
    '病院','医院','クリニック','歯科','歯医者','眼科','皮膚科','内科','外科','耳鼻科','整形外科',
    '駅','バス停','空港','港','銀行','信用金庫','郵便局','学校','高校','大学','保育園','幼稚園',
    '図書館','公民館','会館','ホール','薬局','ドラッグストア','スーパー','コンビニ','百貨店','デパート',
    'モール','店','屋','会社','オフィス','職場','ハローワーク','警察署','交番','税務署','法務局',
    'ジム','美容院','美容室','床屋','公園','ホテル','実家','自宅','家',
    'イオン','ダイソー','ニトリ','ユニクロ','ホームセンター'
  ];
  const PLACE_RE = new RegExp(
    '([一-龥々〆ヵヶァ-ヴーA-Za-z0-9]*?(?:' + PLACE_SUFFIXES.join('|') + ')(?:前|内|近く)?)(にて|まで|から|で|に|へ)'
  );
  function extractPlace(chunk) {
    const m = chunk.match(PLACE_RE);
    if (!m) return null;
    return {
      place: m[1], particle: m[2],
      rest: (chunk.slice(0, m.index) + chunk.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim()
    };
  }

  // ---- WHAT TO BRING / BUY ----
  const BRING_RE = /^(.*?)(?:を|も)?\s*(?:忘れずに\s*)?(?:持参(?:して|する|します)?|持って(?:い|行)?く|持ってく|持っていきます|持って)(.*)$/;
  const FORGET_PRE_RE = /^忘れずに\s*(.+?)(?:を|も)?$/;
  const FORGET_POST_RE = /^(.+?)(?:を|も)?\s*忘れ(?:ずに|ないように|ない)(.*)$/;
  const BRING_LIST_RE = /持ち物\s*(?:は|:)?\s*(.*)$/;
  const BUY_RE = /^(.*?)(?:を|も)?\s*(?:買い足す|買い(?:に行く|に行って)|買っ(?:て(?:く(?:る)?|おく|帰る)?|とく)|買います|買う|購入(?:して|する|します)?)(.*)$/;
  const BUY_LIST_RE = /買い物(?:リスト)?\s*(?:は|:)\s*(.*)$/;
  const BUY_TIMING_RE = /^(?:.*?帰り(?:道)?に|ついでに|あとで|後で|途中で|その後|そのあと)\s*/;
  const MED_VERB_RE = /飲む|飲みます|服用/;
  const MED_NOUN_RE = /薬|ビタミン|サプリ/;

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

  /** Structured parse (pure). */
  function parseStructured(text, now) {
    const raw = normalize(text);
    const w = extractWhen(raw, now);
    const chunks = w.rest.split(/[、。]+/).map(c => c.trim()).filter(Boolean);

    const bring = [], buy = [], memo = [], taskChunks = [];
    let buyPlace = null, buyHint = null, listMode = null;

    // pass 1: classify chunks
    const cls = []; // {type:'task'|'bring'|'buy', text, items?}
    chunks.forEach(c0 => {
      // continue a 持ち物は/買い物は list with bare nouns
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
        if (tail) cls.push({ type: 'task', text: tail });
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
        if (t) taskChunks.push(t);
      }
    });

    let title = '';
    if (taskChunks.length) {
      title = taskChunks[0];
      taskChunks.slice(1).forEach(x => memo.push(x));
      const gv = title.match(GENERIC_VERB_RE);
      if (gv && place) title = place + 'へ' + (gv[1] || '行く');
    } else if (place) {
      title = place + 'へ' + (placeVerb && !/^行/.test(placeVerb) ? placeVerb : '行く');
    }
    if (!place && buyPlace && title) memo.push('購入先: ' + buyPlace);

    return {
      raw, when: w, title, place, bring, buy, buyPlace, buyHint,
      memo: memo.filter(Boolean).join(' / ')
    };
  }

  /**
   * parseChat(text, ctx) -> preview object or null.
   * ctx: { now?: Date, medications?: Medication[] }  (medications used to merge times)
   */
  function parseChat(text, ctx) {
    ctx = ctx || {};
    const raw = normalize(text);
    if (!raw) return null;
    const S = parseStructured(raw, ctx.now);
    const w = S.when;

    // 1) Pure shopping (keeps old behavior: "牛乳と卵を買う")
    if (S.buy.length && !S.bring.length && !S.title && !S.place) {
      const items = S.buy.length ? S.buy : ['買い物アイテム'];
      const notes = [];
      if (w.hasDate) notes.push(whenLabel(w.date, w.hasTime));
      if (S.buyPlace) notes.push(S.buyPlace);
      return {
        kind: 'shopping', label: '買い物リスト', source: raw,
        items, note: notes.join(' '),
        summary: items.map(i => '・' + i).join('\n'),
        meta: '買い物リストに追加' + (notes.length ? '（' + notes.join(' ') + '）' : '')
      };
    }

    // 2) Medication (keeps old behavior: "朝と夜にビタミンを飲む")
    const noTaskSignals = !S.place && !S.bring.length && !S.buy.length;
    if (noTaskSignals && (MED_VERB_RE.test(raw) || (MED_NOUN_RE.test(raw) && !w.dateWord && !w.isDeadline))) {
      return parseMedication(raw, w, ctx.medications || []);
    }

    // 3) Structured main task
    if (w.hasDate || S.place || S.bring.length || S.buy.length) {
      const title = S.title || (S.buy.length ? '買い物' : (S.bring.length ? '持ち物を準備' : '予定'));
      const fields = [{ k: '任務', v: title }];
      const wl = whenLabel(w.date, w.hasTime);
      if (wl) fields.push({ k: w.isDeadline ? '期限' : '日時', v: wl });
      if (S.place) fields.push({ k: '場所', v: S.place });
      if (S.bring.length) fields.push({ k: '持ち物', v: S.bring.join('、') });
      if (S.buy.length) fields.push({ k: '買うもの', v: S.buy.join('、') + (S.buyHint ? '（' + S.buyHint + '）' : '') });
      if (S.memo) fields.push({ k: 'メモ', v: S.memo });
      return {
        kind: 'main_task', label: 'メインタスク', source: raw,
        title,
        deadline: w.date ? w.date.toISOString() : null,
        deadlineKind: w.date ? (w.isDeadline ? 'deadline' : 'appointment') : null,
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

    // 4) Default ToDo
    return {
      kind: 'todo', label: 'サブタスク / ToDo', source: raw,
      title: raw, summary: raw,
      meta: '「インボックス」任務のサブタスクとして追加'
    };
  }

  function parseMedication(raw, w, medications) {
    let name = w.rest
      .replace(/毎?(?:朝|昼|夜|晩)(?:食後|食前|寝る前)?\s*(?:と|・|、|\s)*/g, '')
      .replace(/(?:\d+\s*日\s*)?\d+\s*回|毎食後|食後|食前|寝る前/g, '')
      .replace(/(?:を|も)?\s*(?:飲む|飲みます|服用(?:する|します)?)/g, '')
      .replace(/[、\s]+/g, ' ');
    name = cleanText(name) || '薬';
    const rawTimes = [];
    if (w.recurringSlot) rawTimes.push(w.recurringSlot);
    if (w.timeStr) rawTimes.push(w.timeStr);
    if (/朝/.test(raw)) rawTimes.push('朝');
    if (/昼/.test(raw)) rawTimes.push('昼');
    if (/夜|晩/.test(raw)) rawTimes.push('夜');
    let uniq = dedupeTimes(rawTimes);
    if (!uniq.length) uniq = ['08:00'];
    const labels = uniq.map(t => normalizeTimeLabel(t).label);
    const existing = (medications || []).find(m =>
      m.enabled !== false && String(m.name || '').trim() === name
    );
    if (existing) {
      const newOnly = uniq.filter(t => !dedupeTimes(existing.times).includes(t));
      return {
        kind: 'medication', label: '服薬（既存にマージ）', source: raw,
        name, dose: existing.dose || '1回分', times: uniq,
        mergeIntoId: existing.id, newTimes: newOnly,
        summary: name + (newOnly.length
          ? (' に ' + newOnly.map(t => normalizeTimeLabel(t).label).join('・') + ' を追加')
          : '（追加する新しい時刻なし）'),
        meta: newOnly.length ? '既存の「' + name + '」に時刻を追加' : '同じ薬・同じ時刻のため変更なし'
      };
    }
    return {
      kind: 'medication', label: '服薬', source: raw,
      name, dose: '1回分', times: uniq,
      summary: name + '（' + labels.join('・') + '）',
      meta: '服薬リストに新規登録'
    };
  }

  root.ChatParser = {
    normalize, extractWhen, parseWhen, parseStructured, parseChat, whenLabel,
    canonicalizeTimeToken, dedupeTimes, normalizeTimeLabel
  };
})(typeof window !== 'undefined' ? window : globalThis);
