// Settings → Graphics section: preset, render scale, per-effect overrides,
// adaptive resolution, frame-rate readout and a GPU/cost summary. Strings are
// localized here (the rest of the game ships en-US only).

import { el } from './ui.js';
import { PRESETS, CATEGORIES, SHADOW_MAP, detectPreset, resolve, presetTier, choosePreset } from './gfx.js';

const EN = {
  title: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})', fromPreset: 'From preset ({tier})',
  renderScale: 'Render scale', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device, so the board renders without it.',
  unknownGpu: 'Unknown GPU',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  cats: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing',
    reflections: 'Reflections', particles: 'Particles', detail: 'Surface detail',
  },
  tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Plain', detailed: 'Detailed' },
};

const ES = {
  title: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})', fromPreset: 'Del preajuste ({tier})',
  renderScale: 'Escala de renderizado', adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo; el tablero se muestra sin él.',
  unknownGpu: 'GPU desconocida',
  presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  cats: {
    shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Suavizado de bordes',
    reflections: 'Reflejos', particles: 'Partículas', detail: 'Detalle de superficies',
  },
  tiers: { off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Sencillo', detailed: 'Detallado' },
};

const FR = {
  title: 'Graphismes', quality: 'Qualité', auto: 'Auto (détecté : {tier})', fromPreset: 'Selon le préréglage ({tier})',
  renderScale: 'Échelle de rendu', adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
  postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; le plateau s’affiche sans lui.',
  unknownGpu: 'GPU inconnu',
  presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  cats: {
    shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Lueur', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage',
    reflections: 'Reflets', particles: 'Particules', detail: 'Détail des surfaces',
  },
  tiers: { off: 'Désactivé', on: 'Activé', low: 'Faible', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Détaillé' },
};

export const GFX_STRINGS = {
  'en-US': EN,
  'en-GB': { ...EN, cats: { ...EN.cats, grade: 'Colour grade' } },
  'es-419': { ...ES, postFailed: 'El posprocesamiento no está disponible en este dispositivo; el tablero se muestra sin él.' },
  'es-ES': ES,
  'de-DE': {
    title: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', fromPreset: 'Aus Voreinstellung ({tier})',
    renderScale: 'Renderskalierung', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Brett wird ohne sie dargestellt.',
    unknownGpu: 'Unbekannte GPU',
    presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
    cats: {
      shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchten', grade: 'Farbkorrektur', antialias: 'Kantenglättung',
      reflections: 'Spiegelungen', particles: 'Partikel', detail: 'Oberflächendetails',
    },
    tiers: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Schlicht', detailed: 'Detailliert' },
  },
  'fr-FR': FR,
  'fr-CA': { ...FR, title: 'Graphiques' },
  'pt-BR': {
    title: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})', fromPreset: 'Da predefinição ({tier})',
    renderScale: 'Escala de renderização', adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; o tabuleiro é exibido sem ele.',
    unknownGpu: 'GPU desconhecida',
    presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: {
      shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Antisserrilhamento',
      reflections: 'Reflexos', particles: 'Partículas', detail: 'Detalhe das superfícies',
    },
    tiers: { off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simples', detailed: 'Detalhado' },
  },
  'it-IT': {
    title: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', fromPreset: 'Dal preset ({tier})',
    renderScale: 'Scala di rendering', adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
    postFailed: 'Il post-processing non è disponibile su questo dispositivo; il tabellone viene mostrato senza.',
    unknownGpu: 'GPU sconosciuta',
    presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
    cats: {
      shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing',
      reflections: 'Riflessi', particles: 'Particelle', detail: 'Dettaglio superfici',
    },
    tiers: { off: 'Disattivato', on: 'Attivato', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Semplice', detailed: 'Dettagliato' },
  },
};

/** Pick the closest supported locale for a BCP-47 tag (navigator.language). */
export function gfxLocale(tag) {
  const t = String(tag || 'en-US');
  if (GFX_STRINGS[t]) return t;
  const lang = t.split('-')[0].toLowerCase();
  const region = (t.split('-')[1] || '').toUpperCase();
  if (lang === 'en') return region === 'GB' || region === 'UK' || region === 'IE' || region === 'AU' || region === 'NZ' ? 'en-GB' : 'en-US';
  if (lang === 'es') return region === 'ES' ? 'es-ES' : 'es-419';
  if (lang === 'fr') return region === 'CA' ? 'fr-CA' : 'fr-FR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

function strings() {
  const tag = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  return GFX_STRINGS[gfxLocale(tag)];
}

// One probe context per page: GPU name for Auto and the summary line when no board is live.
let probe = null;
export function probeGpu() {
  if (probe) return probe;
  let gpu = '';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { gpu = ''; }
  const touch = (navigator.maxTouchPoints || 0) > 0 || matchMedia('(pointer: coarse)').matches;
  probe = { gpu, detected: detectPreset(gpu, touch) };
  return probe;
}

function summaryText(t, r, gpu, px) {
  const parts = [
    gpu || t.unknownGpu,
    r.shadows === 'off' ? `${t.cats.shadows}: ${t.tiers.off}` : `${t.cats.shadows} ${SHADOW_MAP[r.shadows]}²`,
    r.ao !== 'off' ? t.cats.ao + (r.ao === 'high' ? ` (${t.tiers.high})` : '') : null,
    r.bloom === 'on' ? t.cats.bloom : null,
    r.reflections === 'on' ? t.cats.reflections : null,
    r.antialias === 'off' ? `${t.cats.antialias}: ${t.tiers.off}` : r.antialias.toUpperCase(),
    px ? `${px[0]}×${px[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/**
 * Build the Graphics controls.
 * ctx: { get() → saved graphics object, set(next) → persist + apply, renderer() → live BoardRenderer|null }
 */
export function graphicsControls(ctx) {
  const t = strings();
  const info = () => {
    const live = ctx.renderer();
    const p = probeGpu();
    const saved = ctx.get();
    if (live?.graphicsInfo) {
      const gi = live.graphicsInfo();
      return { gpu: gi.gpu || p.gpu, detected: gi.detected, r: gi.resolved, px: gi.pixels[0] ? gi.pixels : null, postFailed: gi.postFailed };
    }
    const r = resolve(saved, p.detected);
    const ratio = Math.min(window.devicePixelRatio || 1, r.dprCap) * r.scale;
    return { gpu: p.gpu, detected: p.detected, r, px: [Math.round(innerWidth * ratio), Math.round(innerHeight * ratio)], postFailed: false };
  };

  const box = el('div', { class: 'gfx-controls', id: 'gfx-controls' });
  const row = (label, control, extra) => el('label', { class: 'gfx-row' }, el('span', {}, label), extra ? el('span', { class: 'gfx-inline' }, control, extra) : control);

  const presetSel = el('select', { id: 'gfx-preset', 'data-gfx': 'preset', 'aria-label': t.quality });
  const scale = el('input', { type: 'range', id: 'gfx-scale', 'data-gfx': 'render_scale', min: 50, max: 200, step: 5, 'aria-label': t.renderScale });
  const scaleOut = el('output', { class: 'gfx-scale-value', for: 'gfx-scale' });
  const catSels = {};
  for (const cat of Object.keys(CATEGORIES)) {
    catSels[cat] = el('select', { id: 'gfx-' + cat, 'data-gfx': cat, 'aria-label': t.cats[cat] });
  }
  const adaptive = el('input', { type: 'checkbox', id: 'gfx-adaptive', 'data-gfx': 'adaptive', 'aria-label': t.adaptive });
  const showFps = el('input', { type: 'checkbox', id: 'gfx-show-fps', 'data-gfx': 'show_fps', 'aria-label': t.showFps });
  const summary = el('p', { class: 'gfx-summary', id: 'gfx-summary', 'aria-live': 'polite' });
  const postNote = el('p', { class: 'gfx-note', id: 'gfx-post-note', hidden: true }, t.postFailed);

  const refresh = () => {
    const saved = ctx.get();
    const i = info();
    presetSel.replaceChildren(
      el('option', { value: 'auto' }, t.auto.replace('{tier}', t.presets[i.detected] || i.detected)),
      ...PRESETS.map((p) => el('option', { value: p }, t.presets[p])));
    presetSel.value = PRESETS.includes(saved.preset) ? saved.preset : 'auto';
    const pct = Math.round((Number(saved.render_scale) || 1) * 100);
    scale.value = String(pct);
    scaleOut.textContent = pct + '%';
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      const sel = catSels[cat];
      const pt = presetTier(i.r.preset, cat);
      sel.replaceChildren(
        el('option', { value: '' }, t.fromPreset.replace('{tier}', t.tiers[pt] || pt)),
        ...tiers.map((v) => el('option', { value: v }, t.tiers[v] || v)));
      sel.value = tiers.includes(saved[cat]) ? saved[cat] : '';
    }
    adaptive.checked = saved.adaptive !== false;
    showFps.checked = !!saved.show_fps;
    summary.textContent = summaryText(t, i.r, i.gpu, i.px);
    postNote.hidden = !i.postFailed;
  };

  const commit = (next) => {
    ctx.set(next);
    refresh();
    // The renderer resizes / rebuilds its post chain on the next frame.
    setTimeout(refresh, 250);
  };

  presetSel.onchange = () => commit(choosePreset(ctx.get(), presetSel.value));
  scale.oninput = () => { scaleOut.textContent = scale.value + '%'; };
  scale.onchange = () => commit({ ...ctx.get(), render_scale: Number(scale.value) / 100 });
  for (const [cat, sel] of Object.entries(catSels)) {
    sel.onchange = () => {
      const next = { ...ctx.get() };
      if (sel.value) next[cat] = sel.value; else delete next[cat];
      commit(next);
    };
  }
  adaptive.onchange = () => commit({ ...ctx.get(), adaptive: adaptive.checked });
  showFps.onchange = () => commit({ ...ctx.get(), show_fps: showFps.checked });

  box.append(
    row(t.quality, presetSel),
    row(t.renderScale, scale, scaleOut),
    ...Object.keys(CATEGORIES).map((cat) => row(t.cats[cat], catSels[cat])),
    row(t.adaptive, adaptive),
    row(t.showFps, showFps),
    summary,
    postNote,
  );
  refresh();
  return { el: box, title: t.title, refresh };
}

/** Resolved preset for the <body data-gfx-preset> marker. */
export function resolvedPreset(saved) {
  return resolve(saved, probeGpu().detected).preset;
}
