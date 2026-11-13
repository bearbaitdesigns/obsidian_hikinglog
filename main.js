'use strict';

/*
 * Hiking Log — an Obsidian plugin
 * - Each hike is a Markdown note (diary) with stats stored in frontmatter.
 * - "Log a hike" form: title, date, location, type, rating, stats, photos, diary, notes.
 * - `hike-card` code block renders a stat card at the top of each hike note.
 * - Dashboard view: totals, monthly chart, types, ratings, locations, records, recent hikes, sortable log.
 */

const {
  Plugin,
  ItemView,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  setIcon,
  MarkdownRenderChild,
  addIcon,
} = require('obsidian');

const VIEW_TYPE = 'hiking-dashboard';

const DEFAULT_SETTINGS = {
  hikeFolder: 'Hikes',
  units: 'metric', // 'metric' | 'imperial'
  bodyWeight: 75, // kg or lb depending on units
  autoCalories: true,
  openAfterCreate: true,
  hikeTypes: ['Day hike', 'Backpacking', 'Summit', 'Trail run', 'Walk', 'Snowshoe', 'Via ferrata'],
};

// Rough MET values used for calorie estimates
const BASE_MET = {
  'day hike': 6.0,
  backpacking: 7.0,
  summit: 7.5,
  'trail run': 9.0,
  walk: 3.8,
  snowshoe: 8.0,
  'via ferrata': 7.0,
};

const ROUTE_TYPES = ['Loop', 'Out and back', 'Point to point'];

/* Trail observations (wildflowers, wildlife…), stored in frontmatter as "Type: name" strings */
/* Lucide has no frog, so the plugin ships its own in the same line style (24-unit art scaled to Obsidian's 100-unit icon box) */
const FROG_ICON =
  '<g transform="scale(4.1667)" fill="none" stroke="currentColor" style="stroke-width: var(--icon-stroke, 2px)" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="8" cy="6.5" r="2.5"/><circle cx="16" cy="6.5" r="2.5"/><path d="M5.8 8.2C3.6 9.9 2.6 12.6 3.2 15.2c.5 2.1 2.3 3.6 4.4 3.6h8.8c2.1 0 3.9-1.5 4.4-3.6.6-2.6-.4-5.3-2.6-7"/><path d="M9 11.6c1.9 1.1 4.1 1.1 6 0"/><path d="M7.6 18.8 6 21.5M16.4 18.8l1.6 2.7M4.5 21.5h3M16.5 21.5h3"/><path d="M8 6.5h.01M16 6.5h.01"/>' +
  '</g>';

const OBS_TYPES = [
  { name: 'Wildflower', icon: 'flower-2', color: 'bloom', aliases: ['flower', 'flowers', 'wildflowers', 'bloom'] },
  { name: 'Bird', icon: 'bird', color: 'sky', aliases: ['birds'] },
  { name: 'Animal', icon: 'paw-print', color: 'clay', aliases: ['animals', 'wildlife', 'mammal', 'mammals', 'reptile', 'reptiles'] },
  { name: 'Amphibian', icon: 'hk-frog', color: 'pond', aliases: ['amphibians', 'frog', 'frogs', 'toad', 'toads', 'salamander', 'newt'] },
  { name: 'Insect', icon: 'bug', color: 'moss', aliases: ['insects', 'bug', 'bugs', 'butterfly', 'butterflies'] },
  { name: 'Plant', icon: 'trees', color: 'forest', aliases: ['plants', 'tree', 'trees', 'fungi', 'fungus', 'mushroom', 'mushrooms', 'moss'] },
  { name: 'Other', icon: 'eye', color: 'stone', aliases: [] },
];

function obsType(name) {
  const s = String(name || '').trim().toLowerCase();
  return OBS_TYPES.find((t) => t.name.toLowerCase() === s || t.aliases.includes(s)) || null;
}

/** "Bird: Bald eagle" -> { type, name }; anything without a known type becomes Other. */
function parseObservation(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^([^:]{1,20}):\s*(.+)$/);
  const t = m ? obsType(m[1]) : null;
  if (t) return { type: t, name: m[2].trim() };
  return { type: OBS_TYPES[OBS_TYPES.length - 1], name: s };
}

function formatObservation(o) {
  return `${o.type.name}: ${o.name}`;
}

/** "50% 30%" style focal point for cover photos */
function parseCoverPosition(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%$/);
  if (!m) return null;
  const x = Math.min(100, Math.max(0, parseFloat(m[1])));
  const y = Math.min(100, Math.max(0, parseFloat(m[2])));
  return { x, y, css: `${x}% ${y}%` };
}
const DIFFICULTIES = [
  { name: 'Easy', color: 'forest' },
  { name: 'Moderate', color: 'sky' },
  { name: 'Difficult', color: 'clay' },
  { name: 'Extreme', color: 'ember' },
];

/** Matches free-typed frontmatter ("out & back", "hard") to the canonical names. */
function normalizeRoute(v) {
  const s = String(v || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  if (s.startsWith('loop') || s === 'circuit' || s === 'lollipop') return 'Loop';
  if (s.startsWith('outand') || s === 'outback' || s === 'oab') return 'Out and back';
  if (s.startsWith('point') || s === 'p2p' || s === 'ptp' || s === 'oneway' || s === 'shuttle') return 'Point to point';
  return String(v).trim();
}

function normalizeDifficulty(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  const alias = { easy: 'Easy', moderate: 'Moderate', medium: 'Moderate', difficult: 'Difficult', hard: 'Difficult', strenuous: 'Difficult', extreme: 'Extreme', 'very hard': 'Extreme' };
  return alias[s] || '';
}

function difficultyInfo(name) {
  const i = DIFFICULTIES.findIndex((d) => d.name === name);
  return i === -1 ? null : { ...DIFFICULTIES[i], level: i + 1 };
}

/** A colored pill with 1–4 filled bars, e.g. ▮▮▯▯ Moderate. */
function difficultyBadge(parent, name, extraCls = '') {
  const d = difficultyInfo(name);
  if (!d) return null;
  const b = parent.createSpan({ cls: `hk-diff hk-c-${d.color} ${extraCls}`.trim(), attr: { title: `Difficulty: ${d.name}` } });
  const bars = b.createSpan('hk-diff-bars');
  for (let i = 1; i <= DIFFICULTIES.length; i++) bars.createSpan({ cls: i <= d.level ? 'is-on' : '' });
  b.createSpan({ text: d.name });
  return b;
}

const IMAGE_EXT = /^(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/i;
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, '0');
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return isFinite(n) ? n : null;
}

/** Accepts "3:45", "3h 45m", "3h", "45m", "3.5h" or plain minutes. Returns minutes. */
function parseDuration(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  const colon = s.match(/^(\d+):(\d{1,2})(?::\d{1,2})?$/);
  if (colon) return +colon[1] * 60 + +colon[2];
  const h = s.match(/(\d+(?:[.,]\d+)?)\s*h/);
  const m = s.match(/(\d+)\s*m/);
  if (h || m) return Math.round((h ? parseFloat(h[1].replace(',', '.')) * 60 : 0) + (m ? +m[1] : 0));
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function formatDuration(min) {
  if (min === null || min === undefined || !isFinite(min)) return '—';
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${pad(m)}m`;
}

function durationToField(min) {
  if (min === null || min === undefined) return '';
  const total = Math.round(min);
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sanitizeFileName(s) {
  return (
    String(s)
      .replace(/[\\/:*?"<>|#^[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'Hike'
  );
}

function stars(r) {
  const n = Math.max(0, Math.min(5, Math.round(r || 0)));
  return '★'.repeat(n); // filled stars only — no empty ones
}

function unitLabels(units) {
  return units === 'imperial'
    ? { dist: 'mi', elev: 'ft', weight: 'lb', pace: '/mi' }
    : { dist: 'km', elev: 'm', weight: 'kg', pace: '/km' };
}

function parseTags(fm) {
  let t = fm.tags ?? fm.tag ?? [];
  if (typeof t === 'string') t = t.split(/[,\s]+/);
  if (!Array.isArray(t)) t = [t];
  return t.filter(Boolean).map((x) => String(x).replace(/^#/, '').toLowerCase());
}

/** "[[path|alias]]", "![[path]]" or "path" -> "path" */
function linkPath(v) {
  if (!v) return null;
  let s = String(Array.isArray(v) ? v[0] : v).trim();
  const m = s.match(/\[\[([^\]|#]+)/);
  if (m) s = m[1];
  return s.trim() || null;
}

function estimateCalories({ distance, duration, elevation, type }, settings) {
  const imperial = settings.units === 'imperial';
  const km = distance != null ? (imperial ? distance * 1.609344 : distance) : null;
  const meters = elevation != null ? (imperial ? elevation * 0.3048 : elevation) : 0;
  let hours = duration != null ? duration / 60 : null;
  // Naismith's rule when no time is logged: 5 km/h + 1 h per 600 m of ascent
  if (hours == null && km != null) hours = km / 5 + meters / 600;
  if (!hours || !settings.bodyWeight) return null;
  const kg = imperial ? settings.bodyWeight * 0.453592 : settings.bodyWeight;
  const met = BASE_MET[String(type || '').toLowerCase()] ?? 6.0;
  return Math.round(met * kg * hours + kg * meters * 0.0047);
}

/* ------------------------------------------------------------------ */
/* Procedural topographic map (non-repeating contour lines)           */
/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeValueNoise(rand) {
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint16Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) vals[i] = rand();
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const v = (x, y) => vals[perm[perm[x & 255] + (y & 255)]];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const u = fade(x - xi);
    const w = fade(y - yi);
    const a = v(xi, yi);
    const b = v(xi + 1, yi);
    const c = v(xi, yi + 1);
    const d = v(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
}

// Marching-squares edge pairs. Corner bits: tl=8, tr=4, br=2, bl=1. Edges: 0 top, 1 right, 2 bottom, 3 left.
const MS_TABLE = [[], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], [[0, 1], [3, 2]], [[0, 2]], [[3, 0]], [[3, 0]], [[0, 2]], [[3, 0], [2, 1]], [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], []];

function smoothPath(pts, closed) {
  const n = pts.length;
  const r = (v) => Math.round(v * 10) / 10;
  const P = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${r(pts[0][0])} ${r(pts[0][1])}`;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    d += `C${r(p1[0] + (p2[0] - p0[0]) / 6)} ${r(p1[1] + (p2[1] - p0[1]) / 6)} ${r(p2[0] - (p3[0] - p1[0]) / 6)} ${r(p2[1] - (p3[1] - p1[1]) / 6)} ${r(p2[0])} ${r(p2[1])}`;
  }
  return closed ? d + 'Z' : d;
}

function contourPaths(g, cols, rows, cell, L) {
  const pts = new Map();
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  };
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const tl = g[j * cols + i];
      const tr = g[j * cols + i + 1];
      const br = g[(j + 1) * cols + i + 1];
      const bl = g[(j + 1) * cols + i];
      const idx = (tl > L ? 8 : 0) | (tr > L ? 4 : 0) | (br > L ? 2 : 0) | (bl > L ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const edge = (e) => {
        let key, x, y, t;
        if (e === 0) {
          key = (j * cols + i) * 2;
          t = (L - tl) / (tr - tl);
          x = (i + t) * cell;
          y = j * cell;
        } else if (e === 1) {
          key = (j * cols + i + 1) * 2 + 1;
          t = (L - tr) / (br - tr);
          x = (i + 1) * cell;
          y = (j + t) * cell;
        } else if (e === 2) {
          key = ((j + 1) * cols + i) * 2;
          t = (L - bl) / (br - bl);
          x = (i + t) * cell;
          y = (j + 1) * cell;
        } else {
          key = (j * cols + i) * 2 + 1;
          t = (L - tl) / (bl - tl);
          x = i * cell;
          y = (j + t) * cell;
        }
        if (!pts.has(key)) pts.set(key, [x, y]);
        return key;
      };
      for (const [a, b] of MS_TABLE[idx]) link(edge(a), edge(b));
    }
  }

  const used = new Set();
  const ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const out = [];
  const walk = (start) => {
    const line = [start];
    let cur = start;
    for (;;) {
      const next = adj.get(cur).find((n) => !used.has(ek(cur, n)));
      if (next === undefined) break;
      used.add(ek(cur, next));
      line.push(next);
      cur = next;
      if (cur === start) break;
    }
    return line;
  };
  const starts = [...adj.keys()].sort((a, b) => adj.get(a).length - adj.get(b).length); // open ends first
  for (const s of starts) {
    while (adj.get(s).some((n) => !used.has(ek(s, n)))) {
      const keys = walk(s);
      const closed = keys.length > 2 && keys[0] === keys[keys.length - 1];
      if (closed) keys.pop();
      // thin out points a little, then smooth
      const line = keys.filter((_, i) => i % 2 === 0 || i === keys.length - 1).map((k) => pts.get(k));
      if (line.length < 6) continue;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of line) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      if (closed && Math.max(x1 - x0, y1 - y0) < cell * 6) continue; // skip tiny specks
      out.push(smoothPath(line, closed));
    }
  }
  return out;
}

const TOPO_CACHE = new Map();

/** Builds a seeded, natural-looking contour map (domain-warped fractal noise + marching squares). */
function buildTopo(seed, W = 1600, H = 1200) {
  const cacheKey = `${seed}|${W}x${H}`;
  if (TOPO_CACHE.has(cacheKey)) return TOPO_CACHE.get(cacheKey);
  const rand = mulberry32(hashStr(seed));
  const noise = makeValueNoise(rand);
  const ox = rand() * 100;
  const oy = rand() * 100;
  const fbm = (x, y) => {
    let s = 0;
    let a = 0.5;
    let f = 1;
    for (let o = 0; o < 4; o++) {
      // rotate each octave so lattice artifacts don't line up
      const c = Math.cos(o * 0.9);
      const sn = Math.sin(o * 0.9);
      const rx = x * c - y * sn;
      const ry = x * sn + y * c;
      s += a * noise(rx * f + o * 17.3 + ox, ry * f + o * 9.1 + oy);
      f *= 2.07;
      a *= 0.45;
    }
    return s;
  };
  const cell = 14;
  const cols = Math.floor(W / cell) + 2;
  const rows = Math.floor(H / cell) + 2;
  const scale = 2.6 / W;
  const g = new Float32Array(cols * rows);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const nx = i * cell * scale;
      const ny = j * cell * scale;
      const qx = fbm(nx + 1.7, ny + 9.2);
      const qy = fbm(nx + 8.3, ny + 2.8);
      const v = fbm(nx + 1.7 * qx, ny + 1.7 * qy);
      g[j * cols + i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  // two light box-blur passes for softer, more natural slopes
  for (let pass = 0; pass < 2; pass++) {
    const src2 = g.slice();
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        let sum = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += src2[(j + dj) * cols + i + di];
        g[j * cols + i] = sum / 9;
      }
    }
  }
  min = Infinity;
  max = -Infinity;
  for (const v of g) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const levels = 20;
  const minor = [];
  const major = [];
  for (let k = 1; k < levels; k++) {
    const L = min + ((max - min) * k) / levels;
    const target = k % 5 === 0 ? major : minor;
    for (const d of contourPaths(g, cols, rows, cell, L)) target.push(d);
  }
  const res = { W, H, minor: minor.join(''), major: major.join('') };
  TOPO_CACHE.set(cacheKey, res);
  return res;
}

/** Adds an absolutely-positioned contour-map layer as the first child of `host`. */
function createTopoLayer(host, seed) {
  const t = buildTopo(seed);
  const layer = host.ownerDocument.createElement('div');
  layer.className = 'hk-topo-layer';
  layer.dataset.seed = seed;
  const svg = svgEl('svg', { viewBox: `0 0 ${t.W} ${t.H}`, preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true' }, layer);
  svgEl('path', { d: t.minor, class: 'hk-topo-minor' }, svg);
  svgEl('path', { d: t.major, class: 'hk-topo-major' }, svg);
  host.prepend(layer);
  return layer;
}

function svgEl(tag, attrs, parent) {
  const e = (parent?.ownerDocument || document).createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

function sumOf(items, key) {
  return items.reduce((a, h) => a + (h[key] || 0), 0);
}

function avgOf(items, key) {
  const vals = items.filter((h) => h[key] != null);
  return vals.length ? sumOf(vals, key) / vals.length : null;
}

/* ------------------------------------------------------------------ */
/* Plugin                                                             */
/* ------------------------------------------------------------------ */

class HikingLogPlugin extends Plugin {
  async onload() {
    if (typeof addIcon === 'function') addIcon('hk-frog', FROG_ICON);
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new HikingDashboardView(leaf, this));

    this.addRibbonIcon('mountain', 'Hiking dashboard', () => this.activateView());

    this.addCommand({
      id: 'open-dashboard',
      name: 'Open hiking dashboard',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'new-hike',
      name: 'Log a new hike',
      callback: () => this.openNewHike(),
    });

    this.addCommand({
      id: 'edit-hike',
      name: 'Edit stats / add photos to current hike',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const ok = f && this.isHike(f);
        if (checking) return !!ok;
        if (ok) this.openEditHike(f);
      },
    });

    this.addCommand({
      id: 'toggle-favorite',
      name: 'Toggle favorite on current hike',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const ok = f && this.isHike(f);
        if (checking) return !!ok;
        if (ok) this.toggleFavorite(f);
      },
    });

    this.addCommand({
      id: 'change-cover',
      name: 'Change cover photo of current hike',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const ok = f && this.isHike(f);
        if (checking) return !!ok;
        if (ok) new CoverPickerModal(this, f).open();
      },
    });

    this.addCommand({
      id: 'move-hike-to-folder',
      name: 'Move current hike into its own folder (with its photos)',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const ok = f && this.isHike(f);
        if (checking) return !!ok;
        if (!ok) return;
        if (this.hikeFolderOf(f)) return new Notice('This hike already has its own folder.');
        this.migrateToFolder(f)
          .then((file) => new Notice(`Moved to ${file.parent.path}`))
          .catch((e) => new Notice(`Could not move hike: ${e.message}`));
      },
    });

    this.registerMarkdownCodeBlockProcessor('hike-card', (_src, el, ctx) => {
      ctx.addChild(new HikeCard(el, this, ctx.sourcePath));
    });

    this.registerMarkdownCodeBlockProcessor('hike-gallery', (src, el, ctx) => {
      ctx.addChild(new HikeGallery(el, this, src, ctx.sourcePath));
    });

    this.addCommand({
      id: 'remove-diary-headings',
      name: 'Remove the "Diary" heading from all hike notes',
      callback: () => this.removeDiaryHeadings(true),
    });

    // Keep gallery lists and photo order in sync when a photo is renamed or moved
    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (!(file instanceof TFile) || !IMAGE_EXT.test(file.extension)) return;
        const oldName = oldPath.split('/').pop();
        for (const f of this.app.vault.getMarkdownFiles()) {
          if (!this.isHike(f)) continue;
          const text = await this.app.vault.cachedRead(f);
          if (text.includes('hike-gallery') && text.includes(oldPath)) {
            await this.app.vault.process(f, (c) => c.split(oldPath).join(file.path));
          }
          const order = this.app.metadataCache.getFileCache(f)?.frontmatter?.photo_order;
          if (Array.isArray(order) && (order.includes(oldName) || order.includes(oldPath))) {
            const key = this.photoKey(f, file);
            await this.app.fileManager.processFrontMatter(f, (fm) => {
              fm.photo_order = (fm.photo_order || []).map((k) => (k === oldName || k === oldPath ? key : k));
            });
          }
        }
      })
    );

    // Hike notes no longer use a "Diary" heading — tidy any older notes once the vault is ready
    this.app.workspace.onLayoutReady(() => this.removeDiaryHeadings(false));



    this.addSettingTab(new HikingSettingTab(this.app, this));
  }

  onunload() {
    // clean up the whole-note backdrop used by an earlier version
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const el = leaf.view?.contentEl;
      if (!el) continue;
      el.removeClass('hk-note-topo', 'hk-theme', 'hk-glass');
      el.querySelector(':scope > .hk-topo-layer')?.remove();
    }
  }

  /** Removes the "Diary" heading that older versions put under the hike card. */
  async removeDiaryHeadings(announce) {
    let n = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!this.isHike(f)) continue;
      const headings = this.app.metadataCache.getFileCache(f)?.headings || [];
      if (!headings.some((h) => h.heading.trim().toLowerCase() === 'diary')) continue;
      await this.app.vault.process(f, (c) => {
        const next = c.replace(/^#{1,6}[ \t]+Diary[ \t]*\r?\n(?:[ \t]*\r?\n)?/im, '');
        if (next !== c) n++;
        return next;
      });
    }
    if (announce || n) new Notice(`Removed the Diary heading from ${n} hike note${n === 1 ? '' : 's'}`);
  }


  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshViews();
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof HikingDashboardView) leaf.view.render();
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  openNewHike() {
    new HikeModal(this, { mode: 'create' }).open();
  }

  openEditHike(file) {
    new HikeModal(this, { mode: 'edit', file, hike: this.toHike(file) }).open();
  }

  openFile(file) {
    this.app.workspace.getLeaf('tab').openFile(file);
  }

  /* ---------- reading hikes ---------- */

  isHike(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') return false;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return false;
    if (parseTags(fm).includes('hike')) return true;
    const folder = normalizePath(this.settings.hikeFolder);
    return file.path.startsWith(folder + '/') && !!fm.date;
  }

  getHikes() {
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.isHike(f))
      .map((f) => this.toHike(f));
  }

  toHike(file) {
    const cache = this.app.metadataCache.getFileCache(file) || {};
    const fm = cache.frontmatter || {};
    const date = parseDate(fm.date);
    const hike = {
      file,
      title: fm.title ? String(fm.title) : file.basename,
      date,
      dateStr: date ? isoDate(date) : '',
      location: fm.location ? String(fm.location) : '',
      type: fm.hike_type ? String(fm.hike_type) : '',
      route: normalizeRoute(fm.route_type),
      difficulty: normalizeDifficulty(fm.difficulty),
      difficultyLevel: null,
      rating: toNum(fm.rating),
      favorite: fm.favorite === true || /^(true|yes|1)$/i.test(String(fm.favorite ?? '')),
      distance: toNum(fm.distance),
      duration: parseDuration(fm.duration),
      elevation: toNum(fm.elevation),
      calories: toNum(fm.calories),
      caloriesEstimated: false,
      weather: fm.weather ? String(fm.weather) : '',
      companions: Array.isArray(fm.companions) ? fm.companions.join(', ') : fm.companions ? String(fm.companions) : '',
      observations: (Array.isArray(fm.observations) ? fm.observations : fm.observations ? [fm.observations] : [])
        .map(parseObservation)
        .filter(Boolean),
      coverPosition: parseCoverPosition(fm.cover_position),
      coverFile: null,
    };

    hike.difficultyLevel = difficultyInfo(hike.difficulty)?.level ?? null;

    if (hike.calories == null && this.settings.autoCalories) {
      const est = estimateCalories(hike, this.settings);
      if (est != null) {
        hike.calories = est;
        hike.caloriesEstimated = true;
      }
    }

    // Cover photo: frontmatter `cover` ("none" hides it), else first embedded image, else first photo in the hike's folder
    if (String(fm.cover ?? '').trim().toLowerCase() !== 'none') {
      const lp = linkPath(fm.cover);
      if (lp) {
        const t = this.resolveLink(lp, file.path);
        if (t instanceof TFile && IMAGE_EXT.test(t.extension)) hike.coverFile = t;
      }
      if (!hike.coverFile && cache.embeds) {
        for (const e of cache.embeds) {
          const t = this.resolveLink(e.link.split('#')[0], file.path);
          if (t instanceof TFile && IMAGE_EXT.test(t.extension)) {
            hike.coverFile = t;
            break;
          }
        }
      }
      if (!hike.coverFile) hike.coverFile = this.getFolderPhotos(file)[0] || null;
    }
    return hike;
  }

  resolveLink(lp, sourcePath) {
    return this.app.metadataCache.getFirstLinkpathDest(lp, sourcePath) || this.app.vault.getAbstractFileByPath(normalizePath(lp));
  }

  /* ---------- per-hike folders & photos ---------- */

  /** The hike's own folder, or null if the note shares its folder (older flat layout). */
  hikeFolderOf(file) {
    const parent = file.parent;
    if (!parent || parent.path === '/' || parent.path === '') return null;
    if (normalizePath(parent.path) === normalizePath(this.settings.hikeFolder)) return null;
    const notes = parent.children.filter((c) => c instanceof TFile && c.extension === 'md');
    return notes.length === 1 ? parent : null;
  }

  /** Images sitting directly in the hike's folder (drag-and-drop target). */
  getFolderPhotos(file) {
    const folder = this.hikeFolderOf(file);
    if (!folder) return [];
    return folder.children
      .filter((c) => c instanceof TFile && IMAGE_EXT.test(c.extension))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  /** Folder photos + any images explicitly listed in a hike-gallery block, cover first. */
  collectPhotos(file, listedLines = []) {
    const seen = new Set();
    const out = [];
    const add = (f) => {
      if (f instanceof TFile && IMAGE_EXT.test(f.extension) && !seen.has(f.path)) {
        seen.add(f.path);
        out.push(f);
      }
    };
    this.getFolderPhotos(file).forEach(add);
    for (const raw of listedLines) {
      const p = linkPath(raw.trim().replace(/^[-*]\s+/, '').replace(/^!/, ''));
      if (p) add(this.resolveLink(p, file.path));
    }
    // Apply the saved order (photo_order in frontmatter); anything new goes at the end
    const order = this.app.metadataCache.getFileCache(file)?.frontmatter?.photo_order;
    const pos = new Map((Array.isArray(order) ? order : []).map((k, i) => [String(k), i]));
    return out
      .map((f, i) => ({ f, i, p: pos.get(this.photoKey(file, f)) }))
      .sort((a, b) => {
        if (a.p != null && b.p != null) return a.p - b.p;
        if (a.p != null) return -1;
        if (b.p != null) return 1;
        return a.i - b.i;
      })
      .map((x) => x.f);
  }

  /** How a photo is referred to in photo_order: just its name when it sits in the hike's folder. */
  photoKey(file, img) {
    const folder = this.hikeFolderOf(file);
    return folder && img.parent && img.parent.path === folder.path ? img.name : img.path;
  }

  async setPhotoOrder(file, photos) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.photo_order = photos.map((p) => this.photoKey(file, p));
    });
  }

  /** Deletes a photo: files in the hike's folder go to the trash; photos stored elsewhere are only removed from the gallery. */
  async deletePhoto(file, img) {
    const key = this.photoKey(file, img);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (Array.isArray(fm.photo_order)) fm.photo_order = fm.photo_order.filter((k) => k !== key);
      const lp = linkPath(fm.cover);
      const t = lp ? this.resolveLink(lp, file.path) : null;
      if (t && t.path === img.path) delete fm.cover;
    });
    const folder = this.hikeFolderOf(file);
    if (folder && img.parent && img.parent.path === folder.path) {
      if (this.app.fileManager.trashFile) await this.app.fileManager.trashFile(img);
      else await this.app.vault.trash(img, true);
      return;
    }
    await this.app.vault.process(file, (c) =>
      c.replace(/(```hike-gallery[^\n]*\n)([\s\S]*?)(```)/g, (_m, open, body, close) => {
        const kept = body.split('\n').filter((l) => {
          const p = linkPath(l.trim().replace(/^[-*]\s+/, '').replace(/^!/, ''));
          const t = p ? this.resolveLink(p, file.path) : null;
          return !(t && t.path === img.path);
        });
        return open + kept.join('\n') + close;
      })
    );
  }

  async collectPhotosFromNote(file) {
    const text = await this.app.vault.cachedRead(file);
    const lines = [];
    for (const m of text.matchAll(/```hike-gallery[^\n]*\n([\s\S]*?)```/g)) lines.push(...m[1].split('\n'));
    return this.collectPhotos(file, lines);
  }

  async toggleFavorite(file) {
    let now = false;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const was = fm.favorite === true || /^(true|yes|1)$/i.test(String(fm.favorite ?? ''));
      now = !was;
      if (now) fm.favorite = true;
      else delete fm.favorite;
    });
    new Notice(now ? 'Added to favorites ♥' : 'Removed from favorites');
    return now;
  }

  async setCoverPosition(file, pos) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (pos) fm.cover_position = `${Math.round(pos.x)}% ${Math.round(pos.y)}%`;
      else delete fm.cover_position;
    });
  }

  async addObservation(file, obs) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const list = Array.isArray(fm.observations) ? fm.observations : fm.observations ? [fm.observations] : [];
      list.push(formatObservation(obs));
      fm.observations = list;
    });
  }

  async removeObservation(file, index) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const list = Array.isArray(fm.observations) ? fm.observations : fm.observations ? [fm.observations] : [];
      list.splice(index, 1);
      if (list.length) fm.observations = list;
      else delete fm.observations;
    });
  }

  async setCover(file, img) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      delete fm.cover_position; // a new photo starts centred
      fm.cover = img ? `[[${img.path}]]` : 'none';
    });
  }

  uniqueFolder(path) {
    let p = normalizePath(path);
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(p)) p = normalizePath(`${path} (${i++})`);
    return p;
  }

  /** Moves an older flat-layout hike (and the photos it references) into its own subfolder. */
  async migrateToFolder(file) {
    if (this.hikeFolderOf(file)) return file;
    const parentPath = file.parent && file.parent.path !== '/' ? file.parent.path : '';
    const folder = this.uniqueFolder(parentPath ? `${parentPath}/${file.basename}` : file.basename);
    await this.ensureFolder(folder);

    const content = await this.app.vault.read(file);
    const { found } = this.parsePhotosSection(content);
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const images = new Set();
    for (const p of [...found, linkPath(fm.cover)].filter(Boolean)) {
      const t = this.resolveLink(p, file.path);
      if (t instanceof TFile && IMAGE_EXT.test(t.extension)) images.add(t);
    }

    await this.app.fileManager.renameFile(file, normalizePath(`${folder}/${file.name}`));
    for (const img of images) {
      const dot = img.name.lastIndexOf('.');
      await this.app.fileManager.renameFile(img, this.uniquePath(folder, img.name.slice(0, dot), img.extension));
    }
    // Photos now live in the folder, so the gallery picks them up automatically
    await this.app.vault.process(file, (c) => this.movePhotosToGallery(c, true));
    return file;
  }

  /** Saves dropped/picked photos into the hike's folder (moving the hike first if needed). */
  async addPhotos(file, photos) {
    if (!photos || !photos.length) return { file, paths: [] };
    if (!this.hikeFolderOf(file)) {
      file = await this.migrateToFolder(file);
      new Notice(`Moved this hike into its own folder: ${file.parent.path}`);
    }
    const paths = await this.savePhotos(photos, file.parent.path);
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    if (!fm.cover && paths.length) {
      const img = this.app.vault.getAbstractFileByPath(paths[0]);
      if (img instanceof TFile) await this.setCover(file, img);
    }
    return { file, paths };
  }

  coverUrl(hike) {
    return hike.coverFile ? this.app.vault.getResourcePath(hike.coverFile) : null;
  }

  /* ---------- writing hikes ---------- */

  async ensureFolder(path) {
    const parts = normalizePath(path).split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          /* already exists */
        }
      }
    }
  }

  uniquePath(folder, base, ext) {
    const dir = normalizePath(folder);
    let path = normalizePath(`${dir}/${base}.${ext}`);
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${dir}/${base} (${i}).${ext}`);
      i++;
    }
    return path;
  }

  /** Writes picked/dropped photo files into `folder`, keeping their original names. */
  async savePhotos(files, folder) {
    if (!files || !files.length) return [];
    await this.ensureFolder(folder);
    const paths = [];
    for (const f of files) {
      const dot = f.name.lastIndexOf('.');
      const ext = (dot > 0 ? f.name.slice(dot + 1) : 'jpg').toLowerCase();
      const base = sanitizeFileName(dot > 0 ? f.name.slice(0, dot) : f.name);
      const path = this.uniquePath(folder, base, ext);
      await this.app.vault.createBinary(path, await f.arrayBuffer());
      paths.push(path);
    }
    return paths;
  }

  galleryBlock(paths = []) {
    return ['```hike-gallery', ...paths, '```'].join('\n');
  }

  buildBody(v) {
    return [
      '```hike-card',
      '```',
      '',
      v.diary?.trim() || '',
      '',
      '## Notes',
      v.notes?.trim() || '',
      '',
      '## Photos',
      this.galleryBlock(),
      '',
    ].join('\n');
  }

  /** Splits out the "## Photos" section: image links found in it, other text in it, and the rest of the note. */
  parsePhotosSection(content) {
    const lines = content.split('\n');
    const found = [];
    const leftovers = [];
    const isImg = (p) => IMAGE_EXT.test(p.split('.').pop() || '');
    let rest = lines;

    const idx = lines.findIndex((l) => /^##\s+photos\s*$/i.test(l));
    if (idx !== -1) {
      let end = lines.length;
      let inFence = false;
      for (let i = idx + 1; i < lines.length; i++) {
        if (/^```/.test(lines[i].trim())) inFence = !inFence;
        if (!inFence && /^#{1,2}\s/.test(lines[i])) {
          end = i;
          break;
        }
      }
      let inGallery = false;
      for (const raw of lines.slice(idx + 1, end)) {
        const l = raw.trim();
        if (/^```hike-gallery/.test(l)) {
          inGallery = true;
          continue;
        }
        if (inGallery) {
          if (/^```/.test(l)) inGallery = false;
          else {
            const p = linkPath(l.replace(/^[-*]\s+/, '').replace(/^!/, ''));
            if (p) found.push(p);
          }
          continue;
        }
        let remaining = raw;
        remaining = remaining.replace(/!\[\[([^\]|#]+)[^\]]*\]\]/g, (m, p) => {
          if (!isImg(p.trim())) return m;
          found.push(p.trim());
          return '';
        });
        remaining = remaining.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (m, p) => {
          if (/^https?:/i.test(p) || !isImg(p.trim())) return m;
          found.push(decodeURI(p.trim()));
          return '';
        });
        if (remaining.trim()) leftovers.push(remaining);
      }
      rest = [...lines.slice(0, idx), ...lines.slice(end)];
    }
    return { rest, found: [...new Set(found)], leftovers };
  }

  /**
   * Rewrites the "## Photos" section as a gallery block at the very end of the note.
   * With dropFound, image links are removed (their files now live in the hike's folder).
   */
  movePhotosToGallery(content, dropFound = false) {
    const { rest, found, leftovers } = this.parsePhotosSection(content);
    while (rest.length && rest[rest.length - 1].trim() === '') rest.pop();
    const section = ['', '## Photos'];
    if (leftovers.length) section.push(...leftovers, '');
    section.push(this.galleryBlock(dropFound ? [] : found), '');
    return [...rest, ...section].join('\n');
  }

  writeFrontmatter(fm, v, photoPaths, isNew) {
    if (isNew) {
      fm.tags = ['hike'];
    } else if (!parseTags(fm).includes('hike')) {
      const existing = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
      fm.tags = [...existing, 'hike'];
    }
    fm.title = v.title;
    fm.date = v.date;
    fm.location = v.location || '';
    fm.hike_type = v.type || '';
    fm.route_type = v.route || '';
    fm.difficulty = v.difficulty || '';
    fm.rating = v.rating || null;
    if (v.favorite) fm.favorite = true;
    else delete fm.favorite;
    fm.distance = v.distance;
    fm.duration = v.duration != null ? durationToField(v.duration) : null;
    fm.elevation = v.elevation;
    fm.calories = v.calories != null ? Math.round(v.calories) : null;
    fm.weather = v.weather || '';
    fm.companions = v.companions || '';
    if (v.observations && v.observations.length) fm.observations = v.observations.map(formatObservation);
    else delete fm.observations;
    if (photoPaths.length && !fm.cover) fm.cover = `[[${photoPaths[0]}]]`;
  }

  async createHike(values, photos) {
    await this.ensureFolder(this.settings.hikeFolder);
    const base = sanitizeFileName(`${values.date} ${values.title}`);
    const folder = this.uniqueFolder(`${this.settings.hikeFolder}/${base}`);
    await this.ensureFolder(folder);
    const photoPaths = await this.savePhotos(photos, folder);
    const file = await this.app.vault.create(normalizePath(`${folder}/${base}.md`), this.buildBody(values));
    await this.app.fileManager.processFrontMatter(file, (fm) => this.writeFrontmatter(fm, values, photoPaths, true));
    return file;
  }

  async updateHike(file, values, photos) {
    const res = await this.addPhotos(file, photos);
    await this.app.fileManager.processFrontMatter(res.file, (fm) => this.writeFrontmatter(fm, values, [], false));
    return res.file;
  }

}

/* ------------------------------------------------------------------ */
/* Log / edit modal                                                   */
/* ------------------------------------------------------------------ */

class HikeModal extends Modal {
  constructor(plugin, opts) {
    super(plugin.app);
    this.plugin = plugin;
    this.mode = opts.mode;
    this.file = opts.file || null;
    const h = opts.hike;
    const s = plugin.settings;
    this.raw = {
      title: h?.title || '',
      date: h?.dateStr || isoDate(new Date()),
      location: h?.location || '',
      type: h?.type || s.hikeTypes[0] || '',
      route: h?.route || '',
      difficulty: h?.difficulty || '',
      distance: h?.distance != null ? String(h.distance) : '',
      duration: h?.duration != null ? durationToField(h.duration) : '',
      elevation: h?.elevation != null ? String(h.elevation) : '',
      calories: h && !h.caloriesEstimated && h.calories != null ? String(h.calories) : '',
      weather: h?.weather || '',
      companions: h?.companions || '',
      diary: '',
      notes: '',
    };
    this.rating = h?.rating ? Math.round(h.rating) : 0;
    this.favorite = !!h?.favorite;
    this.observations = (h?.observations || []).map((o) => ({ type: o.type, name: o.name }));
    this.photos = [];
    this.urls = [];
  }

  onOpen() {
    const { contentEl } = this;
    const s = this.plugin.settings;
    const U = unitLabels(s.units);
    this.modalEl.addClass('hk-modal');
    this.titleEl.setText(this.mode === 'edit' ? 'Edit hike' : 'Log a hike');

    new Setting(contentEl).setName('Name').addText((t) =>
      t
        .setPlaceholder('e.g. Ridge loop to Eagle Peak')
        .setValue(this.raw.title)
        .onChange((v) => (this.raw.title = v))
    );

    new Setting(contentEl).setName('Date').addText((t) => {
      t.inputEl.type = 'date';
      t.setValue(this.raw.date).onChange((v) => (this.raw.date = v));
    });

    new Setting(contentEl).setName('Location').addText((t) =>
      t
        .setPlaceholder('Trail, park or region')
        .setValue(this.raw.location)
        .onChange((v) => (this.raw.location = v))
    );

    new Setting(contentEl).setName('Type').addDropdown((d) => {
      const types = [...s.hikeTypes];
      if (this.raw.type && !types.includes(this.raw.type)) types.push(this.raw.type);
      types.forEach((t) => d.addOption(t, t));
      d.setValue(this.raw.type).onChange((v) => (this.raw.type = v));
    });

    new Setting(contentEl).setName('Route').addDropdown((d) => {
      d.addOption('', '—');
      const routes = [...ROUTE_TYPES];
      if (this.raw.route && !routes.includes(this.raw.route)) routes.push(this.raw.route);
      routes.forEach((r) => d.addOption(r, r));
      d.setValue(this.raw.route).onChange((v) => (this.raw.route = v));
    });

    const ds = new Setting(contentEl).setName('Difficulty').setDesc('Click again to clear.');
    const seg = ds.controlEl.createDiv('hk-diff-picker');
    const paintDiff = () =>
      seg.querySelectorAll('button').forEach((b) => b.toggleClass('is-on', b.dataset.value === this.raw.difficulty));
    for (const d of DIFFICULTIES) {
      const b = seg.createEl('button', { cls: `hk-diff-option hk-c-${d.color}`, text: d.name });
      b.dataset.value = d.name;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        this.raw.difficulty = this.raw.difficulty === d.name ? '' : d.name;
        paintDiff();
      });
    }
    paintDiff();

    // Rating stars
    const rs = new Setting(contentEl).setName('Rating').setDesc('Click a star; click again to clear.');
    const starsEl = rs.controlEl.createDiv('hk-stars-input');
    const paint = (n) => starsEl.querySelectorAll('.hk-star').forEach((el, i) => el.toggleClass('is-on', i < n));
    for (let i = 1; i <= 5; i++) {
      const st = starsEl.createSpan({ cls: 'hk-star', text: '★' });
      st.addEventListener('click', () => {
        this.rating = this.rating === i ? 0 : i;
        paint(this.rating);
      });
      st.addEventListener('mouseenter', () => paint(i));
    }
    starsEl.addEventListener('mouseleave', () => paint(this.rating));
    paint(this.rating);

    // Stats grid
    contentEl.createEl('div', { cls: 'hk-modal-section', text: 'Stats' });
    const grid = contentEl.createDiv('hk-field-grid');
    const field = (label, key, placeholder, inputmode = 'decimal') => {
      const w = grid.createDiv('hk-field');
      w.createEl('label', { text: label });
      const i = w.createEl('input', { type: 'text', placeholder });
      i.setAttr('inputmode', inputmode);
      i.value = this.raw[key];
      i.addEventListener('input', () => (this.raw[key] = i.value));
      return { wrap: w, input: i };
    };
    field(`Distance (${U.dist})`, 'distance', '12.4');
    field('Moving time', 'duration', '3:45 or 3h 45m', 'text');
    field(`Elevation gain (${U.elev})`, 'elevation', s.units === 'imperial' ? '2600' : '820');
    const cal = field('Calories (kcal)', 'calories', s.autoCalories ? 'Auto-estimate' : '', 'numeric');
    const estBtn = cal.wrap.createEl('button', { cls: 'hk-mini-btn', text: 'Estimate' });
    estBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const est = estimateCalories(
        {
          distance: toNum(this.raw.distance),
          duration: parseDuration(this.raw.duration),
          elevation: toNum(this.raw.elevation),
          type: this.raw.type,
        },
        s
      );
      if (est == null) return new Notice('Add a distance or time first.');
      cal.input.value = String(est);
      this.raw.calories = String(est);
    });

    new Setting(contentEl)
      .setName('Favorite')
      .setDesc('Show this hike in the Favorites list on the dashboard.')
      .addToggle((t) => t.setValue(this.favorite).onChange((v) => (this.favorite = v)));

    new Setting(contentEl).setName('Weather').addText((t) =>
      t
        .setPlaceholder('Sunny, 14°, light wind')
        .setValue(this.raw.weather)
        .onChange((v) => (this.raw.weather = v))
    );
    new Setting(contentEl).setName('Companions').addText((t) =>
      t
        .setPlaceholder('Who came along?')
        .setValue(this.raw.companions)
        .onChange((v) => (this.raw.companions = v))
    );

    // Observations
    contentEl.createEl('div', { cls: 'hk-modal-section', text: 'Observations' });
    const obsWrap = contentEl.createDiv('hk-obs-editor');
    const renderObs = () => {
      obsWrap.empty();
      this.observations.forEach((o, i) => {
        const row = obsWrap.createDiv('hk-obs-edit-row');
        const sel = row.createEl('select', { cls: 'dropdown' });
        OBS_TYPES.forEach((t) => sel.createEl('option', { value: t.name, text: t.name }));
        sel.value = o.type.name;
        sel.addEventListener('change', () => {
          o.type = obsType(sel.value);
          renderObs();
        });
        const ic = row.createSpan(`hk-obs-edit-icon hk-c-${o.type.color}`);
        setIcon(ic, o.type.icon);
        const inp = row.createEl('input', { type: 'text', placeholder: 'What did you see?' });
        inp.value = o.name;
        inp.addEventListener('input', () => (o.name = inp.value));
        const x = row.createEl('button', { cls: 'hk-obs-edit-remove clickable-icon', attr: { 'aria-label': 'Remove observation' } });
        setIcon(x, 'x');
        x.addEventListener('click', (e) => {
          e.preventDefault();
          this.observations.splice(i, 1);
          renderObs();
        });
      });
      const add = obsWrap.createEl('button', { cls: 'hk-mini-btn hk-obs-add-btn' });
      setIcon(add.createSpan('hk-inline-icon'), 'plus');
      add.appendText('Add observation');
      add.addEventListener('click', (e) => {
        e.preventDefault();
        const last = this.observations[this.observations.length - 1];
        this.observations.push({ type: last ? last.type : OBS_TYPES[0], name: '' });
        renderObs();
        obsWrap.querySelectorAll('input')[this.observations.length - 1]?.focus();
      });
    };
    renderObs();

    // Photos
    const ps = new Setting(contentEl)
      .setName('Photos')
      .setDesc(
        this.mode === 'edit'
          ? "Saved into this hike's folder and shown in its gallery. You can also drop photos onto the gallery or into the folder."
          : "Saved into this hike's own folder. The first photo becomes the cover — you can change it later."
      );
    const fileInput = ps.controlEl.createEl('input', { type: 'file', cls: 'hk-hidden' });
    fileInput.multiple = true;
    fileInput.accept = 'image/*';
    ps.addButton((b) => b.setButtonText('Add photos').onClick(() => fileInput.click()));
    const thumbs = contentEl.createDiv('hk-thumbs');
    const renderThumbs = () => {
      thumbs.empty();
      this.urls.forEach((u) => URL.revokeObjectURL(u));
      this.urls = [];
      this.photos.forEach((f, i) => {
        const t = thumbs.createDiv('hk-thumb');
        const url = URL.createObjectURL(f);
        this.urls.push(url);
        t.createEl('img', { attr: { src: url, alt: f.name } });
        const x = t.createEl('button', { cls: 'hk-thumb-remove', text: '×', attr: { 'aria-label': 'Remove' } });
        x.addEventListener('click', () => {
          this.photos.splice(i, 1);
          renderThumbs();
        });
      });
    };
    fileInput.addEventListener('change', () => {
      for (const f of Array.from(fileInput.files || [])) this.photos.push(f);
      fileInput.value = '';
      renderThumbs();
    });

    if (this.mode === 'create') {
      const diary = contentEl.createEl('textarea', {
        cls: 'hk-textarea hk-diary-input',
        placeholder: 'How did the day go? The trail, the views, how you felt…',
        attr: { 'aria-label': 'Diary' },
      });
      diary.rows = 6;
      diary.addEventListener('input', () => (this.raw.diary = diary.value));

      contentEl.createEl('div', { cls: 'hk-modal-section', text: 'Notes' });
      const notes = contentEl.createEl('textarea', {
        cls: 'hk-textarea',
        placeholder: 'Parking, trail conditions, gear, things to remember next time…',
      });
      notes.rows = 3;
      notes.addEventListener('input', () => (this.raw.notes = notes.value));
    } else {
      contentEl.createEl('p', {
        cls: 'hk-muted',
        text: 'Diary and notes live in the note itself — edit them there.',
      });
    }

    const footer = contentEl.createDiv('hk-modal-footer');
    const cancel = footer.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    this.saveBtn = footer.createEl('button', { cls: 'mod-cta', text: this.mode === 'edit' ? 'Save changes' : 'Save hike' });
    this.saveBtn.addEventListener('click', () => this.submit());
  }

  async submit() {
    const r = this.raw;
    const title = r.title.trim();
    if (!title) return new Notice('Give your hike a name.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return new Notice('Pick a date.');
    const duration = parseDuration(r.duration);
    if (r.duration.trim() && duration == null) return new Notice('Time format not recognised — try 3:45 or 3h 45m.');

    const values = {
      title,
      date: r.date,
      location: r.location.trim(),
      type: r.type,
      route: r.route,
      difficulty: r.difficulty,
      rating: this.rating || null,
      favorite: this.favorite,
      distance: toNum(r.distance),
      duration,
      elevation: toNum(r.elevation),
      calories: toNum(r.calories),
      weather: r.weather.trim(),
      companions: r.companions.trim(),
      observations: this.observations.filter((o) => o.name.trim()).map((o) => ({ type: o.type, name: o.name.trim() })),
      diary: r.diary,
      notes: r.notes,
    };

    this.saveBtn.disabled = true;
    try {
      if (this.mode === 'create') {
        const file = await this.plugin.createHike(values, this.photos);
        new Notice(`Logged "${title}" 🥾`);
        this.close();
        if (this.plugin.settings.openAfterCreate) this.plugin.openFile(file);
      } else {
        await this.plugin.updateHike(this.file, values, this.photos);
        new Notice('Hike updated');
        this.close();
      }
    } catch (e) {
      console.error('[hiking-log]', e);
      new Notice(`Could not save hike: ${e.message}`);
      this.saveBtn.disabled = false;
    }
  }

  onClose() {
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ */
/* Hike card (rendered inside each hike note)                         */
/* ------------------------------------------------------------------ */

class HikeCard extends MarkdownRenderChild {
  constructor(el, plugin, path) {
    super(el);
    this.plugin = plugin;
    this.path = path;
  }

  onload() {
    this.render();
    this.registerEvent(
      this.plugin.app.metadataCache.on('changed', (f) => {
        if (f.path === this.path) this.render();
      })
    );
    const touch = (p) => {
      const dir = this.path.includes('/') ? this.path.slice(0, this.path.lastIndexOf('/') + 1) : '';
      if (dir && p && p.startsWith(dir)) this.render();
    };
    this.registerEvent(this.plugin.app.vault.on('create', (f) => touch(f.path)));
    this.registerEvent(this.plugin.app.vault.on('delete', (f) => touch(f.path)));
  }

  render() {
    const el = this.containerEl;
    el.empty();
    el.addClass('hk-hike-card', 'hk-theme');
    const file = this.plugin.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile)) return;
    const h = this.plugin.toHike(file);
    const U = unitLabels(this.plugin.settings.units);

    const cover = this.plugin.coverUrl(h);
    const nav = el.createDiv('hk-card-nav' + (cover ? ' is-overlay' : ''));
    const back = nav.createEl('button', { cls: 'hk-back-btn', attr: { 'aria-label': 'Back to hiking dashboard' } });
    setIcon(back.createSpan('hk-inline-icon'), 'arrow-left');
    back.appendText('Dashboard');
    back.addEventListener('click', (e) => {
      e.preventDefault();
      this.plugin.activateView();
    });
    if (cover) this.renderCover(el, file, h, cover);

    const body = el.createDiv('hk-card-body');
    createTopoLayer(body, file.path);
    const top = body.createDiv('hk-card-top');
    const left = top.createDiv('hk-card-heading');
    left.createDiv({ cls: 'hk-card-title', text: h.title });
    const meta = [];
    if (h.date) meta.push(h.date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
    if (h.location) meta.push(h.location);
    if (meta.length) left.createDiv({ cls: 'hk-card-meta', text: meta.join(' · ') });

    const right = top.createDiv('hk-card-right');
    if (h.type || h.route || h.difficulty) {
      const tags = left.createDiv('hk-card-tags');
      if (h.type) tags.createSpan({ cls: 'hk-badge', text: h.type });
      if (h.route) {
        const r = tags.createSpan({ cls: 'hk-badge hk-badge-outline' });
        setIcon(r.createSpan('hk-inline-icon'), h.route === 'Loop' ? 'refresh-cw' : h.route === 'Out and back' ? 'arrow-left-right' : 'move-right');
        r.appendText(h.route);
      }
      if (h.difficulty) difficultyBadge(tags, h.difficulty);
    }
    if (h.rating) right.createSpan({ cls: 'hk-stars', text: stars(h.rating), attr: { 'aria-label': `${h.rating} of 5` } });
    const fav = right.createEl('button', {
      cls: 'hk-icon-btn clickable-icon hk-fav-btn' + (h.favorite ? ' is-fav' : ''),
      attr: { 'aria-label': h.favorite ? 'Remove from favorites' : 'Add to favorites', 'aria-pressed': String(!!h.favorite) },
    });
    setIcon(fav, 'heart');
    fav.addEventListener('click', (e) => {
      e.preventDefault();
      this.plugin.toggleFavorite(file);
    });
    const coverBtn = right.createEl('button', { cls: 'hk-icon-btn clickable-icon', attr: { 'aria-label': 'Change cover photo' } });
    setIcon(coverBtn, 'image');
    coverBtn.addEventListener('click', (e) => {
      e.preventDefault();
      new CoverPickerModal(this.plugin, file).open();
    });
    const edit = right.createEl('button', { cls: 'hk-icon-btn clickable-icon', attr: { 'aria-label': 'Edit stats / add photos' } });
    setIcon(edit, 'pencil');
    edit.addEventListener('click', (e) => {
      e.preventDefault();
      this.plugin.openEditHike(file);
    });

    const stats = body.createDiv('hk-card-stats');
    const colors = { route: 'sky', timer: 'moss', 'trending-up': 'clay', flame: 'ember', gauge: 'forest' };
    const stat = (icon, label, value) => {
      const s = stats.createDiv(`hk-card-stat hk-c-${colors[icon] || 'forest'}`);
      const ic = s.createSpan('hk-card-stat-icon hk-chip');
      setIcon(ic, icon);
      const t = s.createDiv();
      t.createDiv({ cls: 'hk-card-stat-value', text: value });
      t.createDiv({ cls: 'hk-card-stat-label', text: label });
    };
    stat('route', 'Distance', h.distance != null ? `${fmtNum(h.distance)} ${U.dist}` : '—');
    stat('timer', 'Time', formatDuration(h.duration));
    stat('trending-up', 'Elevation', h.elevation != null ? `${fmtNum(h.elevation, 0)} ${U.elev}` : '—');
    stat('flame', h.caloriesEstimated ? 'Calories (est.)' : 'Calories', h.calories != null ? `${h.caloriesEstimated ? '~' : ''}${fmtNum(h.calories, 0)}` : '—');
    if (h.distance && h.duration) {
      const p = h.duration / h.distance;
      stat('gauge', 'Pace', `${Math.floor(p)}:${pad(Math.round((p % 1) * 60) % 60)} ${U.pace}`);
    }

    // Observations: wildflowers, wildlife, birds…
    const obs = body.createDiv('hk-card-obs');
    const chips = obs.createDiv({ cls: 'hk-obs-chips', attr: { 'aria-label': 'Observations' } });
    h.observations.forEach((o, i) => {
      const chip = chips.createSpan({ cls: `hk-obs-chip hk-c-${o.type.color}`, attr: { title: `${o.type.name}: ${o.name}` } });
      setIcon(chip.createSpan('hk-obs-icon'), o.type.icon);
      chip.createSpan({ cls: 'hk-obs-name', text: o.name });
      const x = chip.createEl('button', { cls: 'hk-obs-remove', attr: { 'aria-label': `Remove ${o.name}` } });
      setIcon(x, 'x');
      x.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.plugin.removeObservation(file, i);
      });
    });
    const add = chips.createEl('button', { cls: 'hk-obs-chip hk-obs-add' });
    setIcon(add.createSpan('hk-obs-icon'), 'plus');
    add.createSpan({ text: h.observations.length ? 'Add' : 'Add an observation' });
    add.addEventListener('click', (e) => {
      e.preventDefault();
      new ObservationModal(this.plugin, file).open();
    });

    if (h.weather || h.companions) {
      const extra = body.createDiv('hk-card-extra');
      if (h.weather) {
        const w = extra.createSpan();
        setIcon(w.createSpan('hk-inline-icon'), 'cloud-sun');
        w.appendText(h.weather);
      }
      if (h.companions) {
        const c = extra.createSpan();
        setIcon(c.createSpan('hk-inline-icon'), 'users');
        c.appendText(h.companions);
      }
    }
  }

  /** Cover photo you can drag to choose which part shows (saved as cover_position). */
  renderCover(el, file, h, url) {
    const wrap = el.createDiv('hk-card-cover');
    const img = wrap.createEl('img', { attr: { src: url, alt: h.title, draggable: 'false' } });
    let pos = h.coverPosition ? { x: h.coverPosition.x, y: h.coverPosition.y } : { x: 50, y: 50 };
    const apply = () => (img.style.objectPosition = `${pos.x}% ${pos.y}%`);
    apply();

    const btn = wrap.createEl('button', { cls: 'hk-cover-adjust', attr: { 'aria-label': 'Reposition cover photo' } });
    setIcon(btn.createSpan('hk-inline-icon'), 'move');
    btn.appendText('Reposition');

    let editing = false;
    let start = null;
    let saved = { ...pos };
    const bar = wrap.createDiv('hk-cover-bar');
    bar.createSpan({ cls: 'hk-cover-hint', text: 'Drag the photo to reposition' });
    const actions = bar.createDiv('hk-cover-actions');
    const cancel = actions.createEl('button', { cls: 'hk-cover-cancel', text: 'Cancel' });
    const reset = actions.createEl('button', { cls: 'hk-cover-cancel', text: 'Center' });
    const save = actions.createEl('button', { cls: 'hk-cover-save', text: 'Save' });

    const setEditing = (on) => {
      editing = on;
      wrap.toggleClass('is-repositioning', on);
    };
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      saved = { ...pos };
      setEditing(true);
    });
    cancel.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pos = { ...saved };
      apply();
      setEditing(false);
    });
    reset.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pos = { x: 50, y: 50 };
      apply();
    });
    save.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
      await this.plugin.setCoverPosition(file, pos.x === 50 && pos.y === 50 ? null : pos);
    });

    // How far (in px) the photo overflows the frame on each axis, given object-fit: cover
    const overflow = () => {
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;
      const nw = img.naturalWidth || cw;
      const nh = img.naturalHeight || ch;
      const scale = Math.max(cw / nw, ch / nh);
      return { x: nw * scale - cw, y: nh * scale - ch };
    };
    wrap.addEventListener('pointerdown', (e) => {
      if (!editing || e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      e.stopPropagation();
      start = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y, o: overflow() };
      wrap.setPointerCapture(e.pointerId);
      wrap.addClass('is-dragging');
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.px;
      const dy = e.clientY - start.py;
      const clamp = (v) => Math.min(100, Math.max(0, v));
      if (start.o.x > 1) pos.x = clamp(start.x - (dx / start.o.x) * 100);
      if (start.o.y > 1) pos.y = clamp(start.y - (dy / start.o.y) * 100);
      apply();
    });
    const end = (e) => {
      if (!start) return;
      start = null;
      wrap.removeClass('is-dragging');
      try {
        wrap.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* already released */
      }
    };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    // keep clicks inside the cover from reaching the editor
    wrap.addEventListener('mousedown', (e) => editing && e.stopPropagation());
    wrap.addEventListener('click', (e) => editing && e.stopPropagation());
  }
}

/* ------------------------------------------------------------------ */
/* Quick "add observation" dialog                                     */
/* ------------------------------------------------------------------ */

class ObservationModal extends Modal {
  constructor(plugin, file) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
    this.type = OBS_TYPES[0];
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass('hk-modal', 'hk-obs-modal');
    this.titleEl.setText('Add an observation');

    const types = contentEl.createDiv('hk-obs-types');
    const paint = () => types.querySelectorAll('button').forEach((b) => b.toggleClass('is-on', b.dataset.type === this.type.name));
    for (const t of OBS_TYPES) {
      const b = types.createEl('button', { cls: `hk-obs-type hk-c-${t.color}` });
      b.dataset.type = t.name;
      setIcon(b.createSpan('hk-obs-type-icon'), t.icon);
      b.createSpan({ text: t.name });
      b.addEventListener('click', (e) => {
        e.preventDefault();
        this.type = t;
        paint();
        this.input.focus();
      });
    }
    paint();

    this.input = contentEl.createEl('input', { type: 'text', cls: 'hk-obs-input', placeholder: 'e.g. Indian paintbrush, mule deer, red-tailed hawk' });
    const footer = contentEl.createDiv('hk-modal-footer');
    const another = footer.createEl('button', { text: 'Add another' });
    const done = footer.createEl('button', { cls: 'mod-cta', text: 'Add' });
    const submit = async (keepOpen) => {
      const name = this.input.value.trim();
      if (!name) {
        this.input.focus();
        return;
      }
      await this.plugin.addObservation(this.file, { type: this.type, name });
      if (keepOpen) {
        this.input.value = '';
        this.input.focus();
        new Notice(`Added ${name}`);
      } else this.close();
    };
    another.addEventListener('click', () => submit(true));
    done.addEventListener('click', () => submit(false));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit(false);
      }
    });
    setTimeout(() => this.input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ */
/* Photo gallery (rendered from a ```hike-gallery block)              */
/* ------------------------------------------------------------------ */

class HikeGallery extends MarkdownRenderChild {
  constructor(el, plugin, source, sourcePath) {
    super(el);
    this.plugin = plugin;
    this.listed = source.split('\n');
    this.sourcePath = sourcePath;
    this.timer = null;
    this.arranging = false;
    this.pendingOrder = null; // optimistic order while frontmatter saves
    this.dragIndex = null;
  }

  get file() {
    const f = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
    return f instanceof TFile ? f : null;
  }

  folderPath() {
    const f = this.file;
    const folder = f ? this.plugin.hikeFolderOf(f) : null;
    return folder ? folder.path : null;
  }

  onload() {
    const { app } = this.plugin;
    const el = this.containerEl;
    this.render();

    // Live refresh when photos are dropped into / removed from the hike's folder
    const touch = (path) => {
      const folder = this.folderPath();
      if (folder && path && path.startsWith(folder + '/')) this.schedule();
    };
    this.registerEvent(app.vault.on('create', (f) => touch(f.path)));
    this.registerEvent(app.vault.on('delete', (f) => touch(f.path)));
    this.registerEvent(
      app.vault.on('rename', (f, old) => {
        touch(f.path);
        touch(old);
      })
    );
    this.registerEvent(
      app.metadataCache.on('changed', (f) => {
        if (f.path !== this.sourcePath) return;
        this.pendingOrder = null;
        this.schedule();
      })
    );

    // Keep clicks inside the gallery from reaching the editor (which could re-render the block)
    this.registerDomEvent(el, 'mousedown', (e) => e.stopPropagation());
    this.registerDomEvent(el, 'click', (e) => e.stopPropagation());

    // Drag & drop image files from your computer onto the gallery
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    this.registerDomEvent(el, 'dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      el.addClass('is-dragover');
    });
    this.registerDomEvent(el, 'dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.removeClass('is-dragover');
    });
    this.registerDomEvent(el, 'drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      el.removeClass('is-dragover');
      if (this.dropping) return;
      const imgs = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name.split('.').pop() || ''));
      const file = this.file;
      if (!imgs.length || !file) return new Notice('Drop image files to add them to this hike.');
      this.dropping = true;
      try {
        const { paths } = await this.plugin.addPhotos(file, imgs);
        new Notice(`Added ${paths.length} photo${paths.length === 1 ? '' : 's'}`);
        this.schedule();
      } catch (err) {
        console.error('[hiking-log]', err);
        new Notice(`Could not add photos: ${err.message}`);
      } finally {
        this.dropping = false;
      }
    });
  }

  onunload() {
    clearTimeout(this.timer);
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), 200);
  }

  render() {
    const { app } = this.plugin;
    const el = this.containerEl;
    el.empty();
    el.addClass('hk-gallery', 'hk-theme');
    el.toggleClass('is-arranging', this.arranging);
    const file = this.file;
    if (!file) return;

    const photos = this.pendingOrder || this.plugin.collectPhotos(file, this.listed);
    this.photos = photos;
    const cover = this.plugin.toHike(file).coverFile;
    const folder = this.folderPath();

    /* Header */
    const head = el.createDiv('hk-gallery-head');
    head.createSpan({ cls: 'hk-gallery-count', text: photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}` : 'Photos' });
    const actions = head.createDiv('hk-gallery-actions');
    if (photos.length > 0) {
      const arrange = actions.createEl('button', { cls: 'hk-gallery-btn' + (this.arranging ? ' is-active' : '') });
      setIcon(arrange.createSpan('hk-inline-icon'), this.arranging ? 'check' : 'layout-grid');
      arrange.appendText(this.arranging ? 'Done' : 'Arrange');
      arrange.addEventListener('click', (e) => {
        e.preventDefault();
        this.arranging = !this.arranging;
        this.render();
      });
    }
    const add = actions.createEl('button', { cls: 'hk-gallery-btn' });
    setIcon(add.createSpan('hk-inline-icon'), 'image-plus');
    add.appendText('Add photos');
    add.addEventListener('click', (e) => {
      e.preventDefault();
      this.plugin.openEditHike(file);
    });

    if (!photos.length) {
      const drop = el.createDiv('hk-gallery-empty');
      setIcon(drop.createDiv('hk-gallery-empty-icon'), 'image');
      drop.createDiv({ text: 'Drag photos here' });
      drop.createDiv({
        cls: 'hk-muted hk-small',
        text: folder ? `…or drop them into the “${folder}” folder` : 'Adding photos moves this hike into its own folder.',
      });
      return;
    }

    /* Grid — every tile is the same square size. Photos are CSS backgrounds (not <img>),
       so other image-viewer features don't also react to the click. */
    const grid = el.createDiv('hk-gallery-grid');
    photos.forEach((f, i) => {
      const isCover = !!cover && cover.path === f.path;
      const tile = grid.createDiv('hk-gallery-tile' + (isCover ? ' is-cover' : ''));
      const pic = tile.createDiv('hk-gallery-img');
      pic.style.backgroundImage = `url("${app.vault.getResourcePath(f).replace(/"/g, '%22')}")`;
      pic.setAttr('role', 'img');
      pic.setAttr('aria-label', f.basename);

      if (isCover) {
        const b = tile.createSpan('hk-cover-badge');
        setIcon(b.createSpan('hk-inline-icon'), 'star');
        b.appendText('Cover');
      }

      if (this.arranging) {
        this.wireArrangeTile(tile, i, file, f);
      } else {
        if (!isCover) {
          const b = tile.createEl('button', { cls: 'hk-set-cover', attr: { 'aria-label': 'Set as cover' } });
          setIcon(b.createSpan('hk-inline-icon'), 'image');
          b.appendText('Set cover');
          b.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await this.plugin.setCover(file, f);
            new Notice('Cover photo updated');
          });
        }
        tile.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          GalleryModal.show(app, photos, i, {
            coverPath: cover?.path,
            onSetCover: async (img) => {
              await this.plugin.setCover(file, img);
              new Notice('Cover photo updated');
            },
          });
        });
      }
    });

    el.createDiv({
      cls: 'hk-gallery-hint',
      text: this.arranging
        ? 'Drag photos to reorder, or use the arrows · the bin deletes a photo'
        : 'Drop photos here to add them · click a photo to view it',
    });
  }

  wireArrangeTile(tile, i, file, f) {
    tile.draggable = true;
    tile.addEventListener('dragstart', (e) => {
      this.dragIndex = i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-hk-photo', String(i));
      tile.addClass('is-dragging');
    });
    tile.addEventListener('dragend', () => {
      this.dragIndex = null;
      tile.removeClass('is-dragging');
    });
    tile.addEventListener('dragover', (e) => {
      if (this.dragIndex === null) return;
      e.preventDefault();
      e.stopPropagation();
      tile.addClass('is-drop-target');
    });
    tile.addEventListener('dragleave', () => tile.removeClass('is-drop-target'));
    tile.addEventListener('drop', (e) => {
      if (this.dragIndex === null) return;
      e.preventDefault();
      e.stopPropagation();
      const from = this.dragIndex;
      this.dragIndex = null;
      this.move(file, from, i);
    });

    const bar = tile.createDiv('hk-arrange-bar');
    const btn = (icon, label, disabled, fn, cls = '') => {
      const b = bar.createEl('button', { cls: `hk-arrange-btn ${cls}`, attr: { 'aria-label': label, title: label } });
      setIcon(b, icon);
      b.disabled = disabled;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
    };
    btn('arrow-left', 'Move earlier', i === 0, () => this.move(file, i, i - 1));
    btn('trash-2', 'Delete photo', false, () => {
      new ConfirmModal(this.plugin.app, {
        title: 'Delete photo?',
        body: this.plugin.hikeFolderOf(file) && f.parent?.path === this.folderPath()
          ? `“${f.name}” will be moved to the trash.`
          : `“${f.name}” will be removed from this gallery (the file itself is kept).`,
        confirm: 'Delete',
        onConfirm: async () => {
          this.pendingOrder = this.photos.filter((p) => p.path !== f.path);
          this.render();
          await this.plugin.deletePhoto(file, f);
        },
      }).open();
    }, 'is-danger');
    btn('arrow-right', 'Move later', i === this.photos.length - 1, () => this.move(file, i, i + 1));
  }

  move(file, from, to) {
    if (from === to || to < 0 || to >= this.photos.length) return;
    const arr = [...this.photos];
    const [x] = arr.splice(from, 1);
    arr.splice(to, 0, x);
    this.pendingOrder = arr;
    this.render();
    this.plugin.setPhotoOrder(file, arr);
  }
}

class GalleryModal extends Modal {
  /** Opens the viewer, never more than one at a time. */
  static show(app, files, index, opts) {
    if (GalleryModal.current) return GalleryModal.current;
    const m = new GalleryModal(app, files, index, opts);
    m.open();
    return m;
  }

  constructor(app, files, index, opts = {}) {
    super(app);
    this.files = files;
    this.index = index;
    this.coverPath = opts.coverPath || null;
    this.onSetCover = opts.onSetCover || null;
  }

  onOpen() {
    GalleryModal.current = this;
    this.modalEl.addClass('hk-lightbox');
    this.scope.register([], 'ArrowRight', () => {
      this.step(1);
      return false;
    });
    this.scope.register([], 'ArrowLeft', () => {
      this.step(-1);
      return false;
    });
    this.draw();
  }

  step(d) {
    const n = this.files.length;
    this.index = (this.index + d + n) % n;
    this.draw();
  }

  draw() {
    const { contentEl } = this;
    contentEl.empty();
    const f = this.files[this.index];
    const stage = contentEl.createDiv('hk-lightbox-stage');
    stage.createEl('img', { attr: { src: this.app.vault.getResourcePath(f), alt: f.basename, draggable: 'false' } });
    if (this.files.length > 1) {
      for (const [d, icon, cls] of [
        [-1, 'chevron-left', 'is-prev'],
        [1, 'chevron-right', 'is-next'],
      ]) {
        const b = stage.createEl('button', { cls: `hk-lightbox-nav ${cls}`, attr: { 'aria-label': d < 0 ? 'Previous' : 'Next' } });
        setIcon(b, icon);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this.step(d);
        });
      }
    }
    const bar = contentEl.createDiv('hk-lightbox-bar');
    bar.createSpan({ cls: 'hk-lightbox-caption', text: `${this.index + 1} / ${this.files.length} · ${f.basename}` });
    if (this.onSetCover) {
      const isCover = this.coverPath === f.path;
      const b = bar.createEl('button', { cls: 'hk-lightbox-cover', text: isCover ? '★ Cover photo' : 'Set as cover' });
      b.disabled = isCover;
      b.addEventListener('click', async () => {
        await this.onSetCover(f);
        this.coverPath = f.path;
        this.draw();
      });
    }
  }

  onClose() {
    if (GalleryModal.current === this) GalleryModal.current = null;
    this.contentEl.empty();
  }
}
GalleryModal.current = null;

class ConfirmModal extends Modal {
  constructor(app, { title, body, confirm = 'OK', onConfirm }) {
    super(app);
    this.opts = { title, body, confirm, onConfirm };
  }

  onOpen() {
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl('p', { text: this.opts.body });
    const footer = this.contentEl.createDiv('hk-modal-footer');
    footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const ok = footer.createEl('button', { cls: 'mod-warning', text: this.opts.confirm });
    ok.addEventListener('click', async () => {
      this.close();
      try {
        await this.opts.onConfirm();
      } catch (e) {
        console.error('[hiking-log]', e);
        new Notice(`Something went wrong: ${e.message}`);
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class CoverPickerModal extends Modal {
  constructor(plugin, file) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
  }

  async onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass('hk-modal', 'hk-cover-picker');
    this.titleEl.setText('Choose a cover photo');
    const photos = await this.plugin.collectPhotosFromNote(this.file);
    const current = this.plugin.toHike(this.file).coverFile;

    if (!photos.length) {
      contentEl.createEl('p', { cls: 'hk-muted', text: "This hike doesn't have any photos yet. Add some, then pick a cover." });
      const b = contentEl.createEl('button', { cls: 'mod-cta', text: 'Add photos' });
      b.addEventListener('click', () => {
        this.close();
        this.plugin.openEditHike(this.file);
      });
      return;
    }

    const grid = contentEl.createDiv('hk-picker-grid');
    for (const f of photos) {
      const tile = grid.createDiv('hk-picker-tile' + (current && current.path === f.path ? ' is-current' : ''));
      tile.createEl('img', { attr: { src: this.app.vault.getResourcePath(f), alt: f.basename, loading: 'lazy' } });
      tile.createDiv({ cls: 'hk-picker-name', text: f.basename });
      tile.addEventListener('click', async () => {
        await this.plugin.setCover(this.file, f);
        new Notice('Cover photo updated');
        this.close();
      });
    }
    const footer = contentEl.createDiv('hk-modal-footer');
    const none = footer.createEl('button', { text: 'No cover' });
    none.addEventListener('click', async () => {
      await this.plugin.setCover(this.file, null);
      this.close();
    });
    const cancel = footer.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ */
/* Dashboard view                                                     */
/* ------------------------------------------------------------------ */

class HikingDashboardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.filters = { year: 'all', type: 'all' };
    this.chartMetric = 'distance';
    this.sort = { key: 'date', dir: -1 };
    this.timer = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return 'Hiking dashboard';
  }
  getIcon() {
    return 'mountain';
  }

  async onOpen() {
    // A fixed contour-map backdrop behind a scrolling content layer
    const host = this.contentEl;
    host.empty();
    host.addClass('hk-dashboard-view', 'hk-theme', 'hk-glass');
    createTopoLayer(host, 'hiking-dashboard');
    this.scrollEl = host.createDiv('hk-dashboard');
    this.render();
    const refresh = () => this.scheduleRender();
    this.registerEvent(this.app.metadataCache.on('changed', refresh));
    this.registerEvent(this.app.vault.on('delete', refresh));
    this.registerEvent(this.app.vault.on('rename', refresh));
  }

  async onClose() {
    clearTimeout(this.timer);
  }

  scheduleRender() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), 300);
  }

  render() {
    const root = this.scrollEl;
    if (!root) return;
    const scroll = root.scrollTop;
    const ae = root.ownerDocument.activeElement;
    const searchFocused = !!(ae && root.contains(ae) && ae.classList.contains('hk-search-input'));
    root.empty();

    const s = this.plugin.settings;
    const U = unitLabels(s.units);
    const all = this.plugin.getHikes();
    const years = [...new Set(all.filter((h) => h.date).map((h) => h.date.getFullYear()))].sort((a, b) => b - a);
    const types = [...new Set(all.map((h) => h.type).filter(Boolean))].sort();
    if (this.filters.year !== 'all' && !years.includes(+this.filters.year)) this.filters.year = 'all';
    if (this.filters.type !== 'all' && !types.includes(this.filters.type)) this.filters.type = 'all';

    const hikes = all.filter(
      (h) =>
        (this.filters.year === 'all' || (h.date && h.date.getFullYear() === +this.filters.year)) &&
        (this.filters.type === 'all' || h.type === this.filters.type)
    );

    /* Header banner with layered ridgelines */
    const banner = root.createDiv('hk-banner');
    const art = svgEl(
      'svg',
      { viewBox: '0 0 1200 220', preserveAspectRatio: 'xMidYMax slice', class: 'hk-banner-art', 'aria-hidden': 'true' },
      banner
    );
    svgEl('circle', { cx: 960, cy: 68, r: 30, class: 'hk-sun' }, art);
    svgEl('path', { d: 'M0 150 L120 100 L210 130 L330 62 L450 122 L560 84 L690 132 L820 58 L940 116 L1060 86 L1200 126 L1200 220 L0 220 Z', class: 'hk-ridge-far' }, art);
    svgEl('path', { d: 'M0 178 L150 130 L260 160 L400 112 L520 158 L650 124 L800 170 L930 128 L1080 164 L1200 142 L1200 220 L0 220 Z', class: 'hk-ridge-mid' }, art);
    svgEl('path', { d: 'M0 205 Q300 168 600 196 T1200 188 L1200 220 L0 220 Z', class: 'hk-ridge-near' }, art);
    for (const [x, s] of [[60, 1], [84, 0.8], [176, 1.1], [1030, 0.9], [1058, 1.2], [1100, 0.85], [1132, 1]]) {
      const base = 206 - (x > 600 ? 8 : 4);
      svgEl('path', { d: `M${x} ${base - 34 * s} L${x + 11 * s} ${base} L${x - 11 * s} ${base} Z`, class: 'hk-tree' }, art);
    }
    const inner = banner.createDiv('hk-banner-inner');
    const title = inner.createDiv('hk-title');
    title.createDiv({ cls: 'hk-eyebrow', text: 'Trail journal' });
    title.createEl('h2', { text: 'Hiking log' });
    if (all.length) {
      const last = all.filter((h) => h.date).sort((a, b) => b.date - a.date)[0];
      title.createDiv({
        cls: 'hk-banner-sub',
        text: `${all.length} hike${all.length === 1 ? '' : 's'} logged${
          last ? ` · last out ${last.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''
        }`,
      });
    }
    const ctr = inner.createDiv('hk-controls');
    if (all.length) {
      this.select(ctr, [['all', 'All years'], ...years.map((y) => [String(y), String(y)])], String(this.filters.year), (v) => {
        this.filters.year = v;
        this.render();
      });
      this.select(ctr, [['all', 'All types'], ...types.map((t) => [t, t])], this.filters.type, (v) => {
        this.filters.type = v;
        this.render();
      });
    }
    const nb = ctr.createEl('button', { cls: 'mod-cta hk-new-btn' });
    setIcon(nb.createSpan('hk-inline-icon'), 'plus');
    nb.appendText('Log hike');
    nb.addEventListener('click', () => this.plugin.openNewHike());

    if (!all.length) {
      const empty = root.createDiv('hk-empty');
      setIcon(empty.createDiv('hk-empty-icon'), 'footprints');
      empty.createEl('h3', { text: 'No hikes yet' });
      empty.createEl('p', { text: 'Log your first hike and your stats will show up here.' });
      const b = empty.createEl('button', { cls: 'mod-cta', text: 'Log your first hike' });
      b.addEventListener('click', () => this.plugin.openNewHike());
      return;
    }
    if (!hikes.length) {
      root.createDiv({ cls: 'hk-empty', text: 'No hikes match these filters.' });
      return;
    }

    /* Summary cards */
    const rated = hikes.filter((h) => h.rating);
    const avgRating = rated.length ? sumOf(rated, 'rating') / rated.length : null;
    const locations = new Set(hikes.map((h) => h.location).filter(Boolean));
    const maxElev = Math.max(0, ...hikes.map((h) => h.elevation || 0));
    const anyEst = hikes.some((h) => h.caloriesEstimated);

    const cards = root.createDiv('hk-cards');
    this.card(cards, 'forest', 'footprints', 'Hikes', String(hikes.length), `${locations.size} location${locations.size === 1 ? '' : 's'}`);
    this.card(cards, 'sky', 'route', 'Distance', `${fmtNum(sumOf(hikes, 'distance'))} ${U.dist}`, `avg ${fmtNum(avgOf(hikes, 'distance'))} ${U.dist}`);
    this.card(cards, 'moss', 'timer', 'Time on trail', formatDuration(sumOf(hikes, 'duration')), `avg ${formatDuration(avgOf(hikes, 'duration'))}`);
    this.card(cards, 'clay', 'trending-up', 'Elevation gain', `${fmtNum(sumOf(hikes, 'elevation'), 0)} ${U.elev}`, `best ${fmtNum(maxElev, 0)} ${U.elev}`);
    this.card(cards, 'ember', 'flame', 'Calories', `${fmtNum(sumOf(hikes, 'calories'), 0)}`, anyEst ? 'kcal · includes estimates' : 'kcal');
    this.card(cards, 'sun', 'star', 'Avg rating', avgRating ? `${fmtNum(avgRating, 1)} ★` : '—', `${rated.length} rated`);

    /* Personal records — full-width row above the monthly chart */
    const recPanel = this.panel(root, 'Personal records', 'trophy');
    const best = (key) => hikes.filter((h) => h[key] != null).sort((a, b) => b[key] - a[key])[0];
    const topRated = [...rated].sort((a, b) => b.rating - a.rating || (b.date || 0) - (a.date || 0))[0];
    const records = [
      ['sky', 'route', 'Longest hike', best('distance'), (h) => `${fmtNum(h.distance)} ${U.dist}`],
      ['clay', 'trending-up', 'Most climbing', best('elevation'), (h) => `${fmtNum(h.elevation, 0)} ${U.elev}`],
      ['moss', 'timer', 'Longest day', best('duration'), (h) => formatDuration(h.duration)],
      ['ember', 'flame', 'Most calories', best('calories'), (h) => `${fmtNum(h.calories, 0)} kcal`],
      ['sun', 'star', 'Top rated', topRated, (h) => stars(h.rating)],
    ].filter((r) => r[3]);
    if (records.length) {
      const recRow = recPanel.createDiv('hk-records');
      for (const [color, icon, label, h, fmt] of records) {
        const tile = recRow.createDiv(`hk-record hk-c-${color}`);
        tile.setAttr('title', `Open ${h.title}`);
        tile.addEventListener('click', () => this.plugin.openFile(h.file));
        const top = tile.createDiv('hk-record-top');
        setIcon(top.createSpan('hk-chip'), icon);
        top.createSpan({ cls: 'hk-record-label', text: label });
        tile.createDiv({ cls: 'hk-record-value' + (icon === 'star' ? ' hk-stars' : ''), text: fmt(h) });
        tile.createDiv({ cls: 'hk-record-hike', text: h.title });
        const meta = [h.dateStr, h.location].filter(Boolean).join(' · ');
        if (meta) tile.createDiv({ cls: 'hk-record-meta', text: meta });
      }
    } else {
      recPanel.createDiv({ cls: 'hk-muted', text: 'Log some stats to start setting records.' });
    }

    /* Monthly chart */
    const chartPanel = root.createDiv('hk-panel');
    const ch = chartPanel.createDiv('hk-panel-head');
    this.heading(ch, 'bar-chart-3', 'Monthly activity');
    const tabs = ch.createDiv('hk-tabs');
    [
      ['distance', 'Distance'],
      ['elevation', 'Elevation'],
      ['duration', 'Time'],
      ['calories', 'Calories'],
      ['count', 'Hikes'],
    ].forEach(([k, l]) => {
      const b = tabs.createEl('button', { cls: 'hk-tab' + (this.chartMetric === k ? ' is-active' : ''), text: l });
      b.addEventListener('click', () => {
        this.chartMetric = k;
        this.render();
      });
    });
    this.renderMonthly(chartPanel, hikes);

    /* Breakdown grid */
    const grid = root.createDiv('hk-grid');

    const typePanel = this.panel(grid, 'Hike types', 'compass');
    const byType = [...groupBy(hikes, (h) => h.type || 'Unspecified')]
      .map(([label, hs]) => ({
        label,
        value: hs.length,
        display: `${hs.length} · ${fmtNum(sumOf(hs, 'distance'))} ${U.dist}`,
      }))
      .sort((a, b) => b.value - a.value);
    this.barList(typePanel, byType, 'forest');

    const routePanel = this.panel(grid, 'Route types', 'signpost');
    const routeItems = ROUTE_TYPES.map((r) => {
      const hs = hikes.filter((h) => h.route === r);
      return { label: r, value: hs.length, display: `${hs.length}${hs.length ? ` · ${fmtNum(sumOf(hs, 'distance'))} ${U.dist}` : ''}` };
    });
    const otherRoutes = hikes.filter((h) => h.route && !ROUTE_TYPES.includes(h.route)).length;
    if (otherRoutes) routeItems.push({ label: 'Other', value: otherRoutes, display: String(otherRoutes) });
    this.barList(routePanel, routeItems, 'sky').addClass('hk-barlist-wide');
    const noRoute = hikes.filter((h) => !h.route).length;
    if (noRoute) routePanel.createDiv({ cls: 'hk-muted hk-small', text: `${noRoute} without a route type` });

    const diffPanel = this.panel(grid, 'Difficulty', 'gauge');
    const diffList = diffPanel.createDiv('hk-barlist hk-barlist-wide');
    const maxDiff = Math.max(1, ...DIFFICULTIES.map((d) => hikes.filter((h) => h.difficulty === d.name).length));
    for (const d of DIFFICULTIES) {
      const hs = hikes.filter((h) => h.difficulty === d.name);
      const row = diffList.createDiv(`hk-barrow hk-c-${d.color}`);
      difficultyBadge(row.createDiv('hk-barrow-label'), d.name, 'is-plain');
      row.createDiv('hk-barrow-track').createDiv('hk-barrow-fill').style.width = `${(hs.length / maxDiff) * 100}%`;
      row.createDiv({ cls: 'hk-barrow-value', text: `${hs.length}${hs.length ? ` · ${fmtNum(sumOf(hs, 'distance'))} ${U.dist}` : ''}` });
    }
    const noDiff = hikes.filter((h) => !h.difficulty).length;
    if (noDiff) diffPanel.createDiv({ cls: 'hk-muted hk-small', text: `${noDiff} without a difficulty` });

    const ratingPanel = this.panel(grid, 'Ratings', 'star');
    const ratingItems = [5, 4, 3, 2, 1].map((r) => {
      const n = hikes.filter((h) => Math.round(h.rating || 0) === r).length;
      return { label: stars(r), value: n, display: String(n), cls: 'hk-stars' };
    });
    this.barList(ratingPanel, ratingItems, 'sun');
    const unrated = hikes.length - rated.length;
    if (unrated) ratingPanel.createDiv({ cls: 'hk-muted hk-small', text: `${unrated} unrated` });

    const locPanel = this.panel(grid, 'Top locations', 'map-pin');
    const byLoc = [...groupBy(hikes.filter((h) => h.location), (h) => h.location)]
      .map(([label, hs]) => {
        const r = hs.filter((h) => h.rating);
        const avg = r.length ? sumOf(r, 'rating') / r.length : null;
        return {
          label,
          value: hs.length,
          display: `${hs.length}×${avg ? ` · ${fmtNum(avg, 1)}★` : ''}`,
        };
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    if (byLoc.length) this.barList(locPanel, byLoc, 'clay');
    else locPanel.createDiv({ cls: 'hk-muted', text: 'Add locations to your hikes to see them here.' });

    const favPanel = this.panel(grid, 'Favorites', 'heart');
    const favs = hikes.filter((h) => h.favorite).sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.date || 0) - (a.date || 0));
    if (favs.length) {
      const list = favPanel.createDiv('hk-fav-list');
      for (const h of favs) {
        const row = list.createDiv('hk-fav-row');
        row.addEventListener('click', () => this.plugin.openFile(h.file));
        setIcon(row.createSpan('hk-fav-heart'), 'heart');
        const mid = row.createDiv('hk-fav-mid');
        mid.createDiv({ cls: 'hk-fav-title', text: h.title });
        const meta = [h.date ? h.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '', h.location].filter(Boolean).join(' · ');
        if (meta) mid.createDiv({ cls: 'hk-fav-meta', text: meta });
        if (h.rating) row.createSpan({ cls: 'hk-stars hk-fav-stars', text: stars(h.rating) });
      }
    } else {
      favPanel.createDiv({ cls: 'hk-muted', text: 'Tap the ♥ on a hike’s card to add it to your favorites.' });
    }

    /* Recent hikes */
    const recent = [...hikes].sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 5);
    const recentPanel = this.panel(root, 'Recent hikes', 'footprints');
    const wrap = recentPanel.createDiv('hk-recent');
    for (const h of recent) {
      const c = wrap.createDiv('hk-recent-card');
      c.addEventListener('click', () => this.plugin.openFile(h.file));
      const img = this.plugin.coverUrl(h);
      const cover = c.createDiv('hk-recent-cover');
      if (img) {
        const im = cover.createEl('img', { attr: { src: img, alt: h.title, loading: 'lazy' } });
        if (h.coverPosition) im.style.objectPosition = h.coverPosition.css;
      }
      else setIcon(cover.createDiv('hk-recent-placeholder'), 'mountain');
      if (h.type) cover.createSpan({ cls: 'hk-badge hk-badge-float', text: h.type });
      if (h.favorite) setIcon(cover.createSpan({ cls: 'hk-fav-float', attr: { 'aria-label': 'Favorite' } }), 'heart');
      const b = c.createDiv('hk-recent-body');
      b.createDiv({ cls: 'hk-recent-title', text: h.title });
      b.createDiv({
        cls: 'hk-recent-meta',
        text: [h.date ? h.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '', h.location]
          .filter(Boolean)
          .join(' · '),
      });
      const st = [];
      if (h.distance != null) st.push(`${fmtNum(h.distance)} ${U.dist}`);
      if (h.duration != null) st.push(formatDuration(h.duration));
      if (h.elevation != null) st.push(`↑${fmtNum(h.elevation, 0)} ${U.elev}`);
      if (st.length) b.createDiv({ cls: 'hk-recent-stats', text: st.join('  ·  ') });
      const foot = b.createDiv('hk-recent-foot');
      if (h.rating) foot.createSpan({ cls: 'hk-stars', text: stars(h.rating) });
      if (h.difficulty) difficultyBadge(foot, h.difficulty, 'is-small');
      if (h.route) b.createDiv({ cls: 'hk-recent-meta', text: h.route });
    }

    /* Log table */
    const logPanel = root.createDiv('hk-panel');
    this.renderTable(logPanel, hikes, U);

    root.scrollTop = scroll;
    if (searchFocused) {
      const inp = root.querySelector('.hk-search-input');
      if (inp) {
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }
  }

  /* ---------- dashboard building blocks ---------- */

  select(parent, options, value, onChange) {
    const sel = parent.createEl('select', { cls: 'dropdown' });
    for (const [v, l] of options) sel.createEl('option', { value: v, text: l });
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  card(parent, color, icon, label, value, sub) {
    const c = parent.createDiv(`hk-card hk-c-${color}`);
    const top = c.createDiv('hk-card-label');
    setIcon(top.createSpan('hk-chip'), icon);
    top.createSpan({ text: label });
    c.createDiv({ cls: 'hk-card-value', text: value });
    if (sub) c.createDiv({ cls: 'hk-card-sub', text: sub });
  }

  heading(parent, icon, title) {
    const h = parent.createEl('h3', { cls: 'hk-heading' });
    if (icon) setIcon(h.createSpan('hk-heading-icon'), icon);
    h.createSpan({ text: title });
    return h;
  }

  panel(parent, title, icon) {
    const p = parent.createDiv('hk-panel');
    this.heading(p, icon, title);
    return p;
  }

  barList(parent, items, color = 'forest') {
    const max = Math.max(1, ...items.map((i) => i.value));
    const list = parent.createDiv(`hk-barlist hk-c-${color}`);
    for (const it of items) {
      const row = list.createDiv('hk-barrow');
      row.createDiv({ cls: 'hk-barrow-label' + (it.cls ? ` ${it.cls}` : ''), text: it.label, attr: { title: it.label } });
      const track = row.createDiv('hk-barrow-track');
      const fill = track.createDiv('hk-barrow-fill');
      fill.style.width = `${(it.value / max) * 100}%`;
      row.createDiv({ cls: 'hk-barrow-value', text: it.display });
    }
    return list;
  }

  metricText(metric, v, short = false) {
    const U = unitLabels(this.plugin.settings.units);
    switch (metric) {
      case 'distance':
        return short ? fmtNum(v, v < 10 ? 1 : 0) : `${fmtNum(v)} ${U.dist}`;
      case 'elevation':
        return short ? (v >= 1000 ? `${fmtNum(v / 1000, 1)}k` : fmtNum(v, 0)) : `${fmtNum(v, 0)} ${U.elev}`;
      case 'duration':
        return short ? `${fmtNum(v / 60, v < 600 ? 1 : 0)}h` : formatDuration(v);
      case 'calories':
        return short ? (v >= 1000 ? `${fmtNum(v / 1000, 1)}k` : fmtNum(v, 0)) : `${fmtNum(v, 0)} kcal`;
      default:
        return String(v);
    }
  }

  renderMonthly(parent, hikes) {
    const metric = this.chartMetric;
    const dated = hikes.filter((h) => h.date);
    if (!dated.length) {
      parent.createDiv({ cls: 'hk-muted', text: 'Add dates to your hikes to see monthly activity.' });
      return;
    }
    let end;
    if (this.filters.year !== 'all') {
      end = new Date(+this.filters.year, 11, 1);
    } else {
      const latest = dated.reduce((m, h) => (h.date > m ? h.date : m), dated[0].date);
      end = new Date(latest.getFullYear(), latest.getMonth(), 1);
    }
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, date: d, value: 0 });
    }
    const map = new Map(months.map((m) => [m.key, m]));
    for (const h of dated) {
      const m = map.get(`${h.date.getFullYear()}-${h.date.getMonth()}`);
      if (m) m.value += metric === 'count' ? 1 : h[metric] || 0;
    }
    const max = Math.max(0, ...months.map((m) => m.value));

    const W = 720,
      H = 220,
      padX = 6,
      padT = 22,
      padB = 30;
    const slot = (W - padX * 2) / months.length;
    const bw = slot * 0.62;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hk-chart', role: 'img', 'aria-label': 'Monthly activity chart' }, parent);
    const gid = `hk-grad-${Math.random().toString(36).slice(2, 8)}`;
    const grad = svgEl('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, svgEl('defs', {}, svg));
    svgEl('stop', { offset: '0%', style: 'stop-color: var(--hk-moss)' }, grad);
    svgEl('stop', { offset: '100%', style: 'stop-color: var(--hk-forest)' }, grad);
    for (const f of [0.25, 0.5, 0.75]) {
      const y = H - padB - f * (H - padT - padB);
      svgEl('line', { x1: padX, x2: W - padX, y1: y, y2: y, class: 'hk-grid-line' }, svg);
    }
    svgEl('line', { x1: padX, x2: W - padX, y1: H - padB, y2: H - padB, class: 'hk-axis' }, svg);

    months.forEach((m, i) => {
      const x = padX + i * slot + (slot - bw) / 2;
      const h = max ? (m.value / max) * (H - padT - padB) : 0;
      const y = H - padB - h;
      const g = svgEl('g', {}, svg);
      const label = m.date.toLocaleString(undefined, { month: 'short' });
      const t = svgEl('title', {}, g);
      t.textContent = `${label} ${m.date.getFullYear()}: ${this.metricText(metric, m.value)}`;
      svgEl('rect', { x, y: H - padB - Math.max(h, 0), width: bw, height: Math.max(h, 0), rx: 4, fill: `url(#${gid})`, class: 'hk-bar' + (m.value ? '' : ' is-empty') }, g);
      if (m.value) {
        const v = svgEl('text', { x: x + bw / 2, y: y - 6, 'text-anchor': 'middle', class: 'hk-bar-value' }, g);
        v.textContent = this.metricText(metric, m.value, true);
      }
      const lt = svgEl('text', { x: x + bw / 2, y: H - padB + 18, 'text-anchor': 'middle', class: 'hk-bar-label' }, g);
      lt.textContent = m.date.getMonth() === 0 && this.filters.year === 'all' ? `${label} '${String(m.date.getFullYear()).slice(2)}` : label;
    });

    const total = months.reduce((a, m) => a + m.value, 0);
    parent.createDiv({
      cls: 'hk-muted hk-small',
      text: `${this.metricText(metric, total)}${metric === 'count' ? ' hikes' : ''} over these 12 months`,
    });
  }

  /** Everything a hike can be found by in the log search. */
  searchText(h) {
    const parts = [h.title, h.location, h.type, h.route, h.difficulty, h.weather, h.companions, h.dateStr];
    if (h.date) {
      parts.push(String(h.date.getFullYear()));
      parts.push(h.date.toLocaleString(undefined, { month: 'long' }), h.date.toLocaleString(undefined, { month: 'short' }));
      parts.push(h.date.toLocaleString('en', { month: 'long' }));
    }
    if (h.rating) {
      const r = Math.round(h.rating);
      parts.push(`${r}★`, `${r}-star`, `${r} star`, `${r} stars`, `rating ${r}`, '★'.repeat(r));
    } else parts.push('unrated');
    if (h.favorite) parts.push('favorite', 'favourite', 'fav', '♥');
    for (const o of h.observations || []) parts.push(o.name, o.type.name);
    if (h.route === 'Out and back') parts.push('out & back', 'out-and-back');
    if (h.route === 'Point to point') parts.push('point-to-point', 'p2p');
    return parts.filter(Boolean).join(' · ').toLowerCase();
  }

  /** Every word in the query must appear somewhere; "5 stars" / "5★" / "rating 5" match ratings. */
  matchesQuery(h, q) {
    const norm = q
      .toLowerCase()
      .replace(/\b([1-5])\s*(?:stars?|★)/g, '$1★')
      .replace(/\brating\s*:?\s*([1-5])\b/g, '$1★')
      .replace(/\bout\s*(?:and|&)\s*back\b/g, 'out-and-back')
      .replace(/\bpoint\s*to\s*point\b/g, 'point-to-point');
    const words = norm.split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = this.searchText(h);
    return words.every((w) => hay.includes(w));
  }

  renderTable(parent, hikes, U) {
    // Header: title with live count + search box
    const head = parent.createDiv('hk-panel-head hk-log-head');
    const h3 = this.heading(head, 'book-open', '');
    const titleSpan = h3.querySelector('span:last-child');
    const search = head.createDiv('hk-search');
    setIcon(search.createSpan('hk-search-icon'), 'search');
    const input = search.createEl('input', {
      type: 'search',
      cls: 'hk-search-input',
      attr: { placeholder: 'Search year, trail, difficulty, rating, route…', 'aria-label': 'Search hikes', spellcheck: 'false' },
    });
    input.value = this.query || '';
    const clear = search.createEl('button', { cls: 'hk-search-clear', attr: { 'aria-label': 'Clear search' } });
    setIcon(clear, 'x');

    const cols = [
      ['date', 'Date'],
      ['title', 'Hike'],
      ['location', 'Location'],
      ['type', 'Type'],
      ['route', 'Route'],
      ['difficultyLevel', 'Difficulty'],
      ['distance', `Dist (${U.dist})`, true],
      ['duration', 'Time', true],
      ['elevation', `Elev (${U.elev})`, true],
      ['calories', 'kcal', true],
      ['rating', 'Rating', true],
    ];
    const wrap = parent.createDiv('hk-table-wrap');
    const table = wrap.createEl('table', { cls: 'hk-table' });
    const tr = table.createEl('thead').createEl('tr');
    for (const [key, label, numeric] of cols) {
      const th = tr.createEl('th', { text: label, cls: numeric ? 'is-num' : '' });
      if (this.sort.key === key) th.appendText(this.sort.dir === 1 ? ' ▲' : ' ▼');
      th.addEventListener('click', () => {
        if (this.sort.key === key) this.sort.dir *= -1;
        else this.sort = { key, dir: numeric || key === 'date' ? -1 : 1 };
        this.render();
      });
    }

    const { key, dir } = this.sort;
    const val = (h) => (key === 'date' ? (h.date ? h.date.getTime() : null) : h[key]);
    const rows = [...hikes].sort((a, b) => {
      const va = val(a),
        vb = val(b);
      const ea = va === null || va === undefined || va === '';
      const eb = vb === null || vb === undefined || vb === '';
      if (ea && eb) return 0;
      if (ea) return 1;
      if (eb) return -1;
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });

    const tbody = table.createEl('tbody');
    const empty = parent.createDiv({ cls: 'hk-search-empty hk-muted' });
    const fill = () => {
      const q = (this.query || '').trim();
      const shown = q ? rows.filter((h) => this.matchesQuery(h, q)) : rows;
      titleSpan.setText(q ? `Hike log (${shown.length} of ${hikes.length})` : `Hike log (${hikes.length})`);
      search.toggleClass('has-value', !!q);
      tbody.empty();
      empty.setText(shown.length ? '' : `No hikes match “${q}”.`);
      empty.toggleClass('hk-hidden', !!shown.length);
      for (const h of shown) this.renderRow(tbody, h);
    };
    input.addEventListener('input', () => {
      this.query = input.value;
      fill();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        e.stopPropagation();
        input.value = '';
        this.query = '';
        fill();
      }
    });
    clear.addEventListener('click', (e) => {
      e.preventDefault();
      input.value = '';
      this.query = '';
      fill();
      input.focus();
    });
    fill();
  }

  renderRow(tbody, h) {
    {
      const r = tbody.createEl('tr');
      r.addEventListener('click', () => this.plugin.openFile(h.file));
      r.createEl('td', { text: h.dateStr || '—', cls: 'hk-nowrap' });
      const nameTd = r.createEl('td', { cls: 'hk-strong' });
      if (h.favorite) setIcon(nameTd.createSpan({ cls: 'hk-fav-heart hk-fav-inline', attr: { 'aria-label': 'Favorite', title: 'Favorite' } }), 'heart');
      nameTd.appendText(h.title);
      r.createEl('td', { text: h.location || '—' });
      r.createEl('td', { text: h.type || '—' });
      r.createEl('td', { text: h.route || '—', cls: 'hk-nowrap' });
      const dtd = r.createEl('td', { cls: 'hk-nowrap' });
      if (!difficultyBadge(dtd, h.difficulty, 'is-small')) dtd.setText('—');
      r.createEl('td', { text: fmtNum(h.distance), cls: 'is-num' });
      r.createEl('td', { text: formatDuration(h.duration), cls: 'is-num hk-nowrap' });
      r.createEl('td', { text: fmtNum(h.elevation, 0), cls: 'is-num' });
      r.createEl('td', {
        text: h.calories != null ? `${h.caloriesEstimated ? '~' : ''}${fmtNum(h.calories, 0)}` : '—',
        cls: 'is-num',
        attr: h.caloriesEstimated ? { title: 'Estimated' } : {},
      });
      r.createEl('td', { text: h.rating ? stars(h.rating) : '—', cls: 'is-num hk-stars hk-nowrap' });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

class HikingSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Hike folder')
      .setDesc(
        'Each new hike gets its own subfolder here (Hikes/<date name>/) holding the note and its photos. Notes tagged #hike anywhere in the vault are also included.'
      )
      .addText((t) =>
        t.setPlaceholder('Hikes').setValue(s.hikeFolder).onChange(async (v) => {
          s.hikeFolder = v.trim() || 'Hikes';
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Units')
      .setDesc('Values in your notes are read in these units (changing this does not convert existing notes).')
      .addDropdown((d) =>
        d
          .addOption('metric', 'Metric (km, m, kg)')
          .addOption('imperial', 'Imperial (mi, ft, lb)')
          .setValue(s.units)
          .onChange(async (v) => {
            s.units = v;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(`Body weight (${unitLabels(s.units).weight})`)
      .setDesc('Used to estimate calories burned.')
      .addText((t) =>
        t.setValue(String(s.bodyWeight)).onChange(async (v) => {
          const n = toNum(v);
          if (n && n > 0) {
            s.bodyWeight = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName('Estimate missing calories')
      .setDesc('When a hike has no calories logged, estimate them from time, distance, elevation and type (shown with ~).')
      .addToggle((t) =>
        t.setValue(s.autoCalories).onChange(async (v) => {
          s.autoCalories = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Open note after logging')
      .addToggle((t) =>
        t.setValue(s.openAfterCreate).onChange(async (v) => {
          s.openAfterCreate = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Hike types')
      .setDesc('One per line. These appear in the Type dropdown.')
      .addTextArea((t) => {
        t.inputEl.rows = 7;
        t.setValue(s.hikeTypes.join('\n')).onChange(async (v) => {
          const list = v
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean);
          s.hikeTypes = list.length ? list : [...DEFAULT_SETTINGS.hikeTypes];
          await this.plugin.saveSettings();
        });
      });
  }
}

module.exports = HikingLogPlugin;
// exported for testing
module.exports._helpers = { parseDuration, formatDuration, estimateCalories, parseDate, linkPath, parseTags, sanitizeFileName };
