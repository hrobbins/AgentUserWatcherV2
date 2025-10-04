const hostsContainer = document.getElementById('hosts');
const hostTemplate = document.getElementById('host-template');

const state = new Map();

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
    .then(renderHost)
    .catch((error) => console.error('Failed to refresh host', error));
}

function bootstrap() {
  fetch('/api/activity')
    .then((response) => response.json())
    .then((data) => {
      handleSnapshot(data);
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

bootstrap();

