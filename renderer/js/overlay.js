const rowsHost = document.querySelector('#overlay-rows');
const entries = new Map();
let seeded = false;

function setOverlayVisibility(hidden) {
  const graphic = document.querySelector('.ladder-graphic');
  if (!graphic) return;
  if (hidden) {
    graphic.classList.remove('is-revealing');
    document.body.classList.add('is-hidden');
    return;
  }
  document.body.classList.remove('is-hidden');
  graphic.classList.remove('is-revealing');
  void graphic.offsetWidth;
  graphic.classList.add('is-revealing');
  setTimeout(() => graphic.classList.remove('is-revealing'), 520);
}

function handleOverlayCommand(command) {
  if (command?.type === 'set-visibility') setOverlayVisibility(!!command.hidden);
}

function displayName(name) {
  return String(name || '')
    .replace(/\s+(FNC|FC|AFC|JFC)\b/gi, '')
    .replace(/\s+Senior\s+(Men|Women)\b/gi, '')
    .trim().toUpperCase();
}

function abbreviation(name) {
  const clean = displayName(name);
  const known = {
    LANGWARRIN: 'LAN', ROSEBUD: 'ROS', DROMANA: 'DRO',
    'FRANKSTON YCW': 'YCW', 'MT. ELIZA': 'MTE', 'MT ELIZA': 'MTE',
    'DEVON MEADOWS': 'DEV', 'EDITHVALE-ASPENDALE': 'EDI',
    MORNINGTON: 'MOR', SORRENTO: 'SOR', PINES: 'PIN', 'CRIB POINT': 'CRI'
  };
  return known[clean] || clean.replace(/[^A-Z]/g, '').slice(0, 3).padEnd(3, '—');
}

function logoFor(name) {
  const clean = displayName(name);
  if (clean.includes('DEVON')) return '/assets/devon-meadows.jpg';
  if (clean.includes('DROMANA')) return '/assets/dromana.gif';
  if (clean.includes('ROSEBUD')) return '/assets/rosebud.jpg';
  if (clean.includes('LANGWARRIN')) return '/assets/langwarrin.jpg';
  if (clean.includes('ELIZA')) return '/assets/mt-eliza.jpg';
  if (clean.includes('EDITHVALE') || clean.includes('ASPENDALE')) return '/assets/edithvale-aspendale.webp';
  if (clean.includes('YCW')) return '/assets/crib-point.png';
  if (clean.includes('CRIB POINT')) return '/assets/crib-point.png';
  return '';
}

function setValue(el, value) {
  const next = String(value ?? '');
  if (el.textContent === next) return;
  el.textContent = next;
  el.classList.remove('value-change');
  void el.offsetWidth;
  el.classList.add('value-change');
  setTimeout(() => el.classList.remove('value-change'), 600);
}

function setTickerValue(el, value) {
  const next = String(value ?? '');
  const current = el.querySelector('.ticker-value:last-child');
  if (!current) {
    el.textContent = '';
    const initial = document.createElement('span');
    initial.className = 'ticker-value';
    initial.textContent = next;
    el.append(initial);
    return;
  }
  if (current.textContent === next) return;
  const incoming = document.createElement('span');
  incoming.className = 'ticker-value ticker-in';
  incoming.textContent = next;
  current.classList.add('ticker-out');
  el.append(incoming);
  setTimeout(() => {
    current.remove();
    incoming.classList.remove('ticker-in');
  }, 1050);
}

function setDigitTickerValue(el, value) {
  const next = String(value ?? '');
  const currentText = el.dataset.tickerValue;
  if (currentText === next) return;
  if (el.children.length !== next.length) {
    el.textContent = '';
    for (const character of next) {
      const slot = document.createElement('span');
      slot.className = /\d/.test(character) ? 'digit-slot' : 'digit-slot digit-punctuation';
      const initial = document.createElement('span');
      initial.className = 'digit-value';
      initial.textContent = character;
      slot.append(initial);
      el.append(slot);
    }
    el.dataset.tickerValue = next;
    return;
  }
  [...el.children].forEach((slot, index) => {
    const character = next[index];
    const current = slot.querySelector('.digit-value:last-child');
    if (current.textContent === character) return;
    const incoming = document.createElement('span');
    incoming.className = 'digit-value digit-in';
    incoming.textContent = character;
    current.classList.add('digit-out');
    slot.append(incoming);
    setTimeout(() => {
      current.remove();
      incoming.classList.remove('digit-in');
    }, 1050);
  });
  el.dataset.tickerValue = next;
}

function makeEntry() {
  const el = document.createElement('div');
  el.className = 'ladder-graphic-row';
  const rank = document.createElement('span');
  const logoCell = document.createElement('span');
  logoCell.className = 'logo-cell';
  const logo = document.createElement('img');
  const logoFallback = document.createElement('span');
  logoFallback.className = 'logo-fallback';
  const teamCell = document.createElement('span');
  teamCell.className = 'team-cell';
  const team = document.createElement('span');
  const move = document.createElement('span');
  move.className = 'move-indicator';
  const pts = document.createElement('span');
  const percent = document.createElement('span');
  percent.className = 'percent-ticker';
  logoCell.append(logo, logoFallback);
  teamCell.append(team, move);
  el.append(rank, logoCell, teamCell, pts, percent);
  return { el, rank, logo, logoFallback, team, move, pts, percent };
}

function render(snapshot) {
  const ladder = (snapshot?.ladder || []).slice(0, 6);
  const first = new Map([...entries].map(([key, entry]) => [key, entry.el.getBoundingClientRect()]));
  const seen = new Set();

  for (const row of ladder) {
    seen.add(row.key);
    let entry = entries.get(row.key);
    if (!entry) { entry = makeEntry(); entries.set(row.key, entry); }
    setValue(entry.rank, row.position);
    setValue(entry.team, abbreviation(row.display || row.name));
    setTickerValue(entry.pts, row.pts);
    setDigitTickerValue(entry.percent, Number(row.pct).toFixed(1));
    const logo = logoFor(row.name);
    entry.logo.classList.remove('is-loaded', 'is-missing');
    entry.logoFallback.textContent = abbreviation(row.name);
    entry.logo.onload = () => entry.logo.classList.add('is-loaded');
    entry.logo.onerror = () => {
      entry.logo.removeAttribute('src');
      entry.logo.classList.add('is-missing');
    };
    if (logo) entry.logo.src = new URL(logo, window.location.href).href;
    else {
      entry.logo.removeAttribute('src');
      entry.logo.classList.add('is-missing');
    }
    entry.logo.alt = displayName(row.name);
    entry.logo.style.visibility = logo ? 'visible' : 'hidden';
    entry.el.classList.toggle('is-leader', row.position === 1);
    const clean = displayName(row.name);
    entry.el.classList.toggle('is-selected', clean.includes('DEVON') || clean.includes('DROMANA'));
    entry.el.classList.toggle('is-rosebud', clean.includes('ROSEBUD'));
    entry.el.classList.toggle('is-langwarrin', clean.includes('LANGWARRIN'));
    entry.el.classList.toggle('is-dromana', clean.includes('DROMANA'));
    entry.el.classList.toggle('is-devon', clean.includes('DEVON'));
    entry.el.classList.toggle('is-mteliza', clean.includes('ELIZA'));
    entry.el.classList.toggle('is-ycw', abbreviation(row.display || row.name) === 'YCW');
    const delta = Number(row.delta || 0);
    entry.move.textContent = delta > 0 ? '▲' : delta < 0 ? '▼' : '';
    entry.move.className = `move-indicator ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`;
    entry.el.classList.toggle('is-cut-line', row.position === 5);
    const previous = ladder.find((candidate) => candidate.position === row.position - 1);
    const selectedPair = previous && [previous.name, row.name].every((name) => {
      const club = displayName(name);
      return club.includes('DEVON') || club.includes('DROMANA');
    });
    entry.el.classList.toggle('is-selected-pair-line', !!selectedPair);
    rowsHost.append(entry.el);
  }

  for (const [key, entry] of entries) {
    if (!seen.has(key)) { entry.el.remove(); entries.delete(key); }
  }

  if (seeded) {
    for (const [key, entry] of entries) {
      const before = first.get(key);
      if (!before) continue;
      const after = entry.el.getBoundingClientRect();
      const dy = before.top - after.top;
      if (Math.abs(dy) < 1) continue;
      entry.el.animate(
        [
          { transform: `translate3d(0, ${dy}px, 0) rotateX(0deg) rotateY(0deg) scale(1)` },
          { transform: `translate3d(0, ${dy * 0.58}px, 140px) rotateX(-4deg) rotateY(-3deg) scale(1.1)` },
          { transform: `translate3d(0, ${dy * 0.16}px, 72px) rotateX(2deg) rotateY(2deg) scale(1.04)` },
          { transform: 'translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg) scale(1)' }
        ],
        { duration: 1710, easing: 'cubic-bezier(0.22, 1.02, 0.24, 1)' }
      );
      entry.el.classList.add('moved');
      setTimeout(() => entry.el.classList.remove('moved'), 650);
    }
  }
  seeded = true;
}

if (window.api?.onState) {
  window.api.onState(({ snapshot }) => render(snapshot));
  window.api.overlay?.onCommand(handleOverlayCommand);
  window.api.getState().then(render);
} else {
  fetch('/state').then((response) => response.json()).then(render);
  const stream = new EventSource('/events');
  stream.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.snapshot) render(payload.snapshot);
      if (payload.command) handleOverlayCommand(payload.command);
    } catch { /* reconnect may be incomplete */ }
  });
}
