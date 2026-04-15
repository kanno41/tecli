// Costpoint Timesheet - Client-side Application

(function() {
  "use strict";

  let data = window.TIMESHEET_DATA;
  let isLoading = window.IS_LOADING;
  let pendingChanges = new Map();
  let pendingComments = new Map();
  let originalValues = new Map();
  let originalComments = new Map();
  let statusPollingInterval = null;

  // Project codes that require a comment when hours are entered
  var COMMENT_REQUIRED_CODES = ["A09909.SUSP.OVH"];

  function isCommentRequired(projectCode) {
    return COMMENT_REQUIRED_CODES.indexOf(projectCode) !== -1;
  }

  // DOM elements (may not exist if loading)
  const refreshBtn = document.getElementById("refresh-btn");
  const syncStatus = document.getElementById("sync-status");
  const errorBanner = document.getElementById("error-banner");
  const errorMessage = document.getElementById("error-message");
  const dismissError = document.getElementById("dismiss-error");

  // Initialize
  function init() {
    if (isLoading || !data) {
      // Start polling for data to load
      startLoadingPolling();
      attachBasicListeners();
    } else {
      // Data is available, initialize full UI
      storeOriginalValues();
      calculateTotals();
      attachEventListeners();
      startStatusPolling();
      checkThursdayNudge();
    }
  }

  // Store original values for comparison
  function storeOriginalValues() {
    if (!data) return;
    data.projects.forEach(project => {
      data.dates.forEach(d => {
        const key = `${project.line}-${d.date}`;
        const value = project.hours[d.date];
        originalValues.set(key, value !== null && value !== undefined ? value : "");
        const comment = (project.comments && project.comments[d.date]) || "";
        originalComments.set(key, comment);
      });
    });
  }

  // Poll for data when in loading state
  function startLoadingPolling() {
    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch("/api/status");
        if (!response.ok) return;

        const statusData = await response.json();
        updateSyncStatus(statusData.status);

        if (statusData.hasData && statusData.status === "idle") {
          clearInterval(pollInterval);
          // Reload page to get the data
          window.location.reload();
        }
      } catch (err) {
        console.error("Loading poll failed:", err);
      }
    }, 2000);
  }

  // Attach basic listeners (for loading state)
  function attachBasicListeners() {
    if (refreshBtn) {
      refreshBtn.addEventListener("click", handleRefresh);
    }
    const clearCacheBtn = document.getElementById("clear-cache-btn");
    if (clearCacheBtn) {
      clearCacheBtn.addEventListener("click", handleClearCache);
    }
    if (dismissError) {
      dismissError.addEventListener("click", () => {
        errorBanner.style.display = "none";
      });
    }
  }

  // Calculate and display totals
  function calculateTotals() {
    if (!data) return;

    const dates = data.dates;
    const dailyTotals = {};
    let grandTotal = 0;

    // Initialize daily totals
    dates.forEach(d => {
      dailyTotals[d.date] = 0;
    });

    // Calculate row totals and accumulate daily totals
    document.querySelectorAll("tbody tr").forEach(row => {
      let rowTotal = 0;
      row.querySelectorAll(".hours-input").forEach(input => {
        const value = parseFloat(input.value) || 0;
        const day = parseInt(input.dataset.day);
        rowTotal += value;
        dailyTotals[day] += value;
      });
      const rowTotalCell = row.querySelector(".row-total");
      if (rowTotalCell) {
        rowTotalCell.textContent = rowTotal || "";
      }
      grandTotal += rowTotal;
    });

    // Update daily total cells
    dates.forEach(d => {
      const cell = document.querySelector(`.daily-total[data-day="${d.date}"]`);
      if (cell) {
        cell.textContent = dailyTotals[d.date] || "";
      }
    });

    // Update grand total
    const grandTotalCell = document.querySelector(".grand-total");
    if (grandTotalCell) {
      grandTotalCell.textContent = grandTotal || "0";
    }
  }

  // Attach event listeners
  function attachEventListeners() {
    // Hours input changes (only active/enabled inputs)
    document.querySelectorAll(".hours-input:not(:disabled)").forEach(input => {
      input.addEventListener("focus", handleInputFocus);
      input.addEventListener("blur", handleInputBlur);
      input.addEventListener("input", handleInputChange);
      input.addEventListener("keydown", handleInputKeydown);
    });

    // Right-click on any cell wrapper to edit comment
    document.querySelectorAll(".cell-wrap").forEach(wrap => {
      wrap.addEventListener("contextmenu", handleCommentRightClick);
    });

    // Mark rows that require comments
    if (data) {
      data.projects.forEach(function(project) {
        if (isCommentRequired(project.code)) {
          var row = document.querySelector('tr[data-line="' + project.line + '"]');
          if (row) row.classList.add("comment-required-row");
        }
      });
    }

    // Refresh button
    if (refreshBtn) {
      refreshBtn.addEventListener("click", handleRefresh);
    }

    // Clear cache button
    const clearCacheBtn = document.getElementById("clear-cache-btn");
    if (clearCacheBtn) {
      clearCacheBtn.addEventListener("click", handleClearCache);
    }

    // Save button
    const saveBtn = document.getElementById("save-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", handleSave);
    }

    // Add project
    const addProjectBtn = document.getElementById("add-project-btn");
    const addProjectModal = document.getElementById("add-project-modal");
    const confirmAddProject = document.getElementById("confirm-add-project");
    if (addProjectBtn && addProjectModal) {
      addProjectBtn.addEventListener("click", () => showModal(addProjectModal));
    }
    if (confirmAddProject) {
      confirmAddProject.addEventListener("click", handleAddProject);
    }

    // Leave balances
    const leaveBalBtn = document.getElementById("leave-bal-btn");
    const leaveModal = document.getElementById("leave-modal");
    if (leaveBalBtn && leaveModal) {
      leaveBalBtn.addEventListener("click", handleLeaveBalances);
    }

    // Per-week sign buttons
    const signModal = document.getElementById("sign-modal");
    const confirmSign = document.getElementById("confirm-sign");
    document.querySelectorAll(".btn-week-sign").forEach(btn => {
      btn.addEventListener("click", () => showModal(signModal));
    });
    if (confirmSign) {
      confirmSign.addEventListener("click", handleSign);
    }

    // Copy Thursday -> Friday buttons
    document.querySelectorAll(".btn-copy-thu").forEach(btn => {
      btn.addEventListener("click", handleCopyThursdayToFriday);
    });
    const nudgeCopyBtn = document.getElementById("nudge-copy-btn");
    if (nudgeCopyBtn) {
      nudgeCopyBtn.addEventListener("click", handleCopyThursdayToFriday);
    }

    // Modal close buttons
    document.querySelectorAll(".modal-close, .modal-cancel").forEach(btn => {
      btn.addEventListener("click", () => {
        hideAllModals();
      });
    });

    // Modal backdrop click
    document.querySelectorAll(".modal").forEach(modal => {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) {
          hideAllModals();
        }
      });
    });

    // Error banner dismiss
    if (dismissError) {
      dismissError.addEventListener("click", () => {
        errorBanner.style.display = "none";
      });
    }

    // Escape key to close modals
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hideAllModals();
      }
    });
  }

  // Input event handlers
  function handleInputFocus(e) {
    e.target.select();
  }

  function handleInputChange(e) {
    const input = e.target;
    const line = parseInt(input.dataset.line);
    const day = parseInt(input.dataset.day);
    const activeLine = input.dataset.activeLine;
    const key = `${line}-${day}`;
    const newValue = input.value.trim();
    const originalValue = originalValues.get(key);
    const originalStr = originalValue !== null && originalValue !== undefined && originalValue !== "" ? String(originalValue) : "";

    // Check if value differs from original
    if (newValue !== originalStr) {
      input.classList.add("modified");
      pendingChanges.set(key, { line, day, hours: newValue, activeLine });
    } else {
      input.classList.remove("modified");
      pendingChanges.delete(key);
    }

    updateSaveButton();
    calculateTotals();
  }

  function handleInputBlur(e) {
    const input = e.target;
    const newValue = input.value.trim();

    // Validate input
    if (newValue !== "" && isNaN(parseFloat(newValue))) {
      input.value = "";
      handleInputChange(e); // Re-trigger change logic
      return;
    }

    calculateTotals();

    // Auto-prompt for comment on suspense/required-comment rows
    if (newValue !== "" && data) {
      var line = parseInt(input.dataset.line);
      var day = parseInt(input.dataset.day);
      var activeLine = input.dataset.activeLine;
      var project = data.projects.find(function(p) { return p.line === line; });
      if (project && isCommentRequired(project.code)) {
        // Only prompt if no comment already exists for this cell
        var key = line + "-" + day;
        var existingComment = (pendingComments.get(key) || {}).comment || input.dataset.comment || "";
        if (!existingComment) {
          // Defer so blur completes first
          setTimeout(function() {
            showCommentModal(line, day, activeLine, "", input);
          }, 50);
        }
      }
    }
  }

  function handleInputKeydown(e) {
    const input = e.target;

    if (e.key === "Enter" || e.key === "Tab") {
      // Move to next enabled cell
      const inputs = Array.from(document.querySelectorAll(".hours-input:not(:disabled)"));
      const currentIndex = inputs.indexOf(input);
      const nextIndex = e.shiftKey ? currentIndex - 1 : currentIndex + 1;

      if (nextIndex >= 0 && nextIndex < inputs.length) {
        e.preventDefault();
        inputs[nextIndex].focus();
      }
    } else if (e.key === "Escape") {
      input.blur();
    }
  }

  // Update Save button state
  function updateSaveButton() {
    const saveBtn = document.getElementById("save-btn");
    const unsavedIndicator = document.getElementById("unsaved-indicator");
    const hasChanges = pendingChanges.size > 0 || pendingComments.size > 0;

    if (saveBtn) {
      saveBtn.disabled = !hasChanges;
    }
    if (unsavedIndicator) {
      unsavedIndicator.style.display = hasChanges ? "inline" : "none";
    }
  }

  // Save all pending changes
  async function handleSave() {
    const saveBtn = document.getElementById("save-btn");
    if (!saveBtn || (pendingChanges.size === 0 && pendingComments.size === 0)) return;

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    updateSyncStatus("syncing");

    try {
      // Send all pending hours changes to server
      for (const [key, change] of pendingChanges) {
        const response = await fetch("/api/hours", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            line: change.line,
            day: change.day,
            hours: change.hours === "" ? "" : parseFloat(change.hours),
            activeLine: change.activeLine
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to update line ${change.line}, day ${change.day}`);
        }
      }

      // Send all pending comment changes to server
      for (const [key, change] of pendingComments) {
        const response = await fetch("/api/comment", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            day: change.day,
            comment: change.comment,
            activeLine: change.activeLine
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to update comment`);
        }
      }

      // Now trigger the actual save to Costpoint
      const saveResponse = await fetch("/api/save", {
        method: "POST"
      });

      const saveResult = await saveResponse.json();

      if (!saveResponse.ok) {
        throw new Error(saveResult.error || "Failed to save to Costpoint");
      }

      // Check if revision explanation is required
      if (saveResult.revisionRequired) {
        updateSyncStatus("idle");
        saveBtn.textContent = "Save";
        saveBtn.disabled = false;
        showRevisionModal(saveResult.auditDetails || []);
        return;
      }

      // Clear pending changes and update UI
      pendingChanges.forEach((change, key) => {
        const [line, day] = key.split("-").map(Number);
        const input = document.querySelector(`.hours-input[data-line="${line}"][data-day="${day}"]`);
        if (input) {
          input.classList.remove("modified");
        }
        originalValues.set(key, change.hours === "" ? "" : parseFloat(change.hours));
      });
      pendingChanges.clear();

      // Clear pending comments and update UI
      pendingComments.forEach((change, key) => {
        originalComments.set(key, change.comment || "");
        // Update the cell-wrap indicator
        var input = document.querySelector('.hours-input[data-line="' + change.line + '"][data-day="' + change.day + '"]');
        if (input) {
          input.dataset.comment = change.comment || "";
          input.classList.remove("comment-modified");
          var wrap = input.closest(".cell-wrap");
          if (wrap) {
            if (change.comment) {
              wrap.classList.add("has-comment");
              wrap.title = change.comment;
            } else {
              wrap.classList.remove("has-comment");
              wrap.title = "";
            }
          }
        }
      });
      pendingComments.clear();

      updateSyncStatus("idle");
      showSuccess("Changes saved successfully!");

    } catch (err) {
      console.error("Save failed:", err);
      showError(err.message || "Failed to save changes. Please try again.");
      updateSyncStatus("error");
    } finally {
      saveBtn.textContent = "Save";
      updateSaveButton();
    }
  }

  function showRevisionModal(auditDetails) {
    // Remove existing modal if any
    const existing = document.getElementById("revision-modal");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "revision-modal";
    overlay.className = "modal-overlay";

    let auditHTML = "";
    if (auditDetails.length > 0) {
      auditHTML = '<table class="audit-table"><thead><tr>' +
        "<th>Line</th><th>Date</th><th>Project</th><th>Description</th><th>Change</th>" +
        "</tr></thead><tbody>" +
        auditDetails.map(d =>
          "<tr><td>" + (d.lineNo || "") + "</td><td>" + (d.date || "") +
          "</td><td>" + (d.project || "") + "</td><td>" + (d.chargeDescription || "") +
          "</td><td>" + (d.description || "") + "</td></tr>"
        ).join("") +
        "</tbody></table>";
    }

    overlay.innerHTML =
      '<div class="modal-content">' +
        "<h3>Revision Explanation Required</h3>" +
        "<p>Your changes require a revision explanation. Please describe why these changes were made.</p>" +
        '<div class="audit-section">' + auditHTML + "</div>" +
        '<textarea id="revision-explanation" rows="3" placeholder="Enter explanation for changes..."></textarea>' +
        '<div class="modal-buttons">' +
          '<button id="revision-cancel" class="modal-btn cancel">Cancel</button>' +
          '<button id="revision-submit" class="modal-btn submit">Continue</button>' +
        "</div>" +
      "</div>";

    document.body.appendChild(overlay);

    const textarea = document.getElementById("revision-explanation");
    textarea.focus();

    document.getElementById("revision-cancel").addEventListener("click", () => {
      overlay.remove();
    });

    document.getElementById("revision-submit").addEventListener("click", async () => {
      const explanation = textarea.value.trim();
      if (!explanation) {
        textarea.style.borderColor = "#e74c3c";
        textarea.placeholder = "Explanation is required!";
        return;
      }
      const submitBtn = document.getElementById("revision-submit");
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving...";

      try {
        const resp = await fetch("/api/save-with-explanation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ explanation })
        });
        const result = await resp.json();
        if (!resp.ok) throw new Error(result.error || "Failed to save");

        // Clear pending changes
        pendingChanges.forEach((change, key) => {
          const [line, day] = key.split("-").map(Number);
          const input = document.querySelector('.hours-input[data-line="' + line + '"][data-day="' + day + '"]');
          if (input) input.classList.remove("modified");
          originalValues.set(key, change.hours === "" ? "" : parseFloat(change.hours));
        });
        pendingChanges.clear();
        pendingComments.clear();
        updateSyncStatus("idle");
        updateSaveButton();
        overlay.remove();
        showSuccess("Changes saved with revision explanation.");
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Continue";
        showError(err.message);
      }
    });
  }

  // Comment editing via right-click
  function handleCommentRightClick(e) {
    e.preventDefault();
    var input = e.currentTarget.querySelector(".hours-input");
    if (!input || input.disabled) return;

    var line = parseInt(input.dataset.line);
    var day = parseInt(input.dataset.day);
    var activeLine = input.dataset.activeLine;
    if (activeLine === undefined || activeLine === "") return;

    var currentComment = input.dataset.comment || "";
    // Check for pending comment
    var pendingKey = line + "-" + day;
    var pending = pendingComments.get(pendingKey);
    if (pending) currentComment = pending.comment || "";

    showCommentModal(line, day, activeLine, currentComment, input);
  }

  function showCommentModal(line, day, activeLine, currentComment, inputEl) {
    // Find project info for display
    var project = null;
    var dateInfo = null;
    if (data) {
      project = data.projects.find(function(p) { return p.line === line; });
      dateInfo = data.dates.find(function(d) { return d.date === day; });
    }
    var cellRef = (project ? project.code : "Line " + line) +
      " / " + (dateInfo ? dateInfo.dayOfWeek + " " + dateInfo.fullDate : "Day " + day);

    var existing = document.getElementById("comment-modal");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "comment-modal";
    overlay.className = "comment-modal-overlay";
    overlay.innerHTML =
      '<div class="comment-modal">' +
        '<h3>Cell Comment</h3>' +
        '<p class="comment-cell-ref">' + cellRef + '</p>' +
        '<textarea id="comment-text" placeholder="Enter comment...">' +
          (currentComment || "").replace(/</g, "&lt;") +
        '</textarea>' +
        '<div class="comment-modal-buttons">' +
          '<button class="comment-btn-cancel">Cancel</button>' +
          '<button class="comment-btn-clear">Clear</button>' +
          '<button class="comment-btn-save">Save</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    var textarea = document.getElementById("comment-text");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    function close() { overlay.remove(); }

    function applyComment(text) {
      var key = line + "-" + day;
      var orig = originalComments.get(key) || "";

      if (text !== orig) {
        pendingComments.set(key, { line: line, day: day, comment: text, activeLine: activeLine });
        inputEl.classList.add("comment-modified");
      } else {
        pendingComments.delete(key);
        inputEl.classList.remove("comment-modified");
      }

      // Update visual indicator
      inputEl.dataset.comment = text;
      var wrap = inputEl.closest(".cell-wrap");
      if (wrap) {
        if (text) {
          wrap.classList.add("has-comment");
          wrap.title = text;
        } else {
          wrap.classList.remove("has-comment");
          wrap.title = "";
        }
      }

      updateSaveButton();
      close();
    }

    overlay.querySelector(".comment-btn-cancel").addEventListener("click", close);
    overlay.querySelector(".comment-btn-clear").addEventListener("click", function() {
      applyComment("");
    });
    overlay.querySelector(".comment-btn-save").addEventListener("click", function() {
      applyComment(textarea.value);
    });
    overlay.addEventListener("click", function(ev) {
      if (ev.target === overlay) close();
    });
    textarea.addEventListener("keydown", function(ev) {
      if (ev.key === "Escape") close();
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        applyComment(textarea.value);
      }
    });
  }

  async function handleRefresh() {
    // Check for unsaved changes
    if (pendingChanges.size > 0 || pendingComments.size > 0) {
      if (!confirm("You have unsaved changes. Refreshing will discard them. Continue?")) {
        return;
      }
    }

    refreshBtn.classList.add("spinning");
    refreshBtn.disabled = true;
    updateSyncStatus("loading");

    try {
      const response = await fetch("/api/refresh");
      if (!response.ok) {
        throw new Error("Refresh failed");
      }

      // Reload page to show fresh data
      window.location.reload();

    } catch (err) {
      console.error("Refresh failed:", err);
      showError("Failed to refresh timesheet. Please try again.");
      updateSyncStatus("error");
    } finally {
      refreshBtn.classList.remove("spinning");
      refreshBtn.disabled = false;
    }
  }

  async function handleClearCache() {
    if (!confirm("Clear the cache? This will discard any unsaved changes and require a fresh load from Costpoint.")) {
      return;
    }

    try {
      const response = await fetch("/api/cache", {
        method: "DELETE"
      });

      if (!response.ok) {
        throw new Error("Failed to clear cache");
      }

      showSuccess("Cache cleared. Reloading...");
      setTimeout(() => {
        window.location.reload();
      }, 1000);

    } catch (err) {
      console.error("Clear cache failed:", err);
      showError("Failed to clear cache. Please try again.");
    }
  }

  async function handleLeaveBalances() {
    const leaveModal = document.getElementById("leave-modal");
    const leaveBody = document.getElementById("leave-modal-body");
    leaveBody.innerHTML = "<p>Loading leave balances...</p>";
    showModal(leaveModal);

    try {
      const response = await fetch("/api/leave");
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to fetch leave balances");
      }
      const result = await response.json();
      let html = "";

      if (result.balances && result.balances.length > 0) {
        html += '<table class="leave-table"><thead><tr><th>Leave Type</th><th class="num">Balance</th></tr></thead><tbody>';
        for (const b of result.balances) {
          const val = b.balance.toFixed(2);
          const cls = b.balance > 0 ? "positive" : b.balance < 0 ? "negative" : "";
          html += "<tr><td>" + b.description + "</td><td class=\"num " + cls + "\">" + val + "</td></tr>";
        }
        html += "</tbody></table>";
      } else {
        html += "<p>No leave balances found.</p>";
      }

      if (result.details && result.details.length > 0) {
        html += '<h3>Recent Activity</h3><table class="leave-table"><thead><tr><th>Date</th><th>Type</th><th class="num">Hours</th><th>Leave Type</th></tr></thead><tbody>';
        for (const d of result.details) {
          html += "<tr><td>" + d.date + "</td><td>" + d.type + "</td><td class=\"num\">" + d.hours.toFixed(2) + "</td><td>" + (d.leaveTypeDesc || d.leaveTypeCode) + "</td></tr>";
        }
        html += "</tbody></table>";
      }

      leaveBody.innerHTML = html;
    } catch (err) {
      leaveBody.innerHTML = '<p class="error">' + (err.message || "Failed to load leave balances") + "</p>";
    }
  }

  async function handleAddProject() {
    const projectCodeInput = document.getElementById("project-code");
    const projectPayTypeSelect = document.getElementById("project-pay-type");
    const confirmAddProject = document.getElementById("confirm-add-project");
    const code = projectCodeInput.value.trim();
    const payType = projectPayTypeSelect ? projectPayTypeSelect.value : "REG";
    if (!code) {
      projectCodeInput.focus();
      return;
    }

    confirmAddProject.disabled = true;
    confirmAddProject.textContent = "Adding...";
    updateSyncStatus("syncing");

    try {
      const response = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, payType })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to add project");
      }

      hideAllModals();
      projectCodeInput.value = "";
      if (projectPayTypeSelect) {
        projectPayTypeSelect.value = "REG";
      }

      showSuccess("Project added successfully! Reloading...");

      // Reload to get updated data
      setTimeout(() => {
        window.location.reload();
      }, 1000);

    } catch (err) {
      console.error("Add project failed:", err);
      showError(err.message || "Failed to add project. Please check the code and try again.");
      updateSyncStatus("error");
    } finally {
      confirmAddProject.disabled = false;
      confirmAddProject.textContent = "Add";
    }
  }

  async function handleSign() {
    // Check for unsaved changes first
    if (pendingChanges.size > 0) {
      showError("Please save your changes before signing the timesheet.");
      hideAllModals();
      return;
    }

    const confirmSign = document.getElementById("confirm-sign");
    confirmSign.disabled = true;
    confirmSign.textContent = "Signing...";
    updateSyncStatus("syncing");

    try {
      const response = await fetch("/api/sign", {
        method: "POST"
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to sign timesheet");
      }

      hideAllModals();
      updateSyncStatus("idle");
      showSuccess("Timesheet signed successfully! Reloading...");
      setTimeout(() => {
        window.location.reload();
      }, 1000);

    } catch (err) {
      console.error("Sign failed:", err);
      showError(err.message || "Failed to sign timesheet. It may already be signed.");
      updateSyncStatus("error");
    } finally {
      confirmSign.disabled = false;
      confirmSign.textContent = "Sign";
    }
  }

  // Copy Thursday's hours to Friday for the active week
  function handleCopyThursdayToFriday() {
    if (!data || !data.activeDates) return;

    const activeDatesSet = new Set(data.activeDates);
    var thuDay = null, friDay = null;
    for (var di = 0; di < data.dates.length; di++) {
      var d = data.dates[di];
      if (!activeDatesSet.has(d.fullDate)) continue;
      if (d.dayOfWeek === 'Thu') thuDay = d.date;
      if (d.dayOfWeek === 'Fri') friDay = d.date;
    }

    if (thuDay === null || friDay === null) return;

    var copied = 0;
    document.querySelectorAll("tbody tr").forEach(function(row) {
      var thuInput = row.querySelector('.hours-input[data-day="' + thuDay + '"]:not(:disabled)');
      var friInput = row.querySelector('.hours-input[data-day="' + friDay + '"]:not(:disabled)');
      if (thuInput && friInput && thuInput.value.trim() !== '') {
        if (friInput.value.trim() !== thuInput.value.trim()) {
          friInput.value = thuInput.value;
          friInput.dispatchEvent(new Event('input', { bubbles: true }));
          copied++;
        }
      }
    });

    if (copied > 0) {
      showSuccess('Copied Thursday hours to Friday (' + copied + ' row' + (copied !== 1 ? 's' : '') + ')');
    } else {
      showSuccess('Friday already matches Thursday');
    }
  }

  // Check if Thursday nudge should be shown
  function checkThursdayNudge() {
    if (!data || !data.weeks) return;

    var today = new Date();
    var dayOfWeek = today.getDay(); // 0=Sun, 4=Thu, 5=Fri

    // Only show nudge on Thursday or Friday
    if (dayOfWeek !== 4 && dayOfWeek !== 5) return;

    // Find the active week
    var activeWeek = null;
    for (var i = 0; i < data.weeks.length; i++) {
      if (data.weeks[i].isActive) { activeWeek = data.weeks[i]; break; }
    }
    if (!activeWeek) return;

    // Only nudge if unsigned
    if (activeWeek.statusTone !== 'open' && activeWeek.statusTone !== 'missing') return;

    // Check if the active week contains today
    var todayStr = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');
    if (todayStr < activeWeek.startDate || todayStr > activeWeek.endDate) return;

    var nudge = document.getElementById('thursday-nudge');
    if (nudge) {
      var msg = nudge.querySelector('.nudge-message');
      if (msg) {
        msg.textContent = dayOfWeek === 4
          ? "It's Thursday - estimate Friday and sign your timesheet"
          : "Don't forget to sign this week's timesheet";
      }
      nudge.style.display = 'flex';
    }
  }

  // Status polling
  function startStatusPolling() {
    statusPollingInterval = setInterval(checkStatus, 5000);
  }

  async function checkStatus() {
    try {
      const response = await fetch("/api/status");
      if (!response.ok) return null;

      const statusData = await response.json();

      // Only update status if we don't have local pending changes
      if (pendingChanges.size === 0) {
        updateSyncStatus(statusData.status);
      }

      if (statusData.error) {
        showError(statusData.error);
      }

      return statusData.status;
    } catch (err) {
      console.error("Status check failed:", err);
      return null;
    }
  }

  // UI helpers
  function updateSyncStatus(status) {
    if (syncStatus) {
      syncStatus.className = `sync-dot sync-${status}`;
      syncStatus.title = status;
    }
  }

  function showError(message) {
    if (errorMessage && errorBanner) {
      errorBanner.classList.remove("success-banner");
      errorBanner.classList.add("error-banner");
      errorMessage.textContent = message;
      errorBanner.style.display = "flex";
    }
  }

  function showSuccess(message) {
    if (errorMessage && errorBanner) {
      errorBanner.classList.remove("error-banner");
      errorBanner.classList.add("success-banner");
      errorMessage.textContent = message;
      errorBanner.style.display = "flex";
      setTimeout(() => {
        errorBanner.style.display = "none";
      }, 3000);
    }
  }

  function showModal(modal) {
    if (!modal) return;
    modal.style.display = "flex";
    const input = modal.querySelector("input[type='text']");
    if (input) {
      setTimeout(() => input.focus(), 100);
    }
  }

  function hideAllModals() {
    document.querySelectorAll(".modal").forEach(modal => {
      modal.style.display = "none";
    });
    const projectCodeInput = document.getElementById("project-code");
    if (projectCodeInput) {
      projectCodeInput.value = "";
    }
    const projectPayTypeSelect = document.getElementById("project-pay-type");
    if (projectPayTypeSelect) {
      projectPayTypeSelect.value = "REG";
    }
  }

  // Start the app
  init();
})();
