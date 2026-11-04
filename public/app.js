// Costpoint Timesheet - Client-side Application

(function () {
  'use strict';

  const render = window.TecliRender;
  const escapeHtml = render.escapeHtml;
  const cellKey = window.TecliPending.cellKey;
  const takeSaved = window.TecliPending.takeSaved;

  let data = window.TIMESHEET_DATA;
  let isLoading = window.IS_LOADING;
  let pendingChanges = new Map();
  let pendingComments = new Map();
  let originalValues = new Map();
  let originalComments = new Map();
  let signPeriod = 0; // period of the week whose Sign button opened the sign modal

  // The server refuses /api requests without its per-launch token (web-guard.js)
  const tokenMeta = document.querySelector('meta[name="tecli-token"]');
  const apiToken = tokenMeta ? tokenMeta.content : '';

  function apiFetch(url, options = {}) {
    return fetch(url, { ...options, headers: { ...options.headers, 'X-Tecli-Token': apiToken } });
  }

  // Project codes that require a comment when hours are entered
  var COMMENT_REQUIRED_CODES = ['A09909.SUSP.OVH'];

  function isCommentRequired(projectCode) {
    return COMMENT_REQUIRED_CODES.indexOf(projectCode) !== -1;
  }

  // DOM elements (may not exist if loading)
  const refreshBtn = document.getElementById('refresh-btn');
  const syncStatus = document.getElementById('sync-status');
  const errorBanner = document.getElementById('error-banner');
  const errorMessage = document.getElementById('error-message');
  const dismissError = document.getElementById('dismiss-error');

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
      data.dates.forEach((d, i) => {
        const key = cellKey(data.weeks[i < 7 ? 0 : 1].period, project.line, d.date);
        const value = project.hours[d.date];
        originalValues.set(key, value !== null && value !== undefined ? value : '');
        const comment = (project.comments && project.comments[d.date]) || '';
        originalComments.set(key, comment);
      });
    });
  }

  // Poll for data when in loading state
  function startLoadingPolling() {
    const pollInterval = setInterval(async () => {
      try {
        const response = await apiFetch('/api/status');
        if (!response.ok) return;

        const statusData = await response.json();
        updateSyncStatus(statusData.status);

        if (statusData.hasData && statusData.status === 'idle') {
          clearInterval(pollInterval);
          // Reload page to get the data
          window.location.reload();
        }
      } catch (err) {
        console.error('Loading poll failed:', err);
      }
    }, 2000);
  }

  // Attach basic listeners (for loading state)
  function attachBasicListeners() {
    if (refreshBtn) {
      refreshBtn.addEventListener('click', handleRefresh);
    }
    const clearCacheBtn = document.getElementById('clear-cache-btn');
    if (clearCacheBtn) {
      clearCacheBtn.addEventListener('click', handleClearCache);
    }
    if (dismissError) {
      dismissError.addEventListener('click', () => {
        errorBanner.style.display = 'none';
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
    document.querySelectorAll('tbody tr').forEach(row => {
      let rowTotal = 0;
      row.querySelectorAll('.hours-input').forEach(input => {
        const value = parseFloat(input.value) || 0;
        const day = parseInt(input.dataset.day);
        rowTotal += value;
        dailyTotals[day] += value;
      });
      const rowTotalCell = row.querySelector('.row-total');
      if (rowTotalCell) {
        rowTotalCell.textContent = rowTotal || '';
      }
      grandTotal += rowTotal;
    });

    // Update daily total cells
    dates.forEach(d => {
      const cell = document.querySelector(`.daily-total[data-day="${d.date}"]`);
      if (cell) {
        cell.textContent = dailyTotals[d.date] || '';
      }
    });

    // Update grand total
    const grandTotalCell = document.querySelector('.grand-total');
    if (grandTotalCell) {
      grandTotalCell.textContent = grandTotal || '0';
    }
  }

  // Attach event listeners
  function attachEventListeners() {
    // Hours input changes (only active/enabled inputs)
    document.querySelectorAll('.hours-input:not(:disabled)').forEach(input => {
      input.addEventListener('focus', handleInputFocus);
      input.addEventListener('blur', handleInputBlur);
      input.addEventListener('input', handleInputChange);
      input.addEventListener('keydown', handleInputKeydown);
    });

    // Right-click on any cell wrapper to edit comment
    document.querySelectorAll('.cell-wrap').forEach(wrap => {
      wrap.addEventListener('contextmenu', handleCommentRightClick);
    });

    // Mark rows that require comments
    if (data) {
      data.projects.forEach(function (project) {
        if (isCommentRequired(project.code)) {
          var row = document.querySelector('tr[data-line="' + project.line + '"]');
          if (row) row.classList.add('comment-required-row');
        }
      });
    }

    // Refresh button
    if (refreshBtn) {
      refreshBtn.addEventListener('click', handleRefresh);
    }

    // Week navigation drops unsaved edits
    document.querySelectorAll('.week-nav a').forEach(link => {
      link.addEventListener('click', e => {
        if (hasUnsavedChanges() && !confirm('You have unsaved changes. Changing weeks will discard them. Continue?')) {
          e.preventDefault();
        }
      });
    });

    // Clear cache button
    const clearCacheBtn = document.getElementById('clear-cache-btn');
    if (clearCacheBtn) {
      clearCacheBtn.addEventListener('click', handleClearCache);
    }

    // Save button
    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', handleSave);
    }

    // Add project
    const addProjectBtn = document.getElementById('add-project-btn');
    const addProjectModal = document.getElementById('add-project-modal');
    const confirmAddProject = document.getElementById('confirm-add-project');
    if (addProjectBtn && addProjectModal) {
      addProjectBtn.addEventListener('click', () => showModal(addProjectModal));
    }
    if (confirmAddProject) {
      confirmAddProject.addEventListener('click', handleAddProject);
    }
    document.querySelectorAll('.btn-quick-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.code;
        const payType = btn.dataset.paytype;
        document.getElementById('project-code').value = code;
        document.getElementById('project-pay-type').value = payType;
        handleAddProject();
      });
    });

    // Favorites
    const favoritesBtn = document.getElementById('favorites-btn');
    const favoritesModal = document.getElementById('favorites-modal');
    if (favoritesBtn && favoritesModal) {
      favoritesBtn.addEventListener('click', handleFavorites);
      const favPeriod = document.getElementById('fav-target-period');
      if (favPeriod) favPeriod.addEventListener('change', handleFavorites);
    }

    // Leave balances
    const leaveBalBtn = document.getElementById('leave-bal-btn');
    const leaveModal = document.getElementById('leave-modal');
    if (leaveBalBtn && leaveModal) {
      leaveBalBtn.addEventListener('click', handleLeaveBalances);
    }

    // Per-week sign buttons
    const signModal = document.getElementById('sign-modal');
    const confirmSign = document.getElementById('confirm-sign');
    const signModalText = document.getElementById('sign-modal-text');
    document.querySelectorAll('.btn-week-sign').forEach(btn => {
      btn.addEventListener('click', () => {
        signPeriod = parseInt(btn.dataset.week, 10) || 0;
        if (signModalText) signModalText.textContent = 'Sign ' + btn.dataset.label + '?';
        showModal(signModal);
      });
    });
    if (confirmSign) {
      confirmSign.addEventListener('click', handleSign);
    }

    // Copy Thursday -> Friday buttons
    document.querySelectorAll('.btn-copy-thu').forEach(btn => {
      btn.addEventListener('click', handleCopyThursdayToFriday);
    });
    const nudgeCopyBtn = document.getElementById('nudge-copy-btn');
    if (nudgeCopyBtn) {
      nudgeCopyBtn.addEventListener('click', handleCopyThursdayToFriday);
    }

    // Modal close buttons
    document.querySelectorAll('.modal-close, .modal-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        hideAllModals();
      });
    });

    // Modal backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', e => {
        if (e.target === modal) {
          hideAllModals();
        }
      });
    });

    // Error banner dismiss
    if (dismissError) {
      dismissError.addEventListener('click', () => {
        errorBanner.style.display = 'none';
      });
    }

    // Escape key to close modals
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
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
    const week = input.dataset.week;
    const periodLine = input.dataset.periodLine;
    const key = cellKey(week, line, day);
    const newValue = input.value.trim();
    const originalValue = originalValues.get(key);
    const originalStr =
      originalValue !== null && originalValue !== undefined && originalValue !== '' ? String(originalValue) : '';

    // Check if value differs from original
    if (newValue !== originalStr) {
      input.classList.add('modified');
      pendingChanges.set(key, { line, day, hours: newValue, week, periodLine });
    } else {
      input.classList.remove('modified');
      pendingChanges.delete(key);
    }

    updateSaveButton();
    calculateTotals();
  }

  function handleInputBlur(e) {
    const input = e.target;
    const newValue = input.value.trim();

    // Validate input
    if (newValue !== '' && isNaN(parseFloat(newValue))) {
      input.value = '';
      handleInputChange(e); // Re-trigger change logic
      return;
    }

    calculateTotals();

    // Auto-prompt for comment on suspense/required-comment rows
    if (newValue !== '' && data) {
      var line = parseInt(input.dataset.line);
      var day = parseInt(input.dataset.day);
      var project = data.projects.find(function (p) {
        return p.line === line;
      });
      if (project && isCommentRequired(project.code)) {
        // Only prompt if no comment already exists for this cell
        var key = cellKey(input.dataset.week, line, day);
        var existingComment = (pendingComments.get(key) || {}).comment || input.dataset.comment || '';
        if (!existingComment) {
          // Defer so blur completes first
          setTimeout(function () {
            showCommentModal(line, day, '', input);
          }, 50);
        }
      }
    }
  }

  function handleInputKeydown(e) {
    const input = e.target;

    if (e.key === 'Enter' || e.key === 'Tab') {
      // Move to next enabled cell
      const inputs = Array.from(document.querySelectorAll('.hours-input:not(:disabled)'));
      const currentIndex = inputs.indexOf(input);
      const nextIndex = e.shiftKey ? currentIndex - 1 : currentIndex + 1;

      if (nextIndex >= 0 && nextIndex < inputs.length) {
        e.preventDefault();
        inputs[nextIndex].focus();
      }
    } else if (e.key === 'Escape') {
      input.blur();
    }
  }

  function hasUnsavedChanges() {
    return pendingChanges.size > 0 || pendingComments.size > 0;
  }

  // Update Save button state
  function updateSaveButton() {
    const saveBtn = document.getElementById('save-btn');
    const unsavedIndicator = document.getElementById('unsaved-indicator');
    const hasChanges = hasUnsavedChanges();

    if (saveBtn) {
      saveBtn.disabled = !hasChanges;
    }
    if (unsavedIndicator) {
      unsavedIndicator.style.display = hasChanges ? 'inline' : 'none';
    }
  }

  // Save all pending changes
  async function handleSave() {
    const saveBtn = document.getElementById('save-btn');
    if (!saveBtn || (pendingChanges.size === 0 && pendingComments.size === 0)) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    updateSyncStatus('syncing');

    try {
      // Send all pending hours changes to server
      for (const change of pendingChanges.values()) {
        const response = await apiFetch('/api/hours', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            line: change.line,
            day: change.day,
            hours: change.hours === '' ? '' : parseFloat(change.hours),
            period: parseInt(change.week, 10),
            periodLine: change.periodLine,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to update line ${change.line}, day ${change.day}`);
        }
      }

      // Send all pending comment changes to server
      for (const change of pendingComments.values()) {
        const response = await apiFetch('/api/comment', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            day: change.day,
            comment: change.comment,
            period: parseInt(change.week, 10),
            periodLine: change.periodLine,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Failed to update comment`);
        }
      }

      // Now trigger the actual save to Costpoint
      const saveResponse = await apiFetch('/api/save', {
        method: 'POST',
      });

      const saveResult = await saveResponse.json();
      // Weeks saved before a failure or a revision prompt are done; the rest
      // stay pending so a retry sends only them
      settleSaved(saveResult.saved);

      if (!saveResponse.ok) {
        throw new Error(saveResult.error || 'Failed to save to Costpoint');
      }

      // Check if revision explanation is required
      if (saveResult.revisionRequired) {
        updateSyncStatus('idle');
        saveBtn.textContent = 'Save';
        saveBtn.disabled = false;
        showRevisionModal(saveResult.auditDetails || []);
        return;
      }

      updateSyncStatus('idle');
      showSuccess('Changes saved successfully!');
    } catch (err) {
      console.error('Save failed:', err);
      showError(err.message || 'Failed to save changes. Please try again.');
      updateSyncStatus('error');
    } finally {
      saveBtn.textContent = 'Save';
      updateSaveButton();
    }
  }

  function cellInput(change) {
    return document.querySelector(
      '.hours-input[data-week="' + change.week + '"][data-line="' + change.line + '"][data-day="' + change.day + '"]'
    );
  }

  // Mark the changes of the periods the server saved as the new originals
  function settleSaved(periods) {
    takeSaved(pendingChanges, periods).forEach(([key, change]) => {
      const input = cellInput(change);
      if (input) input.classList.remove('modified');
      originalValues.set(key, change.hours === '' ? '' : parseFloat(change.hours));
    });

    takeSaved(pendingComments, periods).forEach(([key, change]) => {
      originalComments.set(key, change.comment || '');
      const input = cellInput(change);
      if (!input) return;
      input.dataset.comment = change.comment || '';
      input.classList.remove('comment-modified');
      const wrap = input.closest('.cell-wrap');
      if (wrap) {
        if (change.comment) {
          wrap.classList.add('has-comment');
          wrap.title = change.comment;
        } else {
          wrap.classList.remove('has-comment');
          wrap.title = '';
        }
      }
    });
    updateSaveButton();
  }

  function showRevisionModal(auditDetails, reloadAfter = false) {
    // Remove existing modal if any
    const existing = document.getElementById('revision-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'revision-modal';
    overlay.className = 'modal-overlay';

    const auditHTML = render.auditTableHTML(auditDetails);

    overlay.innerHTML =
      '<div class="modal-content">' +
      '<h3>Revision Explanation Required</h3>' +
      '<p>Your changes require a revision explanation. Please describe why these changes were made.</p>' +
      '<div class="audit-section">' +
      auditHTML +
      '</div>' +
      '<textarea id="revision-explanation" rows="3" placeholder="Enter explanation for changes..."></textarea>' +
      '<div class="modal-buttons">' +
      '<button id="revision-cancel" class="modal-btn cancel">Cancel</button>' +
      '<button id="revision-submit" class="modal-btn submit">Continue</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    const textarea = document.getElementById('revision-explanation');
    textarea.focus();

    document.getElementById('revision-cancel').addEventListener('click', () => {
      overlay.remove();
    });

    document.getElementById('revision-submit').addEventListener('click', async () => {
      const explanation = textarea.value.trim();
      if (!explanation) {
        textarea.style.borderColor = '#e74c3c';
        textarea.placeholder = 'Explanation is required!';
        return;
      }
      const submitBtn = document.getElementById('revision-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';

      try {
        const resp = await apiFetch('/api/save-with-explanation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ explanation }),
        });
        const result = await resp.json();
        settleSaved(result.saved);
        if (!resp.ok) throw new Error(result.error || 'Failed to save');

        // The other week's changes were saved next and need their own explanation
        if (result.revisionRequired) {
          overlay.remove();
          showRevisionModal(result.auditDetails || [], reloadAfter);
          return;
        }

        if (reloadAfter) {
          overlay.remove();
          showSuccess('Saved with revision explanation. Reloading...');
          setTimeout(() => {
            window.location.reload();
          }, 1000);
          return;
        }

        updateSyncStatus('idle');
        updateSaveButton();
        overlay.remove();
        showSuccess('Changes saved with revision explanation.');
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Continue';
        showError(err.message);
      }
    });
  }

  // Comment editing via right-click
  function handleCommentRightClick(e) {
    e.preventDefault();
    var input = e.currentTarget.querySelector('.hours-input');
    if (!input || input.disabled) return;

    var line = parseInt(input.dataset.line);
    var day = parseInt(input.dataset.day);
    if (input.dataset.periodLine === undefined || input.dataset.periodLine === '') return;

    var currentComment = input.dataset.comment || '';
    // Check for pending comment
    var pendingKey = cellKey(input.dataset.week, line, day);
    var pending = pendingComments.get(pendingKey);
    if (pending) currentComment = pending.comment || '';

    showCommentModal(line, day, currentComment, input);
  }

  function showCommentModal(line, day, currentComment, inputEl) {
    // Find project info for display
    var project = null;
    var dateInfo = null;
    if (data) {
      project = data.projects.find(function (p) {
        return p.line === line;
      });
      dateInfo = data.dates.find(function (d) {
        return d.date === day;
      });
    }
    var cellRef =
      (project ? project.code : 'Line ' + line) +
      ' / ' +
      (dateInfo ? dateInfo.dayOfWeek + ' ' + dateInfo.fullDate : 'Day ' + day);

    var existing = document.getElementById('comment-modal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'comment-modal';
    overlay.className = 'comment-modal-overlay';
    overlay.innerHTML =
      '<div class="comment-modal">' +
      '<h3>Cell Comment</h3>' +
      '<p class="comment-cell-ref">' +
      escapeHtml(cellRef) +
      '</p>' +
      '<textarea id="comment-text" placeholder="Enter comment...">' +
      escapeHtml(currentComment || '') +
      '</textarea>' +
      '<div class="comment-modal-buttons">' +
      '<button class="comment-btn-cancel">Cancel</button>' +
      '<button class="comment-btn-clear">Clear</button>' +
      '<button class="comment-btn-save">Save</button>' +
      '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    var textarea = document.getElementById('comment-text');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    function close() {
      overlay.remove();
    }

    function applyComment(text) {
      var key = cellKey(inputEl.dataset.week, line, day);
      var orig = originalComments.get(key) || '';

      if (text !== orig) {
        pendingComments.set(key, {
          line: line,
          day: day,
          comment: text,
          week: inputEl.dataset.week,
          periodLine: inputEl.dataset.periodLine,
        });
        inputEl.classList.add('comment-modified');
      } else {
        pendingComments.delete(key);
        inputEl.classList.remove('comment-modified');
      }

      // Update visual indicator
      inputEl.dataset.comment = text;
      var wrap = inputEl.closest('.cell-wrap');
      if (wrap) {
        if (text) {
          wrap.classList.add('has-comment');
          wrap.title = text;
        } else {
          wrap.classList.remove('has-comment');
          wrap.title = '';
        }
      }

      updateSaveButton();
      close();
    }

    overlay.querySelector('.comment-btn-cancel').addEventListener('click', close);
    overlay.querySelector('.comment-btn-clear').addEventListener('click', function () {
      applyComment('');
    });
    overlay.querySelector('.comment-btn-save').addEventListener('click', function () {
      applyComment(textarea.value);
    });
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) close();
    });
    textarea.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') close();
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        applyComment(textarea.value);
      }
    });
  }

  async function handleRefresh() {
    // Check for unsaved changes
    if (hasUnsavedChanges()) {
      if (!confirm('You have unsaved changes. Refreshing will discard them. Continue?')) {
        return;
      }
    }

    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
    updateSyncStatus('loading');

    try {
      const response = await apiFetch('/api/refresh');
      if (!response.ok) {
        throw new Error('Refresh failed');
      }

      // Reload page to show fresh data
      window.location.reload();
    } catch (err) {
      console.error('Refresh failed:', err);
      showError('Failed to refresh timesheet. Please try again.');
      updateSyncStatus('error');
    } finally {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }
  }

  async function handleClearCache() {
    if (!confirm('Clear the cache? This will discard any unsaved changes and require a fresh load from Costpoint.')) {
      return;
    }

    try {
      const response = await apiFetch('/api/cache', {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to clear cache');
      }

      showSuccess('Cache cleared. Reloading...');
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (err) {
      console.error('Clear cache failed:', err);
      showError('Failed to clear cache. Please try again.');
    }
  }

  async function handleFavorites() {
    const modal = document.getElementById('favorites-modal');
    const body = document.getElementById('favorites-modal-body');
    const period = selectedPeriod('fav-target-period');
    body.innerHTML = '<p>Loading favorites...</p>';
    showModal(modal);
    if (period === null) {
      body.innerHTML = render.errorHTML('No editable week is shown.');
      return;
    }

    try {
      const response = await apiFetch('/api/favorites?period=' + period);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch favorites');
      }
      const favs = await response.json();

      if (favs.length === 0) {
        body.innerHTML = '<p>No favorites found. Add them in the Costpoint web UI.</p>';
        return;
      }

      body.innerHTML = render.favoritesTableHTML(favs);

      body.querySelectorAll('.fav-add-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const favoriteIndex = parseInt(btn.dataset.index, 10);
          const workLocation = btn.closest('tr').querySelector('.fav-location').value.trim();
          hideAllModals();
          await addFavorite(favoriteIndex, period, workLocation);
        });
      });
    } catch (err) {
      body.innerHTML = render.errorHTML(err.message || 'Failed to load favorites');
    }
  }

  async function handleLeaveBalances() {
    const leaveModal = document.getElementById('leave-modal');
    const leaveBody = document.getElementById('leave-modal-body');
    leaveBody.innerHTML = '<p>Loading leave balances...</p>';
    showModal(leaveModal);

    try {
      const response = await apiFetch('/api/leave');
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch leave balances');
      }
      const result = await response.json();
      leaveBody.innerHTML = render.leaveHTML(result);
    } catch (err) {
      leaveBody.innerHTML = render.errorHTML(err.message || 'Failed to load leave balances');
    }
  }

  function selectedPeriod(selectId) {
    const select = document.getElementById(selectId);
    const period = select ? parseInt(select.value, 10) : NaN;
    return Number.isInteger(period) ? period : null;
  }

  function addProject(code, payType, period, favorite = false, workLocation = '') {
    return postProject({ code, payType, period, favorite, workLocation });
  }

  // The server adds the favorites-list row itself, with the favorite's own
  // pay type (tecli-a1t.12)
  function addFavorite(favoriteIndex, period, workLocation = '') {
    return postProject({ favoriteIndex, period, workLocation });
  }

  async function postProject(fields) {
    if (fields.period === null) {
      showError('No editable week is shown.');
      return;
    }
    updateSyncStatus('syncing');
    try {
      const response = await apiFetch('/api/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields, offset: data ? data.offset : 0 }),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || 'Failed to add project');
      }

      if (result.revisionRequired) {
        updateSyncStatus('idle');
        showRevisionModal(result.auditDetails || [], true);
        return;
      }

      if (result.warning) {
        showError('Project added. ' + result.warning);
      } else {
        showSuccess('Project added successfully! Reloading...');
      }
      setTimeout(
        () => {
          window.location.reload();
        },
        result.warning ? 3000 : 1000
      );
    } catch (err) {
      console.error('Add project failed:', err);
      showError(err.message || 'Failed to add project. Please check the code and try again.');
      updateSyncStatus('error');
    }
  }

  async function handleAddProject() {
    const projectCodeInput = document.getElementById('project-code');
    const projectPayTypeSelect = document.getElementById('project-pay-type');
    const confirmAddProject = document.getElementById('confirm-add-project');
    const favoriteInput = document.getElementById('project-favorite');
    const code = projectCodeInput.value.trim();
    const payType = projectPayTypeSelect ? projectPayTypeSelect.value : 'REG';
    const period = selectedPeriod('add-target-period');
    const favorite = favoriteInput ? favoriteInput.checked : false;
    const locationInput = document.getElementById('project-work-location');
    const workLocation = locationInput ? locationInput.value.trim() : '';
    if (!code) {
      projectCodeInput.focus();
      return;
    }

    confirmAddProject.disabled = true;
    confirmAddProject.textContent = 'Adding...';

    try {
      hideAllModals();
      projectCodeInput.value = '';
      if (projectPayTypeSelect) projectPayTypeSelect.value = 'REG';
      await addProject(code, payType, period, favorite, workLocation);
    } finally {
      confirmAddProject.disabled = false;
      confirmAddProject.textContent = 'Add';
    }
  }

  async function handleSign() {
    // Check for unsaved changes first
    if (pendingChanges.size > 0) {
      showError('Please save your changes before signing the timesheet.');
      hideAllModals();
      return;
    }

    const confirmSign = document.getElementById('confirm-sign');
    confirmSign.disabled = true;
    confirmSign.textContent = 'Signing...';
    updateSyncStatus('syncing');

    try {
      const response = await apiFetch('/api/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: signPeriod }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to sign timesheet');
      }

      hideAllModals();
      updateSyncStatus('idle');
      showSuccess('Timesheet signed successfully! Reloading...');
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (err) {
      console.error('Sign failed:', err);
      showError(err.message || 'Failed to sign timesheet. It may already be signed.');
      updateSyncStatus('error');
    } finally {
      confirmSign.disabled = false;
      confirmSign.textContent = 'Sign';
    }
  }

  // Copy Thursday's hours to Friday for the active week
  function handleCopyThursdayToFriday() {
    if (!data || !data.activeDates) return;

    const activeDatesSet = new Set(data.activeDates);
    var thuDay = null,
      friDay = null;
    for (var di = 0; di < data.dates.length; di++) {
      var d = data.dates[di];
      if (!activeDatesSet.has(d.fullDate)) continue;
      if (d.dayOfWeek === 'Thu') thuDay = d.date;
      if (d.dayOfWeek === 'Fri') friDay = d.date;
    }

    if (thuDay === null || friDay === null) return;

    var copied = 0;
    document.querySelectorAll('tbody tr').forEach(function (row) {
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
      if (data.weeks[i].isActive) {
        activeWeek = data.weeks[i];
        break;
      }
    }
    if (!activeWeek) return;

    // Only nudge if unsigned
    if (activeWeek.statusTone !== 'open' && activeWeek.statusTone !== 'missing') return;

    // Check if the active week contains today
    var todayStr =
      today.getFullYear() +
      '-' +
      String(today.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(today.getDate()).padStart(2, '0');
    if (todayStr < activeWeek.startDate || todayStr > activeWeek.endDate) return;

    var nudge = document.getElementById('thursday-nudge');
    if (nudge) {
      var msg = nudge.querySelector('.nudge-message');
      if (msg) {
        msg.textContent =
          dayOfWeek === 4
            ? "It's Thursday - estimate Friday and sign your timesheet"
            : "Don't forget to sign this week's timesheet";
      }
      nudge.style.display = 'flex';
    }
  }

  // Status polling runs for the life of the page
  function startStatusPolling() {
    setInterval(checkStatus, 5000);
  }

  async function checkStatus() {
    try {
      const response = await apiFetch('/api/status');
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
      console.error('Status check failed:', err);
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
      errorBanner.classList.remove('success-banner');
      errorBanner.classList.add('error-banner');
      errorMessage.textContent = message;
      errorBanner.style.display = 'flex';
    }
  }

  function showSuccess(message) {
    if (errorMessage && errorBanner) {
      errorBanner.classList.remove('error-banner');
      errorBanner.classList.add('success-banner');
      errorMessage.textContent = message;
      errorBanner.style.display = 'flex';
      setTimeout(() => {
        errorBanner.style.display = 'none';
      }, 3000);
    }
  }

  function showModal(modal) {
    if (!modal) return;
    modal.style.display = 'flex';
    const input = modal.querySelector("input[type='text']");
    if (input) {
      setTimeout(() => input.focus(), 100);
    }
  }

  function hideAllModals() {
    document.querySelectorAll('.modal').forEach(modal => {
      modal.style.display = 'none';
    });
    const projectCodeInput = document.getElementById('project-code');
    if (projectCodeInput) {
      projectCodeInput.value = '';
    }
    const projectPayTypeSelect = document.getElementById('project-pay-type');
    if (projectPayTypeSelect) {
      projectPayTypeSelect.value = 'REG';
    }
    const favoriteInput = document.getElementById('project-favorite');
    if (favoriteInput) {
      favoriteInput.checked = false;
    }
    const locationInput = document.getElementById('project-work-location');
    if (locationInput) {
      locationInput.value = '';
    }
  }

  // Start the app
  init();
})();
