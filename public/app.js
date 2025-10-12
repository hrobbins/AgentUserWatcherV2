const hostsContainer = document.getElementById('hosts');
const hostTemplate = document.getElementById('host-template');
const modal = document.getElementById('history-modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalClose = document.getElementById('modal-close');

const state = new Map();

// Classification type labels
const classificationLabels = {
  'SCHOOL_WORK': 'School Work',
  'NON_SCHOOL': 'Non-School',
  'LOCKED_INACTIVE': 'Locked/Inactive',
  'UNKNOWN': 'Unknown'
};

const classificationIcons = {
  'SCHOOL_WORK': '📚',
  'NON_SCHOOL': '🎮',
  'LOCKED_INACTIVE': '🔒',
  'UNKNOWN': '❓'
};

function renderHost(host) {
  const latest = host.history?.[host.history.length - 1] || null;
  const confidenceText = latest?.confidence != null
    ? ` (confidence ${(latest.confidence * 100).toFixed(1)}%)`
    : '';

  let element = state.get(host.hostId);
  if (!element) {
    element = hostTemplate.content.firstElementChild.cloneNode(true);
    element.dataset.hostId = host.hostId;
    state.set(host.hostId, element);
    hostsContainer.appendChild(element);
  }

  element.querySelector('.host__title').textContent = host.hostId;
  element.querySelector('.host__description').textContent = host.description || '—';

  const summaryEl = element.querySelector('.host__summary');
  const timestampEl = element.querySelector('.host__timestamp');
  const imageEl = element.querySelector('.host__image');

  if (latest) {
    summaryEl.textContent = `${latest.summary || 'No summary available'}${confidenceText}`;
    timestampEl.textContent = `Updated ${new Date(latest.timestamp).toLocaleString()}`;

    if (host.latestScreenshot?.path) {
      imageEl.src = `${host.latestScreenshot.path}?t=${Date.now()}`;
      imageEl.alt = `${host.hostId} screenshot`;
      element.classList.remove('host--empty');
    } else {
      element.classList.add('host--empty');
    }
  } else {
    summaryEl.textContent = 'No activity yet';
    timestampEl.textContent = '';
    element.classList.add('host--empty');
  }
}

function removeHost(hostId) {
  const element = state.get(hostId);
  if (element) {
    hostsContainer.removeChild(element);
    state.delete(hostId);
  }
}

function sortAndRender(hosts) {
  const sorted = [...hosts].sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
  sorted.forEach(renderHost);
}

function handleSnapshot(payload) {
  hostsContainer.textContent = '';
  state.clear();
  sortAndRender(payload.hosts || []);
}

function handleUpdate(payload) {
  if (payload.cleared) {
    handleSnapshot({ hosts: [] });
    updateClassificationStats();
    return;
  }

  if (payload.removed && payload.hostId) {
    removeHost(payload.hostId);
    return;
  }

  if (!payload.hostId) return;

  fetch(`/api/activity/${encodeURIComponent(payload.hostId)}`)
    .then((response) => {
      if (!response.ok) {
        if (response.status === 404) {
          removeHost(payload.hostId);
        }
        throw new Error(`Request failed with status ${response.status}`);
      }
      return response.json();
    })
    .then((host) => {
      renderHost(host);
      updateClassificationStats();
    })
    .catch((error) => console.error('Failed to refresh host', error));
}

function bootstrap() {
  fetch('/api/activity')
    .then((response) => response.json())
    .then((data) => {
      handleSnapshot(data);
      updateClassificationStats();
      connectSse();
    })
    .catch((error) => {
      console.error('Failed to fetch initial hosts', error);
    });
}

function connectSse() {
  const source = new EventSource('/api/stream');

  source.addEventListener('snapshot', (event) => {
    const payload = JSON.parse(event.data);
    handleSnapshot(payload);
  });

  source.addEventListener('update', (event) => {
    const payload = JSON.parse(event.data);
    handleUpdate(payload);
  });

  source.onerror = () => {
    console.warn('SSE connection lost, retrying in 5s');
    source.close();
    setTimeout(connectSse, 5000);
  };
}

// Fetch and update classification statistics
function updateClassificationStats() {
  fetch('/api/classifications/summary')
    .then((response) => response.json())
    .then((summary) => {
      document.getElementById('count-work').textContent = summary.SCHOOL_WORK || 0;
      document.getElementById('count-non-work').textContent = summary.NON_SCHOOL || 0;
      document.getElementById('count-locked').textContent = summary.LOCKED_INACTIVE || 0;
      document.getElementById('count-unknown').textContent = summary.UNKNOWN || 0;
    })
    .catch((error) => {
      console.error('Failed to fetch classification summary', error);
    });
}

// Show history modal
function showHistoryModal(type) {
  const label = classificationLabels[type] || type;
  const icon = classificationIcons[type] || '';
  
  modalTitle.textContent = `${icon} ${label} History`;
  modalBody.innerHTML = '<p class="loading">Loading history...</p>';
  modal.classList.remove('hidden');
  
  fetch(`/api/classifications/${type}?limit=50`)
    .then((response) => response.json())
    .then((data) => {
      if (!data.history || data.history.length === 0) {
        modalBody.innerHTML = '<p class="empty-message">No history available for this classification.</p>';
        return;
      }
      
      // Sort history by timestamp (newest first)
      const sortedHistory = [...data.history].sort((a, b) => b.timestamp - a.timestamp);
      
      const historyHtml = sortedHistory.map((entry) => {
        const date = new Date(entry.timestamp).toLocaleString();
        const confidenceText = entry.confidence != null 
          ? ` <span class="confidence">(${(entry.confidence * 100).toFixed(0)}%)</span>` 
          : '';
        const categoryText = entry.category ? ` - ${entry.category}` : '';
        const screenshotHtml = entry.screenshot?.path 
          ? `<img class="history-item__screenshot" src="${entry.screenshot.path}" alt="Screenshot" />` 
          : '';
        
        return `
          <div class="history-item">
            <div class="history-item__header">
              <span class="history-item__host">${entry.hostId}</span>
              <span class="history-item__date">${date}</span>
            </div>
            <div class="history-item__content">
              <p class="history-item__summary">${entry.summary}${confidenceText}</p>
              ${entry.category ? `<p class="history-item__category">Category: ${entry.category}</p>` : ''}
            </div>
            ${screenshotHtml}
          </div>
        `;
      }).join('');
      
      modalBody.innerHTML = historyHtml;
    })
    .catch((error) => {
      console.error('Failed to fetch classification history', error);
      modalBody.innerHTML = '<p class="error-message">Failed to load history. Please try again.</p>';
    });
}

// Close modal
function closeModal() {
  modal.classList.add('hidden');
}

// Event listeners for modal
modalClose.addEventListener('click', closeModal);
modal.querySelector('.modal__overlay').addEventListener('click', closeModal);

// Event listeners for "View History" buttons
document.querySelectorAll('.stat-card__button').forEach((button) => {
  button.addEventListener('click', (e) => {
    const type = e.target.dataset.type;
    showHistoryModal(type);
  });
});

// Update classification stats periodically
setInterval(updateClassificationStats, 5000);

bootstrap();

