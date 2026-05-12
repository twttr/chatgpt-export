document.addEventListener('DOMContentLoaded', () => {
  const exportBtn = document.getElementById('exportBtn');
  const stopBtn = document.getElementById('stopBtn');
  const statusText = document.getElementById('statusText');
  const convCount = document.getElementById('convCount');
  const attachCount = document.getElementById('attachCount');
  const progressContainer = document.getElementById('progressContainer');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const warningBox = document.getElementById('warningBox');
  const logArea = document.getElementById('logArea');
  const includeAttachments = document.getElementById('includeAttachments');
  const includeArchived = document.getElementById('includeArchived');
  const resumeInfo = document.getElementById('resumeInfo');
  const clearBtn = document.getElementById('clearBtn');

  function addLog(msg) {
    logArea.style.display = 'block';
    const line = document.createElement('div');
    line.textContent = msg;
    logArea.appendChild(line);
    logArea.scrollTop = logArea.scrollHeight;
  }

  function setStatus(text, type) {
    statusText.textContent = text;
    statusText.className = 'status-value' + (type ? ' ' + type : '');
  }

  function updateProgress(current, total) {
    progressContainer.style.display = 'block';
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    progressFill.style.width = pct + '%';
    progressText.textContent = current + ' / ' + total;
  }

  function setExporting(running) {
    exportBtn.style.display = running ? 'none' : 'block';
    stopBtn.style.display = running ? 'block' : 'none';
  }

  // Check for saved progress and whether we're on chatgpt.com
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith('https://chatgpt.com')) {
      warningBox.style.display = 'block';
      exportBtn.disabled = true;
      setStatus('Wrong page', 'error');
    }
  });

  chrome.runtime.sendMessage({ action: 'getStatus' }, response => {
    if (chrome.runtime.lastError) return;
    if (response && response.hasSavedProgress) {
      resumeInfo.style.display = 'block';
      resumeInfo.querySelector('.resume-text').textContent =
        response.saved + ' conversations saved locally. Will resume automatically.';
    }
  });

  exportBtn.addEventListener('click', () => {
    setExporting(true);
    setStatus('Exporting...', '');
    resumeInfo.style.display = 'none';
    addLog('Starting export...');

    chrome.runtime.sendMessage({
      action: 'startExport',
      options: {
        includeAttachments: includeAttachments.checked,
        includeArchived: includeArchived.checked,
      },
    });
  });

  stopBtn.addEventListener('click', () => {
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stopping...';
    setStatus('Stopping...', '');
    chrome.runtime.sendMessage({ action: 'stopExport' });
  });

  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearProgress' }, () => {
      resumeInfo.style.display = 'none';
      addLog('Saved progress cleared.');
    });
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'export-log') addLog(msg.text);
    if (msg.type === 'export-status') setStatus(msg.text, msg.statusType || '');
    if (msg.type === 'export-progress') updateProgress(msg.current, msg.total);
    if (msg.type === 'export-stats') {
      if (msg.conversations !== undefined) convCount.textContent = msg.conversations;
      if (msg.attachments !== undefined) attachCount.textContent = msg.attachments;
    }
    if (msg.type === 'export-done') {
      setExporting(false);
      setStatus('Done!', '');
      convCount.textContent = msg.conversations || '-';
      attachCount.textContent = msg.attachments || '-';
      exportBtn.textContent = 'Export Again';
      addLog('Export complete! File downloaded.');
    }
    if (msg.type === 'export-stopped') {
      setExporting(false);
      stopBtn.disabled = false;
      stopBtn.textContent = 'Stop';
      setStatus('Stopped', 'pending');
      addLog('Stopped. ' + msg.saved + '/' + msg.total + ' saved. Reopen to resume.');
      resumeInfo.style.display = 'block';
      resumeInfo.querySelector('.resume-text').textContent =
        'Saved progress: ' + msg.saved + '/' + msg.total + ' conversations. Will resume automatically.';
    }
    if (msg.type === 'export-error') {
      setExporting(false);
      setStatus('Error', 'error');
      addLog('ERROR: ' + msg.text);
    }
  });
});
