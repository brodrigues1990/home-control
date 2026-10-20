# The dashboard

An optional `dashboard.json` in the data folder (`~/Library/Application Support/HouseControl/`) turns the panel's
device grid into tabs of Home Assistant controls: a fan or an infrared AC driven by scripts, media players, status
rows, charts and links, laid out beside the plan's own lights. Without the file the panel is unchanged.
Use **Reload** in the menu (or relaunch) after editing it. A paired iPhone receives it with the plan and shows the same tabs,
under the same allowlist. Ported from a friend's fork, [asantos](https://github.com/alsantos123/house-control-asantos).

## Safety

- Every entity id the file names is the **allowlist**: the panel may read and call only those, in the domains
  `script, switch, light, fan, climate, media_player, sensor, binary_sensor, device_tracker, input_boolean,
  input_select, input_number, select, number, button, sun`. Every call is written to `events.log`.
- Only the `http(s)` links the file lists can be opened from the panel.
- `homeassistant-blocked.json` (same folder): a JSON array of entity ids the app must never list or switch,
  for example the plug that powers this Mac or the router. Read on every use.
- `"menuBar": "<temperature sensor>"` shows that temperature beside the menu bar icon;
  `"panel": {"width": 520, "height": 800}` sets the card size (the height then follows the content).
  `"temperature"` names the room thermometer the panel header shows.

## Format

The top level holds `panel {width, height}`, `watch` (extra entities the 3D model needs,
for example `sun.sun`, `sensor.office_vent_status`, the C2, and
`binary_sensor.pc_gamer_online`), `tabs: [{title, model?, sections: [{title,
temperature?, widgets: [...]}]}]` and `devices` (extras for the plan's own devices, by their ids in the plan).

A section with a `room` (a plan room id) gets one button for that room's lights in its title: on / total, a tap
turns them on when none is lit, off otherwise.

`devices: {"<plan AC id>": {watts, details}}`: an AC's card keeps to power, temperature and `watts` (the sensor
of its draw, shown while it runs); `details` (`glance` items) are listed in its sheet, under its controls.

Widget types:

| type | fields |
| --- | --- |
| `fan` | `status`, `watts`, scripts `on`, `off`, `plus`, `minus`, `reverse` |
| `ac` | `script` (fields `ligado`, `modo`, `temperatura`, `ventilacao`, `sleep`), helpers `power`, `mode`, `fan`, `target`, `sleep`; `room`, `watts`; `plan` (id of the plan AC it stands behind: a click on the card opens its sheet, offering the modes and fan speeds the helpers list) |
| `media` | `entity` (Music Assistant player), optional `favorite {press (button), state (binary_sensor)}` heart |
| `tv` | `entity`, `screen` (switch), optional `sources` labels, `hideSources`, `playPause` |
| `toggle` | `name`, `icon`, `entity` (switch), `watts` (sensor): on/off with its draw |
| `actions` | `script`, shared `variables`, `items[{label, icon?, variables, script?}]`: a row of one-tap script chips |
| `washer` | `script` (+ `fields.action`, verbs iniciar/pausar/acordar/desligar), `status`, `remaining`, `remoteStart`, `course` (select, picked from a pop-up menu), `delay` (number, the delayed end in h), `cycles`, `tubClean`, `energyToday`, `energyMonth`, `labels` |
| `status` | `items[{name, icon, entity, off[], labels{}, above, unit, remaining, battery, color}]` (`battery`: a % sensor shown beside the state) |
| `lights` | `ids` (plan light ids, or an AC's: its card with power and temperature, a click opens all its controls), `columns`. A dimmable light takes a row of its own, above the others |
| `glance` | `items[{name, entity, copy, detail (attribute), strip (regex), status, unit, decimals, note, since}]` (`since`: `day` or `month`, with a meter as `entity`, such as the whole-home kWh total: its use since the day or month began, from Home Assistant's long-term statistics) |
| `chart` | `series[{name, entity}]`, `hours`, `unit`, `max` |
| `net` | `up`, `down`, `unit`, `hours` |
| `links` | `items[{name, url, status, above, onDemand}]`, `columns` |
| `power` | `items[{name, entity}]`, `hours`, optional `total` (the whole-home meter: shown as the figure for the whole home) `rest` (label of a bar for the meter minus every device) and `totalName` (label of a bar for the meter itself) |
| `batteries` | `items[{name, entity, attribute, charging, hideUnavailable, low}]` |
| `countdown` | `status` (template sensor `sensor.countdowns`, its `ativos` attribute lists the running timers), `topic` (input_select of ntfy topics), scripts `start`, `pause`, `resume`, `stop` (all take `minutos`), `minutes` (the chips; default 5…60) |
