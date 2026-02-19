// Costpoint Timesheet - Client-side Application

(function() {
  "use strict";

  let data = window.TIMESHEET_DATA;
  let isLoading = window.IS_LOADING;
  let pendingChanges = new Map();
  let originalValues = new Map();
  let statusPollingInterval = null;

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
    // Hours input changes
    document.querySelectorAll(".hours-input").forEach(input => {
      input.addEventListener("focus", handleInputFocus);
      input.addEventListener("blur", handleInputBlur);
      input.addEventListener("input", handleInputChange);
      input.addEventListener("keydown", handleInputKeydown);
    });

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

    // Sign timesheet
    const signBtn = document.getElementById("sign-btn");
    const signModal = document.getElementById("sign-modal");
    const confirmSign = document.getElementById("confirm-sign");
    if (signBtn && signModal) {
      signBtn.addEventListener("click", () => showModal(signModal));
    }
    if (confirmSign) {
      confirmSign.addEventListener("click", handleSign);
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
    const key = `${line}-${day}`;
    const newValue = input.value.trim();
    const originalValue = originalValues.get(key);
    const originalStr = originalValue !== null && originalValue !== undefined && originalValue !== "" ? String(originalValue) : "";

    // Check if value differs from original
    if (newValue !== originalStr) {
      input.classList.add("modified");
      pendingChanges.set(key, { line, day, hours: newValue });
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
  }

  function handleInputKeydown(e) {
    const input = e.target;

    if (e.key === "Enter" || e.key === "Tab") {
      // Move to next cell
      const inputs = Array.from(document.querySelectorAll(".hours-input"));
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

    if (saveBtn) {
      saveBtn.disabled = pendingChanges.size === 0;
    }
    if (unsavedIndicator) {
      unsavedIndicator.style.display = pendingChanges.size > 0 ? "inline" : "none";
    }
  }

  // Save all pending changes
  async function handleSave() {
    const saveBtn = document.getElementById("save-btn");
    if (!saveBtn || pendingChanges.size === 0) return;

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    updateSyncStatus("syncing");

    try {
      // Send all pending changes to server
      for (const [key, change] of pendingChanges) {
        const response = await fetch("/api/hours", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            line: change.line,
            day: change.day,
            hours: change.hours === "" ? "" : parseFloat(change.hours)
          })
        });

        if (!response.ok) {
          throw new Error(`Failed to update line ${change.line}, day ${change.day}`);
        }
      }

      // Now trigger the actual save to Costpoint
      const saveResponse = await fetch("/api/save", {
        method: "POST"
      });

      if (!saveResponse.ok) {
        const errorData = await saveResponse.json();
        throw new Error(errorData.error || "Failed to save to Costpoint");
      }

      // Clear pending changes and update UI
      pendingChanges.forEach((change, key) => {
        const [line, day] = key.split("-").map(Number);
        const input = document.querySelector(`.hours-input[data-line="${line}"][data-day="${day}"]`);
        if (input) {
          input.classList.remove("modified");
        }
        // Update original values
        originalValues.set(key, change.hours === "" ? "" : parseFloat(change.hours));
      });
      pendingChanges.clear();

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

  async function handleRefresh() {
    // Check for unsaved changes
    if (pendingChanges.size > 0) {
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

  async function handleAddProject() {
    const projectCodeInput = document.getElementById("project-code");
    const confirmAddProject = document.getElementById("confirm-add-project");
    const code = projectCodeInput.value.trim();
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
        body: JSON.stringify({ code })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to add project");
      }

      hideAllModals();
      projectCodeInput.value = "";

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
      showSuccess("Timesheet signed successfully!");

    } catch (err) {
      console.error("Sign failed:", err);
      showError(err.message || "Failed to sign timesheet. It may already be signed.");
      updateSyncStatus("error");
    } finally {
      confirmSign.disabled = false;
      confirmSign.textContent = "Sign";
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
      syncStatus.textContent = status;
      syncStatus.className = `status-badge status-${status}`;
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
  }

  // Start the app
  init();
})();
