'use strict';

/* =========================================================
   STATE
   ========================================================= */

const STORAGE_KEY = 'capacityLedgerState_v1';
const RESOURCE_COLORS = ['#2B3A67', '#1F9D8A', '#D98E2B', '#D9556B', '#6D5DAB', '#3A8FB7', '#B7772E', '#4E8C5E'];

let state = loadState();
let currentYear;
let currentMonth; // 0-indexed
let activeTab = 'resources';

const today = new Date();
today.setHours(0, 0, 0, 0);

function getDefaultState() {
  return { resourceList: [], monthDataByKey: {} };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load saved data, starting fresh.', err);
  }
  return getDefaultState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getMonthKey(year, month) {
  return `${year}-${pad2(month + 1)}`;
}

function getCurrentMonthKey() {
  return getMonthKey(currentYear, currentMonth);
}

function getMonthData(monthKey) {
  if (!state.monthDataByKey[monthKey]) {
    state.monthDataByKey[monthKey] = {
      target: { baseHours: 480, additionalHours: 0 },
      resourceOverrides: {},
      leaves: {},
      holidays: {}
    };
  }
  return state.monthDataByKey[monthKey];
}

function getResourceOverride(monthKey, resourceId) {
  const monthData = getMonthData(monthKey);
  if (!monthData.resourceOverrides[resourceId]) {
    monthData.resourceOverrides[resourceId] = { month: 'full', weekOverrides: {}, dayOverrides: {} };
  }
  return monthData.resourceOverrides[resourceId];
}

function getResourceColor(resourceId) {
  const idx = state.resourceList.findIndex(r => r.id === resourceId);
  return RESOURCE_COLORS[Math.max(idx, 0) % RESOURCE_COLORS.length];
}

/* =========================================================
   DATE HELPERS
   ========================================================= */

function pad2(n) { return String(n).padStart(2, '0'); }

function dateKeyFromParts(year, month, day) {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

function dateKeyFromDate(dateObj) {
  return dateKeyFromParts(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
}

function isWeekend(dateObj) {
  const day = dateObj.getDay();
  return day === 0 || day === 6;
}

function isSameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatMonthLabel(year, month) {
  return new Date(year, month, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function formatShortDate(dateObj) {
  return dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Builds Monday-start weeks covering the given month, padded with adjacent-month days. */
function buildCalendarWeeks(year, month) {
  const lastOfMonth = new Date(year, month + 1, 0);
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // days back to Monday
  const cursor = new Date(year, month, 1 - startOffset);

  const weeks = [];
  let safety = 0;
  while (safety++ < 8) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
    if (week[6].getTime() >= lastOfMonth.getTime()) break;
  }
  return weeks;
}

function getWeekNumberForDate(dateObj, weeks) {
  for (let i = 0; i < weeks.length; i++) {
    if (weeks[i].some(d => isSameDate(d, dateObj))) return i + 1;
  }
  return null;
}

/* =========================================================
   BILLING / HOURS ENGINE
   ========================================================= */

function resolveBillingType(monthKey, resourceId, dateStr, weekNum) {
  const override = getResourceOverride(monthKey, resourceId);
  if (override.dayOverrides[dateStr]) return override.dayOverrides[dateStr];
  if (weekNum != null && override.weekOverrides[weekNum]) return override.weekOverrides[weekNum];
  return override.month || 'full';
}

/** Returns { status, hours, label?, color?, billingType? } for one resource on one date. */
function computeResourceDay(monthKey, resourceId, dateObj, weekNum) {
  const dateStr = dateKeyFromDate(dateObj);
  const monthData = getMonthData(monthKey);

  if (isWeekend(dateObj)) return { status: 'weekend', hours: 0 };

  const holiday = monthData.holidays[dateStr];
  if (holiday) return { status: 'holiday', hours: 0, label: holiday.label };

  const leaveEntry = monthData.leaves[dateStr] && monthData.leaves[dateStr][resourceId];
  if (leaveEntry) return { status: 'leave', hours: 0, label: leaveEntry.label, color: leaveEntry.color };

  const billingType = resolveBillingType(monthKey, resourceId, dateStr, weekNum);
  return { status: 'working', hours: billingType === 'full' ? 8 : 4, billingType };
}

/** Aggregates hours for every in-month day, plus per-resource and per-week rollups. */
function computeMonthCapacity(year, month) {
  const monthKey = getMonthKey(year, month);
  const weeks = buildCalendarWeeks(year, month);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const dayTotals = {};
  const weekTotals = {};
  const resourceWeekTotals = {};
  state.resourceList.forEach(r => { resourceWeekTotals[r.id] = {}; });

  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(year, month, day);
    const dateStr = dateKeyFromDate(dateObj);
    const weekNum = getWeekNumberForDate(dateObj, weeks);
    let dayTotal = 0;

    state.resourceList.forEach(resource => {
      const result = computeResourceDay(monthKey, resource.id, dateObj, weekNum);
      dayTotal += result.hours;
      resourceWeekTotals[resource.id][weekNum] = (resourceWeekTotals[resource.id][weekNum] || 0) + result.hours;
    });

    dayTotals[dateStr] = dayTotal;
    weekTotals[weekNum] = (weekTotals[weekNum] || 0) + dayTotal;
  }

  const grandTotal = Object.values(weekTotals).reduce((sum, v) => sum + v, 0);
  return { weeks, dayTotals, weekTotals, resourceWeekTotals, grandTotal, monthKey };
}

/* =========================================================
   RENDER: SHARED
   ========================================================= */

function renderMonthLabels() {
  const label = formatMonthLabel(currentYear, currentMonth);
  ['resourcesMonthLabel', 'calendarMonthLabel', 'leavesMonthLabel', 'calcMonthLabel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  });
  document.getElementById('monthPicker').value = getCurrentMonthKey();
}

function renderAll() {
  renderMonthLabels();
  renderResourcesTab();
  renderCalendarTab();
  renderLeavesTab();
  renderCalcTab();
}

function showToast(message) {
  const root = document.getElementById('toastRoot');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  root.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

/* =========================================================
   RENDER: RESOURCES TAB
   ========================================================= */

function renderResourcesTab() {
  const monthKey = getCurrentMonthKey();
  const weeks = buildCalendarWeeks(currentYear, currentMonth);
  const listEl = document.getElementById('resourceList');
  const emptyEl = document.getElementById('resourceEmptyState');

  listEl.innerHTML = '';
  emptyEl.hidden = state.resourceList.length > 0;

  state.resourceList.forEach(resource => {
    const override = getResourceOverride(monthKey, resource.id);
    const card = document.createElement('div');
    card.className = 'resource-card';

    const top = document.createElement('div');
    top.className = 'resource-card-top';

    const dot = document.createElement('span');
    dot.className = 'resource-dot';
    dot.style.background = getResourceColor(resource.id);
    top.appendChild(dot);

    const nameInput = document.createElement('input');
    nameInput.className = 'resource-name-input';
    nameInput.value = resource.name;
    nameInput.setAttribute('aria-label', 'Resource name');
    nameInput.addEventListener('change', () => {
      resource.name = nameInput.value.trim() || resource.name;
      saveState();
      renderAll();
    });
    top.appendChild(nameInput);

    const monthSelect = document.createElement('select');
    monthSelect.className = 'month-default-select';
    monthSelect.innerHTML = `<option value="full">Full day (8h) default</option><option value="partial">Partial day (4h) default</option>`;
    monthSelect.value = override.month;
    monthSelect.addEventListener('change', () => {
      override.month = monthSelect.value;
      saveState();
      renderCalendarTab();
      renderCalcTab();
    });
    top.appendChild(monthSelect);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'danger-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      if (confirm(`Remove ${resource.name} from this project? This clears their data for all months.`)) {
        state.resourceList = state.resourceList.filter(r => r.id !== resource.id);
        Object.values(state.monthDataByKey).forEach(md => {
          delete md.resourceOverrides[resource.id];
          Object.values(md.leaves).forEach(dayLeaves => delete dayLeaves[resource.id]);
        });
        saveState();
        renderAll();
      }
    });
    top.appendChild(removeBtn);

    card.appendChild(top);

    const weekRow = document.createElement('div');
    weekRow.className = 'resource-week-row';
    weeks.forEach((week, idx) => {
      const weekNum = idx + 1;
      const hasInMonthDay = week.some(d => d.getMonth() === currentMonth);
      if (!hasInMonthDay) return;

      const wrap = document.createElement('div');
      wrap.className = 'week-toggle';
      const label = document.createElement('span');
      label.textContent = `Week ${weekNum}`;
      wrap.appendChild(label);

      const sel = document.createElement('select');
      sel.innerHTML = `<option value="">Inherit month</option><option value="full">Full (8h)</option><option value="partial">Partial (4h)</option>`;
      sel.value = override.weekOverrides[weekNum] || '';
      sel.addEventListener('change', () => {
        if (sel.value) override.weekOverrides[weekNum] = sel.value;
        else delete override.weekOverrides[weekNum];
        saveState();
        renderCalendarTab();
        renderCalcTab();
      });
      wrap.appendChild(sel);
      weekRow.appendChild(wrap);
    });
    card.appendChild(weekRow);

    listEl.appendChild(card);
  });
}

document.getElementById('addResourceForm').addEventListener('submit', e => {
  e.preventDefault();
  const input = document.getElementById('newResourceName');
  const name = input.value.trim();
  if (!name) return;
  state.resourceList.push({ id: 'res_' + Date.now() + '_' + Math.floor(Math.random() * 1000) });
  state.resourceList[state.resourceList.length - 1].name = name;
  saveState();
  input.value = '';
  renderAll();
});

/* =========================================================
   RENDER: CALENDAR TAB
   ========================================================= */

function renderCalendarTab() {
  const monthKey = getCurrentMonthKey();
  const weeks = buildCalendarWeeks(currentYear, currentMonth);
  const grid = document.getElementById('calendarGrid');
  grid.innerHTML = '';

  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(label => {
    const el = document.createElement('div');
    el.className = 'cal-weekday-label';
    el.textContent = label;
    grid.appendChild(el);
  });

  const maxPossibleHours = Math.max(state.resourceList.length * 8, 1);

  weeks.forEach(week => {
    week.forEach(dateObj => {
      const inMonth = dateObj.getMonth() === currentMonth;
      const cell = document.createElement('div');
      cell.className = 'cal-cell';

      const dateEl = document.createElement('div');
      dateEl.className = 'cal-date';
      dateEl.textContent = dateObj.getDate();
      cell.appendChild(dateEl);

      if (!inMonth) {
        cell.classList.add('outside');
        grid.appendChild(cell);
        return;
      }

      if (isSameDate(dateObj, today)) cell.classList.add('today');

      const dateStr = dateKeyFromDate(dateObj);
      const monthData = getMonthData(monthKey);

      if (isWeekend(dateObj)) {
        cell.classList.add('weekend');
        const tag = document.createElement('div');
        tag.className = 'cal-tag';
        tag.textContent = 'Weekend';
        cell.appendChild(tag);
        grid.appendChild(cell);
        return;
      }

      const holiday = monthData.holidays[dateStr];
      if (holiday) {
        cell.classList.add('is-holiday');
        const tag = document.createElement('div');
        tag.className = 'cal-tag';
        tag.textContent = holiday.label;
        cell.appendChild(tag);
      }

      const weekNum = getWeekNumberForDate(dateObj, weeks);
      let dayTotal = 0;
      const dotsWrap = document.createElement('div');
      dotsWrap.className = 'cal-dots';
      let hasDots = false;

      state.resourceList.forEach(resource => {
        const result = computeResourceDay(monthKey, resource.id, dateObj, weekNum);
        dayTotal += result.hours;
        if (!holiday) {
          const dot = document.createElement('span');
          dot.className = 'dot';
          if (result.status === 'leave') dot.style.background = result.color || getResourceColor(resource.id);
          else if (result.status === 'working' && result.billingType === 'full') dot.style.background = 'var(--full)';
          else if (result.status === 'working') dot.style.background = 'var(--partial)';
          dotsWrap.appendChild(dot);
          hasDots = true;
        }
      });

      if (hasDots) cell.appendChild(dotsWrap);

      const hoursEl = document.createElement('div');
      hoursEl.className = 'cal-hours';
      hoursEl.textContent = dayTotal;
      cell.appendChild(hoursEl);

      const hoursLabel = document.createElement('div');
      hoursLabel.className = 'cal-hours-label';
      hoursLabel.textContent = 'hours';
      cell.appendChild(hoursLabel);

      const barTrack = document.createElement('div');
      barTrack.className = 'cal-bar-track';
      const barFill = document.createElement('div');
      barFill.className = 'cal-bar-fill';
      barFill.style.width = Math.min(100, (dayTotal / maxPossibleHours) * 100) + '%';
      barTrack.appendChild(barFill);
      cell.appendChild(barTrack);

      const tooltipLines = state.resourceList.map(resource => {
        const result = computeResourceDay(monthKey, resource.id, dateObj, weekNum);
        let line = `${resource.name}: `;
        if (result.status === 'leave') line += `On leave (${result.label || 'Leave'})`;
        else line += `${result.hours}h`;
        return line;
      });
      cell.title = `${formatShortDate(dateObj)}${holiday ? ' — ' + holiday.label : ''}\n${tooltipLines.join('\n')}`;

      cell.addEventListener('click', () => openDayModal(dateObj));
      grid.appendChild(cell);
    });
  });
}

/* =========================================================
   DAY MODAL
   ========================================================= */

function openDayModal(dateObj) {
  const monthKey = getCurrentMonthKey();
  const dateStr = dateKeyFromDate(dateObj);
  const weeks = buildCalendarWeeks(currentYear, currentMonth);
  const weekNum = getWeekNumberForDate(dateObj, weeks);
  const monthData = getMonthData(monthKey);
  const existingHoliday = monthData.holidays[dateStr];

  const modalRoot = document.getElementById('modalRoot');
  modalRoot.innerHTML = '';
  modalRoot.hidden = false;

  const card = document.createElement('div');
  card.className = 'modal-card';

  card.innerHTML = `
    <h3>${dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h3>
    <p class="modal-sub">Week ${weekNum} of ${formatMonthLabel(currentYear, currentMonth)}</p>
  `;

  const holidayWrap = document.createElement('div');
  holidayWrap.className = 'modal-holiday-toggle';
  const holidayCheckbox = document.createElement('input');
  holidayCheckbox.type = 'checkbox';
  holidayCheckbox.id = 'modalHolidayCheckbox';
  holidayCheckbox.checked = !!existingHoliday;
  const holidayCheckLabel = document.createElement('label');
  holidayCheckLabel.setAttribute('for', 'modalHolidayCheckbox');
  holidayCheckLabel.textContent = 'Public holiday';
  const holidayLabelInput = document.createElement('input');
  holidayLabelInput.type = 'text';
  holidayLabelInput.placeholder = 'Holiday name';
  holidayLabelInput.value = existingHoliday ? existingHoliday.label : '';
  holidayLabelInput.hidden = !existingHoliday;
  holidayCheckbox.addEventListener('change', () => {
    holidayLabelInput.hidden = !holidayCheckbox.checked;
    resourceRowsWrap.style.opacity = holidayCheckbox.checked ? '0.4' : '1';
    resourceRowsWrap.style.pointerEvents = holidayCheckbox.checked ? 'none' : 'auto';
  });
  holidayWrap.appendChild(holidayCheckbox);
  holidayWrap.appendChild(holidayCheckLabel);
  holidayWrap.appendChild(holidayLabelInput);
  card.appendChild(holidayWrap);

  const resourceRowsWrap = document.createElement('div');
  resourceRowsWrap.className = 'resource-rows';
  if (existingHoliday) {
    resourceRowsWrap.style.opacity = '0.4';
    resourceRowsWrap.style.pointerEvents = 'none';
  }

  const rowControls = [];

  state.resourceList.forEach(resource => {
    const result = computeResourceDay(monthKey, resource.id, dateObj, weekNum);
    const leaveEntry = monthData.leaves[dateStr] && monthData.leaves[dateStr][resource.id];

    const row = document.createElement('div');
    row.className = 'resource-day-row';

    const nameWrap = document.createElement('div');
    nameWrap.className = 'resource-day-name';
    const dot = document.createElement('span');
    dot.className = 'resource-dot';
    dot.style.background = getResourceColor(resource.id);
    dot.style.width = '9px';
    dot.style.height = '9px';
    nameWrap.appendChild(dot);
    nameWrap.appendChild(document.createTextNode(resource.name));
    row.appendChild(nameWrap);

    const statusSelect = document.createElement('select');
    statusSelect.innerHTML = `
      <option value="inherit">Inherit (${resolveBillingType(monthKey, resource.id, dateStr, weekNum) === 'full' ? 'Full' : 'Partial'})</option>
      <option value="full">Full day (8h)</option>
      <option value="partial">Partial day (4h)</option>
      <option value="leave">On leave</option>
    `;
    if (result.status === 'leave') statusSelect.value = 'leave';
    else if (monthData.resourceOverrides[resource.id] && monthData.resourceOverrides[resource.id].dayOverrides[dateStr]) {
      statusSelect.value = monthData.resourceOverrides[resource.id].dayOverrides[dateStr];
    } else {
      statusSelect.value = 'inherit';
    }
    row.appendChild(statusSelect);

    const extraWrap = document.createElement('div');
    extraWrap.className = 'resource-day-extra';
    extraWrap.hidden = statusSelect.value !== 'leave';
    const leaveLabelInput = document.createElement('input');
    leaveLabelInput.type = 'text';
    leaveLabelInput.placeholder = 'Leave label (e.g. Sick leave)';
    leaveLabelInput.value = leaveEntry ? leaveEntry.label : '';
    const leaveColorInput = document.createElement('input');
    leaveColorInput.type = 'color';
    leaveColorInput.value = leaveEntry ? leaveEntry.color : getResourceColor(resource.id);
    extraWrap.appendChild(leaveLabelInput);
    extraWrap.appendChild(leaveColorInput);
    row.appendChild(extraWrap);

    statusSelect.addEventListener('change', () => {
      extraWrap.hidden = statusSelect.value !== 'leave';
    });

    resourceRowsWrap.appendChild(row);
    rowControls.push({ resource, statusSelect, leaveLabelInput, leaveColorInput });
  });

  card.appendChild(resourceRowsWrap);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ghost-btn';
  cancelBtn.style.color = 'var(--ink)';
  cancelBtn.style.borderColor = 'var(--border-strong)';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);
  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    saveDayModal({ monthKey, dateStr, holidayCheckbox, holidayLabelInput, rowControls });
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  card.appendChild(actions);

  modalRoot.appendChild(card);
  modalRoot.addEventListener('click', e => { if (e.target === modalRoot) closeModal(); }, { once: true });
}

function saveDayModal({ monthKey, dateStr, holidayCheckbox, holidayLabelInput, rowControls }) {
  const monthData = getMonthData(monthKey);

  if (holidayCheckbox.checked) {
    const label = holidayLabelInput.value.trim() || 'Holiday';
    monthData.holidays[dateStr] = { label };
  } else {
    delete monthData.holidays[dateStr];
  }

  rowControls.forEach(({ resource, statusSelect, leaveLabelInput, leaveColorInput }) => {
    const override = getResourceOverride(monthKey, resource.id);

    if (monthData.leaves[dateStr]) delete monthData.leaves[dateStr][resource.id];

    if (statusSelect.value === 'leave') {
      if (!monthData.leaves[dateStr]) monthData.leaves[dateStr] = {};
      monthData.leaves[dateStr][resource.id] = {
        label: leaveLabelInput.value.trim() || 'Leave',
        color: leaveColorInput.value
      };
    } else if (statusSelect.value === 'inherit') {
      delete override.dayOverrides[dateStr];
    } else {
      override.dayOverrides[dateStr] = statusSelect.value;
    }
  });

  saveState();
  closeModal();
  renderCalendarTab();
  renderLeavesTab();
  renderCalcTab();
  showToast('Day updated');
}

function closeModal() {
  const modalRoot = document.getElementById('modalRoot');
  modalRoot.hidden = true;
  modalRoot.innerHTML = '';
}

/* =========================================================
   RENDER: LEAVES & HOLIDAYS TAB
   ========================================================= */

const LEAVE_COLORS = ['#D9556B', '#D98E2B', '#6D5DAB', '#3A8FB7', '#4E8C5E'];
let selectedLeaveColor = LEAVE_COLORS[0];

function renderLeaveColorPicker() {
  const wrap = document.getElementById('leaveColorPicker');
  wrap.innerHTML = '';
  LEAVE_COLORS.forEach(color => {
    const swatch = document.createElement('span');
    swatch.className = 'color-swatch' + (color === selectedLeaveColor ? ' selected' : '');
    swatch.style.background = color;
    swatch.addEventListener('click', () => {
      selectedLeaveColor = color;
      renderLeaveColorPicker();
    });
    wrap.appendChild(swatch);
  });
}

function renderLeavesTab() {
  const monthKey = getCurrentMonthKey();
  const monthData = getMonthData(monthKey);

  const resourceSelect = document.getElementById('leaveResourceSelect');
  resourceSelect.innerHTML = state.resourceList.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');

  renderLeaveColorPicker();

  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const defaultDate = dateKeyFromParts(currentYear, currentMonth, 1);
  document.getElementById('leaveStartDate').min = defaultDate;
  document.getElementById('leaveStartDate').max = dateKeyFromParts(currentYear, currentMonth, daysInMonth);
  document.getElementById('leaveEndDate').min = defaultDate;
  document.getElementById('leaveEndDate').max = dateKeyFromParts(currentYear, currentMonth, daysInMonth);
  document.getElementById('holidayDate').min = defaultDate;
  document.getElementById('holidayDate').max = dateKeyFromParts(currentYear, currentMonth, daysInMonth);

  // Leave list
  const leaveListEl = document.getElementById('leaveList');
  leaveListEl.innerHTML = '';
  const leaveRows = [];
  Object.keys(monthData.leaves).sort().forEach(dateStr => {
    Object.keys(monthData.leaves[dateStr]).forEach(resourceId => {
      const resource = state.resourceList.find(r => r.id === resourceId);
      if (!resource) return;
      leaveRows.push({ dateStr, resourceId, resourceName: resource.name, entry: monthData.leaves[dateStr][resourceId] });
    });
  });
  document.getElementById('leaveEmptyState').hidden = leaveRows.length > 0;
  leaveRows.forEach(row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'tag-row';
    rowEl.innerHTML = `
      <span class="tag-color-chip" style="background:${row.entry.color}"></span>
      <span class="tag-date">${row.dateStr.slice(5)}</span>
      <span class="tag-meta"><strong>${escapeHtml(row.resourceName)}</strong><span>${escapeHtml(row.entry.label)}</span></span>
    `;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'danger-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      delete monthData.leaves[row.dateStr][row.resourceId];
      if (Object.keys(monthData.leaves[row.dateStr]).length === 0) delete monthData.leaves[row.dateStr];
      saveState();
      renderLeavesTab();
      renderCalendarTab();
      renderCalcTab();
    });
    rowEl.appendChild(removeBtn);
    leaveListEl.appendChild(rowEl);
  });

  // Holiday list
  const holidayListEl = document.getElementById('holidayList');
  holidayListEl.innerHTML = '';
  const holidayDates = Object.keys(monthData.holidays).sort();
  document.getElementById('holidayEmptyState').hidden = holidayDates.length > 0;
  holidayDates.forEach(dateStr => {
    const holiday = monthData.holidays[dateStr];
    const rowEl = document.createElement('div');
    rowEl.className = 'tag-row';
    rowEl.innerHTML = `
      <span class="tag-color-chip" style="background:var(--holiday)"></span>
      <span class="tag-date">${dateStr.slice(5)}</span>
      <span class="tag-meta"><strong>${escapeHtml(holiday.label)}</strong></span>
    `;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'danger-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      delete monthData.holidays[dateStr];
      saveState();
      renderLeavesTab();
      renderCalendarTab();
      renderCalcTab();
    });
    rowEl.appendChild(removeBtn);
    holidayListEl.appendChild(rowEl);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

document.getElementById('addLeaveForm').addEventListener('submit', e => {
  e.preventDefault();
  const monthKey = getCurrentMonthKey();
  const monthData = getMonthData(monthKey);
  const resourceId = document.getElementById('leaveResourceSelect').value;
  const startStr = document.getElementById('leaveStartDate').value;
  const endStr = document.getElementById('leaveEndDate').value;
  const label = document.getElementById('leaveLabel').value.trim() || 'Leave';
  if (!resourceId || !startStr || !endStr) return;

  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  if (end < start) { showToast('End date must be on or after start date'); return; }

  let addedCount = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    if (!isWeekend(cursor) && cursor.getMonth() === currentMonth) {
      const dateStr = dateKeyFromDate(cursor);
      if (!monthData.leaves[dateStr]) monthData.leaves[dateStr] = {};
      monthData.leaves[dateStr][resourceId] = { label, color: selectedLeaveColor };
      addedCount++;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  saveState();
  e.target.reset();
  renderLeavesTab();
  renderCalendarTab();
  renderCalcTab();
  showToast(addedCount ? `Leave added for ${addedCount} working day(s)` : 'No working days in that range');
});

document.getElementById('addHolidayForm').addEventListener('submit', e => {
  e.preventDefault();
  const monthKey = getCurrentMonthKey();
  const monthData = getMonthData(monthKey);
  const dateStr = document.getElementById('holidayDate').value;
  const label = document.getElementById('holidayLabel').value.trim() || 'Holiday';
  if (!dateStr) return;
  monthData.holidays[dateStr] = { label };
  saveState();
  e.target.reset();
  renderLeavesTab();
  renderCalendarTab();
  renderCalcTab();
  showToast('Holiday added');
});

/* =========================================================
   RENDER: CALCULATIONS TAB
   ========================================================= */

function renderCalcTab() {
  const monthKey = getCurrentMonthKey();
  const monthData = getMonthData(monthKey);
  const capacity = computeMonthCapacity(currentYear, currentMonth);

  const baseInput = document.getElementById('baseTargetInput');
  const additionalInput = document.getElementById('additionalTargetInput');
  baseInput.value = monthData.target.baseHours;
  additionalInput.value = monthData.target.additionalHours;

  const targetTotal = Number(monthData.target.baseHours || 0) + Number(monthData.target.additionalHours || 0);
  const targetRounded = Math.round(targetTotal / 10) * 10;
  document.getElementById('targetTotalReadout').textContent = targetTotal;
  document.getElementById('targetRoundedReadout').textContent = targetRounded;

  const surplusActual = capacity.grandTotal - targetTotal;
  const surplusRounded = capacity.grandTotal - targetRounded;

  const summaryCards = document.getElementById('summaryCards');
  summaryCards.innerHTML = '';
  const cards = [
    { label: 'Planned capacity', value: capacity.grandTotal, cls: '' },
    { label: 'Target (exact)', value: targetTotal, cls: '' },
    { label: 'Surplus vs. exact target', value: (surplusActual >= 0 ? '+' : '') + surplusActual, cls: surplusActual >= 0 ? 'positive' : 'negative' },
    { label: 'Surplus vs. rounded target', value: (surplusRounded >= 0 ? '+' : '') + surplusRounded, cls: surplusRounded >= 0 ? 'positive' : 'negative' }
  ];
  cards.forEach(c => {
    const card = document.createElement('div');
    card.className = 'summary-card ' + c.cls;
    card.innerHTML = `<div class="label">${c.label}</div><div class="value">${c.value}</div>`;
    summaryCards.appendChild(card);
  });

  // Weekly table
  const weeklyBody = document.querySelector('#weeklyTable tbody');
  const weeklyFoot = document.querySelector('#weeklyTable tfoot');
  weeklyBody.innerHTML = '';
  capacity.weeks.forEach((week, idx) => {
    const weekNum = idx + 1;
    const inMonthDays = week.filter(d => d.getMonth() === currentMonth);
    if (inMonthDays.length === 0) return;
    const rangeLabel = `${formatShortDate(inMonthDays[0])} – ${formatShortDate(inMonthDays[inMonthDays.length - 1])}`;
    const total = capacity.weekTotals[weekNum] || 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>Week ${weekNum}</td><td>${rangeLabel}</td><td class="num">${total}</td>`;
    weeklyBody.appendChild(tr);
  });
  weeklyFoot.innerHTML = `<tr><td colspan="2">Grand total</td><td class="num">${capacity.grandTotal}</td></tr>`;

  // Matrix table
  const matrixHead = document.querySelector('#matrixTable thead tr');
  const matrixBody = document.querySelector('#matrixTable tbody');
  const matrixFoot = document.querySelector('#matrixTable tfoot');
  const weekNumbers = Object.keys(capacity.weekTotals).map(Number).sort((a, b) => a - b);

  matrixHead.innerHTML = '<th>Resource</th>' + weekNumbers.map(w => `<th class="num">Week ${w}</th>`).join('') + '<th class="num">Total</th>';
  matrixBody.innerHTML = '';
  state.resourceList.forEach(resource => {
    let resourceTotal = 0;
    const cells = weekNumbers.map(w => {
      const val = capacity.resourceWeekTotals[resource.id][w] || 0;
      resourceTotal += val;
      return `<td class="num">${val}</td>`;
    }).join('');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(resource.name)}</td>${cells}<td class="num"><strong>${resourceTotal}</strong></td>`;
    matrixBody.appendChild(tr);
  });
  const footCells = weekNumbers.map(w => `<td class="num">${capacity.weekTotals[w] || 0}</td>`).join('');
  matrixFoot.innerHTML = `<tr><td>All resources</td>${footCells}<td class="num">${capacity.grandTotal}</td></tr>`;
}

document.getElementById('baseTargetInput').addEventListener('input', e => {
  getMonthData(getCurrentMonthKey()).target.baseHours = Number(e.target.value) || 0;
  saveState();
  renderCalcTab();
});
document.getElementById('additionalTargetInput').addEventListener('input', e => {
  getMonthData(getCurrentMonthKey()).target.additionalHours = Number(e.target.value) || 0;
  saveState();
  renderCalcTab();
});

/* =========================================================
   TABS
   ========================================================= */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === 'tab-' + activeTab);
    });
  });
});

/* =========================================================
   MONTH NAVIGATION
   ========================================================= */

function setMonth(year, month) {
  currentYear = year;
  currentMonth = month;
  renderAll();
}

document.getElementById('prevMonthBtn').addEventListener('click', () => {
  const d = new Date(currentYear, currentMonth - 1, 1);
  setMonth(d.getFullYear(), d.getMonth());
});
document.getElementById('nextMonthBtn').addEventListener('click', () => {
  const d = new Date(currentYear, currentMonth + 1, 1);
  setMonth(d.getFullYear(), d.getMonth());
});
document.getElementById('todayBtn').addEventListener('click', () => {
  setMonth(today.getFullYear(), today.getMonth());
});
document.getElementById('monthPicker').addEventListener('change', e => {
  const [y, m] = e.target.value.split('-').map(Number);
  if (y && m) setMonth(y, m - 1);
});

/* =========================================================
   IMPORT / EXPORT
   ========================================================= */

document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `capacity-ledger-${getCurrentMonthKey()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFileInput').click();
});
document.getElementById('importFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.resourceList || !parsed.monthDataByKey) throw new Error('Unrecognized file format');
      if (confirm('This replaces all current data with the imported file. Continue?')) {
        state = parsed;
        saveState();
        renderAll();
        showToast('Data imported');
      }
    } catch (err) {
      alert('Could not import this file: ' + err.message);
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});

/* =========================================================
   INIT
   ========================================================= */

function init() {
  currentYear = today.getFullYear();
  currentMonth = today.getMonth();
  renderAll();
}

init();
