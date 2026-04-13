#!/usr/bin/env node
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const moment = require("moment");
const Costpoint = require("./costpoint");
const DirectClient = require("./direct");
const { normalizeTimesheetStatus } = require("./timesheet-status");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const url = process.env.COSTPOINT_URL;
const username = process.env.COSTPOINT_USERNAME;
const password = process.env.COSTPOINT_PASSWORD;
const system = process.env.COSTPOINT_SYSTEM;
const useDirect = process.env.COSTPOINT_DIRECT === 'true';

if (!url || !username || !password) {
  console.error(
    "Make sure that COSTPOINT_URL, COSTPOINT_USERNAME, COSTPOINT_PASSWORD are set in the environment."
  );
  process.exit(1);
}

if (!useDirect && !system) {
  console.error(
    "COSTPOINT_SYSTEM is required when not using direct mode. Set COSTPOINT_DIRECT=true for direct protocol."
  );
  process.exit(1);
}

async function launchClient() {
  if (useDirect) {
    return DirectClient.launch(url, username, password);
  }
  return Costpoint.launch(url, username, password, system);
}

// Cache file location — stores per-week data keyed by week start date
const CACHE_FILE = path.join(os.homedir(), ".costpoint-cache.json");

// In-memory state
let cachedWeeks = {}; // { "2026-04-06": weekData, ... }
let activeWeekStart = null; // fullDate of the most recently fetched week
let pendingChanges = new Map(); // key: "line-day", value: { line, day, hours }
let isProcessing = false;
let lastError = null;
let syncStatus = "idle"; // idle, loading, syncing, error
let isFetchingInitialData = false;
const VALID_PAY_TYPES = new Set(["EWW", "RHB", "LWD", "REG"]);

// Get the week start date string from week data
function weekStartKey(weekData) {
  if (!weekData || !weekData.dates || weekData.dates.length === 0) return null;
  return weekData.dates[0].fullDate;
}

// Store fetched week data into the cache
function storeWeekData(weekData) {
  const key = weekStartKey(weekData);
  if (!key) return;
  cachedWeeks[key] = weekData;
  activeWeekStart = key;
}

// Build the merged 2-week view from cached data
function getMergedData() {
  const activeWeek = activeWeekStart ? cachedWeeks[activeWeekStart] : null;
  if (!activeWeek) return null;

  const activeStart = moment(activeWeek.dates[0].fullDate);

  // Look for the adjacent week in cache (check both directions)
  const prevStart = activeStart.clone().subtract(7, 'days');
  const nextStart = activeStart.clone().add(7, 'days');
  const prevWeek = cachedWeeks[prevStart.format('YYYY-MM-DD')] || null;
  const nextWeek = cachedWeeks[nextStart.format('YYYY-MM-DD')] || null;

  // Determine week1 (earlier) and week2 (later)
  let week1Data, week2Data;
  if (prevWeek) {
    week1Data = prevWeek;
    week2Data = activeWeek;
  } else if (nextWeek) {
    week1Data = activeWeek;
    week2Data = nextWeek;
  } else {
    // No adjacent week cached — show active as week2 with empty week1
    week1Data = null;
    week2Data = activeWeek;
  }

  // Build 14-day date array: week1 + week2
  const week1Start = week1Data ? moment(week1Data.dates[0].fullDate) : activeStart.clone().subtract(7, 'days');
  const allDates = [];
  for (let i = 0; i < 14; i++) {
    const d = week1Start.clone().add(i, 'days');
    allDates.push({
      date: d.date(),
      fullDate: d.format('YYYY-MM-DD'),
      dayOfWeek: d.format('ddd'),
    });
  }

  // Set of active (editable) fullDates
  const activeDates = new Set(activeWeek.dates.map(d => d.fullDate));

  // Merge projects from both weeks by code+payType
  const projectMap = new Map();

  function addProjects(weekData, weekLabel) {
    if (!weekData) return;
    for (const p of weekData.projects) {
      const key = `${p.code || ''}|${p.payType || ''}`;
      if (!projectMap.has(key)) {
        projectMap.set(key, {
          code: p.code,
          description: p.description,
          payType: p.payType,
          hours: {},
          lines: {},
        });
      }
      const merged = projectMap.get(key);
      // Prefer the longer description
      if (p.description && p.description.length > (merged.description || '').length) {
        merged.description = p.description;
      }
      Object.assign(merged.hours, p.hours);
      merged.lines[weekLabel] = p.line;
    }
  }

  addProjects(week1Data, week1Data === activeWeek ? 'active' : 'other');
  addProjects(week2Data, week2Data === activeWeek ? 'active' : 'other');

  // Assign sequential line numbers for the merged view
  const projects = Array.from(projectMap.values()).map((p, i) => ({
    line: i,
    code: p.code,
    description: p.description,
    payType: p.payType,
    hours: p.hours,
    activeLine: p.lines.active,
  }));

  return {
    dates: allDates,
    projects,
    activeDates: Array.from(activeDates),
    timesheetStatus: activeWeek.timesheetStatus,
    timesheetStatusCode: activeWeek.timesheetStatusCode,
  };
}

// Get the active week data (raw, for API/save operations)
function getActiveWeekData() {
  return activeWeekStart ? cachedWeeks[activeWeekStart] : null;
}

// Load cache from disk on startup
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      // Support old single-week format: migrate to multi-week
      if (parsed && parsed.dates && Array.isArray(parsed.dates)) {
        const key = weekStartKey(parsed);
        if (key) {
          cachedWeeks = { [key]: parsed };
          activeWeekStart = key;
          console.log("Migrated single-week cache to multi-week format");
          saveCache();
          return true;
        }
      }
      // New multi-week format
      if (parsed && parsed.weeks) {
        cachedWeeks = parsed.weeks;
        activeWeekStart = parsed.activeWeekStart || null;
        console.log("Loaded multi-week cache (" + Object.keys(cachedWeeks).length + " weeks)");
        return true;
      }
    }
  } catch (e) {
    console.error("Failed to load cache:", e.message);
  }
  return false;
}

// Save cache to disk
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      weeks: cachedWeeks,
      activeWeekStart,
    }, null, 2));
  } catch (e) {
    console.error("Failed to save cache:", e.message);
  }
}

// Save all pending changes to Costpoint
async function saveAllChanges() {
  if (isProcessing || pendingChanges.size === 0) return { success: true, message: "No changes to save" };

  isProcessing = true;
  syncStatus = "syncing";

  const changesToSave = Array.from(pendingChanges.values());
  let cp = null;

  try {
    cp = await launchClient();

    // Use setm for multiple changes, set for single change
    if (changesToSave.length === 1) {
      const change = changesToSave[0];
      await cp.set(change.line, change.day, change.hours);
    } else {
      await cp.setm(changesToSave);
    }

    await cp.save();

    // Update cache with fresh data
    storeWeekData(cp.getData());
    saveCache();
    pendingChanges.clear();

    lastError = null;
    syncStatus = "idle";
    return { success: true, message: `Saved ${changesToSave.length} changes` };
  } catch (e) {
    console.error("Save failed:", e.message);
    lastError = e.message;
    syncStatus = "error";
    throw e;
  } finally {
    if (cp) {
      await cp.close();
    }
    isProcessing = false;
  }
}

// Add a project to the timesheet
async function addProject(code, payType) {
  if (isProcessing) throw new Error("Another operation is in progress");

  isProcessing = true;
  syncStatus = "syncing";

  let cp = null;
  try {
    cp = await launchClient();
    await cp.add(code, payType);
    await cp.save();

    storeWeekData(cp.getData());
    saveCache();

    lastError = null;
    syncStatus = "idle";
    return { success: true };
  } catch (e) {
    console.error("Add project failed:", e.message);
    lastError = e.message;
    syncStatus = "error";
    throw e;
  } finally {
    if (cp) {
      await cp.close();
    }
    isProcessing = false;
  }
}

// Sign the timesheet
async function signTimesheet() {
  if (isProcessing) throw new Error("Another operation is in progress");

  isProcessing = true;
  syncStatus = "syncing";

  let cp = null;
  try {
    cp = await launchClient();
    await cp.sign();

    storeWeekData(cp.getData());
    saveCache();

    lastError = null;
    syncStatus = "idle";
    return { success: true };
  } catch (e) {
    console.error("Sign failed:", e.message);
    lastError = e.message;
    syncStatus = "error";
    throw e;
  } finally {
    if (cp) {
      await cp.close();
    }
    isProcessing = false;
  }
}

// Fetch fresh data from Costpoint (both current and previous week)
async function fetchFreshData() {
  if (isProcessing) throw new Error("Another operation is in progress");

  isProcessing = true;
  syncStatus = "loading";
  let cp = null;
  try {
    cp = await launchClient();

    // Store current week
    const currentWeek = cp.getData();
    storeWeekData(currentWeek);

    // Navigate to the other week of the pay period.
    // The real Costpoint "Previous" button re-inits the app, and the server
    // moves the cursor to the previous period. For a biweekly schedule,
    // if we're on Wk 2 this gives us Wk 1; if on Wk 1 it gives us the
    // prior pay period's Wk 2. Either way, we cache whatever we get.
    try {
      await cp.navigateToPreviousPeriod();
      const otherWeek = cp.getData();
      const otherKey = weekStartKey(otherWeek);
      if (otherKey) {
        cachedWeeks[otherKey] = otherWeek;
      }
    } catch (navErr) {
      console.error("Failed to fetch other period (non-fatal):", navErr.message);
    }

    // activeWeekStart stays on the current week
    activeWeekStart = weekStartKey(currentWeek);

    saveCache();
    lastError = null;
    syncStatus = "idle";
    return getActiveWeekData();
  } catch (e) {
    console.error("Failed to fetch fresh data:", e.message);
    lastError = e.message;
    syncStatus = "error";
    throw e;
  } finally {
    if (cp) {
      await cp.close();
    }
    isProcessing = false;
  }
}

// Fetch data in background (non-blocking)
function fetchFreshDataInBackground() {
  if (isFetchingInitialData || isProcessing) return;

  isFetchingInitialData = true;
  syncStatus = "loading";

  fetchFreshData()
    .then(() => {
      console.log("Background fetch completed successfully");
    })
    .catch(e => {
      console.error("Background fetch failed:", e.message);
    })
    .finally(() => {
      isFetchingInitialData = false;
    });
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// HTML template rendering
function renderHTML(data, isLoading = false) {
  const hasData = data && data.dates && data.dates.length > 0;
  const periodStart = hasData ? data.dates[0] : null;
  const periodEnd = hasData ? data.dates[data.dates.length - 1] : null;
  const currentStatus = isLoading ? "loading" : syncStatus;
  const activeDatesSet = hasData ? new Set(data.activeDates || []) : new Set();
  const timesheetStatusMeta = hasData
    ? normalizeTimesheetStatus(data.timesheetStatusCode || data.timesheetStatus)
    : null;
  const timesheetStatusTitle = timesheetStatusMeta && timesheetStatusMeta.code
    ? `Raw status code: ${timesheetStatusMeta.code}`
    : "Raw status unavailable";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Str8 Outta Deltek</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="container">
    <header class="header">
      <img src="/deltek.png" alt="Str8 Outta Deltek" class="logo" />
      <div class="status-container">
        <div class="status-badges">
          <span id="sync-status" class="status-badge status-${currentStatus}">${currentStatus}</span>
          ${timesheetStatusMeta ? `
          <span
            id="timesheet-status"
            class="status-badge timesheet-status-badge timesheet-status-${timesheetStatusMeta.tone}"
            title="${timesheetStatusTitle}"
          >
            ${timesheetStatusMeta.label}
          </span>
          ` : ""}
        </div>
        <button id="refresh-btn" class="btn btn-secondary btn-icon" title="Refresh from Costpoint">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
        <button id="clear-cache-btn" class="btn btn-secondary btn-icon" title="Clear cache">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/>
          </svg>
        </button>
      </div>
    </header>

    ${hasData ? `
    <div class="period-info">
      <span class="period-label">Period:</span>
      <span class="period-dates">${periodStart.dayOfWeek} ${periodStart.fullDate} - ${periodEnd.dayOfWeek} ${periodEnd.fullDate}</span>
    </div>

    <div class="timesheet-wrapper">
      <table class="timesheet" id="timesheet">
        <thead>
          <tr>
            <th class="col-line">#</th>
            <th class="col-code">Code</th>
            <th class="col-desc">Description</th>
            <th class="col-pay">Pay</th>
            ${data.dates.map(d => {
              const isWeekend = d.dayOfWeek === 'Sat' || d.dayOfWeek === 'Sun';
              return `<th class="col-day ${isWeekend ? 'col-weekend' : 'col-weekday'}"><div class="day-header"><span class="day-name">${d.dayOfWeek}</span><span class="day-num">${d.date}</span></div></th>`;
            }).join("")}
            <th class="col-total">Total</th>
          </tr>
        </thead>
        <tbody>
          ${data.projects.map(project => `
          <tr data-line="${project.line}">
            <td class="col-line">${project.line}</td>
            <td class="col-code" title="${project.code || ''}">${project.code || ''}</td>
            <td class="col-desc" title="${project.description}">${project.description}</td>
            <td class="col-pay">${project.payType || ''}</td>
            ${data.dates.map(d => {
              const hours = project.hours[d.date];
              const displayValue = hours !== null && hours !== undefined ? hours : "";
              const isWeekend = d.dayOfWeek === 'Sat' || d.dayOfWeek === 'Sun';
              const isActive = activeDatesSet.has(d.fullDate);
              const disabled = !isActive ? 'disabled' : '';
              return `<td class="col-day ${isWeekend ? 'col-weekend' : 'col-weekday'} ${!isActive ? 'col-inactive' : ''}"><input type="text" class="hours-input ${!isActive ? 'inactive' : ''}" data-line="${project.line}" data-active-line="${isActive ? (project.activeLine != null ? project.activeLine : '') : ''}" data-day="${d.date}" data-fulldate="${d.fullDate}" value="${displayValue}" ${disabled} /></td>`;
            }).join("")}
            <td class="col-total row-total">0</td>
          </tr>
          `).join("")}
        </tbody>
        <tfoot>
          <tr class="totals-row">
            <td class="col-line"></td>
            <td class="col-code"></td>
            <td class="col-desc">Daily Total</td>
            <td class="col-pay"></td>
            ${data.dates.map(d => {
              const isWeekend = d.dayOfWeek === 'Sat' || d.dayOfWeek === 'Sun';
              return `<td class="col-day daily-total ${isWeekend ? 'col-weekend' : 'col-weekday'}" data-day="${d.date}">0</td>`;
            }).join("")}
            <td class="col-total grand-total">0</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div class="actions">
      <button id="add-project-btn" class="btn btn-secondary">+ Add Project</button>
      <div class="actions-right">
        <span id="unsaved-indicator" class="unsaved-indicator" style="display: none;">Unsaved changes</span>
        <button id="save-btn" class="btn btn-success" disabled>Save</button>
        <button id="sign-btn" class="btn btn-primary">Sign Timesheet</button>
      </div>
    </div>
    ` : `
    <div class="loading-container" id="loading-container">
      <div class="loading-spinner"></div>
      <p>Loading timesheet from Costpoint...</p>
      <p class="loading-hint">This may take a moment on first load</p>
    </div>
    `}

    <div id="error-banner" class="error-banner" style="display: none;">
      <span id="error-message"></span>
      <button id="dismiss-error" class="btn-dismiss">&times;</button>
    </div>
  </div>

  <!-- Add Project Modal -->
  <div id="add-project-modal" class="modal" style="display: none;">
    <div class="modal-content">
      <div class="modal-header">
        <h2>Add Project</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="modal-field">
          <label for="project-code">Project Code:</label>
          <input type="text" id="project-code" placeholder="Enter project code..." />
        </div>
        <div class="modal-field">
          <label for="project-pay-type">Pay Type:</label>
          <select id="project-pay-type">
            <option value="REG" selected>REG</option>
            <option value="EWW">EWW</option>
            <option value="RHB">RHB</option>
            <option value="LWD">LWD</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="confirm-add-project">Add</button>
      </div>
    </div>
  </div>

  <!-- Sign Confirmation Modal -->
  <div id="sign-modal" class="modal" style="display: none;">
    <div class="modal-content">
      <div class="modal-header">
        <h2>Sign Timesheet</h2>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <p>Are you sure you want to sign this timesheet?</p>
        <p class="warning">This action cannot be undone.</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="confirm-sign">Sign</button>
      </div>
    </div>
  </div>

  <script>
    window.TIMESHEET_DATA = ${hasData ? JSON.stringify(data) : 'null'};
    window.IS_LOADING = ${isLoading};
  </script>
  <script src="/app.js"></script>
</body>
</html>`;
}

// Routes
app.get("/", (req, res) => {
  const mergedData = getMergedData();
  // Always render immediately - show loading state if no data
  const isLoading = !mergedData && (isFetchingInitialData || !isProcessing);

  // Start background fetch if no data and not already fetching
  if (!mergedData && !isFetchingInitialData && !isProcessing) {
    fetchFreshDataInBackground();
  }

  res.send(renderHTML(mergedData, isLoading || isFetchingInitialData));
});

app.get("/api/status", (req, res) => {
  res.json({
    status: syncStatus,
    error: lastError,
    pendingChanges: pendingChanges.size,
    hasData: !!getActiveWeekData()
  });
});

app.get("/api/data", (req, res) => {
  const data = getMergedData();
  if (!data) {
    return res.status(404).json({ error: "No data cached" });
  }
  res.json(data);
});

app.put("/api/hours", (req, res) => {
  const { line, day, hours, activeLine } = req.body;

  if (activeLine === undefined || activeLine === '' || activeLine === null) {
    return res.status(400).json({ error: "Cannot edit hours for the previous week" });
  }

  if (day === undefined || hours === undefined) {
    return res.status(400).json({ error: "Missing required fields: day, hours" });
  }

  // Use the activeLine (Costpoint line number) for the save, not the merged line
  const realLine = parseInt(activeLine, 10);
  const key = `${realLine}-${day}`;
  const hoursValue = hours === "" ? 0 : parseFloat(hours);
  pendingChanges.set(key, { line: realLine, day, hours: hoursValue });

  // Update active week cache optimistically
  const activeWeek = getActiveWeekData();
  if (activeWeek) {
    const project = activeWeek.projects.find(p => p.line === realLine);
    if (project) {
      project.hours[day] = hours === "" ? null : parseFloat(hours);
    }
  }

  res.json({ success: true, pendingCount: pendingChanges.size });
});

app.post("/api/save", async (req, res) => {
  try {
    const result = await saveAllChanges();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/project", async (req, res) => {
  const { code, payType } = req.body;

  if (!code) {
    return res.status(400).json({ error: "Missing required field: code" });
  }

  const normalizedPayType = typeof payType === "string" && payType.trim()
    ? payType.trim().toUpperCase()
    : "REG";

  if (!VALID_PAY_TYPES.has(normalizedPayType)) {
    return res.status(400).json({ error: "Invalid pay type" });
  }

  try {
    await addProject(code, normalizedPayType);
    res.json({ success: true, data: getMergedData() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sign", async (req, res) => {
  try {
    await signTimesheet();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/refresh", async (req, res) => {
  try {
    await fetchFreshData();
    res.json({ success: true, data: getMergedData() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/cache", (req, res) => {
  try {
    cachedWeeks = {};
    activeWeekStart = null;
    pendingChanges.clear();
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
    }
    res.json({ success: true, message: "Cache cleared" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Initialize and start server
loadCache();

app.listen(PORT, () => {
  console.log(`Costpoint Web UI running at http://localhost:${PORT}`);
  const weekCount = Object.keys(cachedWeeks).length;
  if (weekCount > 0) {
    console.log(`Using cached data (${weekCount} week(s)) - timesheet will load instantly`);
  } else {
    console.log("No cache found - will fetch from Costpoint on first request");
  }
});
