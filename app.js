const STORAGE_KEY = 'mis-lecturas-v1';
const $ = (id) => document.getElementById(id);

const BACKUP_KEY = 'mis-lecturas-v1-corrupto';

let toastTimer = null;
let books = [];
let editingId = null;
let searchTimer = null;
let searchSeq = 0;

// ---------- Avisos ----------
// action: { label, run } añade un botón; ms: 0 mantiene el aviso hasta cerrarlo
function showToast(message, action, ms = 6000) {
  clearTimeout(toastTimer);
  const t = $('toast');
  t.replaceChildren(message);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = () => { action.run(); hideToast(); };
    t.append(b);
  }
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
const hideToast = () => $('toast').replaceChildren();
const dismissable = { label: 'Cerrar', run() {} };

// ---------- Modelo ----------
// Un libro guarda lo suyo (título, carátula, autor, género, procedencia) y una lista de lecturas:
// una por lector, cada una con sus fechas, su puntuación y sus notas.
//   { id, title, cover, author, genre, origin, readings: [{ reader, start, end, rating, notes }] }
// reader '' = lectura sin nombre (la de quien usa la app sin lectores).
const normName = (s) => s.trim().replace(/\s+/g, ' ');
const sameName = (a, b) => a.toLocaleLowerCase('es') === b.toLocaleLowerCase('es');
const byName = (a, b) => a.localeCompare(b, 'es');
const newReading = (reader = '') => ({ reader, start: '', end: '', rating: null, notes: '' });
const ratingOrNull = (n) => (Number.isInteger(n) && n >= 1 && n <= 10 ? n : null);

// Libros guardados antes de las lecturas tenían start/end/rating/notes/readers en el propio libro.
// Se convierten a una lectura por cada lector que tenía el libro (con los mismos datos), o a una lectura sin nombre.
// Es idempotente: sobre un libro ya convertido no cambia nada.
function migrateBook(b) {
  if (!Array.isArray(b.readings)) {
    const names = (Array.isArray(b.readers) ? b.readers : []).filter((r) => typeof r === 'string' && normName(r));
    const base = { start: b.start || '', end: b.end || '', rating: ratingOrNull(b.rating), notes: String(b.notes ?? '') };
    b.readings = (names.length ? names : ['']).map((reader) => ({ reader, ...base }));
  }
  for (const k of ['readers', 'start', 'end', 'rating', 'notes']) delete b[k];
  b.readings = b.readings
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      reader: typeof r.reader === 'string' ? normName(r.reader) : '',
      start: r.start || '', end: r.end || '', rating: ratingOrNull(r.rating), notes: String(r.notes ?? ''),
    }));
  if (!b.readings.length) b.readings = [newReading()];
  return b;
}

// ---------- Almacenamiento ----------
function load() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { return []; }
  if (raw === null) return [];
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data.filter((b) => b && typeof b === 'object');
  } catch {}
  // Ilegible: se guarda aparte para que el siguiente save() no lo destruya
  try { if (localStorage.getItem(BACKUP_KEY) === null) localStorage.setItem(BACKUP_KEY, raw); } catch {}
  showToast('No se pudieron leer tus libros guardados. Hemos conservado una copia intacta en este navegador por si se puede recuperar.', dismissable, 0);
  return [];
}
// Devuelve false si no pudo guardar; en ese caso el aviso de error no debe taparse con uno de éxito
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
    return true;
  } catch {
    showToast('No se pudo guardar en este navegador (almacenamiento lleno o bloqueado). Abre «Opciones» y pulsa «Exportar copia» para no perder tus libros.', dismissable, 0);
    return false;
  }
}
books = load().map(migrateBook);

// ---------- Lectores ----------
// La lista de lectores se guarda aparte (así un lector puede existir sin libros); las lecturas citan su nombre.
const READERS_KEY = 'mis-lecturas-lectores';
let readers = [];
const sortReaders = () => readers.sort(byName);
// Nombres de los lectores de un libro, en orden alfabético (las lecturas sin nombre no cuentan)
const readersOf = (b) => b.readings.map((r) => r.reader).filter(Boolean).sort(byName);
function loadReaders() {
  try {
    const data = JSON.parse(localStorage.getItem(READERS_KEY));
    if (Array.isArray(data)) return data.filter((r) => typeof r === 'string' && normName(r));
  } catch {}
  return []; // si no se puede leer, la lista se reconstruye con los nombres que figuran en las lecturas
}
function saveReaders() {
  try {
    localStorage.setItem(READERS_KEY, JSON.stringify(readers));
    return true;
  } catch {
    showToast('No se pudo guardar la lista de lectores en este navegador. Abre «Opciones» y pulsa «Exportar copia» para no perder tus datos.', dismissable, 0);
    return false;
  }
}
// Las lecturas mandan: un nombre que una lectura cita y no está en la lista (p. ej. importado) se añade,
// las mayúsculas distintas se unifican con la de la lista, un lector solo tiene una lectura por libro
// y un libro siempre tiene al menos una lectura.
function syncReaders() {
  let changed = false;
  for (const b of books) {
    const seen = new Set();
    b.readings = b.readings.filter((rd) => {
      let name = rd.reader ? normName(rd.reader) : '';
      if (name) {
        let r = readers.find((x) => sameName(x, name));
        if (!r) { r = name; readers.push(r); changed = true; }
        name = r;
      }
      rd.reader = name;
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
    if (!b.readings.length) b.readings = [newReading()];
  }
  sortReaders();
  return changed;
}
readers = loadReaders();
if (syncReaders()) saveReaders();

// Primer lector por orden alfabético: es el que ordena el libro; sin lectores, al final
const firstReader = (b) => readersOf(b)[0];

// ---------- Vistas de un libro ----------
// Con un lector elegido en el filtro, el libro se ve con SU lectura; sin filtro, con todas (puntuación media, fechas más recientes).
let viewReader = ''; // '' = todos, '__none__' = sin lector, o un nombre
const viewOf = (b) => {
  if (viewReader === '__none__') return b.readings.filter((r) => !r.reader);
  if (viewReader) return b.readings.filter((r) => r.reader === viewReader);
  return b.readings;
};
// En curso: con fecha de inicio y sin fecha de fin
const rInProgress = (r) => Boolean(r.start && !r.end);
const inProgress = (b) => viewOf(b).some(rInProgress);
const latest = (list, key) => list.map((r) => r[key]).filter(Boolean).sort().pop() || '';
const startOf = (b) => latest(viewOf(b), 'start');
const endOf = (b) => latest(viewOf(b), 'end');
const mean = (nums) => (nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null);
const ratingOf = (b) => mean(viewOf(b).map((r) => r.rating).filter(Boolean));
// Lectura que representa al libro en la tarjeta: la que está en curso (la empezada más recientemente) o la terminada más reciente
const mainReading = (rs) => rs.filter(rInProgress).sort((x, y) => y.start.localeCompare(x.start))[0]
  || [...rs].sort((x, y) => (y.end || '').localeCompare(x.end || ''))[0] || rs[0] || newReading();

// ---------- Listado ----------
// Los libros sin esa fecha quedan siempre al final, también en orden descendente
const byDate = (get, dir) => (a, b) => {
  const x = get(a), y = get(b);
  if (!x || !y) return !x - !y;
  return dir * (x < y ? -1 : x > y ? 1 : 0);
};
// Por fecha de fin, los libros en curso van primero (el empezado más recientemente delante)
const byEnd = (dir) => (a, b) => {
  if (inProgress(a) !== inProgress(b)) return inProgress(a) ? -1 : 1;
  if (inProgress(a)) return byDate(startOf, -1)(a, b);
  return byDate(endOf, dir)(a, b);
};
const sorters = {
  'end-desc': byEnd(-1),
  'end-asc': byEnd(1),
  'start-desc': byDate(startOf, -1),
  'start-asc': byDate(startOf, 1),
  'rating-desc': (a, b) => (ratingOf(b) ?? -1) - (ratingOf(a) ?? -1),
  'rating-asc': (a, b) => (ratingOf(a) ?? 99) - (ratingOf(b) ?? 99),
  'title-asc': (a, b) => a.title.localeCompare(b.title, 'es'),
  'author-asc': (a, b) => (a.author || '').localeCompare(b.author || '', 'es'),
  'reader-asc': (a, b) => {
    const x = firstReader(a), y = firstReader(b);
    if (!x || !y) return !x - !y;
    return x.localeCompare(y, 'es');
  },
};
function filtered() {
  viewReader = $('f-reader').value;
  const text = $('f-text').value.trim().toLowerCase();
  const sf = $('f-start-from').value, st = $('f-start-to').value;
  const ef = $('f-end-from').value, et = $('f-end-to').value;
  const inRange = (d, from, to) => (!from && !to) || (d && (!from || d >= from) && (!to || d <= to));
  const origin = $('f-origin').value;
  const status = $('f-status').value; // '' | reading | finished
  return books
    .filter((b) => !status || (status === 'reading' ? inProgress(b) : viewOf(b).some((r) => r.end)))
    .filter((b) => !origin || b.origin === origin)
    .filter((b) => !viewReader || (viewReader === '__none__' ? !readersOf(b).length : readersOf(b).includes(viewReader)))
    .filter((b) => !text || [b.title, b.author, b.genre, ...b.readings.map((r) => r.notes), ...readersOf(b)].some((v) => (v || '').toLowerCase().includes(text)))
    .filter((b) => viewOf(b).some((r) => inRange(r.start, sf, st) && inRange(r.end, ef, et)))
    .sort(sorters[$('f-sort').value]);
}

function render() {
  const list = filtered();
  // Con el panel cerrado, el número del botón "Filtros" avisa de cuántos filtros del panel hay activos
  const panelFilters = ['f-origin', 'f-reader', 'f-start-from', 'f-start-to', 'f-end-from', 'f-end-to'].filter((id) => $(id).value).length;
  $('dates-count').textContent = panelFilters ? ` (${panelFilters})` : '';
  $('btn-clear').hidden = !(panelFilters || $('f-text').value.trim() || $('f-status').value);
  const n = list.length;
  $('count-n').textContent = n;
  $('count-rest').textContent = ` ${n === 1 ? 'libro' : 'libros'}${books.length !== n ? ` de ${books.length}` : ''}`;
  // Resumen de la página: siempre sobre todas las lecturas, no sobre los filtros
  const all = books.flatMap((b) => b.readings);
  $('st-total').textContent = books.length;
  $('st-reading').textContent = books.filter((b) => b.readings.some(rInProgress)).length;
  $('st-finished').textContent = books.filter((b) => b.readings.some((r) => r.end)).length;
  $('st-avg').textContent = avg(all.map((r) => r.rating).filter(Boolean));
  $('list').replaceChildren(...(list.length ? list.map(card) : [emptyState()]));
  $('genres').replaceChildren(...[...new Set(books.map((b) => b.genre).filter(Boolean))].map((g) => {
    const o = document.createElement('option'); o.value = g; return o;
  }));
}

// Crea un elemento con clase y texto opcionales (siempre textContent, nunca innerHTML)
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
// Icono del sprite de index.html: <svg class="icon"><use href="#i-nombre"/></svg>
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// Estado vacío: invitación a añadir el primer libro, o salida cuando los filtros no encuentran nada
function emptyState() {
  const first = books.length === 0;
  const box = el('div', first ? 'empty-state' : 'empty-state compact-empty');
  const iconBox = el('span', 'empty-state-icon');
  iconBox.append(icon(first ? 'book-open' : 'search'));
  box.append(iconBox);
  if (first) box.append(el('p', 'eyebrow', 'CADA LIBRO CUENTA'));
  box.append(
    el('h3', '', first ? 'Tu próxima historia empieza aquí' : 'No encontramos libros'),
    el('p', '', first
      ? 'Añade el libro que estás leyendo y guarda tus fechas, notas y puntuación.'
      : 'Prueba a cambiar la búsqueda o los filtros que has seleccionado.'),
  );
  const actions = el('div', 'empty-actions');
  const button = (label, onclick, primary) => {
    const b = el('button', primary ? 'primary-button' : 'secondary-button');
    b.type = 'button';
    if (primary) b.append(icon('plus'));
    b.append(label);
    b.onclick = onclick;
    return b;
  };
  if (first) {
    actions.append(
      button('Añadir mi primer libro', () => openDialog(null), true),
      button('Importar una copia', () => $('btn-import').click()),
    );
  } else {
    actions.append(button('Limpiar filtros', () => $('btn-clear').click()));
  }
  box.append(actions);
  return box;
}

// Carátula sin imagen: degradado (5 variantes estables según el título) con autor, título y género
const coverVariant = (s) => [...s].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 5;
function coverArt(b) {
  const art = el('div', `book-cover cover-art cover-art-${coverVariant(b.title)}`);
  art.setAttribute('aria-hidden', 'true'); // el título ya se lee en el encabezado de la tarjeta
  art.append(el('span', 'cover-art-author', b.author || 'Tu biblioteca'), el('span', 'cover-art-title', b.title), el('span', 'cover-art-rule'), el('span', 'cover-art-genre', b.genre || 'LECTURA'));
  return art;
}
function coverNode(b) {
  if (!b.cover) return coverArt(b);
  const wrap = el('div', 'book-cover');
  const img = document.createElement('img');
  img.alt = ''; // decorativa: el título ya está en el texto de la tarjeta
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.onerror = () => wrap.replaceWith(coverArt(b)); // imagen que no carga: se usa la carátula de respaldo
  img.onload = () => {
    // Open Library responde con una imagen de 1×1 píxel cuando no tiene portada: no sirve, se usa el respaldo
    if (img.naturalWidth < 20 || img.naturalHeight < 20) { wrap.replaceWith(coverArt(b)); return; }
    // La caja es vertical (2:3). Una portada de otra proporción se muestra entera en vez de recortarla.
    if (Math.abs(img.naturalWidth / img.naturalHeight - 2 / 3) > 0.1) img.classList.add('contain');
  };
  img.src = b.cover; // asignada como propiedad: una URL rara de un archivo importado no puede romper nada
  wrap.append(img);
  return wrap;
}

const fmtRating = (n) => (Number.isInteger(n) ? String(n) : n.toLocaleString('es', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
function card(b) {
  const article = el('article', 'book');
  article.dataset.id = b.id;
  const rs = viewOf(b);
  const main = mainReading(rs);
  const multi = b.readings.length > 1;

  const wrap = el('div', 'book-cover-wrap');
  wrap.append(coverNode(b));
  if (inProgress(b)) {
    const pill = el('span', 'reading-pill');
    pill.append(el('span', 'reading-dot'), 'En curso');
    wrap.append(pill);
  }
  const rating = ratingOf(b);
  if (rating !== null) {
    const pill = el('span', 'rating-pill');
    const several = rs.filter((r) => r.rating).length > 1;
    pill.append(icon('star-fill'), el('span', 'sr', several ? 'Puntuación media ' : 'Puntuación '), fmtRating(rating), el('span', 'sr', ' de 10'));
    wrap.append(pill);
  }

  const copy = el('div', 'book-card-copy');
  // El título es el botón que abre la ficha; su ::after cubre toda la tarjeta (así "Terminé" puede ser otro botón)
  const line = el('div', 'book-title-line');
  const h = el('h3'); // h3: las tarjetas cuelgan del h2 "Tu colección"
  const open = el('button', 'card-open');
  open.type = 'button';
  open.append(el('span', 'clamp', b.title)); // el recorte va en un span: en el botón recortaría su ::after
  open.title = b.title; // completo al pasar el ratón
  open.onclick = () => openDialog(b);
  h.append(open);
  line.append(h);
  copy.append(line, el('p', 'book-author', b.author || 'Autor por añadir'),
    el('p', 'book-genre', `${b.genre || 'Sin género'}${b.origin ? ` · ${b.origin}` : ''}`));
  if (readersOf(b).length) copy.append(el('p', 'readers', `Leído por ${readersOf(b).join(', ')}`));

  const dates = el('div', 'book-dates');
  const s = fmt(main.start), e = fmt(main.end);
  const range = !s && !e ? 'Sin fechas' : `${s || 'Inicio sin fecha'} — ${e || 'En curso'}`;
  dates.append(icon('calendar'), el('span', '', multi ? `${range} · ${b.readings.length} lecturas` : range));
  copy.append(dates);

  // Un "Terminé" por cada lectura en curso (con el nombre si hay varias)
  const pending = rs.filter(rInProgress);
  for (const rd of pending) {
    const who = pending.length > 1 ? (rd.reader || 'sin nombre') : '';
    const finish = el('button', 'finish');
    finish.type = 'button';
    finish.append(icon('check'), who ? `Terminé (${who})` : 'Terminé');
    finish.setAttribute('aria-label', `Terminé «${b.title}»${who ? ` (${who})` : ''}`);
    finish.onclick = () => openDialog(b, b.readings.indexOf(rd));
    copy.append(finish);
  }
  if (main.notes) copy.append(el('p', 'book-note', `“${main.notes}”${multi && main.reader ? ` — ${main.reader}` : ''}`));

  article.append(wrap, copy);
  return article;
}
const fmt = (d) => (d ? d.split('-').reverse().join('/') : '');

// ---------- Diálogo del libro ----------
// El formulario trabaja con una copia (draft) de las lecturas del libro; los campos de fechas, puntuación y notas
// muestran la lectura activa (pestaña). Al cambiar de pestaña o guardar, lo escrito vuelve a su lectura.
let draft = [];
let activeReading = 0;
const readingFromInputs = () => {
  const rating = parseInt($('rating').value, 10);
  return { reader: $('reading-reader').value, start: $('start').value, end: $('end').value, rating: ratingOrNull(rating), notes: $('notes').value.trim() };
};
const commitActive = () => { if (draft[activeReading]) draft[activeReading] = readingFromInputs(); };
// No se puede salir de una lectura con las fechas al revés
const guardActive = () => {
  if ($('end').checkValidity()) return true;
  $('end').reportValidity();
  return false;
};

function fillReaderSelect() {
  const used = new Set(draft.map((r, i) => (i === activeReading ? null : r.reader)));
  const select = $('reading-reader');
  select.replaceChildren(new Option('Sin nombre', ''), ...readers.map((n) => new Option(n, n)));
  for (const o of select.options) o.disabled = used.has(o.value); // un lector solo tiene una lectura por libro
  select.value = draft[activeReading].reader;
  $('readers-empty').hidden = readers.length > 0;
}
function renderTabs() {
  $('reading-tabs').replaceChildren(...draft.map((r, i) => {
    const tab = el('button', 'reading-tab', r.reader || (draft.length === 1 && !readers.length ? 'Mi lectura' : 'Sin nombre'));
    tab.type = 'button';
    tab.id = `rtab-${i}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(i === activeReading));
    tab.tabIndex = i === activeReading ? 0 : -1;
    tab.onclick = () => switchReading(i);
    return tab;
  }));
  $('reading-panel').setAttribute('aria-labelledby', `rtab-${activeReading}`);
  $('remove-reading').hidden = draft.length < 2;
}
function showReading(i) {
  activeReading = i;
  const r = draft[i];
  fillReaderSelect();
  $('start').value = r.start;
  $('end').value = r.end;
  $('rating').value = r.rating ?? '';
  $('notes').value = r.notes;
  syncRating();
  checkDates();
  renderTabs();
}
function switchReading(i, focusTab = false) {
  if (i === activeReading || !guardActive()) return;
  commitActive();
  showReading(i);
  if (focusTab) $(`rtab-${i}`).focus();
}
$('reading-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  e.preventDefault();
  switchReading((activeReading + (e.key === 'ArrowRight' ? 1 : -1) + draft.length) % draft.length, true);
});
$('reading-reader').addEventListener('change', () => { commitActive(); showReading(activeReading); });
$('add-reading').onclick = () => {
  if (!guardActive()) return;
  commitActive();
  const used = new Set(draft.map((r) => r.reader));
  const next = readers.find((n) => !used.has(n)) ?? (used.has('') ? undefined : '');
  if (next === undefined) {
    $('reader-error').textContent = 'Ya hay una lectura de cada lector. Para añadir otra, crea un lector nuevo en Opciones → Gestionar lectores.';
    return;
  }
  $('reader-error').textContent = '';
  draft.push(newReading(next));
  showReading(draft.length - 1);
  $('reading-reader').focus();
};
$('remove-reading').onclick = () => {
  draft.splice(activeReading, 1);
  showReading(Math.max(0, activeReading - 1));
};

// finishing: viene del botón "Terminé" (true = la primera lectura en curso, o el índice de la lectura); pone la fecha de fin de hoy
// y deja la puntuación a mano. No guarda hasta pulsar Guardar.
function openDialog(b, finishing = false) {
  editingId = b ? b.id : null;
  draft = b ? b.readings.map((r) => ({ ...r })) : [newReading()];
  const idx = finishing === false ? 0
    : typeof finishing === 'number' ? finishing : Math.max(0, draft.findIndex(rInProgress));
  // Al terminar, el diálogo se desplaza hasta la puntuación: el nombre del libro va en el encabezado, que también lee el lector de pantalla
  const who = finishing !== false && draft.length > 1 ? ` · ${draft[idx].reader || 'sin nombre'}` : '';
  $('dlg-title').textContent = finishing !== false ? `Terminar «${b.title}»${who}` : b ? 'Editar libro' : 'Añadir libro';
  $('title').value = b?.title || '';
  $('cover').value = b?.cover || '';
  $('author').value = b?.author || '';
  $('genre').value = b?.genre || '';
  $('origin').value = b?.origin || '';
  $('reader-error').textContent = '';
  showReading(idx);
  $('btn-delete').hidden = !b;
  setOpen(false);
  $('search-status').textContent = '';
  setCoverField(Boolean(b?.cover)); // el campo de la URL solo se muestra si ya hay carátula o se pide
  updatePreview();
  $('dlg').showModal();
  if (finishing !== false) {
    $('end').value = today();
    checkDates();
    pills.firstElementChild.scrollIntoView({ block: 'center' });
    pills.firstElementChild.focus();
  } else if (b && matchMedia('(pointer: coarse)').matches) {
    // Editar en una pantalla táctil: no abrir el teclado sin que nadie lo pida
    $('dlg-title').tabIndex = -1;
    $('dlg-title').focus();
  } else {
    $('title').focus();
  }
  initialState = formState();
}

// Cambios sin guardar: Cancelar y Esc preguntan antes de descartarlos
let initialState = '';
const formState = () => JSON.stringify([
  ...['title', 'cover', 'author', 'genre', 'origin'].map((id) => $(id).value),
  draft.map((r, i) => (i === activeReading ? readingFromInputs() : r)),
]);
const isDirty = () => $('dlg').open && formState() !== initialState;
const confirmDiscard = () => !isDirty() || confirm('Hay cambios sin guardar. ¿Descartarlos?');

function updatePreview() {
  const url = $('cover').value.trim();
  const p = $('cover-preview');
  if (url) {
    p.className = 'cover-preview';
    p.style.backgroundImage = `url(${JSON.stringify(url)})`; // comillas escapadas
    p.replaceChildren();
  } else {
    p.className = 'cover-preview cover-preview-empty';
    p.style.backgroundImage = '';
    p.replaceChildren(icon('image-plus'), el('span', '', 'Carátula'));
  }
}
// La URL de la carátula se rellena sola al elegir un resultado, así que su campo va plegado
function setCoverField(open) {
  $('cover-field').hidden = !open;
  $('cover-toggle').setAttribute('aria-expanded', String(open));
  $('cover-toggle').querySelector('span').textContent = open ? 'Ocultar URL de carátula' : 'Añadir URL de carátula';
}
$('cover-toggle').onclick = () => setCoverField($('cover-field').hidden);

$('form').addEventListener('submit', (e) => {
  commitActive();
  // El navegador solo valida la pestaña visible: si otra tiene las fechas al revés, se va a ella y no se guarda
  const bad = draft.findIndex((r) => r.start && r.end && r.end < r.start);
  if (bad >= 0) {
    e.preventDefault();
    showReading(bad);
    $('end').reportValidity();
    return;
  }
  const data = {
    title: $('title').value.trim(),
    cover: $('cover').value.trim(),
    author: $('author').value.trim(),
    genre: $('genre').value.trim(),
    origin: $('origin').value,
    readings: draft.map((r) => ({ ...r })),
  };
  const editing = Boolean(editingId);
  const id = editingId || crypto.randomUUID();
  const prev = editing ? books.find((b) => b.id === id) : null;
  // "Terminado": alguna lectura que estaba en curso ahora tiene fecha de fin
  const finished = Boolean(prev && prev.readings.some((r) => rInProgress(r) && data.readings.some((d) => d.reader === r.reader && d.end)));
  if (editing) books = books.map((b) => (b.id === id ? { ...b, ...data } : b));
  else books.push({ id, ...data });
  syncReaders();
  const saved = save();
  render();
  if (saved) announceSaved(id, data.title, editing, finished);
});

// Confirma el guardado y lleva la vista al libro, que con el orden actual puede quedar lejos
function announceSaved(id, title, editing, finished) {
  const verb = finished ? 'terminado' : editing ? 'actualizado' : 'añadido';
  const cardEl = $('list').querySelector(`[data-id="${id}"]`);
  if (!cardEl) {
    showToast(`«${title}» ${verb}, pero los filtros activos lo ocultan.`,
      { label: 'Limpiar filtros', run: () => $('btn-clear').click() }, 10000);
    return;
  }
  showToast(`«${title}» ${verb}.`);
  cardEl.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  cardEl.classList.add('just-saved');
  setTimeout(() => cardEl.classList.remove('just-saved'), 2500);
}
$('btn-cancel').onclick = $('btn-dlg-close').onclick = () => { if (confirmDiscard()) $('dlg').close(); };
$('dlg').addEventListener('cancel', (e) => { if (!confirmDiscard()) e.preventDefault(); }); // Esc
$('btn-delete').onclick = () => {
  const i = books.findIndex((b) => b.id === editingId);
  if (i < 0) return;
  const [removed] = books.splice(i, 1);
  const saved = save();
  render(); $('dlg').close();
  if (saved) showToast(`«${removed.title}» eliminado.`, {
    label: 'Deshacer',
    run() { books.splice(Math.min(i, books.length), 0, removed); save(); render(); },
  }, 10000);
};

// La fecha de fin no puede ser anterior a la de inicio
function checkDates() {
  const s = $('start').value, e = $('end').value;
  const msg = s && e && e < s ? 'La fecha de fin es anterior a la de inicio. Corrige una de las dos.' : '';
  $('end').setCustomValidity(msg); // impide guardar
  $('end-error').textContent = msg; // y se ve junto al campo, no solo en la burbuja del navegador
  $('end').setAttribute('aria-invalid', String(Boolean(msg)));
}
$('start').addEventListener('input', checkDates);
$('end').addEventListener('input', checkDates);

const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD en hora local
$('start-today').onclick = () => { $('start').value = today(); checkDates(); };
$('end-today').onclick = () => { $('end').value = today(); checkDates(); };

// Puntuación: 10 botones; volver a pulsar el elegido la quita. El valor vive en #rating.
const pills = $('rating-pills');
for (let n = 1; n <= 10; n++) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = n;
  b.setAttribute('aria-label', `Puntuar con ${n} de 10`);
  b.onclick = () => { $('rating').value = $('rating').value === String(n) ? '' : String(n); syncRating(); };
  pills.append(b);
}
function syncRating() {
  [...pills.children].forEach((b, i) => b.setAttribute('aria-pressed', String(String(i + 1) === $('rating').value)));
}
$('cover').addEventListener('input', updatePreview);

// ---------- Búsqueda automática en Open Library ----------
$('title').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('title').value.trim();
  if (q.length < 3) { setOpen(false); return; }
  searchTimer = setTimeout(() => searchBooks(q), 500);
});

// Combobox: la lista se recorre con flechas y se elige con Enter
let activeOpt = -1;
function setOpen(open) {
  $('suggestions').hidden = !open;
  $('title').setAttribute('aria-expanded', open);
  setActive(-1);
}
function setActive(i) {
  const opts = $('suggestions').children;
  [...opts].forEach((o, n) => o.setAttribute('aria-selected', n === i));
  activeOpt = i;
  if (i >= 0) {
    $('title').setAttribute('aria-activedescendant', opts[i].id);
    opts[i].scrollIntoView({ block: 'nearest' });
  } else {
    $('title').removeAttribute('aria-activedescendant');
  }
}
$('title').addEventListener('keydown', (e) => {
  const ul = $('suggestions');
  const n = ul.children.length;
  if (ul.hidden || !n) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive((activeOpt + 1) % n); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeOpt <= 0 ? n - 1 : activeOpt - 1); }
  else if (e.key === 'Enter' && activeOpt >= 0) { e.preventDefault(); ul.children[activeOpt].click(); }
  else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
});

async function searchBooks(q) {
  const seq = ++searchSeq;
  $('search-status').textContent = 'Buscando en internet…';
  try {
    const url = 'https://openlibrary.org/search.json?limit=6&fields=title,author_name,cover_i,subject,first_publish_year&q=' + encodeURIComponent(q);
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const { docs } = await res.json();
    if (seq !== searchSeq) return; // llegó una búsqueda más reciente
    $('search-status').textContent = docs.length
      ? `${docs.length} resultados. Usa las flechas arriba y abajo y Enter para elegir.`
      : 'Sin resultados';
    showSuggestions(docs);
  } catch {
    if (seq === searchSeq) $('search-status').textContent = 'No se pudo buscar (¿sin conexión?). Puedes rellenar los campos a mano.';
  }
}

function showSuggestions(docs) {
  const ul = $('suggestions');
  ul.replaceChildren(...docs.map((d, n) => {
    const li = document.createElement('li');
    li.id = `sug-${n}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    const thumb = d.cover_i ? document.createElement('img') : document.createElement('div');
    if (d.cover_i) {
      thumb.src = coverUrl(d.cover_i, 'S');
      thumb.alt = ''; // decorativa: el título ya está en el texto de al lado
      thumb.width = 32; thumb.height = 48; // evita saltos de maquetación al cargar
    } else {
      thumb.className = 'noimg';
    }
    const txt = document.createElement('div');
    txt.textContent = d.title;
    const small = document.createElement('small');
    small.textContent = [d.author_name?.[0], d.first_publish_year].filter(Boolean).join(' · ');
    txt.append(small);
    li.append(thumb, txt);
    li.onclick = () => pick(d);
    return li;
  }));
  setOpen(docs.length > 0);
}

const coverUrl = (id, size) => `https://covers.openlibrary.org/b/id/${id}-${size}.jpg`;

function pick(d) {
  $('title').value = d.title;
  if (d.cover_i) $('cover').value = coverUrl(d.cover_i, 'L');
  if (d.author_name?.[0]) $('author').value = d.author_name[0];
  if (!$('genre').value && d.subject?.[0]) $('genre').value = d.subject[0];
  setOpen(false);
  $('search-status').textContent = '';
  updatePreview();
}

// El filtro por lector se reconstruye con la lista actual y conserva la elección si sigue existiendo
function refreshReaderOptions(preferred) {
  const select = $('f-reader');
  const current = preferred ?? select.value;
  select.replaceChildren(new Option('Todos', ''), new Option('Sin lector', '__none__'), ...readers.map((r) => new Option(r, r)));
  select.value = [...select.options].some((o) => o.value === current) ? current : '';
}

// ---------- Lectores: gestión ----------
function readersMsg(text, action) {
  const m = $('readers-msg');
  m.replaceChildren(text);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = action.run;
    m.append(' ', b);
  }
}
function renderReadersList() {
  $('readers-list').replaceChildren(...readers.map((r) => {
    const li = document.createElement('li');
    const input = document.createElement('input');
    input.value = r;
    input.maxLength = 40;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', `Nombre del lector ${r}`);
    input.onchange = () => renameReader(r, input.value);
    const n = books.filter((b) => readersOf(b).includes(r)).length;
    const count = document.createElement('span');
    count.className = 'muted count';
    count.textContent = `${n} ${n === 1 ? 'libro' : 'libros'}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger-button';
    del.textContent = 'Eliminar';
    del.setAttribute('aria-label', `Eliminar al lector ${r}`);
    del.onclick = () => deleteReader(r);
    li.append(input, count, del);
    return li;
  }));
  $('readers-none').hidden = readers.length > 0;
}
function afterReadersChange(preferredFilter) {
  saveReaders();
  save();
  refreshReaderOptions(preferredFilter);
  render();
  renderReadersList();
}
function renameReader(old, raw) {
  const name = normName(raw);
  if (!name) { readersMsg('El nombre no puede estar vacío.'); renderReadersList(); return; }
  const clash = readers.find((r) => r !== old && sameName(r, name));
  if (clash) { readersMsg(`Ya existe un lector llamado «${clash}».`); renderReadersList(); return; }
  if (name === old) { renderReadersList(); return; }
  const filterWasOld = $('f-reader').value === old;
  readers[readers.indexOf(old)] = name;
  sortReaders();
  for (const b of books) for (const rd of b.readings) if (rd.reader === old) rd.reader = name;
  afterReadersChange(filterWasOld ? name : undefined);
  readersMsg(`«${old}» ahora se llama «${name}».`);
}
// Eliminar a un lector borra sus lecturas (fechas, puntuación y notas): se pide confirmación si tienen datos y se puede deshacer
function deleteReader(name) {
  const removed = []; // { id, index, reading }
  for (const b of books) b.readings.forEach((rd, index) => { if (rd.reader === name) removed.push({ id: b.id, index, reading: rd }); });
  const withData = removed.filter(({ reading: r }) => r.start || r.end || r.rating || r.notes).length;
  if (withData && !confirm(`«${name}» tiene ${withData} ${withData === 1 ? 'lectura' : 'lecturas'} con fechas, puntuación o notas. Si lo eliminas, se borran también. ¿Eliminar a «${name}»?`)) return;
  const placeholders = []; // libros que se quedaron sin lecturas y recibieron una vacía
  for (const b of books) {
    b.readings = b.readings.filter((rd) => rd.reader !== name);
    if (!b.readings.length) { b.readings = [newReading()]; placeholders.push(b.id); }
  }
  readers.splice(readers.indexOf(name), 1);
  afterReadersChange();
  const n = new Set(removed.map((x) => x.id)).size;
  readersMsg(`«${name}» eliminado${n ? ` y quitado de ${n} ${n === 1 ? 'libro' : 'libros'}` : ''}.`, {
    label: 'Deshacer',
    run() {
      if (!readers.some((r) => sameName(r, name))) { readers.push(name); sortReaders(); }
      for (const id of placeholders) { const b = books.find((x) => x.id === id); if (b) b.readings = b.readings.filter((r) => r.reader || r.start || r.end || r.rating || r.notes); }
      for (const { id, index, reading } of removed) {
        const b = books.find((x) => x.id === id);
        if (b && !b.readings.some((r) => r.reader === name)) b.readings.splice(Math.min(index, b.readings.length), 0, reading);
      }
      afterReadersChange();
      readersMsg(`«${name}» restaurado.`);
    },
  });
}
$('reader-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = normName($('reader-new').value);
  if (!name) { readersMsg('Escribe el nombre del lector.'); return; }
  const clash = readers.find((r) => sameName(r, name));
  if (clash) { readersMsg(`Ya existe un lector llamado «${clash}».`); return; }
  readers.push(name);
  sortReaders();
  saveReaders();
  refreshReaderOptions();
  $('reader-new').value = '';
  renderReadersList();
  readersMsg(`«${name}» añadido.`);
  $('reader-new').focus();
});
$('btn-readers').onclick = () => {
  readersMsg('');
  renderReadersList();
  $('dlg-readers').showModal();
};
$('btn-readers-close').onclick = () => $('dlg-readers').close();

// ---------- Estadísticas ----------
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const periodKey = {
  year: (d) => d.slice(0, 4),
  quarter: (d) => `${d.slice(0, 4)} T${Math.ceil(+d.slice(5, 7) / 3)}`,
  month: (d) => d.slice(0, 7),
};
const periodLabel = (group, key) => (group === 'month' ? `${MONTHS[+key.slice(5) - 1]} ${key.slice(0, 4)}` : key);
// Coma decimal, como se escribe en español (7,5 y no 7.5)
const avg = (nums) => (nums.length
  ? (nums.reduce((s, n) => s + n, 0) / nums.length).toLocaleString('es', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  : '–');

// Las estadísticas cuentan lecturas (no libros): si dos personas leen el mismo libro son dos lecturas
function renderStats() {
  const group = $('stats-group').value;
  const reader = $('stats-reader').value; // '' = todos los lectores
  const readings = books.flatMap((b) => b.readings).filter((r) => !reader || r.reader === reader);
  const read = readings.filter((r) => r.end);
  const rated = readings.filter((r) => r.rating);

  const stat = (value, label) => {
    const d = document.createElement('div');
    const s = document.createElement('strong'); s.textContent = value;
    const l = document.createElement('span'); l.textContent = label;
    d.append(s, l);
    return d;
  };
  $('stats-summary').replaceChildren(
    stat(read.length, readers.length ? 'lecturas terminadas' : 'libros leídos'),
    stat(avg(rated.map((r) => r.rating)), 'puntuación media'),
    stat(readings.filter(rInProgress).length, 'en curso'),
  );

  const groups = new Map();
  for (const r of read) {
    const k = periodKey[group](r.end);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = [...groups.keys()].sort().reverse();
  const max = Math.max(1, ...[...groups.values()].map((g) => g.length));

  const rows = keys.map((k) => {
    const g = groups.get(k);
    const tr = document.createElement('tr');
    const cell = (txt) => { const td = document.createElement('td'); td.textContent = txt; return td; };
    const barCell = document.createElement('td');
    barCell.className = 'bar-cell';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('aria-hidden', 'true'); // la cifra ya está en la columna Libros
    bar.style.width = `${(g.length / max) * 100}%`;
    barCell.append(bar);
    tr.append(cell(periodLabel(group, k)), cell(g.length), barCell, cell(avg(g.filter((r) => r.rating).map((r) => r.rating))));
    return tr;
  });
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4; td.className = 'muted'; td.textContent = 'Aún no hay lecturas con fecha de fin.';
    tr.append(td); rows.push(tr);
  }
  $('stats-table').tBodies[0].replaceChildren(...rows);
}
$('btn-stats').onclick = () => {
  const select = $('stats-reader');
  const current = select.value;
  select.replaceChildren(new Option('Todos los lectores', ''), ...readers.map((r) => new Option(r, r)));
  select.value = readers.includes(current) ? current : '';
  $('stats-reader-field').hidden = !readers.length;
  renderStats();
  $('dlg-stats').showModal();
};
$('btn-stats-close').onclick = () => $('dlg-stats').close();
$('stats-group').addEventListener('input', renderStats);
$('stats-reader').addEventListener('input', renderStats);

// ---------- Tema claro / oscuro ----------
const prefersDark = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (document.documentElement.dataset.theme || (prefersDark.matches ? 'dark' : 'light')) === 'dark';
function updateThemeButton() {
  const dark = isDark();
  $('btn-theme').textContent = dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
  $('theme-color').content = dark ? '#11151f' : '#f4f5f7'; // barra del navegador en móvil
}
$('btn-theme').onclick = () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('mis-lecturas-theme', next); } catch {}
  updateThemeButton();
};
prefersDark.addEventListener('change', updateThemeButton);
updateThemeButton();

// ---------- Filtros, exportar / importar ----------
['f-text', 'f-sort', 'f-status', 'f-origin', 'f-reader', 'f-start-from', 'f-start-to', 'f-end-from', 'f-end-to'].forEach((id) => $(id).addEventListener('input', render));
$('btn-filters').onclick = () => {
  const open = $('filters-panel').hidden;
  $('filters-panel').hidden = !open;
  $('btn-filters').setAttribute('aria-expanded', String(open));
};
$('btn-clear').onclick = () => {
  ['f-text', 'f-status', 'f-origin', 'f-reader', 'f-start-from', 'f-start-to', 'f-end-from', 'f-end-to'].forEach((id) => ($(id).value = ''));
  render();
};
$('btn-new').onclick = () => openDialog(null);

$('btn-export').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ formato: 2, readers, books }, null, 2)], { type: 'application/json' }));
  a.download = `mis-lecturas-${today()}.json`; // fecha local: toISOString() usa UTC y cerca de medianoche daría otro día
  a.click();
  URL.revokeObjectURL(a.href);
};
$('btn-import').onclick = () => $('file-import').click();
$('file-import').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    // Formato actual: { formato: 2, readers, books } con lecturas. Las copias antiguas son solo la lista de libros
    // (con fechas, puntuación y notas en el propio libro): se convierten a lecturas y conservan tus lectores.
    const fileBooks = Array.isArray(data) ? data : Array.isArray(data?.books) ? data.books : null;
    if (!fileBooks) throw new Error();
    const fileReaders = !Array.isArray(data) && Array.isArray(data.readers) ? data.readers : null;
    const valid = fileBooks.filter((b) => b && typeof b.title === 'string' && b.title.trim());
    if (!valid.length) { alert('El archivo no contiene ningún libro con título. Elige una copia descargada con «Exportar copia».'); return; }
    const skipped = fileBooks.length - valid.length;
    const note = skipped ? ` (se ignoran ${skipped} sin título)` : '';
    const readersNote = fileReaders ? ' y tu lista de lectores por la suya' : '';
    if (!confirm(`Vas a reemplazar tus ${books.length} libros por los ${valid.length} del archivo${readersNote}${note}. ¿Continuar?`)) return;
    // ids nuevos: un archivo con ids repetidos haría que editar uno afectara a otro
    books = valid.map((b) => migrateBook({ ...b, id: crypto.randomUUID() }));
    if (fileReaders) {
      readers = [];
      for (const r of fileReaders) {
        const n = typeof r === 'string' ? normName(r) : '';
        if (n && !readers.some((x) => sameName(x, n))) readers.push(n);
      }
    }
    syncReaders();
    saveReaders(); save(); refreshReaderOptions(); render();
  } catch { alert('El archivo no es válido. Elige una copia descargada con «Exportar copia».'); }
};

// El menú "Opciones" se cierra al elegir una opción, al pulsar fuera o con Esc
const menu = $('menu');
menu.addEventListener('click', (e) => { if (e.target.closest('button')) menu.open = false; });
document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.open = false; });
// Con teclado: al tabular fuera del menú, se cierra (focusin y no focusout: Safari no da foco a los botones al hacer clic)
document.addEventListener('focusin', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
menu.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); }
});

// El orden elegido se recuerda (los filtros no: volver y ver una lista recortada sorprendería)
const SORT_KEY = 'mis-lecturas-orden';
try {
  const saved = localStorage.getItem(SORT_KEY);
  if ([...$('f-sort').options].some((o) => o.value === saved)) $('f-sort').value = saved;
} catch {}
$('f-sort').addEventListener('input', () => { try { localStorage.setItem(SORT_KEY, $('f-sort').value); } catch {} });

refreshReaderOptions();
render();
