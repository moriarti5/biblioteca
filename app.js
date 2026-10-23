const STORAGE_KEY = 'mis-lecturas-v1';
const $ = (id) => document.getElementById(id);

const BACKUP_KEY = 'mis-lecturas-v1-corrupto';
const PREVIOUS_KEY = 'mis-lecturas-v1-formato-anterior'; // copia de lo guardado antes de pasar a un libro por lector

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
// Un libro es la lectura de UN lector: guarda lo del libro (título, carátula, autor, género, procedencia) y lo de su
// lector (fechas, puntuación, notas). Cada lector tiene su propia biblioteca: si dos lectores leen el mismo libro, son dos entradas.
//   { id, title, cover, author, genre, origin, reader, start, end, rating, notes }
// reader '' = sin lector (la de quien usa la app sin lectores).
const normName = (s) => s.trim().replace(/\s+/g, ' ');
const sameName = (a, b) => a.toLocaleLowerCase('es') === b.toLocaleLowerCase('es');
const byName = (a, b) => a.localeCompare(b, 'es');
const ratingOrNull = (n) => (Number.isInteger(n) && n >= 1 && n <= 10 ? n : null);
const hasData = (b) => Boolean(b.start || b.end || b.rating || b.notes);

// Formatos anteriores: v1 (start/end/rating/notes/readers en el propio libro) y v2 (readings: [{ reader, start, end, rating, notes }]).
// Un libro con varios lectores pasa a ser una entrada por lector (con sus datos); en el formato actual devuelve el mismo libro limpio.
// Es idempotente.
const readingData = (r) => ({
  reader: typeof r.reader === 'string' ? normName(r.reader) : '',
  start: r.start || '', end: r.end || '', rating: ratingOrNull(r.rating), notes: String(r.notes ?? ''),
});
function migrateEntry(b) {
  let readings;
  if (Array.isArray(b.readings)) readings = b.readings.filter((r) => r && typeof r === 'object').map(readingData);
  else if (Array.isArray(b.readers)) {
    const names = b.readers.filter((r) => typeof r === 'string' && normName(r));
    readings = (names.length ? names : ['']).map((reader) => readingData({ ...b, reader }));
  } else readings = [readingData(b)];
  // Una lectura sin nombre y sin datos junto a otras con lector sobra
  if (readings.some((r) => r.reader)) readings = readings.filter((r) => r.reader || hasData(r));
  if (!readings.length) readings = [readingData({})];
  const base = { title: String(b.title ?? ''), cover: String(b.cover ?? ''), author: String(b.author ?? ''), genre: String(b.genre ?? ''), origin: String(b.origin ?? '') };
  return readings.map((r, i) => ({ id: (i === 0 && b.id) || crypto.randomUUID(), ...base, ...r }));
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
const stored = load();
books = stored.flatMap(migrateEntry);
// Los datos guardados en un formato anterior (sin "reader" en el libro) se reescriben en el actual;
// antes se guarda aparte una copia de lo que había, por si hiciera falta.
if (stored.some((b) => !('reader' in b))) {
  try { if (localStorage.getItem(PREVIOUS_KEY) === null) localStorage.setItem(PREVIOUS_KEY, localStorage.getItem(STORAGE_KEY)); } catch {}
  save();
}

// ---------- Lectores ----------
// La lista de lectores se guarda aparte (así un lector puede existir sin libros); los libros citan su nombre.
const READERS_KEY = 'mis-lecturas-lectores';
let readers = [];
const sortReaders = () => readers.sort(byName);
function loadReaders() {
  try {
    const data = JSON.parse(localStorage.getItem(READERS_KEY));
    if (Array.isArray(data)) return data.filter((r) => typeof r === 'string' && normName(r));
  } catch {}
  return []; // si no se puede leer, la lista se reconstruye con los nombres que figuran en los libros
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
// Los libros mandan: un nombre que un libro cita y no está en la lista (p. ej. importado) se añade,
// y las mayúsculas distintas se unifican con la de la lista.
function syncReaders() {
  let changed = false;
  for (const b of books) {
    let name = b.reader ? normName(b.reader) : '';
    if (name) {
      let r = readers.find((x) => sameName(x, name));
      if (!r) { r = name; readers.push(r); changed = true; }
      name = r;
    }
    b.reader = name;
  }
  sortReaders();
  return changed;
}
readers = loadReaders();
if (syncReaders()) saveReaders();

// ---------- Perfil ----------
// El lector elegido junto a "Añadir libro": con él solo se ve (y se añade) lo suyo. '' = todos los lectores.
const PROFILE_KEY = 'mis-lecturas-perfil';
let profile = '';
try { const p = localStorage.getItem(PROFILE_KEY); if (p && readers.includes(p)) profile = p; } catch {}
// Los libros del perfil activo; sin perfil, todos
const scoped = () => (profile ? books.filter((b) => b.reader === profile) : books);

// En curso: con fecha de inicio y sin fecha de fin
const inProgress = (b) => Boolean(b.start && !b.end);

// ---------- Listado ----------
// Los libros sin esa fecha quedan siempre al final, también en orden descendente
const byDate = (get, dir) => (a, b) => {
  const x = get(a), y = get(b);
  if (!x || !y) return !x - !y;
  return dir * (x < y ? -1 : x > y ? 1 : 0);
};
const startOf = (b) => b.start;
const endOf = (b) => b.end;
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
  'rating-desc': (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
  'rating-asc': (a, b) => (a.rating ?? 99) - (b.rating ?? 99),
  'title-asc': (a, b) => a.title.localeCompare(b.title, 'es'),
  'author-asc': (a, b) => (a.author || '').localeCompare(b.author || '', 'es'),
};
function filtered() {
  const text = $('f-text').value.trim().toLowerCase();
  const sf = $('f-start-from').value, st = $('f-start-to').value;
  const ef = $('f-end-from').value, et = $('f-end-to').value;
  const inRange = (d, from, to) => (!from && !to) || (d && (!from || d >= from) && (!to || d <= to));
  const origin = $('f-origin').value;
  const status = $('f-status').value; // '' | reading | finished
  return scoped()
    .filter((b) => !status || (status === 'reading' ? inProgress(b) : Boolean(b.end)))
    .filter((b) => !origin || b.origin === origin)
    .filter((b) => !text || [b.title, b.author, b.genre, b.notes, b.reader].some((v) => (v || '').toLowerCase().includes(text)))
    .filter((b) => inRange(b.start, sf, st) && inRange(b.end, ef, et))
    .sort(sorters[$('f-sort').value]);
}

function render() {
  const list = filtered();
  const mine = scoped();
  // Con el panel cerrado, el número del botón "Filtros" avisa de cuántos filtros del panel hay activos
  const panelFilters = ['f-origin', 'f-start-from', 'f-start-to', 'f-end-from', 'f-end-to'].filter((id) => $(id).value).length;
  $('dates-count').textContent = panelFilters ? ` (${panelFilters})` : '';
  $('btn-clear').hidden = !(panelFilters || $('f-text').value.trim() || $('f-status').value);
  const n = list.length;
  $('count-n').textContent = n;
  $('count-rest').textContent = ` ${n === 1 ? 'libro' : 'libros'}${mine.length !== n ? ` de ${mine.length}` : ''}`;
  // Resumen de la página: siempre sobre los libros del perfil, no sobre los filtros
  $('st-total').textContent = mine.length;
  $('st-reading').textContent = mine.filter(inProgress).length;
  $('st-finished').textContent = mine.filter((b) => b.end).length;
  $('st-avg').textContent = avg(mine.map((b) => b.rating).filter(Boolean));
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
  const first = scoped().length === 0;
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
  // Sin perfil elegido se ven los libros de todos: la tarjeta dice de quién es cada uno
  const owner = !profile && b.reader ? b.reader : '';

  const wrap = el('div', 'book-cover-wrap');
  wrap.append(coverNode(b));
  if (inProgress(b)) {
    const pill = el('span', 'reading-pill');
    pill.append(el('span', 'reading-dot'), 'En curso');
    wrap.append(pill);
  }
  if (b.rating) {
    const pill = el('span', 'rating-pill');
    pill.append(icon('star-fill'), el('span', 'sr', 'Puntuación '), fmtRating(b.rating), el('span', 'sr', ' de 10'));
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
  if (owner) copy.append(el('p', 'readers', `Leído por ${owner}`));

  const dates = el('div', 'book-dates');
  const s = fmt(b.start), e = fmt(b.end);
  dates.append(icon('calendar'), el('span', '', !s && !e ? 'Sin fechas' : `${s || 'Inicio sin fecha'} — ${e || 'En curso'}`));
  copy.append(dates);

  if (inProgress(b)) {
    const finish = el('button', 'finish');
    finish.type = 'button';
    finish.append(icon('check'), 'Terminé');
    finish.setAttribute('aria-label', `Terminé «${b.title}»${owner ? ` (${owner})` : ''}`);
    finish.onclick = () => openDialog(b, true);
    copy.append(finish);
  }
  if (b.notes) copy.append(el('p', 'book-note', `“${b.notes}”`));

  article.append(wrap, copy);
  return article;
}
const fmt = (d) => (d ? d.split('-').reverse().join('/') : '');

// ---------- Diálogo del libro ----------
// Edita lo del libro y la lectura de su lector (fechas, puntuación y notas). El lector no se elige aquí: es el perfil
// activo al añadir, o el dueño del libro al editarlo.
let dialogReader = '';
const readingLabel = (reader) => (reader ? `Lectura de ${reader}` : 'Mi lectura');

// finishing: viene del botón "Terminé"; pone la fecha de fin de hoy y deja la puntuación a mano. No guarda hasta pulsar Guardar.
function openDialog(b, finishing = false) {
  if (!b && readers.length && !profile) {
    // Sin lector elegido no se sabe en cuya biblioteca va el libro
    showToast('Elige primero un lector junto a «Añadir libro»: cada libro se guarda en la biblioteca de un lector.');
    $('profile').focus();
    return;
  }
  editingId = b ? b.id : null;
  dialogReader = b ? b.reader : profile;
  // Al terminar, el diálogo se desplaza hasta la puntuación: el nombre del libro va en el encabezado, que también lee el lector de pantalla
  const who = finishing && b.reader && !profile ? ` · ${b.reader}` : '';
  $('dlg-title').textContent = finishing ? `Terminar «${b.title}»${who}` : b ? 'Editar libro' : 'Añadir libro';
  $('reading-legend').textContent = readingLabel(dialogReader);
  $('title').value = b?.title || '';
  $('cover').value = b?.cover || '';
  $('author').value = b?.author || '';
  $('genre').value = b?.genre || '';
  $('origin').value = b?.origin || '';
  $('start').value = b?.start || '';
  $('end').value = b?.end || '';
  $('rating').value = b?.rating ?? '';
  $('notes').value = b?.notes || '';
  syncRating();
  checkDates();
  $('btn-delete').hidden = !b;
  setOpen(false);
  $('search-status').textContent = '';
  setCoverField(Boolean(b?.cover)); // el campo de la URL solo se muestra si ya hay carátula o se pide
  updatePreview();
  $('dlg').showModal();
  if (finishing) {
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
const formState = () => JSON.stringify(['title', 'cover', 'author', 'genre', 'origin', 'start', 'end', 'rating', 'notes'].map((id) => $(id).value));
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

$('form').addEventListener('submit', () => {
  const data = {
    title: $('title').value.trim(),
    cover: $('cover').value.trim(),
    author: $('author').value.trim(),
    genre: $('genre').value.trim(),
    origin: $('origin').value,
    reader: dialogReader,
    start: $('start').value,
    end: $('end').value,
    rating: ratingOrNull(parseInt($('rating').value, 10)),
    notes: $('notes').value.trim(),
  };
  const editing = Boolean(editingId);
  const id = editingId || crypto.randomUUID();
  const prev = editing ? books.find((b) => b.id === id) : null;
  // "Terminado": estaba en curso y ahora tiene fecha de fin
  const finished = Boolean(prev && inProgress(prev) && data.end);
  if (editing) books = books.map((b) => (b.id === id ? { ...b, ...data } : b));
  else books.push({ id, ...data });
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

// ---------- Búsqueda automática de libros (Open Library, Apple Books y, con tu clave, Google Books) ----------
const SEARCH_LIMIT = 20;
const SEARCH_TIMEOUT_MS = 12000;
// Para comparar títulos: sin acentos, mayúsculas ni signos
const plain = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim(); // algunos títulos de Open Library traen saltos de línea
// Qué parte de lo escrito aparece en un título (la última palabra puede ir a medias): 0 a 1
function overlap(typed, title) {
  const want = plain(typed).split(' ').filter(Boolean);
  const have = plain(title).split(' ');
  if (!want.length) return 0;
  return want.filter((w, i) => have.some((h) => (i === want.length - 1 ? h.startsWith(w) : h === w))).length / want.length;
}
// Consulta para Open Library. Con prefix, la última palabra se busca como prefijo ("cien años de sol*"), útil mientras
// se escribe; sin él, es la búsqueda normal, la única que encuentra los títulos de las ediciones en español.
function searchQuery(text, prefix) {
  const words = text.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  if (prefix && !/\s$/.test(text)) { const last = words.pop(); words.push(last.length >= 2 ? `${last}*` : last); }
  return words.join(' ');
}

$('title').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const text = $('title').value;
  if (text.trim().length < 3) { searchSeq++; setOpen(false); return; } // searchSeq++: se ignora una respuesta que llegue tarde
  searchTimer = setTimeout(() => searchBooks(text), 500);
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
  else if (e.key === 'Enter') { e.preventDefault(); useTyped(); } // Enter sin elegir: sigue con tu título (no guarda el libro)
  else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
});
// En el móvil no hay Esc: tocar fuera de la lista, o pasar a otro campo, la cierra
$('dlg').addEventListener('pointerdown', (e) => {
  if (!$('suggestions').hidden && !$('suggestions').contains(e.target) && e.target !== $('title')) setOpen(false);
});
// Solo cuando el foco pasa a otro campo: al pulsar un resultado el foco va al propio diálogo y la lista no debe cerrarse antes del clic
$('dlg').addEventListener('focusin', (e) => {
  if (e.target.matches('input, select, textarea, button, summary') && e.target !== $('title') && !$('suggestions').contains(e.target)) setOpen(false);
});
// Tocar la lista no le quita el foco al título (así no se pierde el clic ni se esconde el teclado)
$('suggestions').addEventListener('mousedown', (e) => e.preventDefault());

// Todas las fuentes se consultan con fetch directo desde el navegador (con CORS) y se normalizan a
//   { title, author, year, genre, thumb, cover }   (thumb: la miniatura de la lista; cover: la URL que se guarda en el libro)
async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw Object.assign(new Error(res.status), { status: res.status });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
const https = (u) => (u ? String(u).replace(/^http:/, 'https:') : '');
const yearOf = (s) => Number(String(s ?? '').slice(0, 4)) || undefined;

// --- Open Library (sin clave) ---
const olCover = (id, size) => `https://covers.openlibrary.org/b/id/${id}-${size}.jpg`;
async function fetchBooks(query) {
  // lang=es: de cada obra devuelve la edición en español (título y portada), no solo el título original. Ojo: sin el campo key Open Library no devuelve las ediciones.
  const url = `https://openlibrary.org/search.json?lang=es&limit=${SEARCH_LIMIT}&fields=key,title,author_name,cover_i,subject,first_publish_year,editions&q=${encodeURIComponent(query)}`;
  return (await fetchJson(url)).docs ?? [];
}
// Las dos búsquedas (normal y por prefijo) a la vez: cada una acierta donde la otra falla. Si una falla, se usa la otra.
async function fetchBoth(text) {
  const queries = [...new Set([searchQuery(text, false), searchQuery(text, true)])].filter(Boolean);
  const settled = await Promise.allSettled(queries.map(fetchBooks));
  const ok = settled.filter((s) => s.status === 'fulfilled');
  if (!ok.length) throw settled[0].reason;
  return ok.flatMap((s) => s.value);
}
// De cada obra, el título (de la edición en español o el original) que más se parece a lo escrito
function olItems(docs, typed) {
  return docs.flatMap((d) => {
    const ed = d.editions?.docs?.[0];
    const title = [clean(ed?.title), clean(d.title)].filter(Boolean).sort((x, y) => overlap(typed, y) - overlap(typed, x))[0];
    if (!title) return [];
    const id = (title === clean(ed?.title) ? ed?.cover_i : d.cover_i) || ed?.cover_i || d.cover_i || null;
    return [{ title, author: clean(d.author_name?.[0]), year: d.first_publish_year, genre: clean(d.subject?.[0]), thumb: id ? olCover(id, 'S') : '', cover: id ? olCover(id, 'L') : '' }];
  });
}

// --- Apple Books (iTunes Search, sin clave; libros electrónicos de la tienda española) ---
async function searchApple(text) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(text.trim())}&media=ebook&entity=ebook&country=es&limit=${SEARCH_LIMIT}`;
  const results = (await fetchJson(url)).results ?? [];
  return results.filter((r) => r.trackName).map((r) => {
    const art = https(r.artworkUrl100 || r.artworkUrl60);
    return {
      title: clean(r.trackName), author: clean(r.artistName), year: yearOf(r.releaseDate),
      genre: clean((r.genres ?? []).find((g) => !/^(libros|books)$/i.test(g))),
      thumb: art, cover: art.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.$1'), // la misma imagen en grande, con su proporción
    };
  });
}

// --- Google Books (solo con la clave de API del propio usuario: sin clave responde 429) ---
const GOOGLE_KEY = 'mis-lecturas-google-key';
const googleKey = () => { try { return localStorage.getItem(GOOGLE_KEY) || ''; } catch { return ''; } };
async function searchGoogle(text) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(text.trim())}&maxResults=${SEARCH_LIMIT}&printType=books&key=${encodeURIComponent(googleKey())}`;
  const items = (await fetchJson(url)).items ?? [];
  return items.filter((i) => i.volumeInfo?.title).map((i) => {
    const v = i.volumeInfo;
    const img = https(v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail).replace('&edge=curl', '');
    return { title: clean(v.title), author: clean(v.authors?.[0]), year: yearOf(v.publishedDate), genre: clean(v.categories?.[0]), thumb: img, cover: img };
  });
}

// Todas las fuentes a la vez: si una falla se usan las demás (y se avisa); solo es un error si fallan todas
const SOURCES = [
  { name: 'Open Library', run: async (text) => olItems(await fetchBoth(text), text) },
  { name: 'Apple Books', run: searchApple },
  { name: 'Google Books', run: searchGoogle, needsKey: true },
];
async function searchAll(text) {
  const active = SOURCES.filter((s) => !s.needsKey || googleKey());
  const settled = await Promise.allSettled(active.map((s) => s.run(text)));
  const ok = settled.filter((s) => s.status === 'fulfilled');
  if (!ok.length) throw settled[0].reason;
  return {
    items: ok.flatMap((s) => s.value),
    failed: active.map((s, i) => ({ name: s.name, err: settled[i].reason })).filter((_, i) => settled[i].status === 'rejected'),
  };
}
// Una fila por libro, sin repetidos (aunque vengan de fuentes distintas), los que más se parecen a lo escrito primero
// (y los que no se parecen nada solo si no hay otros)
function rank(items, typed) {
  const seen = new Map();
  for (const it of items) {
    // el autor también cuenta ("patria aramburu"); a igual parecido, mejor con portada y con el título más corto
    it.score = Math.max(overlap(typed, it.title), overlap(typed, `${it.title} ${it.author}`)) + (it.cover ? 0.02 : 0) - it.title.length * 0.0004;
    const key = `${plain(it.title)}|${plain(it.author)}`;
    const prev = seen.get(key);
    if (!prev) { seen.set(key, it); continue; }
    if (!prev.cover && it.cover) Object.assign(prev, { thumb: it.thumb, cover: it.cover, score: Math.max(prev.score, it.score) });
    prev.genre ||= it.genre;
    prev.year ||= it.year;
  }
  const all = [...seen.values()].sort((x, y) => y.score - x.score); // estable: a igual parecido, el orden de las fuentes
  const close = all.filter((r) => r.score >= 0.5);
  return (close.length ? close : all).slice(0, SEARCH_LIMIT);
}
// Aviso de las fuentes que no respondieron (la clave de Google rechazada merece su propio mensaje)
function failedNote(failed) {
  const bad = failed.find((f) => f.name === 'Google Books' && [400, 403].includes(f.err?.status));
  const others = failed.filter((f) => f !== bad).map((f) => f.name);
  return [bad && 'Google Books no acepta tu clave (Opciones → Google Books).', others.length && `${others.join(' y ')} no ${others.length > 1 ? 'respondieron' : 'respondió'}.`].filter(Boolean).map((s) => ` ${s}`).join('');
}

async function searchBooks(text) {
  const seq = ++searchSeq;
  $('search-status').textContent = 'Buscando en internet…';
  try {
    let { items, failed } = await searchAll(text);
    let note = '';
    // Sin resultados: se prueba sin la última palabra, por si lleva una errata
    const words = text.trim().split(/\s+/);
    if (!items.length && words.length > 1) {
      ({ items, failed } = await searchAll(`${words.slice(0, -1).join(' ')} `));
      if (items.length) note = ` (sin «${words[words.length - 1]}»)`;
    }
    if (seq !== searchSeq) return; // llegó una búsqueda más reciente
    const results = rank(items, text);
    const warn = failedNote(failed);
    $('search-status').textContent = results.length
      ? `${results.length} resultados${note}.${warn} Elige uno o usa tu título tal cual.`
      : `No hemos encontrado ese título.${warn} Puedes rellenar los campos a mano.`;
    showSuggestions(results, text.trim());
  } catch (err) {
    if (seq !== searchSeq) return;
    $('search-status').textContent = err.name === 'AbortError'
      ? 'La búsqueda tarda demasiado. Puedes seguir rellenando los campos a mano.'
      : 'No se pudo buscar (¿sin conexión?). Puedes rellenar los campos a mano.';
    setOpen(false);
  }
}

function showSuggestions(results, typed) {
  const ul = $('suggestions');
  const rows = results.map((r, n) => {
    const li = document.createElement('li');
    li.id = `sug-${n}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    const thumb = r.thumb ? document.createElement('img') : document.createElement('div');
    if (r.thumb) {
      thumb.src = r.thumb;
      thumb.alt = ''; // decorativa: el título ya está en el texto de al lado
      thumb.width = 32; thumb.height = 48; // evita saltos de maquetación al cargar
    } else {
      thumb.className = 'noimg';
    }
    const txt = document.createElement('div');
    txt.textContent = r.title;
    const small = document.createElement('small');
    small.textContent = [r.author, r.year].filter(Boolean).join(' · ');
    txt.append(small);
    li.append(thumb, txt);
    li.onclick = () => pick(r);
    return li;
  });
  if (rows.length) {
    // Siempre hay una salida: si ninguno es el libro, se sigue con lo escrito y se rellena a mano
    const none = document.createElement('li');
    none.id = `sug-${rows.length}`;
    none.className = 'use-typed';
    none.setAttribute('role', 'option');
    none.setAttribute('aria-selected', 'false');
    const txt = document.createElement('div');
    txt.textContent = `Usar «${typed}» tal cual`;
    const small = document.createElement('small');
    small.textContent = 'Ninguno de estos: relleno el resto a mano';
    txt.append(small);
    none.append(txt);
    none.onclick = useTyped;
    rows.push(none);
  }
  ul.replaceChildren(...rows);
  setOpen(rows.length > 0);
}
function useTyped() {
  setOpen(false);
  $('search-status').textContent = '';
  $('author').focus();
}

function pick(r) {
  // Si el resultado no se parece a lo escrito (p. ej. está en otro idioma), se conserva tu título y se rellena lo demás
  const typed = $('title').value.trim();
  const keepTyped = Math.max(overlap(typed, r.title), overlap(typed, `${r.title} ${r.author}`)) < 0.6; // también cuenta el autor: "patria aramburu" -> Patria
  if (!keepTyped) $('title').value = r.title;
  if (r.cover) $('cover').value = r.cover;
  if (r.author) $('author').value = r.author;
  if (!$('genre').value && r.genre) $('genre').value = r.genre;
  setOpen(false);
  $('search-status').textContent = keepTyped ? 'Se ha mantenido tu título; se han rellenado la portada y el autor.' : '';
  updatePreview();
}
// El selector de lector (junto a "Añadir libro") se reconstruye con la lista actual y conserva la elección si sigue existiendo;
// sin lectores no se muestra
function refreshProfileOptions(preferred) {
  const select = $('profile');
  const current = preferred ?? profile;
  select.replaceChildren(new Option('Todos los lectores', ''), ...readers.map((r) => new Option(r, r)));
  profile = readers.includes(current) ? current : '';
  select.value = profile;
  $('profile-wrap').hidden = !readers.length;
  try { localStorage.setItem(PROFILE_KEY, profile); } catch {}
}
$('profile').addEventListener('change', () => {
  profile = $('profile').value;
  try { localStorage.setItem(PROFILE_KEY, profile); } catch {}
  render();
});

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
    const n = books.filter((b) => b.reader === r).length;
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
function afterReadersChange(preferredProfile) {
  saveReaders();
  save();
  refreshProfileOptions(preferredProfile);
  render();
  renderReadersList();
}
function renameReader(old, raw) {
  const name = normName(raw);
  if (!name) { readersMsg('El nombre no puede estar vacío.'); renderReadersList(); return; }
  const clash = readers.find((r) => r !== old && sameName(r, name));
  if (clash) { readersMsg(`Ya existe un lector llamado «${clash}».`); renderReadersList(); return; }
  if (name === old) { renderReadersList(); return; }
  const profileWasOld = profile === old;
  readers[readers.indexOf(old)] = name;
  sortReaders();
  for (const b of books) if (b.reader === old) b.reader = name;
  afterReadersChange(profileWasOld ? name : undefined);
  readersMsg(`«${old}» ahora se llama «${name}».`);
}
// Cada lector tiene su propia biblioteca: eliminarlo borra sus libros (con sus fechas, puntuación y notas).
// Se pide confirmación si los tiene y se puede deshacer.
function deleteReader(name) {
  const removed = []; // { book, index }, de menor a mayor índice
  books.forEach((book, index) => { if (book.reader === name) removed.push({ book, index }); });
  const n = removed.length;
  if (n && !confirm(`«${name}» tiene ${n} ${n === 1 ? 'libro' : 'libros'} en su biblioteca. Si lo eliminas, se borran también. ¿Eliminar a «${name}»?`)) return;
  books = books.filter((b) => b.reader !== name);
  readers.splice(readers.indexOf(name), 1);
  afterReadersChange(); // si era el perfil activo, vuelve a «Todos los lectores»
  readersMsg(`«${name}» eliminado${n ? ` junto con ${n} ${n === 1 ? 'libro' : 'libros'}` : ''}.`, {
    label: 'Deshacer',
    run() {
      if (!readers.some((r) => sameName(r, name))) { readers.push(name); sortReaders(); }
      for (const { book, index } of removed) books.splice(Math.min(index, books.length), 0, book);
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
  refreshProfileOptions();
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

// ---------- Clave de Google Books ----------
// Google Books solo funciona con una clave de API propia (sin clave responde 429). Se guarda solo en este navegador
// y no viaja en las copias de seguridad.
const googleMsg = (text) => { $('google-msg').textContent = text; };
$('btn-google').onclick = () => {
  $('google-key').value = googleKey();
  googleMsg(googleKey() ? 'Hay una clave guardada: la búsqueda también usa Google Books.' : '');
  $('dlg-google').showModal();
};
$('btn-google-close').onclick = () => $('dlg-google').close();
$('google-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('google-key').value.trim();
  if (!key) { googleMsg('Pega tu clave de API.'); return; }
  googleMsg('Comprobando la clave…');
  let note = '';
  try {
    await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=libro&maxResults=1&key=${encodeURIComponent(key)}`);
  } catch (err) {
    if ([400, 403].includes(err.status)) { googleMsg('Google no acepta esa clave. Comprueba que sea una clave de API y que «Books API» esté activada en su proyecto.'); return; }
    note = ' No se pudo comprobar (¿sin conexión?).'; // se guarda igualmente
  }
  try {
    localStorage.setItem(GOOGLE_KEY, key);
    googleMsg(`Clave guardada: la búsqueda también usa Google Books.${note}`);
  } catch {
    googleMsg('No se pudo guardar la clave en este navegador.');
  }
});
$('google-remove').onclick = () => {
  try { localStorage.removeItem(GOOGLE_KEY); } catch {}
  $('google-key').value = '';
  googleMsg('Clave quitada: la búsqueda vuelve a usar solo Open Library y Apple Books.');
};

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

// Las estadísticas cuentan las entradas del perfil activo (todas si no hay perfil): si dos lectores leen el mismo libro son dos lecturas
function renderStats() {
  const group = $('stats-group').value;
  const readings = scoped();
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
    stat(read.length, profile || !readers.length ? 'libros leídos' : 'lecturas terminadas'),
    stat(avg(rated.map((r) => r.rating)), 'puntuación media'),
    stat(readings.filter(inProgress).length, 'en curso'),
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
  $('stats-scope').hidden = !profile;
  $('stats-scope').textContent = profile ? `Biblioteca de ${profile}.` : '';
  renderStats();
  $('dlg-stats').showModal();
};
$('btn-stats-close').onclick = () => $('dlg-stats').close();
$('stats-group').addEventListener('input', renderStats);

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
['f-text', 'f-sort', 'f-status', 'f-origin', 'f-start-from', 'f-start-to', 'f-end-from', 'f-end-to'].forEach((id) => $(id).addEventListener('input', render));
$('btn-filters').onclick = () => {
  const open = $('filters-panel').hidden;
  $('filters-panel').hidden = !open;
  $('btn-filters').setAttribute('aria-expanded', String(open));
};
$('btn-clear').onclick = () => {
  ['f-text', 'f-status', 'f-origin', 'f-start-from', 'f-start-to', 'f-end-from', 'f-end-to'].forEach((id) => ($(id).value = ''));
  render();
};
$('btn-new').onclick = () => openDialog(null);

$('btn-export').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ formato: 3, readers, books }, null, 2)], { type: 'application/json' }));
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
    // Formato actual: { formato: 3, readers, books } con un libro por lector. Las copias anteriores (formato 2 con lecturas,
    // o solo la lista de libros con las fechas en el propio libro) se convierten y conservan tus lectores.
    const fileBooks = Array.isArray(data) ? data : Array.isArray(data?.books) ? data.books : null;
    if (!fileBooks) throw new Error();
    const fileReaders = !Array.isArray(data) && Array.isArray(data.readers) ? data.readers : null;
    const valid = fileBooks.filter((b) => b && typeof b.title === 'string' && b.title.trim());
    if (!valid.length) { alert('El archivo no contiene ningún libro con título. Elige una copia descargada con «Exportar copia».'); return; }
    const skipped = fileBooks.length - valid.length;
    const note = skipped ? ` (se ignoran ${skipped} sin título)` : '';
    const readersNote = fileReaders ? ' y tu lista de lectores por la suya' : '';
    // ids nuevos: un archivo con ids repetidos haría que editar uno afectara a otro
    const imported = valid.flatMap(migrateEntry).map((b) => ({ ...b, id: crypto.randomUUID() }));
    if (!confirm(`Vas a reemplazar tus ${books.length} libros por los ${imported.length} del archivo${readersNote}${note}. ¿Continuar?`)) return;
    books = imported;
    if (fileReaders) {
      readers = [];
      for (const r of fileReaders) {
        const n = typeof r === 'string' ? normName(r) : '';
        if (n && !readers.some((x) => sameName(x, n))) readers.push(n);
      }
    }
    syncReaders();
    saveReaders(); save(); refreshProfileOptions(); render();
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

refreshProfileOptions();
render();
