import './styles.css';
import { DEFAULT_PERIODS } from './demo';
import { ApiTimetableParser, DemoTimetableParser } from './parsers';
import { createDebugInstant, getScheduleStatus, getTaipeiParts } from './schedule';
import {
  clearAllProgress,
  deleteTimetable,
  loadState,
  normalizeClassName,
  persistState,
  replaceTimetable,
  updateProgress,
} from './storage';
import type {
  AppState,
  Course,
  DraftEntry,
  TimetableParseResult,
} from './types';

type Screen = 'home' | 'import' | 'confirm' | 'editor' | 'progress';
type UploadStatus = { kind: 'idle' | 'loading' | 'warning' | 'error'; message: string };

interface EditorTarget {
  originalWeekday: number | null;
  originalPeriod: number | null;
  weekday: number;
  period: number;
}

function requireRoot(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>('#app');
  if (!element) throw new Error('找不到應用程式容器');
  return element;
}

const root = requireRoot();

const weekdayNames = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
const viteEnv = (import.meta as ImportMeta & { env: { VITE_TIMETABLE_PARSER?: string } }).env;
const parserMode = viteEnv.VITE_TIMETABLE_PARSER === 'api' ? 'api' : 'demo';
const debugEnabled = new URLSearchParams(window.location.search).get('debug') === '1';

let state: AppState = loadState();
let screen: Screen = 'home';
let draftEntries: DraftEntry[] = [];
let draftWarnings: string[] = [];
let editorTarget: EditorTarget | null = null;
let progressCourseId: string | null = null;
let selectedFile: File | null = null;
let previewUrl: string | null = null;
let uploadStatus: UploadStatus = { kind: 'idle', message: '' };
let debugNow: Date | null = null;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function effectiveNow(): Date {
  return debugNow ? new Date(debugNow) : new Date();
}

function courseById(courseId: string): Course | undefined {
  return state.courses.find((course) => course.courseId === courseId);
}

function formatNow(date: Date): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

function formatClassDate(date: { year: number; month: number; day: number; weekday: number }, isToday: boolean): string {
  if (isToday) return weekdayNames[date.weekday] ?? '';
  return `${date.year}/${String(date.month).padStart(2, '0')}/${String(date.day).padStart(2, '0')} ${weekdayNames[date.weekday]}`;
}

function button(id: string, label: string, kind = ''): string {
  return `<button id="${id}" class="button ${kind}" type="button">${label}</button>`;
}

function page(title: string, content: string): string {
  return `
    <main class="app-shell">
      <header class="page-header"><h1>${title}</h1></header>
      ${content}
    </main>
  `;
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
      <section class="panel empty-state">
        <p>尚未匯入課表。</p>
        <div class="button-stack">
          ${button('open-import', '匯入課表', 'primary')}
          ${button('load-demo', '載入 Demo 課表', 'secondary')}
        </div>
      </section>
      ${hasProgress ? `
        <section class="panel data-panel">
          <h2>保留的進度資料</h2>
          <p>刪除課表不會刪除進度。重新匯入相同科目與班級後會再次連結。</p>
          ${button('clear-progress', '清除所有進度資料', 'danger')}
        </section>
      ` : ''}
      ${renderDebugControls()}
    `);
    bindHomeEvents();
    return;
  }

  const now = effectiveNow();
  const result = getScheduleStatus(state.timetable, now);
  let scheduleCard = `
    <section class="panel schedule-card">
      <p class="eyebrow">課程狀態</p>
      <h2>未來七天沒有課程</h2>
    </section>
  `;

  if (result.kind !== 'none') {
    const item = result.scheduledClass;
    const course = courseById(item.entry.courseId);
    const today = getTaipeiParts(now);
    const isToday = item.date.year === today.year && item.date.month === today.month && item.date.day === today.day;
    const progress = state.progressByCourse[item.entry.courseId];
    scheduleCard = `
      <section class="panel schedule-card">
        <p class="eyebrow">${result.kind === 'current' ? '目前課程' : '下一堂課'}</p>
        <h2>${escapeHtml(course?.subject ?? '未知科目')}</h2>
        <p class="class-name">${escapeHtml(course?.className ?? '未知班級')}</p>
        <dl class="details">
          <div><dt>日期</dt><dd>${formatClassDate(item.date, isToday)}</dd></div>
          <div><dt>時間</dt><dd>${item.entry.start}–${item.entry.end}</dd></div>
          <div><dt>上次進度</dt><dd>${progress?.progress ? escapeHtml(progress.progress) : '尚未記錄'}</dd></div>
          <div><dt>備註</dt><dd>${progress?.note ? escapeHtml(progress.note) : '—'}</dd></div>
          ${progress ? `<div><dt>更新</dt><dd>${formatTimestamp(progress.updatedAt)}</dd></div>` : ''}
        </dl>
        ${button('update-progress', '更新進度', 'primary')}
      </section>
    `;
    progressCourseId = item.entry.courseId;
  } else {
    progressCourseId = null;
  }

  root.innerHTML = page('今天上到哪', `
    <p class="current-time">現在：${formatNow(now)}</p>
    ${scheduleCard}
    <section class="panel actions-panel" aria-label="課表操作">
      <div class="button-stack">
        ${button('edit-timetable', '查看／編輯課表', 'secondary')}
        ${button('replace-timetable', '更換課表', 'secondary')}
        ${button('delete-timetable', '刪除課表', 'danger')}
      </div>
    </section>
    <section class="panel data-panel">
      <h2>進度資料</h2>
      <p>此操作與刪除課表分開，且無法復原。</p>
      ${button('clear-progress', '清除所有進度資料', 'danger')}
    </section>
    ${renderDebugControls()}
  `);
  bindHomeEvents();
}

function bindDebugEvents(): void {
  document.querySelector('#apply-debug-time')?.addEventListener('click', () => {
    const date = (document.querySelector('#debug-date') as HTMLInputElement).value;
    const time = (document.querySelector('#debug-time') as HTMLInputElement).value;
    try {
      debugNow = createDebugInstant(date, time);
      render();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '無法套用測試時間');
    }
  });
  document.querySelector('#reset-debug-time')?.addEventListener('click', () => {
    debugNow = null;
    render();
  });
}

function draftFromStoredTimetable(): DraftEntry[] {
  if (!state.timetable) return [];
  return state.timetable.entries.map((entry) => {
    const course = courseById(entry.courseId);
    return {
      weekday: entry.weekday,
      period: entry.period,
      start: entry.start,
      end: entry.end,
      subject: course?.subject ?? '',
      className: course?.className ?? '',
    };
  });
}

async function loadDemo(): Promise<void> {
  const parser = new DemoTimetableParser();
  const result = await parser.parse(new File([], 'demo.png', { type: 'image/png' }));
  loadParseResult(result);
}

function loadParseResult(result: TimetableParseResult): void {
  const periods = new Map(result.periods.map((period) => [period.period, period]));
  draftEntries = result.entries.map((entry) => {
    const period = periods.get(entry.period);
    return {
      ...entry,
      className: normalizeClassName(entry.className),
      start: period?.start ?? '08:10',
      end: period?.end ?? '09:00',
    };
  });
  draftWarnings = result.warnings;
  screen = 'confirm';
  render();
}

function bindHomeEvents(): void {
  document.querySelector('#open-import')?.addEventListener('click', () => {
    screen = 'import';
    render();
  });
  document.querySelector('#load-demo')?.addEventListener('click', () => void loadDemo());
  document.querySelector('#update-progress')?.addEventListener('click', () => {
    if (!progressCourseId) return;
    screen = 'progress';
    render();
  });
  document.querySelector('#edit-timetable')?.addEventListener('click', () => {
    draftEntries = draftFromStoredTimetable();
    draftWarnings = [];
    screen = 'confirm';
    render();
  });
  document.querySelector('#replace-timetable')?.addEventListener('click', () => {
    screen = 'import';
    render();
  });
  document.querySelector('#delete-timetable')?.addEventListener('click', () => {
    if (!window.confirm('確定刪除課表？既有進度會保留。')) return;
    state = deleteTimetable(state);
    persistState(state);
    render();
  });
  document.querySelector('#clear-progress')?.addEventListener('click', () => {
    if (!window.confirm('這會清除所有班級的進度、備註與更新時間。要繼續嗎？')) return;
    if (!window.confirm('再次確認：清除後無法復原。')) return;
    state = clearAllProgress(state);
    persistState(state);
    render();
  });
  bindDebugEvents();
}

function renderImport(): void {
  const status = uploadStatus.kind === 'idle' ? '' : `
    <p class="status ${uploadStatus.kind === 'error' ? 'error' : 'warning'}" role="status">${escapeHtml(uploadStatus.message)}</p>
  `;
  root.innerHTML = page('匯入課表', `
    <section class="panel">
      <p>選擇 JPG、PNG 或其他一般圖片。原始圖片只供本次預覽，不會寫入 localStorage。</p>
      <label class="file-label" for="timetable-image">選擇課表圖片</label>
      <input id="timetable-image" type="file" accept="image/*" />
      ${previewUrl ? `<div class="preview-wrap"><img src="${previewUrl}" alt="已選擇的課表圖片預覽" /></div>` : '<p class="small-text">尚未選擇圖片。</p>'}
      ${status}
      <div class="button-stack">
        <button id="start-parse" class="button primary" type="button" ${selectedFile && uploadStatus.kind !== 'loading' ? '' : 'disabled'}>
          ${uploadStatus.kind === 'loading' ? '辨識中…' : '開始辨識'}
        </button>
        ${button('import-demo', '載入 Demo 結果', 'secondary')}
        ${button('manual-create', '手動建立課表', 'secondary')}
        ${button('import-back', '返回', 'quiet')}
      </div>
      <p class="small-text">目前模式：${parserMode === 'api' ? 'API parser' : 'Demo parser（尚未連接真實圖片辨識）'}</p>
    </section>
  `);

  document.querySelector('#timetable-image')?.addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    selectedFile = input.files?.[0] ?? null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = selectedFile ? URL.createObjectURL(selectedFile) : null;
    uploadStatus = { kind: 'idle', message: '' };
    render();
  });
  document.querySelector('#start-parse')?.addEventListener('click', () => void startParse());
  document.querySelector('#import-demo')?.addEventListener('click', () => void loadDemo());
  document.querySelector('#manual-create')?.addEventListener('click', () => {
    draftEntries = [];
    draftWarnings = [];
    screen = 'confirm';
    render();
  });
  document.querySelector('#import-back')?.addEventListener('click', () => {
    screen = 'home';
    render();
  });
}

async function startParse(): Promise<void> {
  if (!selectedFile) return;
  if (parserMode !== 'api') {
    uploadStatus = {
      kind: 'warning',
      message: '目前尚未連接真實圖片辨識。請載入 Demo 結果或手動建立課表。',
    };
    render();
    return;
  }

  uploadStatus = { kind: 'loading', message: '正在上傳並辨識課表…' };
  render();
  try {
    const parser = new ApiTimetableParser();
    loadParseResult(await parser.parse(selectedFile));
  } catch (error) {
    uploadStatus = {
      kind: 'error',
      message: error instanceof Error ? error.message : '課表辨識失敗，請稍後再試。',
    };
    render();
  }
}

function gridPeriods(): number[] {
  const periods = new Set(DEFAULT_PERIODS.map((period) => period.period));
  draftEntries.forEach((entry) => periods.add(entry.period));
  return [...periods].sort((a, b) => a - b);
}

function entryAt(weekday: number, period: number): DraftEntry | undefined {
  return draftEntries.find((entry) => entry.weekday === weekday && entry.period === period);
}

function renderConfirm(): void {
  const rows = gridPeriods().map((period) => {
    const cells = [1, 2, 3, 4, 5].map((weekday) => {
      const entry = entryAt(weekday, period);
      return `
        <td>
          <button class="grid-cell" type="button" data-weekday="${weekday}" data-period="${period}" aria-label="${weekdayNames[weekday]}第 ${period} 節${entry ? `，${escapeHtml(entry.subject)} ${escapeHtml(entry.className)}` : '，空堂'}">
            ${entry ? `<strong>${escapeHtml(entry.subject)}</strong><span>${escapeHtml(entry.className)}</span>` : '<span class="empty-cell">—</span>'}
          </button>
        </td>
      `;
    }).join('');
    return `<tr><th scope="row">${period}</th>${cells}</tr>`;
  }).join('');

  root.innerHTML = page('確認課表', `
    ${draftWarnings.map((warning) => `<p class="status warning">${escapeHtml(warning)}</p>`).join('')}
    <p>請點擊每個格子確認或修改。辨識結果不會自動儲存。</p>
    <div class="timetable-scroll" tabindex="0" aria-label="週課表，可水平捲動">
      <table class="timetable">
        <thead><tr><th scope="col">節次</th><th scope="col">一</th><th scope="col">二</th><th scope="col">三</th><th scope="col">四</th><th scope="col">五</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="button-stack confirm-actions">
      ${button('add-entry', '新增課程', 'secondary')}
      ${button('save-timetable', '確認並儲存', 'primary')}
      ${button('confirm-back', '返回', 'quiet')}
    </div>
  `);

  document.querySelectorAll<HTMLButtonElement>('.grid-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const weekday = Number(cell.dataset.weekday);
      const period = Number(cell.dataset.period);
      const existing = entryAt(weekday, period);
      editorTarget = {
        originalWeekday: existing ? weekday : null,
        originalPeriod: existing ? period : null,
        weekday,
        period,
      };
      screen = 'editor';
      render();
    });
  });
  document.querySelector('#add-entry')?.addEventListener('click', () => {
    editorTarget = { originalWeekday: null, originalPeriod: null, weekday: 1, period: 1 };
    screen = 'editor';
    render();
  });
  document.querySelector('#save-timetable')?.addEventListener('click', () => {
    if (draftEntries.length === 0 && !window.confirm('目前課表沒有任何課程，仍要儲存嗎？')) return;
    state = replaceTimetable(state, draftEntries, effectiveNow());
    persistState(state);
    screen = 'home';
    render();
  });
  document.querySelector('#confirm-back')?.addEventListener('click', () => {
    screen = state.timetable ? 'home' : 'import';
    render();
  });
}

function getEditorEntry(): DraftEntry | undefined {
  if (!editorTarget || editorTarget.originalWeekday === null || editorTarget.originalPeriod === null) return undefined;
  return entryAt(editorTarget.originalWeekday, editorTarget.originalPeriod);
}

function defaultTimes(period: number): { start: string; end: string } {
  const inDraft = draftEntries.find((entry) => entry.period === period);
  const standard = DEFAULT_PERIODS.find((item) => item.period === period);
  return {
    start: inDraft?.start ?? standard?.start ?? '08:10',
    end: inDraft?.end ?? standard?.end ?? '09:00',
  };
}

function renderEditor(): void {
  if (!editorTarget) {
    screen = 'confirm';
    render();
    return;
  }
  const entry = getEditorEntry();
  const times = entry ?? defaultTimes(editorTarget.period);
  root.innerHTML = page(entry ? '編輯課程' : '新增課程', `
    <form id="entry-form" class="panel form-panel">
      <label>科目<input name="subject" required maxlength="40" value="${escapeHtml(entry?.subject ?? '')}" autocomplete="off" /></label>
      <label>班級<input name="className" required maxlength="30" value="${escapeHtml(entry?.className ?? '')}" autocomplete="off" /></label>
      <label>星期
        <select name="weekday">
          ${[1, 2, 3, 4, 5].map((weekday) => `<option value="${weekday}" ${(entry?.weekday ?? editorTarget?.weekday) === weekday ? 'selected' : ''}>${weekdayNames[weekday]}</option>`).join('')}
        </select>
      </label>
      <label>節次<input name="period" required type="number" min="1" max="20" inputmode="numeric" value="${entry?.period ?? editorTarget.period}" /></label>
      <div class="field-row">
        <label>開始時間<input name="start" required type="time" value="${times.start}" /></label>
        <label>結束時間<input name="end" required type="time" value="${times.end}" /></label>
      </div>
      <p id="entry-error" class="status error hidden" role="alert"></p>
      <div class="button-stack">
        <button class="button primary" type="submit">儲存修改</button>
        ${entry ? button('clear-entry', '清空該格', 'danger') : ''}
        ${button('editor-cancel', '取消', 'quiet')}
      </div>
    </form>
  `);

  document.querySelector('#entry-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const next: DraftEntry = {
      subject: String(formData.get('subject') ?? '').trim(),
      className: normalizeClassName(String(formData.get('className') ?? '')),
      weekday: Number(formData.get('weekday')),
      period: Number(formData.get('period')),
      start: String(formData.get('start') ?? ''),
      end: String(formData.get('end') ?? ''),
    };
    const error = document.querySelector<HTMLParagraphElement>('#entry-error');
    if (!next.subject || !next.className || !next.start || !next.end || next.start >= next.end) {
      if (error) {
        error.textContent = '請填寫科目、班級與有效時間；結束時間必須晚於開始時間。';
        error.classList.remove('hidden');
      }
      return;
    }
    if (editorTarget?.originalWeekday !== null && editorTarget?.originalPeriod !== null) {
      draftEntries = draftEntries.filter((item) => !(item.weekday === editorTarget?.originalWeekday && item.period === editorTarget?.originalPeriod));
    }
    draftEntries = draftEntries.filter((item) => !(item.weekday === next.weekday && item.period === next.period));
    draftEntries.push(next);
    screen = 'confirm';
    render();
  });
  document.querySelector('#clear-entry')?.addEventListener('click', () => {
    if (editorTarget?.originalWeekday !== null && editorTarget?.originalPeriod !== null) {
      draftEntries = draftEntries.filter((item) => !(item.weekday === editorTarget?.originalWeekday && item.period === editorTarget?.originalPeriod));
    }
    screen = 'confirm';
    render();
  });
  document.querySelector('#editor-cancel')?.addEventListener('click', () => {
    screen = 'confirm';
    render();
  });
}

function renderProgress(): void {
  const course = progressCourseId ? courseById(progressCourseId) : undefined;
  if (!course || !progressCourseId) {
    screen = 'home';
    render();
    return;
  }
  const previous = state.progressByCourse[progressCourseId];
  const relevantEntry = state.timetable?.entries.find((entry) => entry.courseId === progressCourseId);
  root.innerHTML = page('更新進度', `
    <section class="panel course-summary">
      <h2>${escapeHtml(course.subject)}｜${escapeHtml(course.className)}</h2>
      ${relevantEntry ? `<p>${relevantEntry.start}–${relevantEntry.end}</p>` : ''}
    </section>
    <form id="progress-form" class="panel form-panel">
      <label>進度<input name="progress" maxlength="120" value="${escapeHtml(previous?.progress ?? '')}" autocomplete="off" /></label>
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
    state = updateProgress(
      state,
      progressCourseId as string,
      String(formData.get('progress') ?? ''),
      String(formData.get('note') ?? ''),
      effectiveNow(),
    );
    persistState(state);
    screen = 'home';
    render();
  });
  document.querySelector('#progress-cancel')?.addEventListener('click', () => {
    screen = 'home';
    render();
  });
}

function render(): void {
  switch (screen) {
    case 'home': renderHome(); break;
    case 'import': renderImport(); break;
    case 'confirm': renderConfirm(); break;
    case 'editor': renderEditor(); break;
    case 'progress': renderProgress(); break;
  }
}

window.setInterval(() => {
  if (screen === 'home' && !debugNow) render();
}, 30_000);

render();
