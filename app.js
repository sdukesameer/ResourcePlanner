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
    monthData.resourceOverrides[resourceId] = {
      month: 'full', weekOverrides: {}, dayOverrides: {}, dayAdjustments: {},
      unbillableMonth: false, unbillableWeeks: {}
    };
  }
  const override = monthData.resourceOverrides[resourceId];
  if (!override.dayAdjustments) override.dayAdjustments = {}; // back-fill for data saved before this feature
  if (override.unbillableMonth === undefined) override.unbillableMonth = false;
  if (!override.unbillableWeeks) override.unbillableWeeks = {};
  return override;
}

/** Step size for the daily hour slider: 0.25h (15 min) on full-billed days, 0.125h on partial-billed days. */
function getAdjustmentStep(billingType) {
  return billingType === 'full' ? 0.25 : 0.125;
}

function getResourceColor(resourceId) {
  const resourceObj = state.resourceList.find(r => r.id === resourceId);
  if (resourceObj && resourceObj.color) return resourceObj.color;
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
  const override = getResourceOverride(monthKey, resourceId);

  const resourceObj = state.resourceList.find(r => r.id === resourceId);
  if (resourceObj && !isResourceAssigned(resourceObj, dateStr)) return { status: 'unassigned', hours: 0 };

  const holiday = monthData.holidays[dateStr];
  if (holiday) return { status: 'holiday', hours: 0, label: holiday.label };

  if (isResourceUnbillable(monthKey, resourceId, weekNum)) return { status: 'unbillable', hours: 0 };

  const leaveEntry = monthData.leaves[dateStr] && monthData.leaves[dateStr][resourceId];
  if (leaveEntry) return { status: 'leave', hours: 0, label: leaveEntry.label, color: leaveEntry.color };

  if (isWeekend(dateObj)) {
    const weekendOverride = override.dayOverrides[dateStr]; // undefined = no overtime worked, the default
    if (!weekendOverride) return { status: 'weekend', hours: 0 };
    const baseHours = weekendOverride === 'full' ? 8 : 4;
    const adjustment = override.dayAdjustments[dateStr] || 0;
    const hours = Math.max(0, roundToQuarter(baseHours + adjustment));
    return { status: 'working', hours, billingType: weekendOverride, baseHours, adjustment };
  }

  const billingType = resolveBillingType(monthKey, resourceId, dateStr, weekNum);
  const baseHours = billingType === 'full' ? 8 : 4;
  const adjustment = override.dayAdjustments[dateStr] || 0;
  const hours = Math.max(0, roundToQuarter(baseHours + adjustment));
  return { status: 'working', hours, billingType, baseHours, adjustment };
}

/** True if the resource has no start/end date set (blank = indefinite), or dateStr falls within them. */
function isResourceAssigned(resourceObj, dateStr) {
  if (resourceObj.startDate && dateStr < resourceObj.startDate) return false;
  if (resourceObj.endDate && dateStr > resourceObj.endDate) return false;
  return true;
}

/** True if the resource is marked unbillable for the whole month, or for this specific week. */
function isResourceUnbillable(monthKey, resourceId, weekNum) {
  const override = getResourceOverride(monthKey, resourceId);
  if (override.unbillableMonth) return true;
  if (weekNum != null && override.unbillableWeeks[weekNum]) return true;
  return false;
}

/**
 * True if this resource should count toward hours on dateStr at all: assigned, billable,
 * not on leave, and not a holiday. Used by the bulk "adjust effort" tool so it never
 * projects or writes hours onto a resource who isn't actually active that day.
 */
function isResourceEligibleForBulkAdjust(monthKey, resourceObj, dateStr, weekNum) {
  const monthData = getMonthData(monthKey);
  if (monthData.holidays[dateStr]) return false;
  if (!isResourceAssigned(resourceObj, dateStr)) return false;
  if (isResourceUnbillable(monthKey, resourceObj.id, weekNum)) return false;
  const leaveEntry = monthData.leaves[dateStr] && monthData.leaves[dateStr][resourceObj.id];
  if (leaveEntry) return false;
  return true;
}

/** True if the resource's assigned range (if any) overlaps [rangeStartStr, rangeEndStr] at all. */
function isResourceAssignedDuringRange(resourceObj, rangeStartStr, rangeEndStr) {
  if (resourceObj.endDate && resourceObj.endDate < rangeStartStr) return false;
  if (resourceObj.startDate && resourceObj.startDate > rangeEndStr) return false;
  return true;
}

/** True if the resource's assigned range (if any) overlaps this month at all. */
function isResourceActiveInMonth(resourceObj, year, month) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthStartStr = dateKeyFromParts(year, month, 1);
  const monthEndStr = dateKeyFromParts(year, month, daysInMonth);
  return isResourceAssignedDuringRange(resourceObj, monthStartStr, monthEndStr);
}

/** Avoids floating point drift (e.g. 8.1 + 0.25 = 8.099999...) when stacking 0.125-step adjustments. */
function roundToQuarter(value) {
  return Math.round(value * 1000) / 1000;
}

/** Aggregates hours for every in-month day, plus per-resource and per-week rollups. */
function computeMonthCapacity(year, month) {
  const monthKey = getMonthKey(year, month);
  const monthData = getMonthData(monthKey);
  const weeks = buildCalendarWeeks(year, month);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const dayTotals = {};
  const weekTotals = {};
  const resourceWeekTotals = {};
  state.resourceList.forEach(r => { resourceWeekTotals[r.id] = {}; });

  let workingDayCount = 0;
  let holidayCount = 0;
  let leaveInstanceCount = 0;
  let unbillableInstanceCount = 0;
  const orderedDates = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(year, month, day);
    const dateStr = dateKeyFromDate(dateObj);
    const weekNum = getWeekNumberForDate(dateObj, weeks);
    let dayTotal = 0;

    if (!isWeekend(dateObj)) {
      if (monthData.holidays[dateStr]) holidayCount++;
      else workingDayCount++;
    }

    state.resourceList.forEach(resource => {
      const result = computeResourceDay(monthKey, resource.id, dateObj, weekNum);
      dayTotal += result.hours;
      resourceWeekTotals[resource.id][weekNum] = (resourceWeekTotals[resource.id][weekNum] || 0) + result.hours;
      if (result.status === 'leave') leaveInstanceCount++;
      if (result.status === 'unbillable') unbillableInstanceCount++;
    });

    dayTotals[dateStr] = dayTotal;
    orderedDates.push({ dateObj, dateStr, total: dayTotal, isWeekend: isWeekend(dateObj), isHoliday: !!monthData.holidays[dateStr] });
    weekTotals[weekNum] = (weekTotals[weekNum] || 0) + dayTotal;
  }

  const grandTotal = Object.values(weekTotals).reduce((sum, v) => sum + v, 0);
  return {
    weeks, dayTotals, weekTotals, resourceWeekTotals, grandTotal, monthKey,
    orderedDates, workingDayCount, holidayCount, leaveInstanceCount, unbillableInstanceCount
  };
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
    const activeThisMonth = isResourceActiveInMonth(resource, currentYear, currentMonth);
    const card = document.createElement('div');
    card.className = 'resource-card';

    const top = document.createElement('div');
    top.className = 'resource-card-top' + (activeThisMonth ? '' : ' is-inactive-period');

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'resource-dot-input';
    colorInput.value = getResourceColor(resource.id);
    colorInput.title = 'Change resource colour';
    colorInput.addEventListener('input', () => {
      resource.color = colorInput.value;
      saveState();
      renderCalendarTab();
      renderCalcTab();
    });
    top.appendChild(colorInput);

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
    monthSelect.innerHTML = `
      <option value="full">Full day (8h) default</option>
      <option value="partial">Partial day (4h) default</option>
      <option value="unbillable">Unbillable this month</option>
    `;
    monthSelect.value = override.unbillableMonth ? 'unbillable' : override.month;
    monthSelect.addEventListener('change', () => {
      if (monthSelect.value === 'unbillable') {
        override.unbillableMonth = true;
      } else {
        override.unbillableMonth = false;
        override.month = monthSelect.value;
      }
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

    const assignRow = document.createElement('div');
    assignRow.className = 'resource-assign-row';
    const assignLabel = document.createElement('span');
    assignLabel.className = 'assign-label';
    assignLabel.textContent = 'Assigned';
    assignRow.appendChild(assignLabel);

    const startInput = document.createElement('input');
    startInput.type = 'date';
    startInput.value = resource.startDate || '';
    startInput.setAttribute('aria-label', `${resource.name} start date`);
    startInput.addEventListener('change', () => {
      resource.startDate = startInput.value || null;
      saveState();
      renderCalendarTab();
      renderCalcTab();
    });
    assignRow.appendChild(startInput);

    const assignTo = document.createElement('span');
    assignTo.className = 'assign-to';
    assignTo.textContent = 'to';
    assignRow.appendChild(assignTo);

    const endInput = document.createElement('input');
    endInput.type = 'date';
    endInput.value = resource.endDate || '';
    endInput.setAttribute('aria-label', `${resource.name} end date`);
    endInput.addEventListener('change', () => {
      endInput.setCustomValidity('');
      if (startInput.value && endInput.value && endInput.value < startInput.value) {
        endInput.setCustomValidity('End date must be on or after the start date');
        endInput.reportValidity();
        return;
      }
      resource.endDate = endInput.value || null;
      saveState();
      renderCalendarTab();
      renderCalcTab();
    });
    assignRow.appendChild(endInput);

    const assignHint = document.createElement('span');
    assignHint.className = 'assign-hint';
    assignHint.textContent = 'Leave blank for indefinite';
    assignRow.appendChild(assignHint);

    card.appendChild(assignRow);

    const weekRow = document.createElement('div');
    weekRow.className = 'resource-week-row';
    weeks.forEach((week, idx) => {
      const weekNum = idx + 1;
      const hasInMonthDay = week.some(d => d.getMonth() === currentMonth);
      if (!hasInMonthDay) return;

      const wrap = document.createElement('div');
      wrap.className = 'week-toggle';
      const weekStartStr = dateKeyFromDate(week[0]);
      const weekEndStr = dateKeyFromDate(week[6]);
      const assignedThisWeek = isResourceAssignedDuringRange(resource, weekStartStr, weekEndStr);
      if (!assignedThisWeek) wrap.classList.add('is-inactive-period');

      const label = document.createElement('span');
      label.textContent = `Week ${weekNum}`;
      wrap.appendChild(label);

      const sel = document.createElement('select');
      sel.disabled = !assignedThisWeek;
      sel.innerHTML = `
        <option value="">Inherit month</option>
        <option value="full">Full (8h)</option>
        <option value="partial">Partial (4h)</option>
        <option value="unbillable">Unbillable</option>
      `;
      sel.value = override.unbillableWeeks[weekNum] ? 'unbillable' : (override.weekOverrides[weekNum] || '');
      sel.addEventListener('change', () => {
        if (sel.value === 'unbillable') {
          override.unbillableWeeks[weekNum] = true;
          delete override.weekOverrides[weekNum];
        } else {
          delete override.unbillableWeeks[weekNum];
          if (sel.value) override.weekOverrides[weekNum] = sel.value;
          else delete override.weekOverrides[weekNum];
        }
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
      const isWeekendDay = isWeekend(dateObj);
      let dayTotal = 0;
      const dotsWrap = document.createElement('div');
      dotsWrap.className = 'cal-dots';
      let hasDots = false;

      state.resourceList.forEach(resource => {
        const result = computeResourceDay(monthKey, resource.id, dateObj, weekNum);
        dayTotal += result.hours;
        const showDot = !holiday && (result.status === 'working' || !isWeekendDay);
        if (showDot) {
          const dot = document.createElement('span');
          dot.className = 'dot';
          if (result.status === 'leave') dot.style.background = result.color || getResourceColor(resource.id);
          else if (result.status === 'unbillable' || result.status === 'unassigned') dot.style.background = 'var(--ink-faint)';
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
        else if (result.status === 'unbillable') line += 'Unbillable this period';
        else if (result.status === 'unassigned') line += 'Not assigned this period';
        else if (result.status === 'weekend') line += 'Off (weekend)';
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
  const isWeekendDay = isWeekend(dateObj);

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
    masterWrap.hidden = holidayCheckbox.checked;
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

  const masterWrap = document.createElement('div');
  masterWrap.className = 'adjust-wrap master-adjust-wrap';
  if (existingHoliday) masterWrap.hidden = true;
  const masterLabel = document.createElement('span');
  masterLabel.className = 'adjust-label';
  masterLabel.textContent = 'All resources';
  const masterSlider = document.createElement('input');
  masterSlider.type = 'range';
  masterSlider.min = '50';
  masterSlider.max = '150';
  masterSlider.step = '3.125';
  masterSlider.value = '100';
  const masterReadout = document.createElement('span');
  masterReadout.className = 'adjust-readout';
  masterReadout.textContent = '100%';
  masterSlider.addEventListener('input', () => {
    const percent = parseFloat(masterSlider.value);
    masterReadout.textContent = percent.toFixed(3).replace(/\.?0+$/, '') + '%';
    rowControls.forEach(({ isUnbillable, isRowInactive, adjustSlider, refreshAdjustUI, getEffectiveBillingType }) => {
      if (isUnbillable || isRowInactive()) return;
      const base = getEffectiveBillingType() === 'full' ? 8 : 4;
      adjustSlider.value = String(roundToQuarter(base * (percent - 100) / 100));
      refreshAdjustUI();
    });
  });
  masterWrap.appendChild(masterLabel);
  masterWrap.appendChild(masterSlider);
  masterWrap.appendChild(masterReadout);
  card.appendChild(masterWrap);

  state.resourceList.forEach(resource => {
    const result = computeResourceDay(monthKey, resource.id, dateObj, weekNum);
    const leaveEntry = monthData.leaves[dateStr] && monthData.leaves[dateStr][resource.id];

    if (result.status === 'unbillable' || result.status === 'unassigned') {
      const row = document.createElement('div');
      row.className = 'unbillable-row';
      const tagText = result.status === 'unbillable' ? 'Unbillable this week' : 'Not assigned this period';
      row.innerHTML = `
        <span class="resource-day-name">${escapeHtml(resource.name)}</span>
        <span class="unbillable-tag">${tagText}</span>
      `;
      resourceRowsWrap.appendChild(row);
      rowControls.push({ resource, isUnbillable: true });
      return;
    }

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

    const leaveToggleWrap = document.createElement('label');
    leaveToggleWrap.className = 'leave-toggle-wrap';
    leaveToggleWrap.title = 'Mark this resource on leave for the day';
    const leaveToggleLabel = document.createElement('span');
    leaveToggleLabel.className = 'leave-toggle-label';
    leaveToggleLabel.textContent = 'Leave';
    const leaveToggle = document.createElement('input');
    leaveToggle.type = 'checkbox';
    leaveToggle.className = 'leave-toggle';
    leaveToggle.checked = !!leaveEntry;
    leaveToggleWrap.appendChild(leaveToggleLabel);
    leaveToggleWrap.appendChild(leaveToggle);
    row.appendChild(leaveToggleWrap);

    const statusSelect = document.createElement('select');
    const existingDayOverride = monthData.resourceOverrides[resource.id] && monthData.resourceOverrides[resource.id].dayOverrides[dateStr];
    if (isWeekendDay) {
      statusSelect.innerHTML = `
        <option value="weekend">Weekend (no work)</option>
        <option value="full">Full day (8h)</option>
        <option value="partial">Partial day (4h)</option>
      `;
      statusSelect.value = existingDayOverride || 'weekend';
    } else {
      statusSelect.innerHTML = `
        <option value="inherit">Inherit (${resolveBillingType(monthKey, resource.id, dateStr, weekNum) === 'full' ? 'Full' : 'Partial'})</option>
        <option value="full">Full day (8h)</option>
        <option value="partial">Partial day (4h)</option>
      `;
      statusSelect.value = existingDayOverride || 'inherit';
    }
    row.appendChild(statusSelect);

    const extraWrap = document.createElement('div');
    extraWrap.className = 'resource-day-extra';
    extraWrap.hidden = !leaveToggle.checked;
    const leaveLabelInput = document.createElement('input');
    leaveLabelInput.type = 'text';
    leaveLabelInput.placeholder = 'Leave label (required, e.g. Sick leave)';
    leaveLabelInput.required = true;
    leaveLabelInput.value = leaveEntry ? leaveEntry.label : '';
    const leaveColorInput = document.createElement('input');
    leaveColorInput.type = 'color';
    leaveColorInput.value = leaveEntry ? leaveEntry.color : LEAVE_COLORS[0];
    extraWrap.appendChild(leaveLabelInput);
    extraWrap.appendChild(leaveColorInput);
    row.appendChild(extraWrap);

    // Fine-tune slider: nudges the day's hours up/down in 0.25h (full-billed) or 0.125h (partial-billed) steps.
    const adjustWrap = document.createElement('div');
    adjustWrap.className = 'adjust-wrap';

    const adjustLabel = document.createElement('span');
    adjustLabel.className = 'adjust-label';
    adjustLabel.textContent = 'Fine-tune';

    const adjustSlider = document.createElement('input');
    adjustSlider.type = 'range';
    adjustSlider.min = '-4';
    adjustSlider.max = '4';

    const adjustReadout = document.createElement('span');
    adjustReadout.className = 'adjust-readout';

    function currentEffectiveBillingType() {
      if (statusSelect.value === 'full') return 'full';
      if (statusSelect.value === 'partial') return 'partial';
      return resolveBillingType(monthKey, resource.id, dateStr, weekNum);
    }

    function isRowInactive() {
      return leaveToggle.checked || (isWeekendDay && statusSelect.value === 'weekend');
    }

    function refreshAdjustUI() {
      const billingType = currentEffectiveBillingType();
      adjustSlider.step = String(getAdjustmentStep(billingType));
      const base = billingType === 'full' ? 8 : 4;
      const delta = parseFloat(adjustSlider.value) || 0;
      adjustReadout.textContent = Math.max(0, roundToQuarter(base + delta)) + 'h';
    }

    function refreshRowState() {
      const inactive = isRowInactive();
      nameWrap.classList.toggle('is-disabled', inactive);
      adjustWrap.classList.toggle('is-disabled', inactive);
      adjustSlider.disabled = inactive;
      statusSelect.disabled = leaveToggle.checked;
      extraWrap.hidden = !leaveToggle.checked;
      refreshAdjustUI();
    }

    adjustSlider.value = String(result.status === 'working' ? (result.adjustment || 0) : 0);
    adjustSlider.addEventListener('input', refreshAdjustUI);
    leaveToggle.addEventListener('change', refreshRowState);
    statusSelect.addEventListener('change', refreshRowState);
    refreshRowState();

    adjustWrap.appendChild(adjustLabel);
    adjustWrap.appendChild(adjustSlider);
    adjustWrap.appendChild(adjustReadout);
    row.appendChild(adjustWrap);

    resourceRowsWrap.appendChild(row);
    rowControls.push({
      resource, statusSelect, leaveToggle, leaveLabelInput, leaveColorInput, adjustSlider,
      refreshAdjustUI: refreshRowState, getEffectiveBillingType: currentEffectiveBillingType, isRowInactive
    });
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
  if (!holidayCheckbox.checked) {
    for (const rc of rowControls) {
      if (rc.isUnbillable || !rc.leaveToggle) continue;
      if (rc.leaveToggle.checked && !rc.leaveLabelInput.value.trim()) {
        rc.leaveLabelInput.focus();
        showToast(`Add a leave label for ${rc.resource.name}`);
        return;
      }
    }
  }

  const monthData = getMonthData(monthKey);

  if (holidayCheckbox.checked) {
    const label = holidayLabelInput.value.trim() || 'Holiday';
    monthData.holidays[dateStr] = { label };
  } else {
    delete monthData.holidays[dateStr];
  }

  rowControls.forEach(({ resource, isUnbillable, statusSelect, leaveToggle, leaveLabelInput, leaveColorInput, adjustSlider }) => {
    if (isUnbillable) return; // controlled from the Resources tab, not editable per-day

    const override = getResourceOverride(monthKey, resource.id);

    if (monthData.leaves[dateStr]) delete monthData.leaves[dateStr][resource.id];

    if (leaveToggle.checked) {
      if (!monthData.leaves[dateStr]) monthData.leaves[dateStr] = {};
      monthData.leaves[dateStr][resource.id] = {
        label: leaveLabelInput.value.trim() || 'Leave',
        color: leaveColorInput.value
      };
      delete override.dayAdjustments[dateStr]; // leave always zeroes the day, adjustment is meaningless
      delete override.dayOverrides[dateStr];
    } else {
      const noWorkValue = statusSelect.value === 'inherit' || statusSelect.value === 'weekend';
      if (noWorkValue) delete override.dayOverrides[dateStr];
      else override.dayOverrides[dateStr] = statusSelect.value;

      const adjustment = parseFloat(adjustSlider.value) || 0;
      if (adjustment === 0 || statusSelect.value === 'weekend') delete override.dayAdjustments[dateStr];
      else override.dayAdjustments[dateStr] = adjustment;
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
   BULK "ADJUST EFFORT TO HIT TARGET" MODAL
   ========================================================= */

/**
 * Projects the month's grand total if a uniform effort % (in 3.125% / 0.25h steps)
 * is applied to every resource on every working day from fromDateStr to month end.
 * Days before fromDateStr keep their currently saved hours.
 */
function computeProjectedTotal(fromDateStr, percent) {
  const monthKey = getCurrentMonthKey();
  const weeks = buildCalendarWeeks(currentYear, currentMonth);
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  let total = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(currentYear, currentMonth, day);
    const dateStr = dateKeyFromDate(dateObj);
    const weekNum = getWeekNumberForDate(dateObj, weeks);

    if (dateStr < fromDateStr) {
      state.resourceList.forEach(resource => {
        total += computeResourceDay(monthKey, resource.id, dateObj, weekNum).hours;
      });
      continue;
    }

    if (isWeekend(dateObj)) continue;

    state.resourceList.forEach(resource => {
      if (!isResourceEligibleForBulkAdjust(monthKey, resource, dateStr, weekNum)) return;
      const billingType = resolveBillingType(monthKey, resource.id, dateStr, weekNum);
      const base = billingType === 'full' ? 8 : 4;
      const delta = base * (percent - 100) / 100;
      total += Math.max(0, roundToQuarter(base + delta));
    });
  }
  return total;
}

// Remembers the last date/percent chosen in the bulk-adjust modal so reopening it doesn't reset the view.
let bulkAdjustLastFromDate = null;
let bulkAdjustLastPercent = 100;

function openBulkAdjustModal() {
  const monthKey = getCurrentMonthKey();
  const monthData = getMonthData(monthKey);
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const monthStartStr = dateKeyFromParts(currentYear, currentMonth, 1);
  const monthEndStr = dateKeyFromParts(currentYear, currentMonth, daysInMonth);
  const targetTotal = Number(monthData.target.baseHours || 0) + Number(monthData.target.additionalHours || 0);

  const defaultFromDate = (today >= new Date(currentYear, currentMonth, 1) && today <= new Date(currentYear, currentMonth, daysInMonth))
    ? dateKeyFromDate(today) : monthStartStr;

  const modalRoot = document.getElementById('modalRoot');
  modalRoot.innerHTML = '';
  modalRoot.hidden = false;

  const card = document.createElement('div');
  card.className = 'modal-card';
  card.innerHTML = `
    <h3>Adjust effort to hit target</h3>
    <p class="modal-sub">Scale every resource's daily hours from a chosen date through month end, in 3.125% (0.25h) steps, to close the gap to your target.</p>
  `;

  const fromLabel = document.createElement('label');
  fromLabel.style.cssText = 'display:flex;flex-direction:column;gap:5px;font-size:12.5px;font-weight:600;color:var(--ink-soft);margin-bottom:14px;';
  fromLabel.textContent = 'Apply from';
  const fromInput = document.createElement('input');
  fromInput.type = 'date';
  fromInput.min = monthStartStr;
  fromInput.max = monthEndStr;
  fromInput.value = bulkAdjustLastFromDate || defaultFromDate;
  fromLabel.appendChild(fromInput);
  card.appendChild(fromLabel);

  const sliderWrap = document.createElement('div');
  sliderWrap.className = 'adjust-wrap master-adjust-wrap';
  sliderWrap.style.marginBottom = '16px';
  const sliderLabel = document.createElement('span');
  sliderLabel.className = 'adjust-label';
  sliderLabel.textContent = 'Effort %';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '50';
  slider.max = '150';
  slider.step = '3.125';
  slider.value = String(bulkAdjustLastPercent);
  const sliderReadout = document.createElement('span');
  sliderReadout.className = 'adjust-readout';
  sliderReadout.textContent = bulkAdjustLastPercent + '%';
  sliderWrap.appendChild(sliderLabel);
  sliderWrap.appendChild(slider);
  sliderWrap.appendChild(sliderReadout);
  card.appendChild(sliderWrap);

  const tileGrid = document.createElement('div');
  tileGrid.className = 'bulk-tile-grid';
  card.appendChild(tileGrid);

  const preview = document.createElement('div');
  preview.className = 'bulk-preview';
  card.appendChild(preview);

  function refreshPreview() {
    const percent = parseFloat(slider.value);
    const isAdjusted = percent !== 100;
    sliderReadout.textContent = percent.toFixed(3).replace(/\.?0+$/, '') + '%';

    const fromDateLabel = formatShortDate(new Date(fromInput.value + 'T00:00:00'));
    const fullHoursNew = Math.max(0, roundToQuarter(8 * (1 + (percent - 100) / 100)));
    const partialHoursNew = Math.max(0, roundToQuarter(4 * (1 + (percent - 100) / 100)));

    const tiles = [
      { label: 'Full day', value: '8h', sub: isAdjusted ? `Until ${fromDateLabel}` : 'Applies all month' },
      { label: 'Partial day', value: '4h', sub: isAdjusted ? `Until ${fromDateLabel}` : 'Applies all month' }
    ];
    if (isAdjusted) {
      tiles.push({ label: 'Full day (new)', value: `${fullHoursNew}h`, sub: `From ${fromDateLabel}` });
      tiles.push({ label: 'Partial day (new)', value: `${partialHoursNew}h`, sub: `From ${fromDateLabel}` });
    }
    tileGrid.innerHTML = tiles.map(t => `
      <div class="summary-card bulk-tile">
        <div class="label">${t.label}</div>
        <div class="value">${t.value}</div>
        <div class="sublabel">${t.sub}</div>
      </div>
    `).join('');

    const projectedTotal = computeProjectedTotal(fromInput.value, percent);
    const diff = projectedTotal - targetTotal;
    preview.innerHTML = `
      <div class="bulk-preview-row"><span>Projected month total</span><strong>${projectedTotal}h</strong></div>
      <div class="bulk-preview-row ${diff >= 0 ? 'positive' : 'negative'}"><span>Vs. target (${targetTotal}h)</span><strong>${diff >= 0 ? '+' : ''}${diff}h</strong></div>
    `;
  }

  slider.addEventListener('input', () => {
    bulkAdjustLastPercent = parseFloat(slider.value);
    refreshPreview();
  });
  fromInput.addEventListener('change', () => {
    bulkAdjustLastFromDate = fromInput.value;
    refreshPreview();
  });
  refreshPreview();

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const resetBtn = document.createElement('button');
  resetBtn.className = 'ghost-btn';
  resetBtn.style.color = 'var(--ink)';
  resetBtn.style.borderColor = 'var(--border-strong)';
  resetBtn.style.marginRight = 'auto';
  resetBtn.textContent = 'Reset';
  resetBtn.addEventListener('click', () => {
    slider.value = '100';
    fromInput.value = defaultFromDate;
    bulkAdjustLastPercent = 100;
    bulkAdjustLastFromDate = defaultFromDate;
    refreshPreview();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'ghost-btn';
  cancelBtn.style.color = 'var(--ink)';
  cancelBtn.style.borderColor = 'var(--border-strong)';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeModal);
  const applyBtn = document.createElement('button');
  applyBtn.className = 'primary-btn';
  applyBtn.textContent = 'Apply';
  applyBtn.addEventListener('click', () => {
    applyBulkAdjust(fromInput.value, parseFloat(slider.value));
  });
  actions.appendChild(resetBtn);
  actions.appendChild(cancelBtn);
  actions.appendChild(applyBtn);
  card.appendChild(actions);

  modalRoot.appendChild(card);
  modalRoot.addEventListener('click', e => { if (e.target === modalRoot) closeModal(); }, { once: true });
}

function applyBulkAdjust(fromDateStr, percent) {
  const monthKey = getCurrentMonthKey();
  const weeks = buildCalendarWeeks(currentYear, currentMonth);
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  let affectedDays = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(currentYear, currentMonth, day);
    const dateStr = dateKeyFromDate(dateObj);
    if (dateStr < fromDateStr || isWeekend(dateObj)) continue;
    const weekNum = getWeekNumberForDate(dateObj, weeks);
    let dayHadEligibleResource = false;

    state.resourceList.forEach(resource => {
      if (!isResourceEligibleForBulkAdjust(monthKey, resource, dateStr, weekNum)) return;
      dayHadEligibleResource = true;
      const override = getResourceOverride(monthKey, resource.id);
      const billingType = resolveBillingType(monthKey, resource.id, dateStr, weekNum);
      const base = billingType === 'full' ? 8 : 4;
      const delta = roundToQuarter(base * (percent - 100) / 100);
      if (delta === 0) delete override.dayAdjustments[dateStr];
      else override.dayAdjustments[dateStr] = delta;
    });

    if (dayHadEligibleResource) affectedDays++;
  }

  saveState();
  closeModal();
  renderCalendarTab();
  renderCalcTab();
  showToast(`Effort set to ${percent}% for ${affectedDays} working day(s)`);
}

document.getElementById('bulkAdjustBtn').addEventListener('click', openBulkAdjustModal);

/* =========================================================
   RENDER: LEAVES & HOLIDAYS TAB
   ========================================================= */

const LEAVE_COLORS = ['#E14F73', '#D98E2B', '#6D5DAB', '#3A8FB7', '#4E8C5E'];
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
  const activeResourceList = state.resourceList.filter(r => isResourceActiveInMonth(r, currentYear, currentMonth));
  resourceSelect.innerHTML = activeResourceList.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');

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
      if (!resource || !isResourceActiveInMonth(resource, currentYear, currentMonth)) return;
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
    { label: 'Surplus vs. rounded target', value: (surplusRounded >= 0 ? '+' : '') + surplusRounded, cls: surplusRounded >= 0 ? 'positive' : 'negative' },
    { label: 'Working days', value: capacity.workingDayCount, cls: '' },
    { label: 'Public holidays', value: capacity.holidayCount, cls: '' },
    { label: 'Leave instances', value: capacity.leaveInstanceCount, cls: '' },
    { label: 'Unbillable instances', value: capacity.unbillableInstanceCount, cls: '' }
  ];
  cards.forEach(c => {
    const card = document.createElement('div');
    card.className = 'summary-card ' + c.cls;
    card.innerHTML = `<div class="label">${c.label}</div><div class="value">${c.value}</div>`;
    summaryCards.appendChild(card);
  });
  const summaryColumns = Math.ceil(cards.length / 2);
  summaryCards.style.gridTemplateColumns = window.innerWidth > 700
    ? `repeat(${summaryColumns}, minmax(150px, 1fr))`
    : '';

  renderDailyHoursChart(capacity, targetTotal);
  renderCompositionChart(capacity);

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
    if (!isResourceActiveInMonth(resource, currentYear, currentMonth)) return;
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

/** Bar chart of planned hours per day, with a dashed reference line for the average daily target. */
function renderDailyHoursChart(capacity, targetTotal) {
  const container = document.getElementById('dailyHoursChart');
  const dayList = capacity.orderedDates;
  if (!dayList.length) { container.innerHTML = '<p class="chart-empty">No data yet.</p>'; return; }

  const maxHours = Math.max(...dayList.map(d => d.total), 8);
  const width = 760, height = 230, padLeft = 8, padRight = 8, padTop = 14, padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const slot = plotW / dayList.length;
  const barWidth = Math.max(2, slot - 3);
  const avgTarget = capacity.workingDayCount > 0 ? targetTotal / capacity.workingDayCount : 0;

  let bars = '';
  dayList.forEach((d, i) => {
    const x = padLeft + i * slot;
    let yCursor = padTop + plotH;
    const weekNum = getWeekNumberForDate(d.dateObj, capacity.weeks);

    state.resourceList.forEach(resource => {
      const result = computeResourceDay(capacity.monthKey, resource.id, d.dateObj, weekNum);
      if (result.hours <= 0) return;
      const segH = maxHours > 0 ? (result.hours / maxHours) * plotH : 0;
      yCursor -= segH;
      bars += `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${segH.toFixed(1)}" fill="${getResourceColor(resource.id)}"><title>${escapeHtml(resource.name)} — ${formatShortDate(d.dateObj)}: ${result.hours}h</title></rect>`;
    });
  });

  let refLine = '';
  if (avgTarget > 0 && avgTarget <= maxHours) {
    const refY = padTop + (plotH - (avgTarget / maxHours) * plotH);
    refLine = `<line x1="${padLeft}" y1="${refY.toFixed(1)}" x2="${width - padRight}" y2="${refY.toFixed(1)}" stroke="var(--leave)" stroke-width="1.5" stroke-dasharray="5,4" />
      <text x="${width - padRight}" y="${(refY - 6).toFixed(1)}" text-anchor="end" font-size="10.5" fill="var(--leave)" font-family="var(--font-mono)">avg/day target ${avgTarget.toFixed(1)}h</text>`;
  }

  const labelEvery = Math.max(1, Math.ceil(dayList.length / 8));
  let labels = '';
  dayList.forEach((d, i) => {
    if (i % labelEvery === 0) {
      const x = padLeft + i * slot + barWidth / 2;
      labels += `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="10" fill="var(--ink-faint)" font-family="var(--font-mono)">${d.dateObj.getDate()}</text>`;
    }
  });

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${bars}${refLine}${labels}</svg>`;
}

/** Horizontal bar breakdown of working days vs. holidays vs. leave instances for the month. */
function renderCompositionChart(capacity) {
  const container = document.getElementById('compositionChart');
  const items = [
    { label: 'Working days', value: capacity.workingDayCount, color: 'var(--full)' },
    { label: 'Holidays', value: capacity.holidayCount, color: 'var(--holiday)' },
    { label: 'Leave instances', value: capacity.leaveInstanceCount, color: 'var(--leave)' },
    { label: 'Unbillable instances', value: capacity.unbillableInstanceCount, color: 'var(--ink-faint)' }
  ];
  const maxVal = Math.max(...items.map(i => i.value), 1);
  const width = 320, rowHeight = 48, height = items.length * rowHeight + 8;
  const labelColumnWidth = 34;
  const barMaxWidth = width - labelColumnWidth;

  let rows = '';
  items.forEach((item, i) => {
    const barWidth = Math.max((item.value / maxVal) * barMaxWidth, item.value > 0 ? 4 : 0);
    const y = 8 + i * rowHeight;
    rows += `
      <text x="0" y="${y + 12}" font-size="12" fill="var(--ink-soft)" font-family="Inter, sans-serif">${item.label}</text>
      <rect x="0" y="${y + 18}" width="${barMaxWidth}" height="11" rx="5.5" fill="var(--surface-sunken)" />
      <rect x="0" y="${y + 18}" width="${barWidth.toFixed(1)}" height="11" rx="5.5" fill="${item.color}" />
      <text x="${width}" y="${y + 27}" text-anchor="end" font-size="13" font-weight="700" font-family="var(--font-mono)" fill="var(--ink)">${item.value}</text>
    `;
  });

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${rows}</svg>`;
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

const THEME_STORAGE_KEY = 'capacityLedgerTheme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeToggleBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
}

function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
}

document.getElementById('themeToggleBtn').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem(THEME_STORAGE_KEY, next);
});

function init() {
  initTheme();
  currentYear = today.getFullYear();
  currentMonth = today.getMonth();
  renderAll();
}

init();
