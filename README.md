# Irish Solar & Savings Predictor

Hourly solar generation forecast **and running-cost model** for Irish homes. Built around
Newcastle West, Co. Limerick (Eircode **V42 AD96**), and works for any Eircode or town in Ireland.

- **Live site:** https://dclnosullivan1986-ui.github.io/solar-predcitordeclan/
- **Repository:** https://github.com/dclnosullivan1986-ui/solar-predcitordeclan

---

## What changed in this version

### 1. The day rating is now measured against a clear sky

The old rating leaned on total kWh, so a grey, drizzly June day still made ~10 kWh over sixteen
hours of daylight and got called a **Good Solar Day**. That was the wrong answer.

Every hour is now compared to what a **cloudless sky** would have delivered at that date, latitude
and roof angle, using a Meinel/Hottel clear-sky model. The score combines three things, and all
three have to be high:

| Weight | Measure | What it catches |
|---|---|---|
| 55 | Clearness index — delivered energy ÷ clear-sky energy | Thick cloud, however long the day |
| 30 | Sunshine fraction — share of daylight with direct beam sun | Diffuse-only overcast |
| 15 | Cloud cover, weighted by clear-sky irradiance | Midday cloud counts more than 6am cloud |

Bands are AND-gated — there is no "but it made a lot of kWh" escape hatch:

| Rating | Requires |
|---|---|
| ☀️ **Wall-to-wall sunshine** | score ≥ 80, cloud ≤ 25%, sunshine ≥ 68%, clearness ≥ 0.78 |
| 🌤️ **Good solar day** | score ≥ 60, cloud ≤ 55%, sunshine ≥ 38% |
| ⛅ **Bright spells** | score ≥ 38, sunshine ≥ 15% |
| ☁️ **Poor solar day** | score ≥ 18 |
| 🌧️ **Washout** | below that |

A mostly cloudy day now reads **Poor**. A crisp clear day in December reads **Excellent** — the
conditions genuinely are excellent, the kWh figure beside it tells you the day is short.

### 2. Costs, tariffs and battery dispatch

The model simulates each hour: generation, household load, flexible loads, battery charge and
discharge, grid import at the right rate band, and export income.

**Default tariff — a typical Irish EV / night plan:**

| Band | Hours | Rate |
|---|---|---|
| Day | 08:00–23:00 | 30.0 c/kWh |
| Night | 23:00–08:00 | 20.0 c/kWh |
| EV / cheap window | 02:00–05:00 | 10.0 c/kWh |
| Export (Clean Export Guarantee) | — | 18.5 c/kWh |
| Standing charge | — | €0.85/day |

Presets are included for a smart tariff with a 17:00–19:00 peak, a flat 24-hour rate, and
"no smart meter, export not paid". Every rate is editable.

**Defaults for the house:** 10 kWh/day base usage on an evening-peak profile, a 5 kWh battery at
3 kW, immersion at 2.4 kWh/day, EV off (switch it on for 20 kWh × 4 nights a week). Battery, EV
and immersion all run in the 02:00–05:00 cheap window by default.

**Three battery plans, compared side by side on every day:**

- **Smart** — searches the whole range of overnight charge levels and keeps the cheapest for that
  day's forecast. Never loses to the other two.
- **Night-first** — fills the battery every night on the cheap rate.
- **Solar only** — never buys from the grid.

### 3. The result that surprises most people

On this tariff the **10 c EV window is cheaper than the 18.5 c you get paid to export**. So the
arithmetic says: fill the battery, the car and the cylinder overnight, let the panels cover the
house during the day, and **sell the surplus** rather than store it. The app spells this out and
flips the advice automatically if you have no export payment, where self-consumption becomes
everything instead.

### 4. Other Irish specifics built in

- €400/year microgeneration income is exempt from income tax, USC and PRSI (relief runs to end of
  2028) — you're warned when the estimate crosses it.
- Smart meter and an NC6 registered with ESB Networks are needed before CEG pays anything.
- €1,800 SEAI grant and 0% VAT on domestic solar noted against payback.
- Annual estimates use **850 kWh per kWp**, a realistic Irish figure, rather than extrapolating a
  sunny forecast week. Solar savings and battery arbitrage are projected separately, because one
  scales with sunshine and the other happens every night regardless.

### 5. Accuracy & physics upgrades under the hood

- **Preceding-hour interval alignment.** Open-Meteo hourly radiation is the average over the
  preceding hour `(H−1):00–H:00`. Solar geometry now uses the interval midpoint (`H − 30 min`)
  and clear-sky irradiance integrates across the preceding hour via 4-point quadrature, eliminating
  morning/afternoon phase drift and sunrise/sunset distortion.
- **Spencer (1971) solar astronomy + Hay–Davies transposition + Martin–Ruiz IAM.** Replaces
  single-term sun angles and isotropic sky assumptions with high-precision declination, equation of
  time, Earth–Sun eccentricity, circumsolar diffuse brightening and AR-coated glass reflection losses.
- **Faiman thermal model (m/s wind) + Sandia inverter curve.** Requests `wind_speed_unit=ms`
  (fixing a km/h-vs-m/s wind-cooling mismatch), uses the PVGIS Faiman roof-mounted cell-temperature
  model, applies a realistic part-load inverter efficiency curve, and automatically derates snow cover.
- **Sky rating decoupled from shading and panel age.** Clearness index compares delivered vs
  clear-sky POA irradiance directly so shaded or older roofs still get an honest sky verdict.
- **Multi-model forecast confidence.** Runs ECMWF IFS, ICON-EU and UKMO UKV in parallel through the
  same PV physics engine to display High / Moderate / Low confidence and a Low–High kWh envelope.
- **Split roofs & location-specific 12-month yield.** True 50/50 East–West split and optional
  second roof plane, plus a PVGIS-calibrated 12-month yield chart replacing the old flat `850 kWh/kWp`.
- **Sequential 7-day battery SOC & tariff-priority dispatch.** Battery charge carries over day to
  day across the week, and `SMART` mode preserves battery charge for Day/Peak hours instead of
  draining it during cheaper Night hours.
- **Pinpoint location accuracy.** Supports GPS lookup, direct `lat, lon` coordinates, all Irish
  county Eircode routing keys, and an honest precision badge (`Exact`, `GPS`, `Town`, or `Routing-key area`).

---

## Files

| File | What it does |
|---|---|
| `solar-predictor-newcastle-west.html` | Standalone build — open it directly in a browser, no server needed |
| `index.html` | Page structure |
| `styles.css` | Dark glass design system |
| `solar-model.js` | Sun position, clear-sky reference, PV yield, day rating |
| `energy-model.js` | Tariff bands, load profiles, battery dispatch, savings and Irish notes |
| `app.js` | Geocoding, Open-Meteo requests, charts and rendering |
| `build-standalone.js` | Inlines CSS and JS to regenerate the standalone file |

Rebuild the standalone after editing any source file:

```bash
node build-standalone.js
```

## Using it

Enter any Eircode or town and everything recalculates. Your array, house and tariff settings are
remembered in the browser. You can also deep-link a location: `?eircode=V94%20XV2W`.

## Caveats

Estimates only. Real generation depends on shading, soiling, panel and inverter specifics, and
snow or dirt on the glass. Real bills depend on your meter, your supplier and their current rates.
Check the rates on your own bill before making decisions, and treat the tax notes as a pointer to
Revenue rather than advice.

Weather from [Open-Meteo](https://open-meteo.com/); geocoding from Open-Meteo and OpenStreetMap
Nominatim.
