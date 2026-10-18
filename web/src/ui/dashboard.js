// The panel's dashboard (dashboard.json in the data folder): Home Assistant controls the
// floor plan has no device for — a fan run by scripts, an infrared AC, media players and a
// row of status — laid out in sections together with the plan's own lights. The native
// shell reads and calls only the entities that file names (ha.states / ha.call).
import './dashboard.css';
import { h } from './dom.js';
import { icon } from './icons.js';
import { MODE_COLORS } from '../three/ac.js';
import { call, post } from '../bridge.js';
import { createLineChart, valueAt } from './linechart.js';

const POLL_MS = 5000;
const HISTORY_MS = 60000; // how often the charts read their hours of history again
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70']; // categorical slots 1-3, validated on the panel surface
const NET_COLORS = { up: '#c98500', down: '#9085e9' };
const POWER_COLOR = '#ffb46b'; // one series: magnitude in a single hue
const BATTERY_COLOR = '#7f9cc9';
const LOW_COLOR = '#e66767'; // critical; always with the word "low"
const ASSUME_MS = 10000; // how long a change shown ahead of Home Assistant waits for it to agree
const OFF = ['off', 'unavailable', 'unknown', 'idle', 'standby', 'power_off', 'none', '0', ''];
const AC_MODES = {
  auto: ['auto', 'Auto', MODE_COLORS.auto], cool: ['cool', 'Cool', MODE_COLORS.cool], save: ['leaf', 'Eco', '#5fe08a'],
  fan: ['fan', 'Fan', MODE_COLORS.fan], dry: ['dry', 'Dry', MODE_COLORS.dry], heat: ['heat', 'Heat', MODE_COLORS.heat],
};
const FAN_LABEL = { auto: 'Fan auto', low: 'Fan low', med: 'Fan med', medium: 'Fan med', high: 'Fan high' };

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ') : '');
const next = (list, value) => list[(list.indexOf(value) + 1) % list.length];

/** `chips`: the panel's tiles for the plan's devices, by device id. */
// The plan's AC modes and fan speeds against the infrared remote's ("save" is cool + eco).
const TO_PLAN_MODE = { auto: 'auto', cool: 'cool', save: 'cool', fan: 'fan', dry: 'dry', heat: 'heat' };
const TO_PLAN_FAN = { auto: 'auto', low: 'low', med: 'medium', medium: 'medium', high: 'high' };
const FROM_PLAN_FAN = { auto: 'auto', low: 'low', medium: 'med', high: 'high', turbo: 'high' };

/**
 * `onStates(get)`: after each read, Home Assistant's states for the 3D model.
 * `onPlanAC(id, state, features)`: the real state of an AC of the plan that a dashboard
 * AC stands behind (`"plan": "<ac id>"`).
 */
export function createDashboard(spec, { chips, onTab = () => {}, onStates = () => {}, onPlanAC = () => {}, menu = null }) {
  const planACs = new Map(); // plan AC id -> (patch, current) => Promise: the panel's AC sheet, sent to the remote
  const ha = {}; // entity id -> { state, attributes, last_updated }
  const assumed = new Map(); // entity id -> { state?, attributes?, at }
  const updaters = [];
  const used = new Set();
  let offline = null;

  function view(id) {
    const base = ha[id] || { state: 'unknown', attributes: {} };
    const a = assumed.get(id);
    if (!a) return base;
    return { ...base, state: a.state ?? base.state, attributes: { ...base.attributes, ...(a.attributes || {}) } };
  }
  const state = (id) => (id ? view(id).state : undefined);
  const attr = (id, key) => (id ? view(id).attributes?.[key] : undefined);

  // Shows a change at once; Home Assistant's next newer report (or a timeout) replaces it.
  function assume(id, patch) {
    if (!id) return;
    const before = assumed.get(id) || {};
    assumed.set(id, { ...before, ...patch, attributes: { ...before.attributes, ...patch.attributes }, at: Date.now() });
    render();
  }

  /* ---------- talking to Home Assistant ---------- */

  const ids = new Set();
  JSON.stringify(spec, (k, v) => { if (typeof v === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(v)) ids.add(v); return v; });

  let inflight = null;
  let again = false;
  async function refresh() {
    if (inflight) { again = true; return inflight; }
    inflight = (async () => {
      try {
        const { states } = await call('ha.states', { ids: [...ids] });
        for (const key of Object.keys(ha)) if (!(key in states)) delete ha[key];
        Object.assign(ha, states);
        offline = null;
        const now = Date.now();
        for (const [id, a] of assumed) {
          const updated = Date.parse(ha[id]?.last_updated || '') || 0;
          if (updated > a.at - 300 || now - a.at > ASSUME_MS) assumed.delete(id);
        }
      } catch (error) {
        offline = error.message;
      }
      render();
    })();
    await inflight;
    inflight = null;
    if (again) { again = false; refresh(); }
  }

  const later = (ms) => setTimeout(refresh, ms);
  async function act(card, domain, service, data = {}) {
    try {
      await call('ha.call', { domain, service, data });
    } catch (error) {
      card?.fail(error.message);
    }
    later(350);
    later(2000);
  }
  const runScript = (card, id, variables) => act(card, 'script', 'turn_on', variables ? { entity_id: id, variables } : { entity_id: id });

  // Coalesces repeated clicks (temperature, volume) into one call after a short pause.
  function debounced(ms, fn) {
    let t = 0;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ---------- building blocks ---------- */

  const button = (name, label, onclick, size = 13) => h('button.chip-step', {
    'aria-label': label, title: label, onclick: (e) => { e.stopPropagation(); onclick(); },
  }, icon(name, size, 2.4));

  function card(kind, color, ...children) {
    const sub = h('div.chip-sub');
    const name = h('div.chip-name');
    const bubble = h('span.chip-bubble');
    const el = h(`div.chip.dash-card.${kind}`, { vars: { '--c': color } }, bubble, h('div.chip-text', name, sub), ...children);
    let shownIcon = null;
    let failure = null;
    return {
      el, sub, name,
      icon(nameOfIcon) { if (shownIcon !== nameOfIcon) { bubble.replaceChildren(icon(nameOfIcon, 15)); shownIcon = nameOfIcon; } },
      fail(message) {
        failure = message;
        el.classList.add('fail');
        sub.textContent = message;
        sub.title = message;
        setTimeout(() => { failure = null; el.classList.remove('fail'); render(); }, 3500);
      },
      get failing() { return failure !== null; },
      setSub(...nodes) { if (failure === null) { sub.replaceChildren(...nodes); sub.title = sub.textContent; } },
    };
  }

  const power = (label, onclick) => h('button.chip-power', { 'aria-label': label, title: label, onclick: (e) => { e.stopPropagation(); onclick(); } }, icon('power', 13, 2.4));

  /* ---------- widgets ---------- */

  // A fan driven by scripts; `status` says whether it runs ("1"/"on"), `watts` what it draws.
  function fan(w) {
    const c = card('fan', w.color || '#7dd3fc',
      w.minus && button('minus', 'Slower', () => runScript(c, w.minus)),
      w.plus && button('plus', 'Faster', () => runScript(c, w.plus)),
      w.reverse && button('reverse', 'Reverse', () => runScript(c, w.reverse)),
      power(`${w.name} power`, () => {
        const on = !OFF.includes(state(w.status));
        assume(w.status, { state: on ? '0' : '1' });
        runScript(c, on ? w.off : w.on);
      }));
    c.icon('fan');
    c.name.textContent = w.name || 'Fan';
    return {
      el: c.el,
      update() {
        const on = !OFF.includes(state(w.status));
        const watts = num(state(w.watts));
        c.el.classList.toggle('on', on);
        // The speed, read from what it draws (`levels`: [low|medium, medium|high] in W).
        const speed = watts != null && w.levels ? (watts < w.levels[0] ? 'Low' : watts < w.levels[1] ? 'Medium' : 'High') : null;
        c.setSub(on ? ['On', speed, watts != null ? `${Math.round(watts)} W` : null].filter(Boolean).join(' · ') : 'Off');
      },
    };
  }

  // An infrared AC behind a script that takes what to change (ligado, modo, temperatura,
  // ventilacao) and keeps its state in helpers: power, mode, fan and target.
  function ac(w) {
    const f = { power: 'ligado', mode: 'modo', target: 'temperatura', fan: 'ventilacao', sleep: 'sleep', ...(w.fields || {}) };
    if (w.plan) {
      used.add(w.plan);
      // The AC of the 3D model and its sheet: what they change goes to the same script.
      planACs.set(w.plan, async (patch, current) => {
        const variables = {};
        if ('on' in patch) variables[f.power] = Boolean(patch.on);
        if ('target' in patch) variables[f.target] = Math.round(patch.target);
        if ('mode' in patch || 'eco' in patch) {
          const mode = patch.mode ?? current.mode;
          variables[f.mode] = (patch.eco ?? current.eco) && mode === 'cool' ? 'save' : mode;
        }
        if ('fan' in patch) variables[f.fan] = FROM_PLAN_FAN[patch.fan] || 'auto';
        if ('sleep' in patch && w.sleep) variables[f.sleep] = Boolean(patch.sleep);
        if (!Object.keys(variables).length) return;
        await call('ha.call', { domain: 'script', service: 'turn_on', data: { entity_id: w.script, variables } });
        later(400);
        later(2000);
      });
    }
    const send = (variables) => runScript(c, w.script, variables);
    const sendTarget = debounced(700, (t) => send({ [f.target]: t }));
    const step = (d) => () => {
      const t = num(state(w.target)) ?? 24;
      const goal = Math.min(attr(w.target, 'max') ?? 30, Math.max(attr(w.target, 'min') ?? 16, t + d));
      assume(w.target, { state: String(goal) });
      sendTarget(goal);
    };
    const modeBtn = h('button.dash-opt', { title: 'Next mode', onclick: (e) => {
      e.stopPropagation();
      const m = next(attr(w.mode, 'options') || Object.keys(AC_MODES), state(w.mode));
      assume(w.mode, { state: m });
      send({ [f.mode]: m });
    } });
    const fanBtn = h('button.dash-opt', { title: 'Next fan speed', onclick: (e) => {
      e.stopPropagation();
      const s = next(attr(w.fan, 'options') || ['auto', 'low', 'med', 'high'], state(w.fan));
      assume(w.fan, { state: s });
      send({ [f.fan]: s });
    } });
    const value = h('span.chip-value');
    const c = card('ac', MODE_COLORS.cool,
      button('minus', 'Cooler', step(-1)), value, button('plus', 'Warmer', step(1)),
      power(`${w.name} power`, () => {
        const on = state(w.power) === 'on';
        assume(w.power, { state: on ? 'off' : 'on' });
        send({ [f.power]: !on });
      }));
    c.name.textContent = w.name || 'AC';
    return {
      el: c.el,
      update() {
        const on = state(w.power) === 'on';
        const [iconName, label, color] = AC_MODES[state(w.mode)] || ['ac', cap(state(w.mode)), MODE_COLORS.cool];
        c.icon(iconName);
        c.el.style.setProperty('--c', color);
        c.el.classList.toggle('on', on);
        const t = num(state(w.target));
        value.textContent = t != null ? `${Math.round(t)}°` : '–';
        modeBtn.textContent = label;
        fanBtn.textContent = FAN_LABEL[state(w.fan)] || cap(state(w.fan));
        const room = num(state(w.room));
        const watts = num(state(w.watts));
        c.el.title = watts != null ? `Drawing ${Math.round(watts)} W` : '';
        c.setSub(on ? '' : 'Off · ', modeBtn, ' · ', fanBtn, room != null ? ` · ${room.toFixed(1)}° in` : '');
        if (w.plan && ha[w.power]) {
          onPlanAC(w.plan, {
            on, target: t ?? 24, mode: TO_PLAN_MODE[state(w.mode)] || 'cool', eco: state(w.mode) === 'save',
            fan: TO_PLAN_FAN[state(w.fan)] || 'auto', ...(w.sleep ? { sleep: state(w.sleep) === 'on' } : {}),
          }, { modes: ['cool', 'dry', 'fan', 'auto'], fans: ['auto', 'low', 'medium', 'high'], sleep: Boolean(w.sleep), eco: true, swing: false });
        }
      },
    };
  }

  // A media player: what is playing, play/pause, skip and volume.
  function media(w) {
    const id = w.entity;
    const vol = h('span.dash-vol');
    const sendVolume = debounced(350, (v) => act(c, 'media_player', 'volume_set', { entity_id: id, volume_level: v }));
    const volume = (d) => () => {
      const v = Math.round(Math.min(1, Math.max(0, (attr(id, 'volume_level') ?? 0) + d)) * 100) / 100;
      assume(id, { attributes: { volume_level: v } });
      sendVolume(v);
    };
    const playBtn = h('button.chip-step', { 'aria-label': 'Play or pause', title: 'Play / pause', onclick: (e) => {
      e.stopPropagation();
      assume(id, { state: state(id) === 'playing' ? 'paused' : 'playing' });
      act(c, 'media_player', 'media_play_pause', { entity_id: id });
    } });
    const progress = h('i.chip-level');
    // `favorite: {press, state}`: a heart that marks the song playing (a button entity) and shows
    // whether it is already a favourite (a binary sensor).
    const heart = w.favorite ? h('button.chip-step', { 'aria-label': 'Favourite', title: 'Favourite this song', onclick: (e) => {
      e.stopPropagation();
      assume(w.favorite.state, { state: 'on' });
      act(c, 'button', 'press', { entity_id: w.favorite.press });
    } }, icon('heart', 13, 2.4)) : null;
    const c = card('media', w.color || '#c084fc', heart,
      button('prev', 'Previous', () => act(c, 'media_player', 'media_previous_track', { entity_id: id })),
      playBtn,
      button('skip', 'Next', () => act(c, 'media_player', 'media_next_track', { entity_id: id })),
      button('minus', 'Volume down', volume(-0.04)), vol, button('plus', 'Volume up', volume(0.04)),
      progress);
    c.icon('music');
    let shownPlay = null;
    return {
      el: c.el,
      update() {
        const s = state(id);
        const playing = s === 'playing';
        c.el.classList.toggle('on', playing);
        if (shownPlay !== playing) { playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 13, 2.4)); shownPlay = playing; }
        if (heart) heart.classList.toggle('active', state(w.favorite.state) === 'on');
        const title = attr(id, 'media_title');
        const artist = attr(id, 'media_artist');
        c.name.textContent = title || w.name || 'Music';
        const where = w.name || attr(id, 'friendly_name') || '';
        c.setSub(OFF.includes(s) && s !== 'idle' ? 'Off' : [title ? artist : cap(s), where].filter(Boolean).join(' · '));
        const v = attr(id, 'volume_level');
        vol.textContent = v != null ? `${Math.round(v * 100)}%` : '–';
        this.tick();
      },
      tick() {
        const duration = attr(id, 'media_duration');
        let position = attr(id, 'media_position');
        if (!duration || position == null) { progress.style.setProperty('--level', '0'); return; }
        if (state(id) === 'playing') position += (Date.now() - (Date.parse(attr(id, 'media_position_updated_at')) || Date.now())) / 1000;
        progress.style.setProperty('--level', String(Math.min(1, position / duration)));
      },
    };
  }

  // A TV: power, inputs, volume and mute, and the switch that blanks its screen.
  function tv(w) {
    const id = w.entity;
    const labels = w.sources || {};
    const sources = h('div.dash-src');
    let shownSources = '';
    const mute = h('button.chip-step', { 'aria-label': 'Mute', title: 'Mute', onclick: (e) => {
      e.stopPropagation();
      const muted = Boolean(attr(id, 'is_volume_muted'));
      assume(id, { attributes: { is_volume_muted: !muted } });
      act(c, 'media_player', 'volume_mute', { entity_id: id, is_volume_muted: !muted });
    } }, icon('mute', 13, 2.4));
    const screen = w.screen && h('button.chip-step', { 'aria-label': 'Screen', title: 'Screen on / off (picture only)', onclick: (e) => {
      e.stopPropagation();
      const on = state(w.screen) === 'on';
      assume(w.screen, { state: on ? 'off' : 'on' });
      act(c, 'switch', on ? 'turn_off' : 'turn_on', { entity_id: w.screen });
    } }, icon('monitorOff', 13, 2.4));
    const c = card('tv', w.color || '#60a5fa',
      sources,
      button('minus', 'Volume down', () => act(c, 'media_player', 'volume_down', { entity_id: id })),
      button('plus', 'Volume up', () => act(c, 'media_player', 'volume_up', { entity_id: id })),
      mute, screen,
      w.playPause && button('play', 'Play / pause', () => act(c, 'media_player', 'media_play_pause', { entity_id: id })),
      power(`${w.name} power`, () => {
        const on = !OFF.includes(state(id));
        assume(id, { state: on ? 'off' : 'on' });
        act(c, 'media_player', on ? 'turn_off' : 'turn_on', { entity_id: id });
      }));
    c.icon('tv');
    c.name.textContent = w.name || 'TV';
    return {
      el: c.el,
      update() {
        const s = state(id);
        const on = !OFF.includes(s);
        c.el.classList.toggle('on', on);
        const list = (attr(id, 'source_list') || []).filter((x) => !(w.hideSources || []).includes(x));
        if (list.join('|') !== shownSources) {
          shownSources = list.join('|');
          sources.replaceChildren(...list.map((src) => h('button', { title: src, 'data-src': src, onclick: (e) => {
            e.stopPropagation();
            assume(id, { attributes: { source: src } });
            act(c, 'media_player', 'select_source', { entity_id: id, source: src });
          } }, labels[src] || src.replace(/^HDMI\s*/, 'HDMI ').replace(/ Game Console$/i, ''))));
        }
        for (const b of sources.children) b.classList.toggle('active', on && b.dataset.src === attr(id, 'source'));
        sources.hidden = !on;
        const muted = Boolean(attr(id, 'is_volume_muted'));
        mute.classList.toggle('active', muted);
        if (screen) screen.classList.toggle('active', state(w.screen) === 'off');
        const v = attr(id, 'volume_level');
        c.setSub(on ? [attr(id, 'source'), muted ? 'Muted' : v != null ? `Vol ${Math.round(v * 100)}` : null,
          w.screen && state(w.screen) === 'off' ? 'Screen off' : null].filter(Boolean).join(' · ') || 'On' : 'Off');
      },
    };
  }

  // A row of read-only pills: is something on, and how (a washer's phase, a plug's watts).
  function status(w) {
    const row = h('div.dash-status');
    const items = (w.items || []).map((item) => {
      const value = h('span.v');
      const el = h('div.pill-stat', { vars: { '--c': item.color || '#5fe08a' }, title: item.entity },
        h('i.dot'), icon(item.icon || 'activity', 13, 2.2), h('b', item.name), value);
      row.append(el);
      return () => {
        const s = state(item.entity);
        let on;
        let text;
        if (item.above != null) {
          const n = num(s);
          on = n != null && n > item.above;
          text = on ? `${Math.round(n)}${item.unit ? ` ${item.unit}` : ''}` : (item.labels?.off || 'Off');
        } else {
          on = !(item.off || OFF).includes(s);
          text = item.labels?.[s] ?? cap(s);
        }
        const level = item.battery ? num(state(item.battery)) : null; // `battery`: a % sensor shown beside the state
        if (level != null) text += ` · ${Math.round(level)}%`;
        const left = item.remaining && on ? state(item.remaining) : null;
        if (left && /^\d+:\d\d/.test(left) && !/^0:00/.test(left)) text += ` · ${left.split(':').slice(0, 2).join(':')} left`;
        el.classList.toggle('on', on);
        value.textContent = text;
      };
    });
    return { el: row, update() { items.forEach((fn) => fn()); } };
  }

  // The plan's own lights (and ACs), by their ids in the plan.
  function lights(w) {
    const cols = w.columns || Math.min(3, (w.ids || []).length || 1);
    const grid = h(`div.dash-lights${cols >= 3 ? '.many' : ''}`, { vars: { '--cols': String(cols) } });
    for (const id of w.ids || []) {
      const chip = chips.get(id);
      if (!chip) continue;
      used.add(id);
      grid.append(chip);
    }
    return { el: grid };
  }

  // A computer: whether it is on (any of `status`), what it is doing (`cpu`, `gpu` in %), a
  // button that wakes it (`wake`: a script sending Wake-on-LAN) while it is off and, with
  // `screen: {entity, source}`, one that puts it on that TV's input while it is on.
  // `power`: a media player switched with turn_on / turn_off (an Xbox) instead of a wake script;
  // it then also gets an off button, and shows what it is playing.
  function computer(w) {
    const ids = [].concat(w.status || w.power || []);
    let wakingSince = 0;
    const wake = h('button.dash-wake', { title: w.power ? 'Turn it on' : 'Wake it up (Wake-on-LAN)', onclick: (e) => {
      e.stopPropagation();
      wakingSince = Date.now();
      if (w.power) act(c, 'media_player', 'turn_on', { entity_id: w.power });
      else runScript(c, w.wake);
      render();
    } }, icon('power', 13, 2.4), h('span', 'Wake'));
    const off = w.power ? power(`${w.name} power`, () => {
      assume(w.power, { state: 'off' });
      act(c, 'media_player', 'turn_off', { entity_id: w.power });
    }) : null;
    const toTv = w.screen ? h('button.dash-wake.alt', { title: `Show it on the TV (${w.screen.source})`, onclick: (e) => {
      e.stopPropagation();
      assume(w.screen.entity, { attributes: { source: w.screen.source } });
      act(c, 'media_player', 'select_source', { entity_id: w.screen.entity, source: w.screen.source });
    } }, icon('tv', 13, 2.2), h('span', 'On TV')) : null;
    const c = card('pc', w.color || '#8b7bff', toTv, wake, off);
    c.icon(w.icon || 'monitor');
    c.name.textContent = w.name || 'Computer';
    return {
      el: c.el,
      update() {
        const on = ids.some((id) => !OFF.includes(state(id)));
        if (on) wakingSince = 0;
        const waking = !on && wakingSince && Date.now() - wakingSince < 120000;
        c.el.classList.toggle('on', on);
        wake.hidden = on;
        if (off) off.hidden = !on;
        if (toTv) {
          toTv.hidden = !on;
          const showing = attr(w.screen.entity, 'source') === w.screen.source && !OFF.includes(state(w.screen.entity));
          toTv.classList.toggle('active', showing);
          toTv.lastChild.textContent = showing ? 'On TV ✓' : 'On TV';
        }
        wake.disabled = Boolean(waking);
        wake.lastChild.textContent = waking ? 'Waking…' : 'Wake';
        const cpu = num(state(w.cpu));
        const gpu = num(state(w.gpu));
        const playing = w.power && (attr(w.power, 'media_title') || attr(w.power, 'app_name'));
        c.el.classList.toggle('stats', on && (cpu != null || gpu != null)); // a long status: on a phone the buttons drop below it
        c.setSub(on ? ['On', playing || null, cpu != null ? `CPU ${Math.round(cpu)}%` : null, gpu != null ? `GPU ${Math.round(gpu)}%` : null].filter(Boolean).join(' · ')
          : waking ? 'Waking up…' : 'Off');
      },
    };
  }

  // A switch with what it draws (an AC on a smart plug): on/off and its watts.
  // `plan`: an AC of the plan it powers; the model shows it on (and blowing) while the switch is.
  function toggle(w) {
    if (w.plan) used.add(w.plan); // it stands for that plan AC: no extra tile under "Other"
    if (w.plan) {
      planACs.set(w.plan, async (patch) => {
        if (!('on' in patch)) return;
        await call('ha.call', { domain: 'switch', service: patch.on ? 'turn_on' : 'turn_off', data: { entity_id: w.entity } });
        later(400);
        later(2000);
      });
    }
    const sw = power(`${w.name} power`, () => {
      const on = state(w.entity) === 'on';
      assume(w.entity, { state: on ? 'off' : 'on' });
      act(c, 'switch', on ? 'turn_off' : 'turn_on', { entity_id: w.entity });
    });
    const c = card('toggle', w.color || '#7dd3fc', sw);
    c.icon(w.icon || 'plug');
    c.name.textContent = w.name;
    return {
      el: c.el,
      update() {
        const on = state(w.entity) === 'on';
        const watts = num(state(w.watts));
        c.el.classList.toggle('on', on);
        const gone = ['unavailable', 'unknown'].includes(state(w.entity)); // unplugged, or the plug is off the network
        c.el.classList.toggle('gone', gone);
        c.setSub(on ? ['On', watts != null ? `${Math.round(watts)} W` : null].filter(Boolean).join(' · ') : gone ? 'Offline' : 'Off');
        if (w.plan && ha[w.entity]) {
          onPlanAC(w.plan, { on, target: 23, mode: 'cool', eco: false, fan: 'auto' },
            { modes: ['cool'], fans: ['auto'], sleep: false, eco: false, swing: false });
        }
      },
    };
  }

  // A row of one-tap shortcuts, each running a script with its fields (a playlist, an artist).
  function actions(w) {
    const row = h('div.dash-actions');
    for (const a of w.items || []) {
      row.append(h('button.dash-action', { title: a.title || a.label, onclick: () => runScript(null, a.script || w.script, { ...(w.variables || {}), ...(a.variables || {}) }) },
        a.icon ? icon(a.icon, 13, 2.2) : null, h('span', a.label)));
    }
    return { el: row };
  }

  // A robot vacuum in one card: its state and battery, start / pause, back to the dock and locate;
  // and, when the integration can clean one room (`vacuum.clean_area`), a chip per room under it.
  // `rooms: [{name, area}]`, `area` being the Home Assistant area id; `battery`: a % sensor.
  function vacuumControl(w) {
    const id = w.entity;
    const CLEAN_AREA = 16384;
    const labels = { docked: 'Na base', cleaning: 'Limpando', returning: 'Voltando', paused: 'Pausado', idle: 'Parado', error: 'Erro', ...(w.labels || {}) };
    const run = (service, data = {}) => act(c, 'vacuum', service, { entity_id: id, ...data });
    const main = button('play', 'Iniciar', () => run(state(id) === 'cleaning' ? 'pause' : 'start'));
    const c = card('vacuum', w.color || '#5fe08a', main,
      button('home', 'Voltar à base', () => run('return_to_base')),
      button('bell', 'Localizar', () => run('locate')));
    c.icon('sparkles');
    c.name.textContent = w.name || 'Aspirador';
    const rooms = h('div.dash-actions', (w.rooms || []).map((r) =>
      h('button.dash-action', { title: `Aspirar ${r.name}`, onclick: () => run('clean_area', { cleaning_area_id: [].concat(r.area) }) }, h('span', r.name))));
    const el = h('div.dash-vacuum', { style: { gridColumn: '1 / -1', display: 'grid', gap: '6px' } }, c.el, rooms);
    return {
      el,
      update() {
        const s = state(id);
        const cleaning = s === 'cleaning';
        main.replaceChildren(icon(cleaning ? 'pause' : 'play', 13, 2.4));
        main.title = cleaning ? 'Pausar' : 'Iniciar';
        main.setAttribute('aria-label', main.title);
        c.el.classList.toggle('on', cleaning);
        const level = w.battery ? num(state(w.battery)) : null;
        c.setSub([labels[s] ?? cap(s), level != null ? `${Math.round(level)}%` : null].filter(Boolean).join(' · '));
        rooms.hidden = !(((Number(attr(id, 'supported_features')) || 0) & CLEAN_AREA) && (w.rooms || []).length);
      },
    };
  }

  // The washing machine (LG): its phase and time left, start / pause / resume, wake and power off
  // (through a script taking `acao`), the programme to run, the delayed end, and its counters.
  function washer(w) {
    const f = w.fields || { action: 'acao' };
    const labels = w.labels || {};
    const RUNNING = ['running', 'rinsing', 'spinning', 'drying', 'steam_softening', 'detecting', 'refreshing', 'cool_down', 'rinse_hold'];
    const run = (verb) => runScript(c, w.script, { [f.action]: verb });
    const main = h('button.dash-wake', { onclick: (e) => {
      e.stopPropagation();
      const s = state(w.status);
      run(RUNNING.includes(s) ? w.verbs?.pause || 'pausar' : w.verbs?.start || 'iniciar');
    } }, icon('play', 13, 2.4), h('span'));
    const wake = button('bell', 'Wake it up', () => run(w.verbs?.wake || 'acordar'));
    const off = power('Power off', () => run(w.verbs?.off || 'desligar'));
    const c = card('washer', w.color || '#5fe08a', main, wake, off);
    c.icon('washer');
    c.name.textContent = w.name || 'Washer';
    // second line: the programme and the delayed end
    const course = h('button.dash-opt', { title: 'Programme', onclick: (e) => {
      e.stopPropagation();
      const options = (attr(w.course, 'options') || []).filter((o) => o !== 'Current course');
      const pick = (o) => { assume(w.course, { state: o }); act(c, 'select', 'select_option', { entity_id: w.course, option: o }); };
      if (menu) menu(course, options.map((o) => ({ label: o, selected: state(w.course) === o, action: () => pick(o) })));
      else pick(next(options, state(w.course)));
    } });
    const delayValue = h('span.dash-vol');
    const setDelay = (d) => () => {
      const v = num(state(w.delay)) || 0;
      const lo = attr(w.delay, 'min') ?? 3;
      const hi = attr(w.delay, 'max') ?? 19;
      const goal = v === 0 && d > 0 ? lo : Math.min(hi, Math.max(0, v + d < lo ? 0 : v + d));
      assume(w.delay, { state: String(goal) });
      act(c, 'number', 'set_value', { entity_id: w.delay, value: goal });
    };
    const stats = h('div.washer-stats');
    const extra = h('div.washer-row', h('span.washer-k', 'Programme'), course,
      h('span.washer-k', 'Ends in'), button('minus', 'Earlier', setDelay(-1)), delayValue, button('plus', 'Later', setDelay(1)));
    c.el.append(extra, stats);
    return {
      el: c.el,
      update() {
        const s = state(w.status);
        const running = RUNNING.includes(s);
        const paused = s === 'pause';
        const offline = ['unavailable', 'unknown', ''].includes(s ?? '');
        c.el.classList.toggle('on', running || paused);
        // the programme and the delayed end only mean something while the machine is awake
        extra.hidden = offline || ['power_off', 'sleep', 'off'].includes(s);
        const left = state(w.remaining);
        const leftText = left && /^\d+:\d\d/.test(left) && !/^0:00/.test(left) ? `${left.split(':').slice(0, 2).join(':')} left` : null;
        c.setSub([labels[s] ?? cap(s), (running || paused) ? leftText : null,
          w.remoteStart && !offline && !running && !paused && state(w.remoteStart) !== 'on' ? 'remote start off' : null].filter(Boolean).join(' · '));
        main.lastChild.textContent = running ? (w.words?.pause || 'Pause') : paused ? (w.words?.resume || 'Resume') : (w.words?.start || 'Start');
        main.firstChild.replaceWith(icon(running ? 'pause' : 'play', 13, 2.4));
        const prog = state(w.course);
        course.textContent = prog && !['unavailable', 'unknown', 'Current course'].includes(prog) ? prog : '—';
        const d = num(state(w.delay)) || 0;
        delayValue.textContent = d ? `${d} h` : 'off';
        const kwh = (id) => { const v = num(state(id)); return v == null ? null : `${(v / 1000).toFixed(1)} kWh`; };
        stats.textContent = [
          w.cycles && num(state(w.cycles)) != null ? `${num(state(w.cycles))} ${num(state(w.cycles)) === 1 ? 'wash' : 'washes'}` : null,
          w.tubClean && num(state(w.tubClean)) != null ? `tub clean ${num(state(w.tubClean))}` : null,
          w.energyToday && kwh(w.energyToday) ? `today ${kwh(w.energyToday)}` : null,
          w.energyMonth && kwh(w.energyMonth) ? `month ${kwh(w.energyMonth)}` : null,
        ].filter(Boolean).join(' · ');
      },
    };
  }

  /* ---------- NAS / network ---------- */

  // A few facts at a glance: one value per tile, with an optional copy button, a detail
  // line (an attribute) and an online dot with its word.
  function glance(w) {
    const row = h('div.dash-glance');
    const items = (w.items || []).map((item) => {
      const value = h('div.glance-value');
      const detail = h('div.glance-detail');
      const dot = item.status ? h('i.dot') : null;
      const copy = item.copy ? h('button.chip-step', { title: 'Copy', 'aria-label': `Copy ${item.name}`, onclick: (e) => {
        e.stopPropagation();
        const text = state(item.entity);
        if (!text || OFF.includes(text)) return;
        post('dashboard.copy', { text });
        copy.replaceChildren(icon('check', 13, 2.4));
        setTimeout(() => copy.replaceChildren(icon('copy', 13, 2.2)), 1400);
      } }, icon('copy', 13, 2.2)) : null;
      row.append(h('div.glance', h('div.glance-label', item.name), h('div.glance-line', value, copy), h('div.glance-sub', dot, detail)));
      return () => {
        const raw = state(item.entity);
        const missing = raw == null || ['unknown', 'unavailable', ''].includes(raw);
        let text = missing ? '–' : String(raw);
        if (!missing && item.strip) text = text.replace(new RegExp(item.strip), '');
        if (!missing && item.unit) { const n = num(raw); text = n != null ? `${n.toFixed(item.decimals ?? 0)} ${item.unit}` : text; }
        value.textContent = text;
        value.title = text;
        if (item.status) {
          const s = state(item.status);
          const up = !OFF.includes(s) && !['offline', 'down'].includes(s);
          dot.classList.toggle('on', up);
          detail.textContent = cap(s);
        } else {
          detail.textContent = item.detail ? (attr(item.entity, item.detail) || '') : (item.note || '');
        }
        detail.title = detail.textContent;
      };
    });
    return { el: row, update() { items.forEach((fn) => fn()); } };
  }

  // Reads a widget's hours of history now and then; between reads the live readings extend it.
  function history(ids, hours) {
    const data = {};
    let loadedAt = 0;
    return {
      data,
      get stale() { return Date.now() - loadedAt > HISTORY_MS; },
      async load() {
        loadedAt = Date.now();
        try {
          const { history: got } = await call('ha.history', { ids, hours });
          for (const id of ids) data[id] = got[id] || [];
        } catch { loadedAt = 0; }
      },
      // The latest reading, appended so the line reaches "now" between history reads.
      tail() {
        const now = Date.now();
        for (const id of ids) {
          const v = num(state(id));
          const points = data[id] || (data[id] = []);
          if (v == null) continue;
          if (!points.length || now - points[points.length - 1][0] > 15000) points.push([now, v]);
          while (points.length > 2 && points[1][0] < now - hours * 3600000) points.shift();
        }
      },
    };
  }

  // The panel's room filter. An entry (section, widget, chart series, power item) with `room`
  // shows for that room; with `only: "all"` only for the whole home; with `only: "room"` only
  // when a room is picked. Entries naming neither stay in view for the whole home.
  let roomSel = 'all';
  const visible = (x) => (roomSel === 'all' ? x.only !== 'room' : x.room === roomSel && x.only !== 'all');
  const filtered = (x) => x.room != null || x.only != null; // has something to filter by
  const roomAware = []; // { el, spec } hidden by the room filter, and widgets that redraw on it

  // Percentages over the last hours on one axis (CPU, memory, GPU...), labelled at the end.
  function chart(w) {
    const series = (w.series || []).map((s, i) => ({ ...s, color: s.color || SERIES_COLORS[i % SERIES_COLORS.length] }));
    const hours = w.hours || 3;
    const unit = w.unit ?? '%';
    const store = history(series.map((s) => s.entity), hours);
    const plot = createLineChart({
      height: w.height || 140, yMax: w.max ?? (unit === '%' ? 100 : null),
      format: (v) => `${Math.round(v)}${unit}`, label: w.title || series.map((s) => s.name).join(', '),
    });
    const legend = h('div.chart-legend');
    const el = h('div.dash-chart', h('div.chart-head', h('span.chart-title', w.title || `Last ${hours} h`), legend), plot.el);
    const shown = () => series.filter(visible);
    const draw = () => {
      store.tail();
      const now = Date.now();
      const mine = shown();
      legend.replaceChildren(...mine.map((s) => h('span.chart-key', h('i', { vars: { '--c': s.color } }), s.name)));
      el.hidden = !mine.length; // nothing to plot for this room
      plot.render(mine.map((s) => ({ name: s.name, color: s.color, points: store.data[s.entity] || [] })), now - hours * 3600000, now);
    };
    return { el, history: store, draw, setRoom: draw, update: () => { if (el.isConnected && el.offsetParent) draw(); } };
  }

  // Network throughput: up, down and their sum now, the data moved in the window, and the
  // two directions over time (one unit, one axis).
  function net(w) {
    const hours = w.hours || 3;
    const unit = w.unit || 'Mbit/s';
    const store = history([w.up, w.down], hours);
    const cells = ['up', 'down', 'sum'].map((key) => {
      const value = h('b');
      const sub = h('span.net-sub');
      const keyMark = key === 'sum' ? h('i.net-key.sum') : h('i.net-key', { vars: { '--c': NET_COLORS[key] } });
      return { key, value, sub, el: h('div.net-cell', h('div.net-label', keyMark, { up: 'Up', down: 'Down', sum: 'Up + down' }[key]), h('div.net-value', value, h('small', unit)), sub) };
    });
    const plot = createLineChart({ height: w.height || 64, compact: true, format: (v) => `${v.toFixed(1)} ${unit}`, label: 'Network' });
    const el = h('div.dash-net', h('div.net-cells', cells.map((c) => c.el)), plot.el);
    // Mbit/s held until the next reading, integrated over the window: gigabytes moved.
    const moved = (points, t0, t1) => {
      let mbit = 0;
      for (let i = 0; i < points.length; i++) {
        const a = Math.max(points[i][0], t0);
        const b = Math.min(i + 1 < points.length ? points[i + 1][0] : t1, t1);
        if (b > a) mbit += points[i][1] * ((b - a) / 1000);
      }
      return mbit / 8 / 1000; // Mbit -> MB -> GB
    };
    const gb = (v) => (v >= 10 ? `${v.toFixed(0)} GB` : v >= 1 ? `${v.toFixed(1)} GB` : `${Math.round(v * 1000)} MB`);
    const draw = () => {
      store.tail();
      const now = Date.now();
      const t0 = now - hours * 3600000;
      const up = store.data[w.up] || [];
      const down = store.data[w.down] || [];
      const vUp = num(state(w.up));
      const vDown = num(state(w.down));
      const totals = { up: moved(up, t0, now), down: moved(down, t0, now) };
      totals.sum = totals.up + totals.down;
      const now3 = { up: vUp, down: vDown, sum: vUp != null && vDown != null ? vUp + vDown : null };
      for (const c of cells) {
        c.value.textContent = now3[c.key] != null ? now3[c.key].toFixed(1) : '–';
        c.sub.textContent = `${gb(totals[c.key])} in ${hours} h`;
      }
      plot.render([{ name: 'Up', color: NET_COLORS.up, points: up }, { name: 'Down', color: NET_COLORS.down, points: down }], t0, now,
        (t) => {
          const a = valueAt(up, t);
          const b = valueAt(down, t);
          return a != null && b != null ? [[{ name: 'Up + down', color: null }, a + b]] : [];
        });
    };
    return { el, history: store, draw, update: () => { if (el.isConnected && el.offsetParent) draw(); } };
  }

  // Shortcuts to web apps (the NAS containers): a dot says whether each answers; a click
  // opens it in the browser and closes the panel.
  function links(w) {
    const grid = h('div.dash-links', { vars: { '--cols': String(w.columns || 3) } });
    const items = (w.items || []).map((item) => {
      const dot = h('i.dot');
      const note = h('span.link-note');
      const el = h('button.dash-link', { title: item.url, onclick: () => post('dashboard.open', { url: item.url }) },
        dot, h('span.link-name', item.name), note);
      grid.append(el);
      return () => {
        if (!item.status) { el.classList.add('plain'); return; }
        const known = ha[item.status] != null;
        el.classList.toggle('plain', !known); // no such sensor (yet): no verdict either way
        // A binary sensor ("on"), or a number above `above` (a container's memory in use).
        const up = item.above != null ? (num(state(item.status)) ?? 0) > item.above : state(item.status) === 'on';
        dot.classList.toggle('on', up);
        // Started only when needed (`onDemand`): stopped is normal there, so it is "off", not "down".
        el.classList.toggle('down', known && !up && !item.onDemand);
        el.classList.toggle('idle', known && !up && Boolean(item.onDemand));
        note.textContent = known && !up ? (item.onDemand ? 'off' : 'down') : '';
      };
    });
    return { el: grid, update() { items.forEach((fn) => fn()); } };
  }

  /* ---------- energy ---------- */

  // What each device draws now, as bars sorted by size, and the total over the last hours.
  // `total`: the whole-home meter. For the whole home it is then the figure shown (not the sum
  // of the devices), and `rest` (a label) adds a bar for what no device meter accounts for:
  // the meter minus every device. For one room the figure is the sum of that room's devices.
  function powerUse(w) {
    const items = w.items || [];
    const hours = w.hours || 3;
    const store = history([...items.map((i) => i.entity), ...(w.total ? [w.total] : [])], hours);
    const total = h('b');
    const plot = createLineChart({ height: 40, compact: true, format: (v) => `${Math.round(v)} W`, label: 'Total power' });
    const makeRow = (item) => {
      const fill = h('i.bar-fill');
      const value = h('span.bar-value');
      const el = h('div.bar-row', h('span.bar-name', item.name), h('span.bar-track', fill), value);
      return { item, el, fill, value, watts: null };
    };
    const rows = items.map(makeRow);
    const rest = w.total && w.rest ? makeRow({ name: w.rest }) : null;
    // `totalName`: the meter itself as a bar too (the longest one), not added to the devices.
    const meterRow = w.total && w.totalName ? makeRow({ name: w.totalName }) : null;
    const all = [...rows, ...(rest ? [rest] : []), ...(meterRow ? [meterRow] : [])];
    const list = h('div.bar-list', all.map((r) => r.el));
    const el = h('div.dash-power',
      h('div.pw-head', h('div.pw-total', h('span.pw-label', w.label || 'Using now'), h('div', total, h('small', 'W'))), h('div.pw-spark', plot.el)),
      list);
    const metered = () => Boolean(w.total) && roomSel === 'all';
    // Sum of every device at each moment (each holds its last reading until the next one).
    const totalSeries = () => {
      if (metered()) return store.data[w.total] || [];
      const series = items.filter(visible).map((i) => store.data[i.entity] || []).filter((p) => p.length);
      const times = [...new Set(series.flatMap((p) => p.map((x) => x[0])))].sort((a, b) => a - b);
      return times.map((t) => [t, series.reduce((sum, p) => sum + (valueAt(p, t) ?? 0), 0)]);
    };
    const draw = () => {
      store.tail();
      const now = Date.now();
      plot.render([{ name: 'Total', color: POWER_COLOR, points: totalSeries() }], now - hours * 3600000, now);
    };
    return {
      el, history: store, draw,
      setRoom() { this.update(); },
      update() {
        for (const r of rows) { r.watts = num(state(r.item.entity)); r.el.hidden = !visible(r.item); }
        const mine = rows.filter((r) => !r.el.hidden);
        const devices = mine.reduce((s, r) => s + (r.watts ?? 0), 0);
        const meter = metered() ? num(state(w.total)) : null;
        const sum = meter ?? devices;
        if (rest) {
          rest.el.hidden = meter == null;
          rest.watts = meter == null ? null : Math.max(0, meter - devices);
        }
        if (meterRow) { meterRow.el.hidden = meter == null; meterRow.watts = meter; }
        const shown = all.filter((r) => !r.el.hidden);
        el.hidden = !mine.length && meter == null; // no metered device in this room
        const top = Math.max(1, ...shown.map((r) => r.watts ?? 0));
        total.textContent = Math.round(sum);
        const sorted = [...all].sort((a, b) => (b.watts ?? -1) - (a.watts ?? -1));
        sorted.forEach((r, i) => {
          if (list.children[i] !== r.el) list.insertBefore(r.el, list.children[i] || null);
          const known = r.watts != null;
          r.el.classList.toggle('missing', !known);
          r.fill.style.width = known ? `${(r.watts / top) * 100}%` : '0';
          r.fill.style.background = POWER_COLOR;
          r.value.textContent = known ? `${r.watts < 10 ? r.watts.toFixed(1) : Math.round(r.watts)} W` : '–';
          r.el.title = known ? `${r.item.name}: ${Math.round(r.watts)} W · ${sum ? Math.round((r.watts / sum) * 100) : 0}% of the total` : `${r.item.name}: no reading`;
        });
        if (el.isConnected && el.offsetParent) draw();
      },
    };
  }

  // Battery levels on one 0-100 % scale; a bolt while charging, and "low" under 20 %.
  function batteries(w) {
    const rows = (w.items || []).map((item) => {
      const fill = h('i.bar-fill');
      const value = h('span.bar-value');
      const bolt = h('span.bat-bolt', { title: 'Charging', 'aria-label': 'Charging' }, icon('zap', 12, 2.4));
      const el = h('div.bar-row', h('span.bar-name', item.name), h('span.bar-track', fill), h('span.bat-end', bolt, value));
      return { item, el, fill, value, bolt };
    });
    const el = h('div.dash-batteries', rows.map((r) => r.el));
    return {
      el,
      update() {
        for (const r of rows) {
          const raw = r.item.attribute ? attr(r.item.entity, r.item.attribute) : state(r.item.entity);
          const level = num(raw);
          r.el.hidden = level == null && Boolean(r.item.hideUnavailable);
          const low = level != null && level < (r.item.low ?? 20);
          // Plugged in: charging, or full on the charger. The word says which.
          const how = String(state(r.item.charging) || '').toLowerCase();
          const charging = /charging|full/.test(how) && !/not|dis/.test(how);
          r.fill.style.width = level != null ? `${Math.max(2, Math.min(100, level))}%` : '0';
          r.fill.style.background = low ? LOW_COLOR : BATTERY_COLOR;
          r.value.textContent = level != null ? `${Math.round(level)}%${low ? ' low' : ''}` : '–';
          r.value.classList.toggle('low', low);
          r.bolt.hidden = !charging;
          r.bolt.title = charging ? cap(how) : '';
          r.el.title = level != null ? `${r.item.name}: ${Math.round(level)}%${charging ? `, ${how}` : ''}` : `${r.item.name}: no reading`;
        }
      },
    };
  }

  const WIDGETS = { fan, ac, media, tv, computer, toggle, actions, washer, status, lights, glance, chart, net, links, power: powerUse, batteries, vacuum: vacuumControl };
  const FULL_WIDTH = ['media', 'tv', 'computer', 'toggle', 'actions', 'washer', 'glance', 'chart', 'net', 'links', 'power', 'batteries', 'vacuum'];

  /* ---------- layout ---------- */

  const charts = []; // { pane, widget } with history to read while their tab shows
  function buildSection(section, pane) {
    const note = h('span.dash-note');
    const body = h('div.dash-sec-grid');
    for (const w of section.widgets || []) {
      const make = WIDGETS[w.type];
      if (!make) continue;
      const widget = make(w);
      if (w.wide ?? FULL_WIDTH.includes(w.type)) widget.el.classList.add('wide'); // `"wide": false` pairs two up
      body.append(widget.el);
      if (filtered(w)) roomAware.push({ el: widget.el, spec: w });
      if (widget.setRoom) roomAware.push({ widget });
      if (widget.update) updaters.push(widget);
      if (widget.history) charts.push({ pane, widget });
    }
    if (section.temperature) {
      updaters.push({ update() { const t = num(state(section.temperature)); note.textContent = t != null ? `${t.toFixed(1)}°` : ''; } });
    }
    const sec = h('section.dash-sec', h('div.dash-title', h('span', section.title || ''), note), body);
    if (filtered(section)) roomAware.push({ el: sec, spec: section });
    return sec;
  }

  const tabs = spec.tabs?.length ? spec.tabs : [{ title: spec.title || 'Home', sections: spec.sections || [] }];
  const panes = tabs.map((tab, i) => h('div.dash-pane', { role: 'tabpanel' }, (tab.sections || []).map((section) => buildSection(section, i))));
  // Whatever the plan has that no section placed still gets a home at the end of the first tab.
  const rest = [...chips.keys()].filter((id) => !used.has(id));
  if (rest.length) panes[0].append(buildSection({ title: 'Other', widgets: [{ type: 'lights', ids: rest }] }, 0));

  const tabButtons = tabs.map((tab, i) => h('button.dash-tab', { role: 'tab', onclick: () => select(i) }, tab.title || `Tab ${i + 1}`));
  const tabBar = tabs.length > 1 ? h('div.dash-tabs', { role: 'tablist' }, tabButtons) : null;
  const banner = h('div.dash-offline', { hidden: true });
  const el = h('div.dash', banner, panes);
  let current = 0;
  let active = false;

  function render() {
    banner.hidden = !offline;
    banner.textContent = offline ? `Home Assistant: ${offline}` : '';
    for (const w of updaters) w.update();
    onStates(view);
  }

  // The charts of the tab on screen: draw now (they need its width), read history if old.
  async function showCharts() {
    const mine = charts.filter((c) => c.pane === current);
    mine.forEach((c) => c.widget.draw());
    if (!active) return;
    await Promise.all(mine.filter((c) => c.widget.history.stale).map((c) => c.widget.history.load()));
    mine.forEach((c) => c.widget.draw());
  }

  function select(i) {
    current = Math.max(0, Math.min(i, tabs.length - 1));
    panes.forEach((p, j) => { p.hidden = j !== current; });
    tabButtons.forEach((b, j) => { b.classList.toggle('active', j === current); b.setAttribute('aria-selected', String(j === current)); });
    onTab(tabs[current]);
    render();
    showCharts();
  }

  /* ---------- life cycle ---------- */

  let pollTimer = 0;
  let tickTimer = 0;
  let historyTimer = 0;
  let pushed = 0;
  // HOUSE_DASH_TAB=<title> (or ?tab=) opens on that tab: screenshots and UI checks.
  const startTab = window.__HOUSE_BOOT__?.dashboardTab || new URLSearchParams(location.search).get('tab');
  select(Math.max(0, tabs.findIndex((t) => t.title === startTab)));

  return {
    el,
    /** The tab switcher for the header, or null with a single tab. */
    tabBar,
    planACs,
    /** Reads Home Assistant while the panel is open, and stops when it closes. */
    setActive(on) {
      active = on;
      clearInterval(pollTimer);
      clearInterval(tickTimer);
      clearInterval(historyTimer);
      if (!on) return;
      refresh();
      showCharts();
      pollTimer = setInterval(refresh, POLL_MS);
      tickTimer = setInterval(() => { for (const w of updaters) w.tick?.(); }, 1000);
      historyTimer = setInterval(showCharts, HISTORY_MS);
    },
    /** Home Assistant said one of our entities changed (pushed by the native shell). */
    changed() {
      clearTimeout(pushed);
      pushed = setTimeout(refresh, 120);
    },
    refresh,
    select,
    /** The panel's room filter changed: 'all' or a plan room id. */
    setRoom(id) {
      roomSel = id || 'all';
      for (const r of roomAware) { if (r.spec) r.el.hidden = !visible(r.spec); }
      render();
      showCharts();
      this.onLayout?.();
    },
  };
}
