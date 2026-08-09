import './styles.css';
import {
  PERIODS,
  createDebugInstant,
  getHomeScheduleState,
  getTaipeiParts,
  type HomeScheduleState,
  type HomeTab,
  type ScheduledClass,
} from './schedule';
import {
  loadPreferences,
  savePreferences,
  type FontSize,
  type Preferences,
  type Theme,
} from './preferences';
import {
  clearAllProgress,
  deleteTimetable,
  loadState,
  normalizeClassName,
  persistState,
  replaceTimetable,
  restoreProgress,
  updateProgress,
} from './storage';
import type { AppState, Course, CourseProgress, DraftEntry } from './types';

type Screen = 'home' | 'timetable' | 'progress' | 'class-picker' | 'settings';
type TimetableIntent = 'create' | 'edit' | 'rebuild';
type ToastKind = 'success' | 'error';

interface ProgressTarget {
  courseId: string;
  scheduledClass: ScheduledClass | null;
  returnTab: HomeTab;
}

interface UndoRecord {
  courseId: string;
  previous: CourseProgress | undefined;
  expiresAt: number;
  timeoutId: number;
}

interface ToastState {
  kind: ToastKind;
  message: string;
  showUndo: boolean;
}

function requireRoot(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>('#app');
  if (!element) throw new Error('找不到應用程式容器');
  return element;
}

const root = requireRoot();
const weekdayNames = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
const shortWeekdayNames = ['', '一', '二', '三', '四', '五', '六', '日'];
const debugEnabled = new URLSearchParams(globalThis.location.search).get('debug') === '1';

let state: AppState = loadState();
let preferences: Preferences = loadPreferences();
let screen: Screen = 'home';
let timetableIntent: TimetableIntent = 'create';
let draftGrid = new Map<string, string>();
let selectedGridCell: string | null = null;
let progressTarget: ProgressTarget | null = null;
let debugNow: Date | null = null;
let activeHomeTab: HomeTab = 'next';
let homeStateSignature = '';
let undoRecord: UndoRecord | null = null;
let toast: ToastState | null = null;

function applyPreferences(next: Preferences): void {
  document.documentElement.dataset.theme = next.theme;
  document.documentElement.dataset.fontSize = next.fontSize;
  document.documentElement.style.colorScheme = next.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    next.theme === 'dark' ? '#121212' : '#f5f5f5',
  );
}

applyPreferences(preferences);

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function gridKey(weekday: number, period: number): string {
  return `${weekday}:${period}`;
}

function effectiveNow(): Date {
  return debugNow ? new Date(debugNow) : new Date();
}

function courseById(courseId: string): Course | undefined {
  return state.courses.find((course) => course.courseId === courseId);
}

function currentTimetableClasses(): Course[] {
  if (!state.timetable) return [];
  const ids = new Set(state.timetable.entries.map((entry) => entry.courseId));
  return state.courses
    .filter((course) => ids.has(course.courseId))
    .sort((a, b) => a.className.localeCompare(b.className, 'zh-Hant'));
}

function formatClock(date: Date): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function formatRelativeTimestamp(iso: string, now: Date): string {
  const updated = new Date(iso);
  if (Number.isNaN(updated.getTime())) return '時間未知';
  const nowParts = getTaipeiParts(now);
  const updatedParts = getTaipeiParts(updated);
  const nowDay = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  const updatedDay = Date.UTC(updatedParts.year, updatedParts.month - 1, updatedParts.day);
  const dayDifference = Math.round((nowDay - updatedDay) / 86_400_000);
  const clock = formatClock(updated);
  if (dayDifference === 0) return `今天 ${clock}`;
  if (dayDifference === 1) return `昨天 ${clock}`;
  return `${updatedParts.year}/${String(updatedParts.month).padStart(2, '0')}/${String(updatedParts.day).padStart(2, '0')} ${clock}`;
}

function formatClassDate(item: ScheduledClass): string {
  const { year, month, day, weekday } = item.date;
  return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')} ${weekdayNames[weekday]}`;
}

function isToday(item: ScheduledClass, now: Date): boolean {
  const today = getTaipeiParts(now);
  return item.date.year === today.year && item.date.month === today.month && item.date.day === today.day;
}

function button(id: string, label: string, kind = '', attributes = ''): string {
  return `<button id="${id}" class="button ${kind}" type="button" ${attributes}>${label}</button>`;
}

function page(title: string, content: string, showSettings = false): string {
  return `
    <main class="app-shell">
      <header class="page-header">
        <h1>${title}</h1>
        ${showSettings ? '<button id="open-settings" class="header-action" type="button">設定</button>' : ''}
      </header>
      ${content}
    </main>
  `;
}

function renderToast(): string {
  if (!toast) return '';
  return `
    <div class="toast ${toast.kind}" role="status" aria-live="polite">
      <span>${toast.kind === 'success' ? '✓ ' : ''}${escapeHtml(toast.message)}</span>
      ${toast.showUndo ? '<button id="undo-progress" type="button">復原</button>' : ''}
    </div>
  `;
}

function renderProgressDetails(courseId: string, now: Date): string {
  const progress = state.progressByCourse[courseId];
  return `
    <section class="progress-summary" aria-label="上次進度">
      <h3>上次進度</h3>
      <p class="progress-value">${progress?.progress ? escapeHtml(progress.progress) : '尚未紀錄'}</p>
      ${progress?.note ? `<h3>備註</h3><p class="progress-note">${escapeHtml(progress.note)}</p>` : ''}
      ${progress?.updatedAt ? `<p class="last-updated">最後更新：${formatRelativeTimestamp(progress.updatedAt, now)}</p>` : ''}
    </section>
  `;
}

function renderNextCard(item: ScheduledClass | null, now: Date): string {
  if (!item) {
    return `
      <section class="panel schedule-card">
        <p class="eyebrow">下一堂</p>
        <h2 class="empty-schedule">未來七天沒有課程</h2>
      </section>
    `;
  }
  const course = courseById(item.entry.courseId);
  return `
    <section class="panel schedule-card" data-view="next">
      <p class="eyebrow">下一堂</p>
      <h2 class="class-name">${escapeHtml(course?.className ?? '未知班級')}</h2>
      <p class="period-time">${item.start}–${item.end}</p>
      ${isToday(item, now) ? '' : `<p class="class-date">${formatClassDate(item)}</p>`}
      ${renderProgressDetails(item.entry.courseId, now)}
    </section>
  `;
}

function renderUpdateCard(
  item: ScheduledClass,
  kind: 'current' | 'previous' | 'last',
  now: Date,
): string {
  const course = courseById(item.entry.courseId);
  const heading = kind === 'current' ? '目前課程' : kind === 'last' ? '今天最後一堂' : '上一堂課';
  const action = kind === 'current' ? '更新目前進度' : kind === 'last' ? '更新今天最後一堂進度' : '更新上一堂進度';
  return `
    <section class="panel schedule-card" data-view="${kind}">
      <p class="eyebrow">${heading}</p>
      <h2 class="class-name">${escapeHtml(course?.className ?? '未知班級')}</h2>
      <p class="period-time">${item.start}–${item.end}</p>
      ${renderProgressDetails(item.entry.courseId, now)}
      ${button('update-target-progress', action, 'primary')}
    </section>
  `;
}

function tabButton(tab: HomeTab, label: string): string {
  const active = activeHomeTab === tab;
  return `<button class="tab-button ${active ? 'active' : ''}" type="button" role="tab" data-tab="${tab}" aria-selected="${active}">${label}</button>`;
}

function scheduleSignature(schedule: HomeScheduleState): string {
  return [
    schedule.mode,
    schedule.current?.startAt.toISOString() ?? '',
    schedule.previousToday?.startAt.toISOString() ?? '',
    schedule.next?.startAt.toISOString() ?? '',
  ].join('|');
}

function syncDefaultTab(schedule: HomeScheduleState): void {
  const signature = scheduleSignature(schedule);
  if (signature !== homeStateSignature) {
    activeHomeTab = schedule.defaultTab;
    homeStateSignature = signature;
  }
}

function renderScheduleContent(schedule: HomeScheduleState, now: Date): string {
  if (schedule.mode === 'current' && schedule.current) {
    return renderUpdateCard(schedule.current, 'current', now);
  }
  if (schedule.mode === 'gap' && schedule.previousToday) {
    const className = courseById(schedule.previousToday.entry.courseId)?.className ?? '未知班級';
    return `
      <div class="tabs" role="tablist" aria-label="課間操作">
        ${tabButton('next', '下一堂')}
        ${tabButton('previous', `更新上一堂（${escapeHtml(className)}）`)}
      </div>
      ${activeHomeTab === 'previous'
        ? renderUpdateCard(schedule.previousToday, 'previous', now)
        : renderNextCard(schedule.next, now)}
    `;
  }
  if (schedule.mode === 'after-school' && schedule.previousToday) {
    const className = courseById(schedule.previousToday.entry.courseId)?.className ?? '未知班級';
    return `
      <section class="status-summary"><h2>今日課程已結束</h2></section>
      <div class="tabs" role="tablist" aria-label="放學後操作">
        ${tabButton('previous', `更新今天最後一堂（${escapeHtml(className)}）`)}
        ${tabButton('next', '下一堂')}
      </div>
      ${activeHomeTab === 'next'
        ? renderNextCard(schedule.next, now)
        : renderUpdateCard(schedule.previousToday, 'last', now)}
    `;
  }
  return renderNextCard(schedule.next, now);
}

function renderDebugControls(): string {
  if (!debugEnabled) return '';
  const parts = getTaipeiParts(effectiveNow());
  const date = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const time = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  return `
    <section class="panel debug-panel" aria-labelledby="debug-title">
      <h2 id="debug-title">測試時間控制</h2>
      <p class="small-text">只在網址包含 <code>?debug=1</code> 時顯示。</p>
      <div class="field-row">
        <label>測試日期<input id="debug-date" type="date" value="${date}" /></label>
        <label>測試時間<input id="debug-time" type="time" value="${time}" /></label>
      </div>
      <div class="button-row">
        ${button('apply-debug-time', '套用測試時間', 'secondary')}
        ${button('reset-debug-time', '回到真實時間', 'secondary')}
      </div>
      ${debugNow ? '<p class="status warning">目前正在使用固定測試時間。</p>' : ''}
    </section>
  `;
}

function renderHome(): void {
  if (!state.timetable) {
    const hasProgress = Object.keys(state.progressByCourse).length > 0;
    root.innerHTML = page('今天上到哪', `
      ${renderToast()}
      <section class="panel empty-state">
        <p>尚未建立課表。</p>
        ${button('create-timetable', '建立課表', 'primary')}
      </section>
      ${hasProgress ? `
        <section class="panel data-panel">
          <h2>保留的進度資料</h2>
          <p>刪除課表不會刪除進度。重新建立相同班級後會再次連結。</p>
          ${button('clear-progress', '清除所有進度資料', 'danger')}
        </section>
      ` : ''}
      ${renderDebugControls()}
    `, true);
    bindHomeEvents(null);
    return;
  }

  const now = effectiveNow();
  const schedule = getHomeScheduleState(state.timetable, now);
  syncDefaultTab(schedule);
  const classes = currentTimetableClasses();

  root.innerHTML = page('今天上到哪', `
    ${renderToast()}
    ${renderScheduleContent(schedule, now)}
    <section class="panel alternate-panel">
      <h2>延後補登</h2>
      ${button('choose-class', '選擇其他班級更新', 'secondary', classes.length ? '' : 'disabled')}
    </section>
    <section class="panel actions-panel" aria-label="課表操作">
      <div class="button-stack">
        ${button('edit-timetable', '編輯課表', 'secondary')}
        ${button('rebuild-timetable', '重新建立課表', 'secondary')}
        ${button('delete-timetable', '刪除課表', 'danger')}
      </div>
    </section>
    <section class="panel data-panel">
      <h2>進度資料</h2>
      <p>只清除進度、備註與更新時間，不會刪除課表。</p>
      ${button('clear-progress', '清除所有進度資料', 'danger')}
    </section>
    ${renderDebugControls()}
  `, true);
  bindHomeEvents(schedule);
}

function beginTimetable(intent: TimetableIntent): void {
  timetableIntent = intent;
  draftGrid = new Map();
  selectedGridCell = null;
  if (intent === 'edit' && state.timetable) {
    for (const entry of state.timetable.entries) {
      const className = courseById(entry.courseId)?.className;
      if (className) draftGrid.set(gridKey(entry.weekday, entry.period), className);
    }
  }
  screen = 'timetable';
  render();
}

function openProgress(item: ScheduledClass, returnTab: HomeTab): void {
  progressTarget = { courseId: item.entry.courseId, scheduledClass: item, returnTab };
  screen = 'progress';
  render();
}

function invalidateUndo(): void {
  if (undoRecord) globalThis.clearTimeout(undoRecord.timeoutId);
  undoRecord = null;
}

function armUndo(courseId: string, previous: CourseProgress | undefined): void {
  invalidateUndo();
  const expiresAt = Date.now() + 10_000;
  const timeoutId = globalThis.setTimeout(() => {
    if (!undoRecord || undoRecord.expiresAt !== expiresAt) return;
    undoRecord = null;
    if (toast?.showUndo) {
      toast = null;
      if (screen === 'home') render();
    }
  }, 10_000);
  undoRecord = {
    courseId,
    previous: previous ? { ...previous } : undefined,
    expiresAt,
    timeoutId,
  };
  toast = { kind: 'success', message: '已儲存', showUndo: true };
}

function performUndo(): void {
  const record = undoRecord;
  if (!record || Date.now() >= record.expiresAt) {
    invalidateUndo();
    toast = { kind: 'error', message: '復原期限已過，無法復原。', showUndo: false };
    render();
    return;
  }
  try {
    const restored = restoreProgress(state, record.courseId, record.previous);
    persistState(restored);
    state = restored;
    invalidateUndo();
    toast = { kind: 'success', message: '已復原最近一次進度儲存', showUndo: false };
  } catch {
    invalidateUndo();
    toast = { kind: 'error', message: '復原失敗，進度未變更。', showUndo: false };
  }
  render();
}

function bindDebugEvents(): void {
  document.querySelector('#apply-debug-time')?.addEventListener('click', () => {
    const date = (document.querySelector('#debug-date') as HTMLInputElement).value;
    const time = (document.querySelector('#debug-time') as HTMLInputElement).value;
    try {
      debugNow = createDebugInstant(date, time);
      homeStateSignature = '';
      render();
    } catch (error) {
      globalThis.alert(error instanceof Error ? error.message : '無法套用測試時間');
    }
  });
  document.querySelector('#reset-debug-time')?.addEventListener('click', () => {
    debugNow = null;
    homeStateSignature = '';
    render();
  });
}

function bindHomeEvents(schedule: HomeScheduleState | null): void {
  document.querySelector('#open-settings')?.addEventListener('click', () => {
    screen = 'settings';
    render();
  });
  document.querySelector('#undo-progress')?.addEventListener('click', performUndo);
  document.querySelector('#create-timetable')?.addEventListener('click', () => beginTimetable('create'));
  document.querySelector('#edit-timetable')?.addEventListener('click', () => beginTimetable('edit'));
  document.querySelector('#rebuild-timetable')?.addEventListener('click', () => {
    if (!globalThis.confirm('重新建立會從空白課表開始，但既有進度會保留。要繼續嗎？')) return;
    beginTimetable('rebuild');
  });
  document.querySelectorAll<HTMLButtonElement>('.tab-button').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeHomeTab = tab.dataset.tab as HomeTab;
      render();
    });
  });
  document.querySelector('#update-target-progress')?.addEventListener('click', () => {
    if (!schedule) return;
    if (schedule.mode === 'current' && schedule.current) openProgress(schedule.current, 'current');
    else if (schedule.previousToday) openProgress(schedule.previousToday, 'previous');
  });
  document.querySelector('#choose-class')?.addEventListener('click', () => {
    screen = 'class-picker';
    render();
  });
  document.querySelector('#delete-timetable')?.addEventListener('click', () => {
    if (!globalThis.confirm('確定刪除課表？所有班級的既有進度會保留。')) return;
    state = deleteTimetable(state);
    persistState(state);
    homeStateSignature = '';
    render();
  });
  document.querySelector('#clear-progress')?.addEventListener('click', () => {
    if (!globalThis.confirm('這只會清除所有班級的進度、備註與更新時間。課表會保留。要繼續嗎？')) return;
    if (!globalThis.confirm('再次確認：所有進度資料清除後無法復原。')) return;
    state = clearAllProgress(state);
    persistState(state);
    invalidateUndo();
    toast = null;
    render();
  });
  bindDebugEvents();
}

function renderTimetable(): void {
  const title = timetableIntent === 'edit' ? '編輯課表' : '建立課表';
  const rows = PERIODS.map((period) => {
    const cells = [1, 2, 3, 4, 5].map((weekday) => {
      const key = gridKey(weekday, period.period);
      return `
        <td>
          <input
            class="class-input"
            data-grid-key="${key}"
            data-weekday="${weekday}"
            data-period="${period.period}"
            value="${escapeHtml(draftGrid.get(key) ?? '')}"
            maxlength="20"
            autocomplete="off"
            inputmode="text"
            aria-label="${weekdayNames[weekday]}第 ${period.period} 節班級"
          />
        </td>
      `;
    }).join('');
    return `
      <tr>
        <th scope="row"><strong>第${period.period}節</strong><span>${period.start}<br />${period.end}</span></th>
        ${cells}
      </tr>
    `;
  }).join('');

  root.innerHTML = page(title, `
    <p>直接輸入每一格的班級。空格代表空堂，星期、節次與和平高中時間固定。</p>
    ${timetableIntent === 'rebuild' ? '<p class="status warning">目前從空白課表重新建立；既有班級進度不會被刪除。</p>' : ''}
    <div class="timetable-scroll" tabindex="0" aria-label="星期一至星期五、第一至第八節課表">
      <table class="timetable edit-grid">
        <thead>
          <tr><th scope="col">節次</th>${[1, 2, 3, 4, 5].map((weekday) => `<th scope="col">${shortWeekdayNames[weekday]}</th>`).join('')}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p id="selected-cell-status" class="small-text" role="status">尚未選擇格子。</p>
    <div class="button-stack">
      ${button('clear-cell', '清空選取格子', 'danger', 'disabled')}
      ${button('save-timetable', '儲存課表', 'primary')}
      ${button('timetable-back', '返回', 'quiet')}
    </div>
  `);

  const updateSelectedCell = (input: HTMLInputElement): void => {
    selectedGridCell = input.dataset.gridKey ?? null;
    const weekday = Number(input.dataset.weekday);
    const period = Number(input.dataset.period);
    const status = document.querySelector<HTMLParagraphElement>('#selected-cell-status');
    if (status) status.textContent = `已選擇：${weekdayNames[weekday]}第 ${period} 節`;
    const clear = document.querySelector<HTMLButtonElement>('#clear-cell');
    if (clear) clear.disabled = false;
  };

  document.querySelectorAll<HTMLInputElement>('.class-input').forEach((input) => {
    input.addEventListener('focus', () => updateSelectedCell(input));
    input.addEventListener('click', () => updateSelectedCell(input));
  });
  document.querySelector('#clear-cell')?.addEventListener('click', () => {
    if (!selectedGridCell) return;
    const input = document.querySelector<HTMLInputElement>(`.class-input[data-grid-key="${selectedGridCell}"]`);
    if (!input) return;
    input.value = '';
    input.focus();
  });
  document.querySelector('#save-timetable')?.addEventListener('click', () => {
    const entries: DraftEntry[] = [];
    document.querySelectorAll<HTMLInputElement>('.class-input').forEach((input) => {
      const className = normalizeClassName(input.value);
      if (!className) return;
      entries.push({
        weekday: Number(input.dataset.weekday),
        period: Number(input.dataset.period),
        className,
      });
    });
    if (entries.length === 0 && !globalThis.confirm('目前 40 格都是空堂，仍要儲存空白課表嗎？')) return;
    state = replaceTimetable(state, entries, effectiveNow());
    persistState(state);
    homeStateSignature = '';
    screen = 'home';
    render();
  });
  document.querySelector('#timetable-back')?.addEventListener('click', () => {
    screen = 'home';
    render();
  });
}

function renderClassPicker(): void {
  const courses = currentTimetableClasses();
  root.innerHTML = page('選擇其他班級更新', `
    <section class="panel">
      <p>選擇目前課表內的班級，進行延後補登。</p>
      <div class="class-list">
        ${courses.map((course) => `<button class="button secondary class-choice" type="button" data-course-id="${course.courseId}">${escapeHtml(course.className)}</button>`).join('') || '<p>目前課表沒有班級。</p>'}
      </div>
      ${button('picker-back', '返回', 'quiet')}
    </section>
  `);
  document.querySelectorAll<HTMLButtonElement>('.class-choice').forEach((choice) => {
    choice.addEventListener('click', () => {
      progressTarget = {
        courseId: choice.dataset.courseId ?? '',
        scheduledClass: null,
        returnTab: activeHomeTab,
      };
      screen = 'progress';
      render();
    });
  });
  document.querySelector('#picker-back')?.addEventListener('click', () => {
    screen = 'home';
    render();
  });
}

function renderProgress(): void {
  const course = progressTarget ? courseById(progressTarget.courseId) : undefined;
  if (!course || !progressTarget) {
    screen = 'home';
    render();
    return;
  }
  const previous = state.progressByCourse[course.courseId];
  root.innerHTML = page('更新進度', `
    <section class="panel course-summary">
      <p class="eyebrow">確認更新班級</p>
      <h2 class="class-name">${escapeHtml(course.className)}</h2>
      <p class="period-time">${progressTarget.scheduledClass
        ? `${progressTarget.scheduledClass.start}–${progressTarget.scheduledClass.end}`
        : '延後補登'}</p>
    </section>
    <form id="progress-form" class="panel form-panel">
      <label>進度<input name="progress" maxlength="120" value="${escapeHtml(previous?.progress ?? '')}" autocomplete="off" placeholder="例如：P.56" /></label>
      <label>備註（選填）<textarea name="note" maxlength="300" rows="4">${escapeHtml(previous?.note ?? '')}</textarea></label>
      <div class="button-stack">
        <button class="button primary" type="submit">儲存</button>
        ${button('progress-cancel', '取消', 'quiet')}
      </div>
    </form>
  `);
  document.querySelector('#progress-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const previousProgress = previous ? { ...previous } : undefined;
    const updated = updateProgress(
      state,
      course.courseId,
      String(formData.get('progress') ?? ''),
      String(formData.get('note') ?? ''),
      effectiveNow(),
    );
    try {
      persistState(updated);
      state = updated;
      armUndo(course.courseId, previousProgress);
    } catch {
      toast = { kind: 'error', message: '儲存失敗，進度未變更。', showUndo: false };
    }
    activeHomeTab = progressTarget?.returnTab ?? 'next';
    screen = 'home';
    render();
  });
  document.querySelector('#progress-cancel')?.addEventListener('click', () => {
    activeHomeTab = progressTarget?.returnTab ?? 'next';
    screen = 'home';
    render();
  });
}

function renderSettings(): void {
  root.innerHTML = page('設定', `
    <section class="panel settings-group" aria-labelledby="appearance-title">
      <h2 id="appearance-title">外觀</h2>
      <div class="setting-options" role="group" aria-label="外觀">
        <button class="setting-option ${preferences.theme === 'dark' ? 'active' : ''}" type="button" data-theme="dark" aria-pressed="${preferences.theme === 'dark'}">深色</button>
        <button class="setting-option ${preferences.theme === 'light' ? 'active' : ''}" type="button" data-theme="light" aria-pressed="${preferences.theme === 'light'}">淺色</button>
      </div>
    </section>
    <section class="panel settings-group" aria-labelledby="font-size-title">
      <h2 id="font-size-title">文字大小</h2>
      <div class="setting-options three-options" role="group" aria-label="文字大小">
        <button class="setting-option ${preferences.fontSize === 'small' ? 'active' : ''}" type="button" data-font-size="small" aria-pressed="${preferences.fontSize === 'small'}">小</button>
        <button class="setting-option ${preferences.fontSize === 'medium' ? 'active' : ''}" type="button" data-font-size="medium" aria-pressed="${preferences.fontSize === 'medium'}">中</button>
        <button class="setting-option ${preferences.fontSize === 'large' ? 'active' : ''}" type="button" data-font-size="large" aria-pressed="${preferences.fontSize === 'large'}">大</button>
      </div>
    </section>
    ${button('settings-back', '返回首頁', 'quiet')}
  `);
  document.querySelectorAll<HTMLButtonElement>('.setting-option[data-theme]').forEach((choice) => {
    choice.addEventListener('click', () => {
      preferences = { ...preferences, theme: choice.dataset.theme as Theme };
      savePreferences(preferences);
      applyPreferences(preferences);
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('.setting-option[data-font-size]').forEach((choice) => {
    choice.addEventListener('click', () => {
      preferences = { ...preferences, fontSize: choice.dataset.fontSize as FontSize };
      savePreferences(preferences);
      applyPreferences(preferences);
      render();
    });
  });
  document.querySelector('#settings-back')?.addEventListener('click', () => {
    screen = 'home';
    render();
  });
}

function render(): void {
  switch (screen) {
    case 'home': renderHome(); break;
    case 'timetable': renderTimetable(); break;
    case 'progress': renderProgress(); break;
    case 'class-picker': renderClassPicker(); break;
    case 'settings': renderSettings(); break;
  }
}

globalThis.setInterval(() => {
  if (screen === 'home' && !debugNow) render();
}, 30_000);

render();
