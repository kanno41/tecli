#!/usr/bin/env node
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const Costpoint = require("./costpoint");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const url = process.env.COSTPOINT_URL;
const username = process.env.COSTPOINT_USERNAME;
const password = process.env.COSTPOINT_PASSWORD;
const system = process.env.COSTPOINT_SYSTEM;

if (!url || !username || !password || !system) {
  console.error(
    "Make sure that COSTPOINT_URL, COSTPOINT_USERNAME, COSTPOINT_PASSWORD, COSTPOINT_SYSTEM are set in the environment."
  );
  process.exit(1);
}

// Cache file location
const CACHE_FILE = path.join(os.homedir(), ".costpoint-cache.json");

// In-memory state
let cachedData = null;
let pendingChanges = new Map(); // key: "line-day", value: { line, day, hours }
let isProcessing = false;
let lastError = null;
let syncStatus = "idle"; // idle, loading, syncing, error
let isFetchingInitialData = false;

// Load cache from disk on startup
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, "utf8");
      cachedData = JSON.parse(data);
      console.log("Loaded timesheet data from cache");
      return true;
    }
  } catch (e) {
    console.error("Failed to load cache:", e.message);
  }
  return false;
}

// Save cache to disk
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cachedData, null, 2));
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
    cp = await Costpoint.launch(url, username, password, system);

    // Use setm for multiple changes, set for single change
    if (changesToSave.length === 1) {
      const change = changesToSave[0];
      await cp.set(change.line, change.day, change.hours);
    } else {
      await cp.setm(changesToSave);
    }

    await cp.save();

    // Update cache with fresh data
    cachedData = cp.getData();
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
async function addProject(code) {
  if (isProcessing) throw new Error("Another operation is in progress");

  isProcessing = true;
  syncStatus = "syncing";

  let cp = null;
  try {
    cp = await Costpoint.launch(url, username, password, system);
    await cp.add(code);
    await cp.save();

    cachedData = cp.getData();
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
    cp = await Costpoint.launch(url, username, password, system);
    await cp.sign();

    cachedData = cp.getData();
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

// Fetch fresh data from Costpoint
async function fetchFreshData() {
  if (isProcessing) throw new Error("Another operation is in progress");

  isProcessing = true;
  syncStatus = "loading";
  let cp = null;
  try {
    cp = await Costpoint.launch(url, username, password, system);
    cachedData = cp.getData();
    saveCache();
    lastError = null;
    syncStatus = "idle";
    return cachedData;
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
        <span id="sync-status" class="status-badge status-${currentStatus}">${currentStatus}</span>
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
            <th class="col-desc">Description</th>
            ${data.dates.map(d => `<th class="col-day"><div class="day-header"><span class="day-name">${d.dayOfWeek}</span><span class="day-num">${d.date}</span></div></th>`).join("")}
            <th class="col-total">Total</th>
          </tr>
        </thead>
        <tbody>
          ${data.projects.map(project => `
          <tr data-line="${project.line}">
            <td class="col-line">${project.line}</td>
            <td class="col-desc" title="${project.description}">${project.description}</td>
            ${data.dates.map(d => {
              const hours = project.hours[d.date];
              const displayValue = hours !== null && hours !== undefined ? hours : "";
              return `<td class="col-day"><input type="text" class="hours-input" data-line="${project.line}" data-day="${d.date}" value="${displayValue}" /></td>`;
            }).join("")}
            <td class="col-total row-total">0</td>
          </tr>
          `).join("")}
        </tbody>
        <tfoot>
          <tr class="totals-row">
            <td class="col-line"></td>
            <td class="col-desc">Daily Total</td>
            ${data.dates.map(d => `<td class="col-day daily-total" data-day="${d.date}">0</td>`).join("")}
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
        <label for="project-code">Project Code:</label>
        <input type="text" id="project-code" placeholder="Enter project code..." />
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
  // Always render immediately - show loading state if no data
  const isLoading = !cachedData && (isFetchingInitialData || !isProcessing);

  // Start background fetch if no data and not already fetching
  if (!cachedData && !isFetchingInitialData && !isProcessing) {
    fetchFreshDataInBackground();
  }

  res.send(renderHTML(cachedData, isLoading || isFetchingInitialData));
});

app.get("/api/status", (req, res) => {
  res.json({
    status: syncStatus,
    error: lastError,
    pendingChanges: pendingChanges.size,
    hasData: !!cachedData
  });
});

app.get("/api/data", (req, res) => {
  if (!cachedData) {
    return res.status(404).json({ error: "No data cached" });
  }
  res.json(cachedData);
});

app.put("/api/hours", (req, res) => {
  const { line, day, hours } = req.body;

  if (line === undefined || day === undefined || hours === undefined) {
    return res.status(400).json({ error: "Missing required fields: line, day, hours" });
  }

  // Track the change locally (will be saved when user clicks Save)
  const key = `${line}-${day}`;
  const hoursValue = hours === "" ? 0 : parseFloat(hours);
  pendingChanges.set(key, { line, day, hours: hoursValue });

  // Update cache optimistically (for display purposes)
  if (cachedData) {
    const project = cachedData.projects.find(p => p.line === line);
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
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: "Missing required field: code" });
  }

  try {
    await addProject(code);
    res.json({ success: true, data: cachedData });
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
    res.json({ success: true, data: cachedData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/cache", (req, res) => {
  try {
    cachedData = null;
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
  if (cachedData) {
    console.log("Using cached data - timesheet will load instantly");
  } else {
    console.log("No cache found - will fetch from Costpoint on first request");
  }
});
