/*
 * Værkart – varsel fra MET/Yr oppå OpenStreetMap.
 * Ren statisk app (ingen byggesteg) – laget for GitHub Pages.
 *
 * Datakilder:
 *  - Varsel: MET Locationforecast 2.0 (api.met.no), CC BY 4.0
 *  - Kart:   OpenStreetMap-fliser
 *  - Søk:    Nominatim (OpenStreetMap)
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- Konfig

  var FORECAST_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
  var ALERTS_URL = "https://api.met.no/weatherapi/metalerts/2.0/current.json";
  var NOWCAST_URL = "https://api.met.no/weatherapi/nowcast/2.0/complete";
  var SUNRISE_URL = "https://api.met.no/weatherapi/sunrise/3.0/sun";
  var NOMINATIM_URL = "https://nominatim.openstreetmap.org";

  // Kandidat-URLer for MET sine offisielle værsymboler (SVG). Vi prober ved
  // oppstart og bruker den første som svarer.
  var ICON_BASES = [
    "https://cdn.jsdelivr.net/gh/metno/weathericons@main/weather/svg/",
    "https://cdn.jsdelivr.net/gh/metno/weathericons@master/weather/svg/",
    "https://cdn.statically.io/gh/metno/weathericons/main/weather/svg/"
  ];
  var iconBase = ICON_BASES[0];

  // Rutenett av værpunkter i kartutsnittet
  var GRID_COLS = 6;
  var GRID_ROWS = 4;
  var COORD_DECIMALS = 2;   // ~1 km – gir god cache-treff ved panorering
  var FETCH_CONCURRENCY = 4;

  var HOURLY_HOURS = 48;    // time for time de første 48 t
  var SIXHOUR_DAYS = 9;     // deretter 6-timers steg opptil 9 døgn

  // ---------------------------------------------------------------- Tilstand

  var map;
  var markerLayer;
  var forecastCache = Object.create(null); // "lat,lon" -> { byTime, times } | "pending" | "failed"
  var gridPoints = [];                     // aktive punkter i utsnittet
  var timeline = buildTimeline();
  var timeIndex = 0;
  var playTimer = null;
  var detailAbort = null;

  // ---------------------------------------------------------------- Tidslinje

  /** Bygger en liste med UTC-tidspunkter: hver time i 48 t (fra neste hele
   *  time), deretter hver 6. time (justert til 00/06/12/18 UTC) i 9 døgn.
   *  Dette speiler oppløsningen i Locationforecast. */
  function buildTimeline() {
    var out = [];
    var t = new Date();
    t.setUTCMinutes(0, 0, 0);

    for (var h = 0; h < HOURLY_HOURS; h++) {
      out.push(new Date(t.getTime() + h * 3600e3));
    }

    var last = out[out.length - 1];
    var next6 = new Date(last.getTime());
    next6.setUTCHours(Math.ceil((next6.getUTCHours() + 1) / 6) * 6, 0, 0, 0);

    var end = t.getTime() + SIXHOUR_DAYS * 24 * 3600e3;
    for (var ts = next6.getTime(); ts <= end; ts += 6 * 3600e3) {
      out.push(new Date(ts));
    }
    return out;
  }

  var DAY_FMT = new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "numeric", month: "long" });
  var HOUR_FMT = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" });

  function formatTimeLabel(date) {
    var now = new Date();
    var label;
    if (date.toDateString() === now.toDateString()) {
      label = "I dag";
    } else {
      var tomorrow = new Date(now.getTime() + 24 * 3600e3);
      label = date.toDateString() === tomorrow.toDateString()
        ? "I morgen"
        : capitalize(DAY_FMT.format(date));
    }
    return label + " kl. " + HOUR_FMT.format(date);
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---------------------------------------------------------------- Værdata

  function coordKey(lat, lon) {
    return lat.toFixed(COORD_DECIMALS) + "," + lon.toFixed(COORD_DECIMALS);
  }

  /** Henter og indekserer varsel for ett punkt. Returnerer Promise. */
  function fetchForecast(lat, lon) {
    var key = coordKey(lat, lon);
    var cached = forecastCache[key];
    if (cached && cached !== "failed") {
      return cached.promise || Promise.resolve(cached);
    }

    var url = FORECAST_URL + "?lat=" + lat.toFixed(COORD_DECIMALS) +
              "&lon=" + lon.toFixed(COORD_DECIMALS);

    var entry = {};
    entry.promise = fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (json) {
        var series = (json.properties && json.properties.timeseries) || [];
        entry.byTime = Object.create(null);
        entry.times = [];
        series.forEach(function (step) {
          var ms = Date.parse(step.time);
          entry.byTime[ms] = step;
          entry.times.push(ms);
        });
        delete entry.promise;
        forecastCache[key] = entry;
        return entry;
      })
      .catch(function (err) {
        forecastCache[key] = "failed";
        throw err;
      });

    forecastCache[key] = entry;
    return entry.promise;
  }

  /** Nærmeste tidssteg i et varsel, maks 3,5 t unna. */
  function nearestStep(entry, date) {
    var target = date.getTime();
    var best = null;
    var bestDiff = 3.5 * 3600e3;
    for (var i = 0; i < entry.times.length; i++) {
      var diff = Math.abs(entry.times[i] - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = entry.byTime[entry.times[i]];
      }
      if (entry.times[i] > target + bestDiff) break;
    }
    return best;
  }

  function symbolCode(step) {
    var d = step.data;
    return (d.next_1_hours && d.next_1_hours.summary.symbol_code) ||
           (d.next_6_hours && d.next_6_hours.summary.symbol_code) ||
           (d.next_12_hours && d.next_12_hours.summary.symbol_code) ||
           null;
  }

  function airTemp(step) {
    var inst = step.data.instant && step.data.instant.details;
    return inst && typeof inst.air_temperature === "number" ? inst.air_temperature : null;
  }

  // ---------------------------------------------------------------- Rutenett

  var refreshQueued = false;

  function refreshGrid() {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(function () {
      refreshQueued = false;
      doRefreshGrid();
    }, 350);
  }

  function doRefreshGrid() {
    var bounds = map.getBounds();
    var south = bounds.getSouth(), north = bounds.getNorth();
    var west = bounds.getWest(), east = bounds.getEast();

    gridPoints = [];
    for (var r = 0; r < GRID_ROWS; r++) {
      for (var c = 0; c < GRID_COLS; c++) {
        var lat = south + (north - south) * (r + 0.5) / GRID_ROWS;
        var lon = west + (east - west) * (c + 0.5) / GRID_COLS;
        lon = ((lon + 180) % 360 + 360) % 360 - 180; // normaliser
        if (lat < -85 || lat > 85) continue;
        gridPoints.push({
          lat: +lat.toFixed(COORD_DECIMALS),
          lon: +lon.toFixed(COORD_DECIMALS)
        });
      }
    }

    // Hent manglende varsler med begrenset parallellitet
    var queue = gridPoints.slice();
    var failures = 0;

    function worker() {
      var p = queue.shift();
      if (!p) return Promise.resolve();
      return fetchForecast(p.lat, p.lon)
        .catch(function () { failures++; })
        .then(function () {
          renderMarkers(); // tegn etter hvert som data kommer
          return worker();
        });
    }

    var workers = [];
    for (var i = 0; i < FETCH_CONCURRENCY; i++) workers.push(worker());
    Promise.all(workers).then(function () {
      if (failures > 0 && failures === gridPoints.length) {
        showToast("Kunne ikke hente værdata fra MET akkurat nå.");
      }
    });

    renderMarkers();
  }

  function renderMarkers() {
    markerLayer.clearLayers();
    var when = timeline[timeIndex];

    gridPoints.forEach(function (p) {
      var entry = forecastCache[coordKey(p.lat, p.lon)];
      if (!entry || entry === "failed" || entry.promise) return;

      var step = nearestStep(entry, when);
      if (!step) return;

      var code = symbolCode(step);
      var temp = airTemp(step);
      if (code === null && temp === null) return;

      var html = '<div class="wx-box">';
      if (code) {
        html += '<img src="' + iconBase + code + '.svg" alt="" draggable="false">';
      }
      if (temp !== null) {
        var rounded = Math.round(temp);
        var cls = rounded >= 0 ? "warm" : "cold";
        html += '<span class="wx-temp ' + cls + '">' + rounded + '°</span>';
      }

      // Vindpil: peker dit vinden blåser (wind_from_direction er hvor den
      // kommer fra; ➤ peker mot øst, dvs. 90° kompass)
      var inst = step.data.instant.details || {};
      if (typeof inst.wind_speed === "number" &&
          typeof inst.wind_from_direction === "number" &&
          inst.wind_speed >= 0.5) {
        var rot = Math.round(inst.wind_from_direction + 90);
        html += '<span class="wx-wind">' +
                '<span class="wx-arrow" style="transform:rotate(' + rot + 'deg)">➤</span>' +
                Math.round(inst.wind_speed) + '</span>';
      }
      html += "</div>";

      L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: "wx-marker", html: html, iconSize: [44, 66], iconAnchor: [22, 33] }),
        interactive: false,
        keyboard: false
      }).addTo(markerLayer);
    });
  }

  // ---------------------------------------------------------------- Tidslinje-UI

  var slider = document.getElementById("time-slider");
  var timeLabel = document.getElementById("time-label");
  var playBtn = document.getElementById("play-btn");
  var speedSelect = document.getElementById("speed-select");

  function setTimeIndex(idx, fromSlider) {
    timeIndex = Math.max(0, Math.min(timeline.length - 1, idx));
    if (!fromSlider) slider.value = String(timeIndex);
    timeLabel.textContent = formatTimeLabel(timeline[timeIndex]);
    renderMarkers();
  }

  function stopPlayback() {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      playBtn.textContent = "▶";
      playBtn.title = "Spill av været fremover";
    }
  }

  function startPlayback() {
    stopPlayback();
    playBtn.textContent = "⏸";
    playBtn.title = "Pause";
    playTimer = setInterval(function () {
      var next = timeIndex + 1;
      if (next >= timeline.length) next = 0; // start på nytt
      setTimeIndex(next);
    }, parseInt(speedSelect.value, 10));
  }

  playBtn.addEventListener("click", function () {
    if (playTimer) stopPlayback();
    else startPlayback();
  });

  speedSelect.addEventListener("change", function () {
    if (playTimer) startPlayback(); // restart med ny hastighet
  });

  slider.addEventListener("input", function () {
    stopPlayback();
    setTimeIndex(parseInt(slider.value, 10), true);
  });

  // ---------------------------------------------------------------- Søk

  var searchInput = document.getElementById("search-input");
  var searchResults = document.getElementById("search-results");
  var searchTimer = null;
  var searchAbort = null;

  function hideResults() {
    searchResults.hidden = true;
    searchResults.innerHTML = "";
  }

  function runSearch(query) {
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();

    var url = NOMINATIM_URL + "/search?format=jsonv2&limit=6&accept-language=no&q=" +
              encodeURIComponent(query);

    fetch(url, { signal: searchAbort.signal })
      .then(function (res) { return res.json(); })
      .then(function (results) {
        searchResults.innerHTML = "";
        if (!results.length) {
          var li = document.createElement("li");
          li.className = "muted";
          li.textContent = "Ingen treff";
          searchResults.appendChild(li);
        }
        results.forEach(function (r) {
          var li = document.createElement("li");
          var name = r.name || r.display_name.split(",")[0];
          li.innerHTML = "<strong></strong><span class='sub'></span>";
          li.querySelector("strong").textContent = name;
          li.querySelector(".sub").textContent = r.display_name;
          li.addEventListener("click", function () {
            hideResults();
            searchInput.value = name;
            goToPlace(parseFloat(r.lat), parseFloat(r.lon), name);
          });
          searchResults.appendChild(li);
        });
        searchResults.hidden = false;
      })
      .catch(function (err) {
        if (err.name !== "AbortError") {
          showToast("Stedssøket feilet. Prøv igjen.");
        }
      });
  }

  function goToPlace(lat, lon, name) {
    map.flyTo([lat, lon], Math.max(map.getZoom(), 9), { duration: 1.2 });
    openDetail(lat, lon, name);
  }

  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimer);
    var q = searchInput.value.trim();
    if (q.length < 2) { hideResults(); return; }
    searchTimer = setTimeout(function () { runSearch(q); }, 400);
  });

  searchInput.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      var first = searchResults.querySelector("li:not(.muted)");
      if (first) first.click();
      else if (searchInput.value.trim().length >= 2) runSearch(searchInput.value.trim());
    } else if (ev.key === "Escape") {
      hideResults();
    }
  });

  document.addEventListener("click", function (ev) {
    if (!ev.target.closest(".search")) hideResults();
    if (!ev.target.closest(".favs")) {
      document.getElementById("fav-menu").hidden = true;
    }
  });

  // ---------------------------------------------------------------- Detaljpanel

  var detailPanel = document.getElementById("detail-panel");
  var detailTitle = document.getElementById("detail-title");
  var detailBody = document.getElementById("detail-body");
  var selectedMarker = null;

  function setSelectedMarker(lat, lon) {
    clearSelectedMarker();
    selectedMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: "loc-marker",
        html: '<div class="loc-pulse"></div><div class="loc-pin"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      }),
      interactive: false,
      keyboard: false
    }).addTo(map);
  }

  function clearSelectedMarker() {
    if (selectedMarker) {
      map.removeLayer(selectedMarker);
      selectedMarker = null;
    }
  }

  document.getElementById("detail-close").addEventListener("click", function () {
    detailPanel.hidden = true;
    clearSelectedMarker();
    currentDetail = null;
    compareState = null;
    clearCmpMarker();
    map.getContainer().classList.remove("picking");
    updateHash();
  });

  // Ekstrainfo (farevarsler, nedbør nå, soltider) lastes parallelt og
  // flettes inn øverst i panelet etter hvert som svarene kommer.
  var extras = { alerts: "", nowcast: "", sun: "" };
  var currentDetail = null;

  function flushExtras() {
    var div = detailBody.querySelector(".detail-extras");
    if (div) div.innerHTML = extras.alerts + extras.nowcast + extras.sun;
  }

  function fetchExtras(lat, lon, abort) {
    extras = { alerts: "", nowcast: "", sun: "" };
    var q = "?lat=" + lat.toFixed(4) + "&lon=" + lon.toFixed(4);

    // Farevarsler (gult/oransje/rødt)
    fetch(ALERTS_URL + q, { signal: abort.signal })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (json) {
        if (!json || abort.signal.aborted || !json.features) return;
        extras.alerts = json.features.map(function (f) {
          var p = f.properties || {};
          var color = (p.awareness_level || "").split(";")[1] || "";
          color = color.trim().toLowerCase();
          if (["yellow", "orange", "red"].indexOf(color) < 0) color = "yellow";
          var name = p.eventAwarenessName || p.event || "Farevarsel";
          var body = [p.description, p.instruction].filter(Boolean).join(" ");
          return "<details class='alert-chip alert-" + color + "'>" +
                 "<summary>⚠️ Farevarsel: " + escapeHtml(name) + "</summary>" +
                 "<p>" + escapeHtml(body) + "</p></details>";
        }).join("");
        flushExtras();
      })
      .catch(function () { /* farevarsler er tillegg – ignorer feil */ });

    // Nedbør de neste 90 minuttene (kun Norden)
    fetch(NOWCAST_URL + q, { signal: abort.signal })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (json) {
        if (!json || abort.signal.aborted) return;
        var series = (json.properties && json.properties.timeseries) || [];
        var limit = Date.now() + 95 * 60e3;
        var steps = [];
        series.forEach(function (s) {
          var ms = Date.parse(s.time);
          var det = s.data && s.data.instant && s.data.instant.details;
          if (ms <= limit && det && typeof det.precipitation_rate === "number") {
            steps.push({ ms: ms, r: det.precipitation_rate });
          }
        });
        if (steps.length < 3) return;

        var wet = function (s) { return s.r > 0.1; };
        var text, i;
        if (!steps.some(wet)) {
          text = "Oppholdsvær de neste 90 minuttene";
        } else if (!wet(steps[0])) {
          for (i = 0; i < steps.length && !wet(steps[i]); i++) {}
          text = "Nedbør fra ca. kl. " + HOUR_FMT.format(new Date(steps[i].ms));
        } else {
          for (i = 0; i < steps.length && wet(steps[i]); i++) {}
          text = i >= steps.length
            ? "Nedbør de neste 90 minuttene"
            : "Nedbøren gir seg ca. kl. " + HOUR_FMT.format(new Date(steps[i].ms));
        }

        var maxR = Math.max.apply(null, steps.map(function (s) { return s.r; }));
        var bars = "";
        if (maxR > 0.1) {
          bars = "<div class='nowcast-strip' aria-hidden='true'>" +
            steps.map(function (s) {
              var h = Math.max(s.r > 0.1 ? 3 : 1, Math.round(s.r / maxR * 16));
              return "<span style='height:" + h + "px'></span>";
            }).join("") + "</div>";
        }
        extras.nowcast = "<div class='nowcast'><span>🌧️ " + text + "</span>" + bars + "</div>";
        flushExtras();
      })
      .catch(function () { /* nowcast dekker bare Norden – ignorer feil */ });

    // Soloppgang og solnedgang
    var d = new Date();
    var dateStr = d.getFullYear() + "-" +
                  String(d.getMonth() + 1).padStart(2, "0") + "-" +
                  String(d.getDate()).padStart(2, "0");
    var offMin = -d.getTimezoneOffset();
    var offStr = (offMin < 0 ? "-" : "+") +
                 String(Math.floor(Math.abs(offMin) / 60)).padStart(2, "0") + ":" +
                 String(Math.abs(offMin) % 60).padStart(2, "0");
    fetch(SUNRISE_URL + q + "&date=" + dateStr + "&offset=" + encodeURIComponent(offStr),
          { signal: abort.signal })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (json) {
        if (!json || abort.signal.aborted) return;
        var p = json.properties || {};
        var rise = p.sunrise && p.sunrise.time;
        var set = p.sunset && p.sunset.time;
        var line;
        if (rise && set) {
          line = "🌅 " + HOUR_FMT.format(new Date(rise)) +
                 " · 🌇 " + HOUR_FMT.format(new Date(set));
        } else {
          var noonEl = p.solarnoon && p.solarnoon.disc_centre_elevation;
          line = typeof noonEl === "number" && noonEl > 0
            ? "☀️ Midnattssol – sola går ikke ned i dag"
            : "🌑 Mørketid – sola går ikke opp i dag";
        }
        extras.sun = "<p class='sun-line'>" + line + "</p>";
        flushExtras();
      })
      .catch(function () { /* soltider er pynt – ignorer feil */ });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function openDetail(lat, lon, knownName) {
    compareState = null;
    clearCmpMarker();
    map.getContainer().classList.remove("picking");
    detailPanel.hidden = false;
    setSelectedMarker(lat, lon);
    currentDetail = { lat: lat, lon: lon };
    updateHash();
    updateFavStar();
    detailTitle.textContent = knownName || lat.toFixed(3) + "°, " + lon.toFixed(3) + "°";
    detailBody.innerHTML = '<p class="muted">Laster varsel …</p>';

    if (detailAbort) detailAbort.abort();
    var abort = detailAbort = new AbortController();

    fetchExtras(lat, lon, abort);

    // Stedsnavn via omvendt geokoding (hvis vi ikke fikk det fra søket)
    if (!knownName) {
      fetch(NOMINATIM_URL + "/reverse?format=jsonv2&zoom=12&accept-language=no&lat=" +
            lat + "&lon=" + lon, { signal: abort.signal })
        .then(function (res) { return res.json(); })
        .then(function (r) {
          if (abort.signal.aborted) return;
          var a = r.address || {};
          var name = a.village || a.town || a.suburb || a.city || a.municipality ||
                     (r.name || "").split(",")[0];
          if (name) {
            detailTitle.textContent = name + (a.country && a.country !== "Norge" ? ", " + a.country : "");
          }
        })
        .catch(function () { /* navnet er pynt – ignorer feil */ });
    }

    fetchForecast(lat, lon)
      .then(function (entry) {
        if (abort.signal.aborted) return;
        renderDetail(entry);
      })
      .catch(function () {
        if (abort.signal.aborted) return;
        detailBody.innerHTML = '<p class="muted">Kunne ikke hente varselet. Prøv igjen senere.</p>';
      });
  }

  function tempSpan(t) {
    if (t === null || t === undefined) return "";
    var r = Math.round(t);
    return '<span class="' + (r >= 0 ? "t-warm" : "t-cold") + '">' + r + "°</span>";
  }

  // ---- Meteogram: temperaturlinje + nedbørssøyler for de neste 48 timene.
  // To stablede paneler med felles tidsakse (aldri dobbel y-akse).

  var MET_W = 360, MET_H = 190;
  var MET_L = 26, MET_R = 8;          // venstre/høyre marg
  var TEMP_TOP = 16, TEMP_BOT = 100;  // temperaturpanel
  var PREC_TOP = 126, PREC_BOT = 168; // nedbørspanel

  var TIP_FMT = new Intl.DateTimeFormat("nb-NO", { weekday: "short", hour: "2-digit", minute: "2-digit" });

  function nb(num, decimals) {
    return num.toFixed(decimals).replace(".", ",");
  }

  /** Timesverdier (temp + nedbør) for de neste maks 48 timene. */
  function collectHourly(entry) {
    var pts = [];
    var now = Date.now();
    for (var i = 0; i < entry.times.length && pts.length < 48; i++) {
      var ms = entry.times[i];
      if (ms < now - 3600e3) continue;
      var d = entry.byTime[ms].data;
      if (!d.next_1_hours) break;
      var t = d.instant.details && d.instant.details.air_temperature;
      if (typeof t !== "number") continue;
      var det = d.next_1_hours.details;
      pts.push({ ms: ms, t: t, p: (det && det.precipitation_amount) || 0 });
    }
    return pts;
  }

  function buildMeteogram(entry) {
    var i;
    var pts = collectHourly(entry);
    if (pts.length < 3) return null;

    var xs = pts.map(function (_, idx) {
      return MET_L + (MET_W - MET_L - MET_R) * idx / (pts.length - 1);
    });

    // Temperaturskala med «pene» steg
    var tMin = Infinity, tMax = -Infinity, pMax = 0;
    pts.forEach(function (p) {
      if (p.t < tMin) tMin = p.t;
      if (p.t > tMax) tMax = p.t;
      if (p.p > pMax) pMax = p.p;
    });
    var span = (tMax - tMin) || 1;
    var stepT = span <= 5 ? 2 : span <= 12 ? 3 : span <= 22 ? 5 : 10;
    var tLo = Math.floor((tMin - 1) / stepT) * stepT;
    var tHi = Math.ceil((tMax + 1) / stepT) * stepT;

    function ty(v) {
      return TEMP_BOT - (v - tLo) / (tHi - tLo) * (TEMP_BOT - TEMP_TOP);
    }

    var svg = "";

    // Horisontale gridlinjer + verdier for temperatur
    for (var tv = tLo; tv <= tHi; tv += stepT) {
      var y = ty(tv).toFixed(1);
      var cls = tv === 0 ? "meteo-zero" : "meteo-grid";
      svg += "<line class='" + cls + "' x1='" + MET_L + "' y1='" + y +
             "' x2='" + (MET_W - MET_R) + "' y2='" + y + "'/>";
      svg += "<text class='meteo-label' x='" + (MET_L - 4) + "' y='" + (+y + 3) +
             "' text-anchor='end'>" + tv + "</text>";
    }

    // Tidsakse: merker hver 6. time, vertikale hjelpelinjer gjennom begge paneler
    for (i = 0; i < pts.length; i++) {
      var dt = new Date(pts[i].ms);
      if (dt.getHours() % 6 !== 0) continue;
      var x = xs[i].toFixed(1);
      svg += "<line class='meteo-grid' x1='" + x + "' y1='" + TEMP_TOP +
             "' x2='" + x + "' y2='" + PREC_BOT + "'/>";
      svg += "<text class='meteo-label' x='" + x + "' y='" + (PREC_BOT + 12) +
             "' text-anchor='middle'>" + String(dt.getHours()).padStart(2, "0") + "</text>";
    }

    // Temperaturlinje delt i varme/kalde segmenter ved nullpunktene
    var segs = [];
    var cur = null, curWarm = null;
    for (i = 0; i < pts.length; i++) {
      var warm = pts[i].t >= 0;
      var px = xs[i], py = ty(pts[i].t);
      if (cur === null) {
        cur = [px.toFixed(1) + "," + py.toFixed(1)];
        curWarm = warm;
        continue;
      }
      if (warm !== curWarm) {
        var f = (0 - pts[i - 1].t) / (pts[i].t - pts[i - 1].t);
        var cx = (xs[i - 1] + (px - xs[i - 1]) * f).toFixed(1);
        var cy = ty(0).toFixed(1);
        cur.push(cx + "," + cy);
        segs.push({ warm: curWarm, pts: cur });
        cur = [cx + "," + cy];
        curWarm = warm;
      }
      cur.push(px.toFixed(1) + "," + py.toFixed(1));
    }
    segs.push({ warm: curWarm, pts: cur });

    segs.forEach(function (seg) {
      svg += "<polyline class='" + (seg.warm ? "meteo-line-warm" : "meteo-line-cold") +
             "' points='" + seg.pts.join(" ") + "'/>";
    });

    // Direktemerk høyeste og laveste temperatur
    var iMax = 0, iMin = 0;
    for (i = 1; i < pts.length; i++) {
      if (pts[i].t > pts[iMax].t) iMax = i;
      if (pts[i].t < pts[iMin].t) iMin = i;
    }
    [{ i: iMax, above: true }, { i: iMin, above: false }].forEach(function (m) {
      if (iMax === iMin && !m.above) return;
      var p = pts[m.i];
      var lx = Math.min(Math.max(xs[m.i], MET_L + 12), MET_W - MET_R - 12);
      var lyv = ty(p.t) + (m.above ? -6 : 12);
      svg += "<text class='" + (p.t >= 0 ? "meteo-extreme-warm" : "meteo-extreme-cold") +
             "' x='" + lx.toFixed(1) + "' y='" + lyv.toFixed(1) +
             "' text-anchor='middle'>" + nb(p.t, 0) + "°</text>";
    });

    // Nedbørspanel
    svg += "<text class='meteo-title' x='" + MET_L + "' y='" + (TEMP_TOP - 6) + "'>Temperatur (°C)</text>";
    svg += "<text class='meteo-title' x='" + MET_L + "' y='" + (PREC_TOP - 6) + "'>Nedbør (mm)</text>";
    svg += "<line class='meteo-axis' x1='" + MET_L + "' y1='" + PREC_BOT +
           "' x2='" + (MET_W - MET_R) + "' y2='" + PREC_BOT + "'/>";

    var pScale = Math.max(1, Math.ceil(pMax));
    svg += "<text class='meteo-label' x='" + (MET_L - 4) + "' y='" + (PREC_TOP + 3) +
           "' text-anchor='end'>" + pScale + "</text>";
    svg += "<text class='meteo-label' x='" + (MET_L - 4) + "' y='" + (PREC_BOT + 3) +
           "' text-anchor='end'>0</text>";

    var stepX = (MET_W - MET_L - MET_R) / (pts.length - 1);
    var barW = Math.max(2, stepX * 0.62);
    for (i = 0; i < pts.length; i++) {
      if (pts[i].p <= 0) continue;
      var bh = Math.max(1.5, pts[i].p / pScale * (PREC_BOT - PREC_TOP));
      svg += "<rect class='meteo-bar' x='" + (xs[i] - barW / 2).toFixed(1) +
             "' y='" + (PREC_BOT - bh).toFixed(1) +
             "' width='" + barW.toFixed(1) + "' height='" + bh.toFixed(1) + "' rx='1.5'/>";
    }

    // Krysshår for hover (skjult til musa er over)
    svg += "<line class='meteo-cross' x1='0' y1='" + TEMP_TOP + "' x2='0' y2='" +
           PREC_BOT + "' style='display:none'/>";

    var html = "<div class='meteo-wrap'>" +
      "<svg viewBox='0 0 " + MET_W + " " + MET_H + "' role='img' " +
      "aria-label='Temperatur og nedbør de neste 48 timene'>" + svg + "</svg>" +
      "<div class='meteo-tip' hidden></div></div>";

    return { html: html, pts: pts, xs: xs };
  }

  function attachMeteoHover(mg) {
    var wrap = detailBody.querySelector(".meteo-wrap");
    if (!wrap || !mg) return;
    var svgEl = wrap.querySelector("svg");
    var tip = wrap.querySelector(".meteo-tip");
    var cross = svgEl.querySelector(".meteo-cross");

    function onMove(ev) {
      var rect = svgEl.getBoundingClientRect();
      var vx = (ev.clientX - rect.left) / rect.width * MET_W;
      var best = 0, bd = Infinity;
      for (var i = 0; i < mg.xs.length; i++) {
        var d = Math.abs(mg.xs[i] - vx);
        if (d < bd) { bd = d; best = i; }
      }
      var p = mg.pts[best];
      cross.setAttribute("x1", mg.xs[best]);
      cross.setAttribute("x2", mg.xs[best]);
      cross.style.display = "";
      tip.hidden = false;
      tip.textContent = TIP_FMT.format(new Date(p.ms)) + " · " + nb(p.t, 1) + "°" +
                        (p.p > 0 ? " · " + nb(p.p, 1) + " mm" : "");
      var px = mg.xs[best] / MET_W * rect.width;
      var tipW = tip.offsetWidth || 120;
      tip.style.left = Math.min(Math.max(px - tipW / 2, 0), rect.width - tipW) + "px";
    }

    function onLeave() {
      tip.hidden = true;
      cross.style.display = "none";
    }

    wrap.addEventListener("mousemove", onMove);
    wrap.addEventListener("mouseleave", onLeave);
  }

  function renderDetail(entry) {
    var html = "<div class='detail-extras'></div>";

    // ---- Meteogram for de neste 48 timene
    var mg = buildMeteogram(entry);
    if (mg) {
      html += "<h3>Neste 48 timer</h3>" + mg.html;
    }

    // ---- Neste 24 timer, time for time
    html += "<h3>Time for time</h3><table class='hour-table'>";
    var now = Date.now();
    var count = 0;
    for (var i = 0; i < entry.times.length && count < 24; i++) {
      var ms = entry.times[i];
      if (ms < now - 3600e3) continue;
      var step = entry.byTime[ms];
      var d = step.data;
      if (!d.next_1_hours) break; // hourly-delen er slutt
      count++;

      var precip = d.next_1_hours.details &&
                   d.next_1_hours.details.precipitation_amount;
      var wind = d.instant.details.wind_speed;

      html += "<tr>" +
        "<td>" + HOUR_FMT.format(new Date(ms)) + "</td>" +
        "<td><img src='" + iconBase + d.next_1_hours.summary.symbol_code + ".svg' alt=''></td>" +
        "<td>" + tempSpan(airTemp(step)) + "</td>" +
        "<td class='precip'>" + (precip ? precip.toFixed(1) + " mm" : "") + "</td>" +
        "<td class='wind'>" + (wind != null ? Math.round(wind) + " m/s" : "") + "</td>" +
        "</tr>";
    }
    html += "</table>";

    // ---- Langtidsvarsel per døgn
    var days = aggregateDays(entry);
    html += "<h3>Langtidsvarsel</h3><table class='day-table'>";
    days.forEach(function (day) {
      html += "<tr>" +
        "<td class='day-name'>" + day.label + "<span class='sub'>" + day.dateLabel + "</span></td>" +
        "<td>" + (day.symbol ? "<img src='" + iconBase + day.symbol + ".svg' alt=''>" : "") + "</td>" +
        "<td>" + tempSpan(day.max) + " / " + tempSpan(day.min) + "</td>" +
        "<td class='precip'>" + (day.precip > 0 ? day.precip.toFixed(1) + " mm" : "") + "</td>" +
        "<td class='wind'>" + (day.wind != null ? Math.round(day.wind) + " m/s" : "") + "</td>" +
        "</tr>";
    });
    html += "</table>";

    html += "<p class='muted' style='font-size:0.75rem'>Varsel fra Meteorologisk institutt (Yr). " +
            "Tidspunkter i lokal tid.</p>";

    detailBody.innerHTML = html;
    flushExtras();
    attachMeteoHover(mg);
  }

  var WEEKDAY_FMT = new Intl.DateTimeFormat("nb-NO", { weekday: "long" });
  var DATE_FMT = new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "short" });

  /** Grupperer varselet per lokal dato: min/max-temp, nedbørsum, maks vind
   *  og symbolet nærmest kl. 12 lokal tid. */
  function aggregateDays(entry) {
    var byDate = Object.create(null);
    var order = [];

    entry.times.forEach(function (ms) {
      var step = entry.byTime[ms];
      var local = new Date(ms);
      var dateKey = local.getFullYear() + "-" + local.getMonth() + "-" + local.getDate();

      var day = byDate[dateKey];
      if (!day) {
        day = byDate[dateKey] = {
          date: local, min: null, max: null, precip: 0, wind: null,
          symbol: null, symbolDist: Infinity
        };
        order.push(dateKey);
      }

      var t = airTemp(step);
      if (t !== null) {
        if (day.min === null || t < day.min) day.min = t;
        if (day.max === null || t > day.max) day.max = t;
      }

      var w = step.data.instant.details && step.data.instant.details.wind_speed;
      if (w != null && (day.wind === null || w > day.wind)) day.wind = w;

      // Nedbør: summer 6-timersblokker på 00/06/12/18 UTC for å unngå
      // dobbeltelling (blokken tilskrives døgnet den starter i)
      var d = step.data;
      if (d.next_6_hours && new Date(ms).getUTCHours() % 6 === 0) {
        var det = d.next_6_hours.details;
        if (det && typeof det.precipitation_amount === "number") {
          day.precip += det.precipitation_amount;
        }
      }

      // Dagssymbol: 6-timerssymbolet nærmest kl. 12 lokal tid
      var sym = (d.next_6_hours && d.next_6_hours.summary.symbol_code) ||
                (d.next_1_hours && d.next_1_hours.summary.symbol_code);
      if (sym) {
        var dist = Math.abs(local.getHours() - 12);
        if (dist < day.symbolDist) {
          day.symbolDist = dist;
          day.symbol = sym;
        }
      }
    });

    var today = new Date().toDateString();
    var tomorrow = new Date(Date.now() + 24 * 3600e3).toDateString();

    return order.map(function (key) {
      var day = byDate[key];
      var ds = day.date.toDateString();
      day.label = ds === today ? "I dag" :
                  ds === tomorrow ? "I morgen" :
                  capitalize(WEEKDAY_FMT.format(day.date));
      day.dateLabel = DATE_FMT.format(day.date);
      return day;
    }).filter(function (day) {
      return day.min !== null; // dropp døgn helt uten data
    });
  }

  // ---------------------------------------------------------------- Diverse

  var toastEl = document.getElementById("status-toast");
  var toastTimer = null;

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 4000);
  }

  /** Finner en ikonkilde som faktisk svarer. */
  function probeIconBase() {
    var idx = 0;
    function tryNext() {
      if (idx >= ICON_BASES.length) return;
      var img = new Image();
      img.onload = function () {
        iconBase = ICON_BASES[idx];
        renderMarkers();
      };
      img.onerror = function () {
        idx++;
        tryNext();
      };
      img.src = ICON_BASES[idx] + "partlycloudy_day.svg";
    }
    tryNext();
  }

  // ---------------------------------------------------------------- Favoritter

  var FAVS_KEY = "wxmap-favs";
  var favBtn = document.getElementById("fav-btn");
  var favMenu = document.getElementById("fav-menu");
  var detailFavBtn = document.getElementById("detail-fav");

  function loadFavs() {
    try { return JSON.parse(localStorage.getItem(FAVS_KEY)) || []; } catch (e) { return []; }
  }

  function saveFavs(favs) {
    try { localStorage.setItem(FAVS_KEY, JSON.stringify(favs)); } catch (e) {}
  }

  function favIndexOf(favs, lat, lon) {
    for (var i = 0; i < favs.length; i++) {
      if (Math.abs(favs[i].lat - lat) < 0.005 && Math.abs(favs[i].lon - lon) < 0.005) return i;
    }
    return -1;
  }

  function updateFavStar() {
    var isFav = currentDetail &&
      favIndexOf(loadFavs(), currentDetail.lat, currentDetail.lon) >= 0;
    detailFavBtn.textContent = isFav ? "★" : "☆";
    detailFavBtn.classList.toggle("is-fav", !!isFav);
    detailFavBtn.title = isFav ? "Fjern fra favoritter" : "Lagre som favoritt";
  }

  function renderFavMenu() {
    var favs = loadFavs();
    favMenu.innerHTML = "";
    if (!favs.length) {
      var empty = document.createElement("li");
      empty.className = "muted fav-empty";
      empty.textContent = "Ingen favoritter ennå – åpne et sted og trykk ☆";
      favMenu.appendChild(empty);
      return;
    }
    favs.forEach(function (f) {
      var li = document.createElement("li");
      var name = document.createElement("span");
      name.className = "fav-name";
      name.textContent = f.name;
      li.appendChild(name);
      var del = document.createElement("button");
      del.className = "fav-del";
      del.title = "Fjern favoritt";
      del.textContent = "×";
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var updated = loadFavs();
        var i = favIndexOf(updated, f.lat, f.lon);
        if (i >= 0) { updated.splice(i, 1); saveFavs(updated); }
        renderFavMenu();
        updateFavStar();
      });
      li.appendChild(del);
      li.addEventListener("click", function () {
        favMenu.hidden = true;
        goToPlace(f.lat, f.lon, f.name);
      });
      favMenu.appendChild(li);
    });
  }

  favBtn.addEventListener("click", function () {
    if (favMenu.hidden) renderFavMenu();
    favMenu.hidden = !favMenu.hidden;
  });

  detailFavBtn.addEventListener("click", function () {
    if (!currentDetail) return;
    var favs = loadFavs();
    var i = favIndexOf(favs, currentDetail.lat, currentDetail.lon);
    if (i >= 0) {
      favs.splice(i, 1);
    } else {
      favs.push({
        name: detailTitle.textContent,
        lat: +currentDetail.lat.toFixed(3),
        lon: +currentDetail.lon.toFixed(3)
      });
    }
    saveFavs(favs);
    updateFavStar();
  });

  // ---------------------------------------------------------------- Nedbørsradar

  // Radarfliser fra RainViewer (åpent API, dekker Norge). Viser siste time
  // pluss et kort fremskriv, animert i løkke. Uavhengig av varsel-tidslinjen.
  var RADAR_API = "https://api.rainviewer.com/public/weather-maps.json";
  var radarBtn = document.getElementById("radar-btn");
  var radarLabel = document.getElementById("radar-label");
  var radar = { on: false, layers: [], frames: [], idx: 0, timer: null };

  function toggleRadar() {
    if (radar.on) { disableRadar(); return; }
    radar.on = true;
    radarBtn.classList.add("active");
    radarLabel.hidden = false;
    radarLabel.textContent = "Laster radar …";

    fetch(RADAR_API)
      .then(function (res) { return res.json(); })
      .then(function (json) {
        if (!radar.on) return;
        var past = (json.radar && json.radar.past) || [];
        var cast = (json.radar && json.radar.nowcast) || [];
        var frames = past.slice(-9).concat(cast.slice(0, 3));
        if (!frames.length) throw new Error("ingen radarbilder");

        radar.frames = frames.map(function (f) {
          return { time: f.time * 1000, url: json.host + f.path + "/256/{z}/{x}/{y}/2/1_1.png" };
        });
        radar.layers = radar.frames.map(function (f) {
          return L.tileLayer(f.url, {
            opacity: 0,
            pane: "radarPane",
            maxZoom: 19,
            attribution: 'Radar: <a href="https://www.rainviewer.com/">RainViewer</a>'
          }).addTo(map);
        });
        radar.idx = 0;
        radarStep();
        radar.timer = setInterval(radarStep, 750);
      })
      .catch(function () {
        disableRadar();
        showToast("Radaren er utilgjengelig akkurat nå.");
      });
  }

  function radarStep() {
    var n = radar.layers.length;
    if (!n) return;
    radar.layers.forEach(function (layer, i) {
      layer.setOpacity(i === radar.idx ? 0.65 : 0);
    });
    var f = radar.frames[radar.idx];
    var future = f.time > Date.now();
    radarLabel.textContent = "📡 " + HOUR_FMT.format(new Date(f.time)) +
                             (future ? " (fremskriv)" : "");
    radar.idx = (radar.idx + 1) % n;
  }

  function disableRadar() {
    radar.on = false;
    radarBtn.classList.remove("active");
    radarLabel.hidden = true;
    if (radar.timer) { clearInterval(radar.timer); radar.timer = null; }
    radar.layers.forEach(function (layer) { map.removeLayer(layer); });
    radar.layers = [];
    radar.frames = [];
  }

  radarBtn.addEventListener("click", toggleRadar);

  // ---------------------------------------------------------------- Sammenligning

  // To steder side om side: temperaturgraf, «nå»-kort og dag-for-dag.
  // Fargene følger stedet (A = blå, B = grønn), aldri verdien.
  var compareState = null; // null | {a, picking:true} | {a, b}
  var cmpMarker = null;

  function setCmpMarker(lat, lon) {
    clearCmpMarker();
    cmpMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: "loc-marker",
        html: '<div class="loc-pulse loc-pulse-b"></div><div class="loc-pin loc-pin-b"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      }),
      interactive: false,
      keyboard: false
    }).addTo(map);
  }

  function clearCmpMarker() {
    if (cmpMarker) {
      map.removeLayer(cmpMarker);
      cmpMarker = null;
    }
  }

  function startComparePicking() {
    if (!currentDetail) return;
    compareState = {
      a: {
        lat: currentDetail.lat,
        lon: currentDetail.lon,
        name: detailTitle.textContent
      },
      picking: true
    };
    map.getContainer().classList.add("picking");
    detailTitle.textContent = "Sammenlign " + compareState.a.name + " med …";

    var html = "<p class='muted'>Klikk et sted i kartet, eller velg en favoritt:</p>";
    var favs = loadFavs().filter(function (f) {
      return favIndexOf([f], compareState.a.lat, compareState.a.lon) < 0;
    });
    if (favs.length) {
      html += "<ul class='cmp-pick'>" + favs.map(function (f, i) {
        return "<li data-i='" + i + "'>★ " + escapeHtml(f.name) + "</li>";
      }).join("") + "</ul>";
    }
    html += "<button class='cmp-cancel' id='cmp-cancel'>Avbryt</button>";
    detailBody.innerHTML = html;

    detailBody.querySelectorAll(".cmp-pick li").forEach(function (li) {
      li.addEventListener("click", function () {
        var f = favs[+li.getAttribute("data-i")];
        setCompareB(f.lat, f.lon, f.name);
      });
    });
    document.getElementById("cmp-cancel").addEventListener("click", function () {
      exitCompare();
    });
  }

  function exitCompare() {
    var a = compareState && compareState.a;
    compareState = null;
    clearCmpMarker();
    map.getContainer().classList.remove("picking");
    if (a) openDetail(a.lat, a.lon, a.name);
  }

  function setCompareB(lat, lon, name) {
    if (!compareState) return;
    map.getContainer().classList.remove("picking");
    setCmpMarker(lat, lon);
    compareState = {
      a: compareState.a,
      b: { lat: lat, lon: lon, name: name || lat.toFixed(2) + "°, " + lon.toFixed(2) + "°" }
    };
    var state = compareState;

    if (!name) {
      // Slå opp stedsnavn i bakgrunnen og oppdater visningen
      fetch(NOMINATIM_URL + "/reverse?format=jsonv2&zoom=12&accept-language=no&lat=" +
            lat + "&lon=" + lon)
        .then(function (res) { return res.json(); })
        .then(function (r) {
          if (compareState !== state || !compareState.b) return;
          var a = r.address || {};
          var found = a.village || a.town || a.suburb || a.city || a.municipality ||
                      (r.name || "").split(",")[0];
          if (found) {
            compareState.b.name = found;
            renderCompare();
          }
        })
        .catch(function () {});
    }
    renderCompare();
  }

  function renderCompare() {
    if (!compareState || !compareState.b) return;
    var state = compareState;
    var A = state.a, B = state.b;

    detailTitle.textContent = A.name + " ⇄ " + B.name;
    detailBody.innerHTML = "<p class='muted'>Laster varsler …</p>";

    Promise.all([fetchForecast(A.lat, A.lon), fetchForecast(B.lat, B.lon)])
      .then(function (entries) {
        if (compareState !== state) return;
        renderCompareBody(entries[0], entries[1], A, B);
      })
      .catch(function () {
        if (compareState !== state) return;
        detailBody.innerHTML = "<p class='muted'>Kunne ikke hente varslene. Prøv igjen senere.</p>";
      });
  }

  function renderCompareBody(entryA, entryB, A, B) {
    var html = "<div class='cmp-legend'>" +
      "<span><span class='dot dot-a'></span>" + escapeHtml(A.name) + "</span>" +
      "<span><span class='dot dot-b'></span>" + escapeHtml(B.name) + "</span></div>";

    // ---- Temperaturgraf med to linjer
    var chart = buildCompareChart(entryA, entryB);
    if (chart) {
      html += "<h3>Temperatur neste 48 timer</h3>" + chart.html;
    }

    // ---- Slik er det nå
    html += "<h3>Nå</h3><div class='cmp-now'>" +
            compareNowCard(entryA, "a") + compareNowCard(entryB, "b") + "</div>";

    // ---- Dag for dag
    var daysA = aggregateDays(entryA);
    var daysB = aggregateDays(entryB);
    var bByDate = {};
    daysB.forEach(function (day) { bByDate[day.dateLabel] = day; });

    html += "<h3>Dag for dag</h3><table class='cmp-table'>" +
      "<tr><td></td><td><span class='dot dot-a'></span></td><td><span class='dot dot-b'></span></td></tr>";
    daysA.forEach(function (dayA) {
      var dayB = bByDate[dayA.dateLabel];
      html += "<tr><td class='day-name'>" + dayA.label +
              "<span class='sub'>" + dayA.dateLabel + "</span></td>" +
              compareDayCell(dayA) + compareDayCell(dayB) + "</tr>";
    });
    html += "</table>";

    html += "<button class='cmp-cancel' id='cmp-back'>← Tilbake til varselet</button>";
    html += "<p class='muted' style='font-size:0.75rem'>Varsler fra Meteorologisk institutt (Yr).</p>";

    detailBody.innerHTML = html;
    if (chart) attachCompareHover(chart, A, B);
    document.getElementById("cmp-back").addEventListener("click", exitCompare);
  }

  function compareNowCard(entry, cls) {
    var step = nearestStep(entry, new Date());
    if (!step) return "<div class='cmp-card'></div>";
    var code = symbolCode(step);
    var inst = step.data.instant.details || {};
    return "<div class='cmp-card cmp-" + cls + "'>" +
      (code ? "<img src='" + iconBase + code + ".svg' alt=''>" : "") +
      "<div class='cmp-card-temp'>" + tempSpan(airTemp(step)) + "</div>" +
      (typeof inst.wind_speed === "number"
        ? "<div class='cmp-card-wind'>💨 " + Math.round(inst.wind_speed) + " m/s</div>"
        : "") +
      "</div>";
  }

  function compareDayCell(day) {
    if (!day) return "<td class='cmp-cell muted'>–</td>";
    return "<td class='cmp-cell'>" +
      (day.symbol ? "<img src='" + iconBase + day.symbol + ".svg' alt=''>" : "") +
      "<div>" + tempSpan(day.max) + "&thinsp;/&thinsp;" + tempSpan(day.min) + "</div>" +
      "<div class='cmp-precip'>" + (day.precip > 0 ? nb(day.precip, 1) + " mm" : "&nbsp;") + "</div>" +
      "</td>";
  }

  var CMP_W = 360, CMP_H = 136;
  var CMP_L = 26, CMP_R = 8, CMP_TOP = 12, CMP_BOT = 108;

  function buildCompareChart(entryA, entryB) {
    var ptsA = collectHourly(entryA);
    var ptsB = collectHourly(entryB);
    if (ptsA.length < 3 || ptsB.length < 3) return null;

    // Parvis på felles tidspunkter
    var bByMs = {};
    ptsB.forEach(function (p) { bByMs[p.ms] = p; });
    var pairs = [];
    ptsA.forEach(function (p) {
      if (bByMs[p.ms]) pairs.push({ ms: p.ms, ta: p.t, tb: bByMs[p.ms].t });
    });
    if (pairs.length < 3) return null;

    var xs = pairs.map(function (_, i) {
      return CMP_L + (CMP_W - CMP_L - CMP_R) * i / (pairs.length - 1);
    });

    var lo = Infinity, hi = -Infinity;
    pairs.forEach(function (p) {
      lo = Math.min(lo, p.ta, p.tb);
      hi = Math.max(hi, p.ta, p.tb);
    });
    var span = (hi - lo) || 1;
    var stepT = span <= 5 ? 2 : span <= 12 ? 3 : span <= 22 ? 5 : 10;
    var tLo = Math.floor((lo - 1) / stepT) * stepT;
    var tHi = Math.ceil((hi + 1) / stepT) * stepT;

    function ty(v) {
      return CMP_BOT - (v - tLo) / (tHi - tLo) * (CMP_BOT - CMP_TOP);
    }

    var svg = "";
    for (var tv = tLo; tv <= tHi; tv += stepT) {
      var y = ty(tv).toFixed(1);
      svg += "<line class='" + (tv === 0 ? "meteo-zero" : "meteo-grid") +
             "' x1='" + CMP_L + "' y1='" + y + "' x2='" + (CMP_W - CMP_R) + "' y2='" + y + "'/>";
      svg += "<text class='meteo-label' x='" + (CMP_L - 4) + "' y='" + (+y + 3) +
             "' text-anchor='end'>" + tv + "</text>";
    }

    for (var i = 0; i < pairs.length; i++) {
      var dt = new Date(pairs[i].ms);
      if (dt.getHours() % 6 !== 0) continue;
      var x = xs[i].toFixed(1);
      svg += "<line class='meteo-grid' x1='" + x + "' y1='" + CMP_TOP +
             "' x2='" + x + "' y2='" + CMP_BOT + "'/>";
      svg += "<text class='meteo-label' x='" + x + "' y='" + (CMP_BOT + 12) +
             "' text-anchor='middle'>" + String(dt.getHours()).padStart(2, "0") + "</text>";
    }

    ["a", "b"].forEach(function (key) {
      var line = pairs.map(function (p, idx) {
        return xs[idx].toFixed(1) + "," + ty(key === "a" ? p.ta : p.tb).toFixed(1);
      }).join(" ");
      svg += "<polyline class='cmp-line-" + key + "' points='" + line + "'/>";
    });

    svg += "<line class='meteo-cross' x1='0' y1='" + CMP_TOP + "' x2='0' y2='" +
           CMP_BOT + "' style='display:none'/>";

    var html = "<div class='meteo-wrap cmp-wrap'>" +
      "<svg viewBox='0 0 " + CMP_W + " " + CMP_H + "' role='img' " +
      "aria-label='Temperatur for begge steder de neste 48 timene'>" + svg + "</svg>" +
      "<div class='meteo-tip' hidden></div></div>";

    return { html: html, pairs: pairs, xs: xs };
  }

  function attachCompareHover(chart, A, B) {
    var wrap = detailBody.querySelector(".cmp-wrap");
    if (!wrap) return;
    var svgEl = wrap.querySelector("svg");
    var tip = wrap.querySelector(".meteo-tip");
    var cross = svgEl.querySelector(".meteo-cross");

    wrap.addEventListener("mousemove", function (ev) {
      var rect = svgEl.getBoundingClientRect();
      var vx = (ev.clientX - rect.left) / rect.width * CMP_W;
      var best = 0, bd = Infinity;
      for (var i = 0; i < chart.xs.length; i++) {
        var d = Math.abs(chart.xs[i] - vx);
        if (d < bd) { bd = d; best = i; }
      }
      var p = chart.pairs[best];
      cross.setAttribute("x1", chart.xs[best]);
      cross.setAttribute("x2", chart.xs[best]);
      cross.style.display = "";
      tip.hidden = false;
      tip.textContent = TIP_FMT.format(new Date(p.ms)) + " · " +
                        A.name + " " + nb(p.ta, 1) + "° · " +
                        B.name + " " + nb(p.tb, 1) + "°";
      var px = chart.xs[best] / CMP_W * rect.width;
      var tipW = tip.offsetWidth || 160;
      tip.style.left = Math.min(Math.max(px - tipW / 2, 0), rect.width - tipW) + "px";
    });
    wrap.addEventListener("mouseleave", function () {
      tip.hidden = true;
      cross.style.display = "none";
    });
  }

  document.getElementById("detail-cmp").addEventListener("click", startComparePicking);

  // ---------------------------------------------------------------- Delbare lenker

  // Kartutsnitt og valgt sted speiles i URL-en: #zoom/lat/lon[/sel=lat,lon]
  function updateHash() {
    if (!map) return;
    var c = map.getCenter();
    var h = "#" + map.getZoom() + "/" + c.lat.toFixed(3) + "/" + c.lng.toFixed(3);
    if (currentDetail) {
      h += "/sel=" + currentDetail.lat.toFixed(3) + "," + currentDetail.lon.toFixed(3);
    }
    history.replaceState(null, "", h);
  }

  function parseHash() {
    var m = location.hash.match(
      /^#(\d{1,2})\/(-?[\d.]+)\/(-?[\d.]+)(?:\/sel=(-?[\d.]+),(-?[\d.]+))?/
    );
    if (!m) return null;
    return {
      zoom: +m[1],
      lat: +m[2],
      lon: +m[3],
      sel: m[4] ? { lat: +m[4], lon: +m[5] } : null
    };
  }

  // ---------------------------------------------------------------- Tastatur

  document.addEventListener("keydown", function (ev) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (ev.key === "ArrowRight") {
      stopPlayback();
      setTimeIndex(timeIndex + 1);
      ev.preventDefault();
    } else if (ev.key === "ArrowLeft") {
      stopPlayback();
      setTimeIndex(timeIndex - 1);
      ev.preventDefault();
    } else if (ev.key === " ") {
      if (playTimer) stopPlayback();
      else startPlayback();
      ev.preventDefault();
    } else if (ev.key === "Escape" && !detailPanel.hidden) {
      document.getElementById("detail-close").click();
    }
  });

  document.getElementById("now-btn").addEventListener("click", function () {
    stopPlayback();
    setTimeIndex(0);
  });

  // ---------------------------------------------------------------- Tema

  var themeBtn = document.getElementById("theme-btn");

  function applyTheme(dark) {
    document.documentElement.classList.toggle("dark", dark);
    themeBtn.textContent = dark ? "☀️" : "🌙";
    try { localStorage.setItem("wxmap-theme", dark ? "dark" : "light"); } catch (e) {}
  }

  function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem("wxmap-theme"); } catch (e) {}
    var dark = stored
      ? stored === "dark"
      : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(dark);
  }

  themeBtn.addEventListener("click", function () {
    applyTheme(!document.documentElement.classList.contains("dark"));
  });

  // ---------------------------------------------------------------- Min posisjon

  document.getElementById("geo-btn").addEventListener("click", function () {
    if (!navigator.geolocation) {
      showToast("Nettleseren støtter ikke posisjonstjenester.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        goToPlace(pos.coords.latitude, pos.coords.longitude);
      },
      function () {
        showToast("Fikk ikke tilgang til posisjonen din.");
      },
      { timeout: 10000, maximumAge: 300000 }
    );
  });

  // ---------------------------------------------------------------- Init

  function init() {
    initTheme();
    var fromHash = parseHash();

    map = L.map("map", {
      zoomControl: true,
      worldCopyJump: true,
      keyboard: false // piltastene styrer tidslinjen i stedet
    });

    if (fromHash) {
      map.setView([fromHash.lat, fromHash.lon], fromHash.zoom);
    } else {
      map.setView([65.0, 13.0], 5); // Norge
    }

    // Radarlaget ligger over grunnkartet, under markørene
    map.createPane("radarPane");
    map.getPane("radarPane").style.zIndex = 350;

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
                   ' | Værdata: <a href="https://api.met.no/">MET Norge</a> (CC BY 4.0)'
    }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);

    map.on("moveend", function () {
      refreshGrid();
      updateHash();
    });
    map.on("click", function (ev) {
      if (compareState && compareState.picking) {
        setCompareB(ev.latlng.lat, ev.latlng.lng);
      } else {
        openDetail(ev.latlng.lat, ev.latlng.lng);
      }
    });

    slider.max = String(timeline.length - 1);
    setTimeIndex(0);

    probeIconBase();
    doRefreshGrid();

    if (fromHash && fromHash.sel) {
      openDetail(fromHash.sel.lat, fromHash.sel.lon);
    }
  }

  init();
})();
