import './styles.css';
import {
  normalizeProgressDraft,
  progressDraftChanged,
  timetableDraftSnapshot,
  type ProgressDraft,
} from './drafts';
import {
  loadPreferences,
  savePreferences,
  type FontSize,
  type Preferences,
  type Theme,
} from './preferences';
import {
  PERIODS,
  createDebugInstant,
  getTimelineScheduleState,
  getTaipeiParts,
  type ScheduledClass,
  type TimelineRole,
  type TimelineScheduleState,
} from './schedule';
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
import {
  orderedTimelineRoles,
  resolveTimelineSelection,
  shouldCenterTimelineCard,
} from './timeline';
import type { AppState, Course, CourseProgress, DraftEntry } from './types';

type Screen = 'home' | 'timetable' | 'progress' | 'settings';
type TimetableIntent = 'create' | 'edit';
type ToastKind = 'success' | 'error';

type RoutePayload =
  | { screen: 'home' }
  | { screen: 'settings' }
  | { screen: 'timetable'; intent: TimetableIntent }
  | { screen: 'progress'; courseId: string; timeLabel: string };

type AppRoute = RoutePayload & {
  app: 'today-progress-g1';
  index: number;
};

interface ProgressTarget {
  courseId: string;
  timeLabel: string;
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
let timetableOriginalSnapshot: string | null = null;
let selectedGridCell: string | null = null;
let progressTarget: ProgressTarget | null = null;
let progressOriginalSnapshot: ProgressDraft | null = null;
let debugNow: Date | null = null;
let timelineContextSignature = '';
let expandedTimelineRole: TimelineRole | null = null;
let undoRecord: UndoRecord | null = null;
let toast: ToastState | null = null;
let discardDialog: HTMLDivElement | null = null;
let currentRoute: AppRoute = { app: 'today-progress-g1', index: 0, screen: 'home' };
let restoringBlockedPop = false;
let blockedPopTarget: AppRoute | null = null;

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

const timelineLabels: Record<TimelineRole, string> = {
  last: '上一堂',
  current: '目前課程',
  next: '下一堂',
};

function formatOccurrenceWeekday(item: ScheduledClass): string {
  return `週${shortWeekdayNames[item.date.weekday]}`;
}

function formatOccurrenceDate(item: ScheduledClass): string {
  return `${formatOccurrenceWeekday(item)} / ${item.date.year}/${String(item.date.month).padStart(2, '0')}/${String(item.date.day).padStart(2, '0')}`;
}

function timelineCta(role: TimelineRole, item: ScheduledClass): string {
  if (role === 'next') return '';
  const label = role === 'current' ? '更新進度' : '修正進度';
  const kind = role === 'current' ? 'primary' : 'secondary';
  return `<button
    class="button ${kind} timeline-cta"
    type="button"
    data-course-id="${escapeHtml(item.entry.courseId)}"
    data-time-label="${item.start}–${item.end}"
  >${label}</button>`;
}

function renderTimelineCard(role: TimelineRole, item: ScheduledClass, now: Date): string {
  const expanded = expandedTimelineRole === role;
  const className = courseById(item.entry.courseId)?.className ?? '未知班級';
  const progress = state.progressByCourse[item.entry.courseId];
  const progressValue = progress?.progress || '尚未紀錄';
  return `
    <article class="timeline-card ${expanded ? 'is-expanded' : 'is-shrunk'}" data-timeline-role="${role}">
      <button
        class="timeline-card-toggle"
        type="button"
        data-expand-role="${role}"
        aria-expanded="${expanded}"
        aria-label="${timelineLabels[role]}：${escapeHtml(className)}${expanded ? '，已展開' : '，展開詳細資料'}"
      >
        <span class="timeline-shrink" aria-hidden="${expanded}">
          <span class="timeline-context">${timelineLabels[role]}</span>
          <strong class="timeline-shrink-class">${escapeHtml(className)}</strong>
          <span class="timeline-shrink-time">${formatOccurrenceWeekday(item)} ${item.start}–${item.end}</span>
          <span class="timeline-shrink-progress">${escapeHtml(progressValue)}</span>
        </span>
        <span class="timeline-expanded-head" aria-hidden="${!expanded}">
          <span class="timeline-context">${timelineLabels[role]}</span>
          <strong class="timeline-class-name">${escapeHtml(className)}</strong>
          <span class="timeline-date">${formatOccurrenceDate(item)}</span>
          <span class="timeline-time">${item.start}–${item.end}</span>
        </span>
      </button>
      <div class="timeline-details" aria-hidden="${!expanded}" ${expanded ? '' : 'inert'}>
        <div class="timeline-details-inner">
          <section class="timeline-progress" aria-label="上次進度">
            <h3>上次進度</h3>
            <p class="timeline-progress-value">${escapeHtml(progressValue)}</p>
          </section>
          ${progress?.note ? `
            <section class="timeline-note" aria-label="備註">
              <h3>備註</h3>
              <p>${escapeHtml(progress.note)}</p>
            </section>
          ` : ''}
          ${progress?.updatedAt ? `<p class="timeline-updated">最後更新：${formatRelativeTimestamp(progress.updatedAt, now)}</p>` : ''}
          ${timelineCta(role, item)}
        </div>
      </div>
    </article>
  `;
}

function availableTimelineRoles(timeline: TimelineScheduleState): TimelineRole[] {
  return orderedTimelineRoles(timeline);
}

function syncTimelineSelection(timeline: TimelineScheduleState): void {
  const available = availableTimelineRoles(timeline);
  expandedTimelineRole = resolveTimelineSelection({
    previousRole: expandedTimelineRole,
    previousSignature: timelineContextSignature,
    nextSignature: timeline.signature,
    availableRoles: available,
    defaultRole: timeline.defaultRole,
  });
  timelineContextSignature = timeline.signature;
}

function renderTimeline(timeline: TimelineScheduleState, now: Date): string {
  const cards = orderedTimelineRoles(timeline)
    .flatMap((role) => timeline[role] ? [renderTimelineCard(role, timeline[role], now)] : []);
  if (cards.length === 0) {
    return `
      <section class="panel schedule-card">
        <p class="eyebrow">課程</p>
        <h2 class="empty-schedule">沒有可顯示的課程</h2>
      </section>
    `;
  }
  return `<section class="timeline" aria-label="課程時間軸">${cards.join('')}</section>`;
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
    timelineContextSignature = '';
    expandedTimelineRole = null;
    root.innerHTML = page('今天上到哪', `
      ${renderToast()}
      <section class="panel empty-state">
        <p>尚未建立課表。</p>
        ${button('create-timetable', '設定課表', 'primary')}
      </section>
      ${renderDebugControls()}
    `, true);
    bindHomeEvents();
    return;
  }

  const now = effectiveNow();
  const timeline = getTimelineScheduleState(state.timetable, now);
  syncTimelineSelection(timeline);
  root.innerHTML = page('今天上到哪', `
    ${renderToast()}
    ${renderTimeline(timeline, now)}
    ${renderDebugControls()}
  `, true);
  bindHomeEvents();
}

function autoCenterTimelineCard(card: HTMLElement): void {
  let finished = false;
  let fallbackId = 0;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    globalThis.clearTimeout(fallbackId);
    card.removeEventListener('transitionend', onTransitionEnd);
    globalThis.requestAnimationFrame(() => {
      const rect = card.getBoundingClientRect();
      if (!shouldCenterTimelineCard(rect.top, rect.bottom, globalThis.innerHeight)) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    });
  };
  const onTransitionEnd = (event: TransitionEvent): void => {
    if (event.target === card && event.propertyName === 'padding-top') finish();
  };
  card.addEventListener('transitionend', onTransitionEnd);
  fallbackId = globalThis.setTimeout(finish, 360);
}

function expandTimelineCard(role: TimelineRole, userInitiated: boolean): void {
  if (expandedTimelineRole === role) return;
  const selectedCard = document.querySelector<HTMLElement>(`[data-timeline-role="${role}"]`);
  if (!selectedCard) return;
  expandedTimelineRole = role;
  document.querySelectorAll<HTMLElement>('.timeline-card').forEach((card) => {
    const expanded = card.dataset.timelineRole === role;
    card.classList.toggle('is-expanded', expanded);
    card.classList.toggle('is-shrunk', !expanded);
    const toggle = card.querySelector('.timeline-card-toggle');
    toggle?.setAttribute('aria-expanded', String(expanded));
    const cardRole = card.dataset.timelineRole as TimelineRole;
    const cardClass = card.querySelector('.timeline-shrink-class')?.textContent?.trim() ?? '未知班級';
    toggle?.setAttribute('aria-label', `${timelineLabels[cardRole]}：${cardClass}${expanded ? '，已展開' : '，展開詳細資料'}`);
    card.querySelector('.timeline-shrink')?.setAttribute('aria-hidden', String(expanded));
    card.querySelector('.timeline-expanded-head')?.setAttribute('aria-hidden', String(!expanded));
    const details = card.querySelector<HTMLElement>('.timeline-details');
    details?.setAttribute('aria-hidden', String(!expanded));
    details?.toggleAttribute('inert', !expanded);
  });
  if (userInitiated) autoCenterTimelineCard(selectedCard);
}

function initializeTimetableDraft(intent: TimetableIntent): void {
  timetableIntent = intent;
  draftGrid = new Map();
  selectedGridCell = null;
  if (intent === 'edit' && state.timetable) {
    for (const entry of state.timetable.entries) {
      const className = courseById(entry.courseId)?.className;
      if (className) draftGrid.set(gridKey(entry.weekday, entry.period), className);
    }
  }
  timetableOriginalSnapshot = timetableDraftSnapshot(draftGrid);
}

function initializeProgressDraft(target: ProgressTarget): void {
  progressTarget = target;
  const previous = state.progressByCourse[target.courseId];
  progressOriginalSnapshot = normalizeProgressDraft(previous?.progress ?? '', previous?.note ?? '');
}

function clearEditSnapshots(): void {
  timetableOriginalSnapshot = null;
  progressOriginalSnapshot = null;
}

function readTimetableDraft(): Map<string, string> {
  const values = new Map<string, string>();
  document.querySelectorAll<HTMLInputElement>('.class-input').forEach((input) => {
    const key = input.dataset.gridKey;
    if (key) values.set(key, input.value);
  });
  return values;
}

function readProgressDraft(): ProgressDraft | null {
  const progress = document.querySelector<HTMLInputElement>('input[name="progress"]');
  const note = document.querySelector<HTMLTextAreaElement>('textarea[name="note"]');
  if (!progress || !note) return null;
  return normalizeProgressDraft(progress.value, note.value);
}

function hasDirtyEdit(): boolean {
  if (screen === 'timetable' && timetableOriginalSnapshot !== null) {
    return timetableDraftSnapshot(readTimetableDraft()) !== timetableOriginalSnapshot;
  }
  if (screen === 'progress' && progressOriginalSnapshot) {
    const current = readProgressDraft();
    return current ? progressDraftChanged(progressOriginalSnapshot, current) : false;
  }
  return false;
}

function closeDiscardDialog(): void {
  discardDialog?.remove();
  discardDialog = null;
}

function showDiscardDialog(onDiscard: () => void): void {
  if (discardDialog) return;
  const overlay = document.createElement('div');
  overlay.className = 'dialog-backdrop';
  overlay.innerHTML = `
    <section class="discard-dialog" role="dialog" aria-modal="true" aria-labelledby="discard-title">
      <h2 id="discard-title">尚未儲存變更</h2>
      <p>要放棄目前修改，還是繼續編輯？</p>
      <div class="button-stack">
        ${button('discard-changes', '放棄變更', 'danger')}
        ${button('continue-editing', '繼續編輯', 'primary')}
      </div>
    </section>
  `;
  document.body.append(overlay);
  discardDialog = overlay;
  overlay.querySelector('#continue-editing')?.addEventListener('click', () => {
    closeDiscardDialog();
  });
  overlay.querySelector('#discard-changes')?.addEventListener('click', () => {
    clearEditSnapshots();
    closeDiscardDialog();
    onDiscard();
  });
  overlay.querySelector<HTMLButtonElement>('#continue-editing')?.focus();
}

function requestBack(): void {
  if (hasDirtyEdit()) {
    showDiscardDialog(() => history.back());
    return;
  }
  history.back();
}

function isAppRoute(value: unknown): value is AppRoute {
  if (!value || typeof value !== 'object') return false;
  const route = value as Partial<AppRoute>;
  return route.app === 'today-progress-g1'
    && typeof route.index === 'number'
    && (route.screen === 'home' || route.screen === 'settings' || route.screen === 'timetable' || route.screen === 'progress');
}

function applyRoute(route: AppRoute): void {
  currentRoute = route;
  screen = route.screen;
  closeDiscardDialog();
  if (route.screen === 'timetable') initializeTimetableDraft(route.intent);
  else if (route.screen === 'progress') initializeProgressDraft({ courseId: route.courseId, timeLabel: route.timeLabel });
  else clearEditSnapshots();
  render();
}

function navigate(payload: RoutePayload): void {
  const route = {
    ...payload,
    app: 'today-progress-g1' as const,
    index: currentRoute.index + 1,
  } as AppRoute;
  history.pushState(route, '');
  applyRoute(route);
}

function openProgress(courseId: string, timeLabel: string): void {
  navigate({
    screen: 'progress',
    courseId,
    timeLabel,
  });
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
    const date = document.querySelector<HTMLInputElement>('#debug-date')?.value ?? '';
    const time = document.querySelector<HTMLInputElement>('#debug-time')?.value ?? '';
    try {
      debugNow = createDebugInstant(date, time);
      renderHome();
    } catch (error) {
      globalThis.alert(error instanceof Error ? error.message : '無法套用測試時間');
    }
  });
  document.querySelector('#reset-debug-time')?.addEventListener('click', () => {
    debugNow = null;
    renderHome();
  });
}

function bindHomeEvents(): void {
  document.querySelector('#open-settings')?.addEventListener('click', () => navigate({ screen: 'settings' }));
  document.querySelector('#undo-progress')?.addEventListener('click', performUndo);
  document.querySelector('#create-timetable')?.addEventListener('click', () => {
    navigate({ screen: 'timetable', intent: 'create' });
  });
  document.querySelectorAll<HTMLButtonElement>('.timeline-card-toggle').forEach((choice) => {
    choice.addEventListener('click', () => {
      const role = choice.dataset.expandRole as TimelineRole | undefined;
      if (role) expandTimelineCard(role, true);
    });
  });
  document.querySelectorAll<HTMLButtonElement>('.timeline-cta').forEach((choice) => {
    choice.addEventListener('click', () => {
      const courseId = choice.dataset.courseId;
      const timeLabel = choice.dataset.timeLabel;
      if (!courseId || !timeLabel) return;
      openProgress(courseId, timeLabel);
    });
  });
  bindDebugEvents();
}

function showFormError(message: string): void {
  const status = document.querySelector<HTMLParagraphElement>('#form-error');
  if (!status) return;
  status.textContent = message;
  status.hidden = false;
}

function renderTimetable(): void {
  const title = timetableIntent === 'edit' ? '課表設定' : '設定課表';
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
    <div class="timetable-scroll" tabindex="0" aria-label="星期一至星期五、第一至第八節課表">
      <table class="timetable edit-grid">
        <thead>
          <tr><th scope="col">節次</th>${[1, 2, 3, 4, 5].map((weekday) => `<th scope="col">${shortWeekdayNames[weekday]}</th>`).join('')}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p id="selected-cell-status" class="small-text" role="status">尚未選擇格子。</p>
    <p id="form-error" class="status error" role="alert" hidden></p>
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
    const currentDraft = readTimetableDraft();
    const entries: DraftEntry[] = [];
    for (const [key, value] of currentDraft) {
      const className = normalizeClassName(value);
      if (!className) continue;
      const [weekday, period] = key.split(':').map(Number);
      entries.push({ weekday, period, className });
    }
    if (entries.length === 0 && !globalThis.confirm('目前 40 格都是空堂，仍要儲存空白課表嗎？')) return;
    const updated = replaceTimetable(state, entries, effectiveNow());
    try {
      persistState(updated);
      state = updated;
      timetableOriginalSnapshot = timetableDraftSnapshot(currentDraft);
      clearEditSnapshots();
      timelineContextSignature = '';
      requestBack();
    } catch {
      showFormError('課表儲存失敗，變更尚未離開此畫面。');
    }
  });
  document.querySelector('#timetable-back')?.addEventListener('click', requestBack);
}

function renderProgress(): void {
  const course = progressTarget ? courseById(progressTarget.courseId) : undefined;
  if (!course || !progressTarget) {
    requestBack();
    return;
  }
  const previous = state.progressByCourse[course.courseId];
  root.innerHTML = page('更新進度', `
    <section class="panel course-summary">
      <p class="eyebrow">確認更新班級</p>
      <h2 class="class-name">${escapeHtml(course.className)}</h2>
      <p class="period-time">${escapeHtml(progressTarget.timeLabel)}</p>
    </section>
    <form id="progress-form" class="panel form-panel">
      <label>進度<input name="progress" maxlength="120" value="${escapeHtml(previous?.progress ?? '')}" autocomplete="off" placeholder="例如：P.56" /></label>
      <label>備註（選填）<textarea name="note" maxlength="300" rows="4">${escapeHtml(previous?.note ?? '')}</textarea></label>
      <p id="form-error" class="status error" role="alert" hidden></p>
      <div class="button-stack">
        <button class="button primary" type="submit">儲存</button>
        ${button('progress-cancel', '取消', 'quiet')}
      </div>
    </form>
  `);
  document.querySelector('#progress-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const currentDraft = readProgressDraft();
    if (!currentDraft) return;
    const previousProgress = previous ? { ...previous } : undefined;
    const updated = updateProgress(
      state,
      course.courseId,
      currentDraft.progress,
      currentDraft.note,
      effectiveNow(),
    );
    try {
      persistState(updated);
      state = updated;
      progressOriginalSnapshot = currentDraft;
      clearEditSnapshots();
      armUndo(course.courseId, previousProgress);
      requestBack();
    } catch {
      showFormError('儲存失敗，進度未變更。');
    }
  });
  document.querySelector('#progress-cancel')?.addEventListener('click', requestBack);
}

function renderSettings(): void {
  const hasProgress = Object.keys(state.progressByCourse).length > 0;
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
    <section class="panel settings-group" aria-labelledby="timetable-settings-title">
      <h2 id="timetable-settings-title">課表</h2>
      ${button('open-timetable-settings', '課表設定', 'secondary')}
    </section>
    <section class="panel danger-zone" aria-labelledby="danger-title">
      <h2 id="danger-title">危險操作</h2>
      <div class="button-stack">
        ${button('delete-timetable', '刪除課表', 'danger', state.timetable ? '' : 'disabled')}
        ${button('clear-progress', '清除所有進度', 'danger', hasProgress ? '' : 'disabled')}
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
  document.querySelector('#open-timetable-settings')?.addEventListener('click', () => {
    navigate({ screen: 'timetable', intent: state.timetable ? 'edit' : 'create' });
  });
  document.querySelector('#delete-timetable')?.addEventListener('click', () => {
    if (!globalThis.confirm('確定刪除課表？所有班級的既有進度會保留。')) return;
    const updated = deleteTimetable(state);
    persistState(updated);
    state = updated;
    timelineContextSignature = '';
    render();
  });
  document.querySelector('#clear-progress')?.addEventListener('click', () => {
    if (!globalThis.confirm('這只會清除所有班級的進度、備註與更新時間。課表會保留。要繼續嗎？')) return;
    if (!globalThis.confirm('再次確認：所有進度資料清除後無法復原。')) return;
    const updated = clearAllProgress(state);
    persistState(updated);
    state = updated;
    invalidateUndo();
    toast = null;
    render();
  });
  document.querySelector('#settings-back')?.addEventListener('click', requestBack);
}

function render(): void {
  switch (screen) {
    case 'home': renderHome(); break;
    case 'timetable': renderTimetable(); break;
    case 'progress': renderProgress(); break;
    case 'settings': renderSettings(); break;
  }
}

function refreshHomeIfScheduleChanged(): void {
  if (screen !== 'home' || !state.timetable || debugNow) return;
  const nextSignature = getTimelineScheduleState(state.timetable, new Date()).signature;
  if (nextSignature !== timelineContextSignature) renderHome();
}

globalThis.addEventListener('popstate', (event) => {
  const target = isAppRoute(event.state) ? event.state : null;
  if (!target) return;

  if (restoringBlockedPop) {
    restoringBlockedPop = false;
    const pendingTarget = blockedPopTarget;
    blockedPopTarget = null;
    if (pendingTarget) {
      showDiscardDialog(() => history.go(pendingTarget.index - currentRoute.index));
    }
    return;
  }

  if (hasDirtyEdit()) {
    const restoreDelta = currentRoute.index - target.index;
    if (restoreDelta !== 0) {
      restoringBlockedPop = true;
      blockedPopTarget = target;
      history.go(restoreDelta);
    }
    return;
  }

  applyRoute(target);
});

globalThis.addEventListener('beforeunload', (event) => {
  if (!hasDirtyEdit()) return;
  event.preventDefault();
  event.returnValue = '';
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshHomeIfScheduleChanged();
});
globalThis.addEventListener('pageshow', refreshHomeIfScheduleChanged);
globalThis.addEventListener('focus', refreshHomeIfScheduleChanged);
globalThis.setInterval(refreshHomeIfScheduleChanged, 30_000);

history.replaceState(currentRoute, '');
render();
