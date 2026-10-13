// node tests/features.test.mjs
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(here, '..', 'features.js'), 'utf8'), ctx);
const F = ctx.LifeFeatures; const H = 3600e3;
let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.log('FAIL', name); } };
const NOW = new Date(2026, 9, 13, 9, 0).getTime();
const iso = ms => new Date(ms).toISOString();

ok(F.deadlineThreshold(iso(NOW + 30 * H), NOW) === null, 'far');
ok(F.deadlineThreshold(iso(NOW + 20 * H), NOW) === '24h', '24h');
ok(F.deadlineThreshold(iso(NOW + 2 * H), NOW) === '3h', '3h');
ok(F.deadlineThreshold(iso(NOW - 1), NOW) === 'over', 'over');

const tasks = [
  { id: 'a', title: 'A', status: 'in_progress', deadline: iso(NOW + 2 * H) },
  { id: 'b', title: 'B', status: 'in_progress', deadline: iso(NOW + 20 * H) },
  { id: 'c', title: 'C', status: 'completed', deadline: iso(NOW + 2 * H) },
  { id: 'd', title: 'D', status: 'unaccepted', deadline: iso(NOW - H) },
  { id: 'e', title: 'E', status: 'failed', deadline: iso(NOW - H) },
  { id: 'f', title: 'F', status: 'in_progress', deadline: null },
  { id: 'g', title: 'G', status: 'in_progress', deadline: iso(NOW + H), isMedDaily: true }
];
let shown = {};
let p = F.pendingDeadlinePopups(tasks, shown, NOW);
ok(p.map(x => x.id + ':' + x.threshold).join() === 'e:over,a:3h,b:24h', 'popups order ' + p.map(x => x.id + ':' + x.threshold));
F.markPopupShown(shown, 'a', '3h');
ok(shown.a.includes('24h') && shown.a.includes('3h'), 'mark lower');
p = F.pendingDeadlinePopups(tasks, shown, NOW);
ok(!p.some(x => x.id === 'a'), 'a once');
p = F.pendingDeadlinePopups(tasks, shown, NOW + 3 * H);
ok(p.some(x => x.id === 'a' && x.threshold === 'over'), 'a over later');

const today = F.dayKey(new Date(NOW));
ok(F.shouldShowRecovery(NOW, { lastOpenDay: 'x' }, []) === false, 'no recovery at 9:00');
ok(F.shouldShowRecovery(NOW, { lastOpenDay: 'x' }, [130]) === true, 'recovery by overdue med');
const noon = new Date(2026, 9, 13, 11, 30).getTime();
ok(F.shouldShowRecovery(noon, { lastOpenDay: 'x' }, []) === true, 'first open after 11');
ok(F.shouldShowRecovery(noon, { lastOpenDay: today }, []) === false, 'not first open');
ok(F.shouldShowRecovery(noon, { lastOpenDay: 'x', recoveryShownDay: today }, [300]) === false, 'once a day');

const plan = F.recoveryPlan(tasks.concat([{ id: 'h', status: 'in_progress', deadline: null, isDailyRequired: true },
  { id: 'i', status: 'in_progress', deadline: null, snoozeUntil: iso(NOW + H) }]), NOW);
ok(plan.strict.map(t => t.id).join() === 'd,a,b', 'strict ' + plan.strict.map(t => t.id));
ok(plan.movable.map(t => t.id).join() === 'f', 'movable');
ok(plan.snoozed.map(t => t.id).join() === 'i', 'snoozed');
ok(!F.canSnooze(tasks[0]) && F.canSnooze(tasks[5]), 'canSnooze');
ok(new Date(F.snoozeTarget(NOW, 'later')).getHours() === 12, 'later +3h');
const late = new Date(2026, 9, 13, 21, 0).getTime();
const t2 = new Date(F.snoozeTarget(late, 'later'));
ok(t2.getDate() === 14 && t2.getHours() === 8, 'late -> tomorrow 8');

const st = { tasks: [{ status: 'completed', completedAt: iso(NOW) }, { status: 'failed', deadline: iso(NOW) }, { status: 'completed', completedAt: iso(NOW - 40 * 24 * H) }],
  bathLog: { '2026-10-01': true, '2026-10-02': false, '2026-09-30': true }, laundryLog: {}, cleanLog: { '2026-10-05': true }, trashLog: {},
  medLog: { '2026-10-01': { a: true, b: true } }, dailyLog: {}, healthLog: [{ day: '2026-10-02', mood: 'ok' }, { day: '2026-09-02', mood: 'ok' }] };
const s = F.monthlySummary(st, '2026-10', { dosesPerDay: 2, daysElapsed: 13 });
ok(s.tasks.done === 1 && s.tasks.failed === 1 && s.tasks.rate === 50, 'month tasks');
ok(s.bath.done === 1 && s.bath.total === 2 && s.clean.done === 1, 'month chores');
ok(s.meds.checked === 2 && s.meds.planned === 26 && s.health.total === 1, 'month meds/health');

const sch = F.buildSchedule([{ id: 'x', title: 'X', type: 'med', at: NOW + H, taskId: 'T1' }, { id: 'y', at: NOW - H }], NOW, 'https://e/');
ok(sch.length === 1 && sch[0].time.endsWith('T10:00') && sch[0].url === 'https://e/#/alarm?id=T1', 'schedule');
ok(F.parseDeepLink('#/alarm?id=abc%20d').id === 'abc d' && F.parseDeepLink('#x') === null, 'deeplink');
ok(F.healthHistory([{ day: today, ts: 1 }], NOW, 7).length === 7, 'history');
console.log(`features: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
