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
  });

  function openDetail(lat, lon, knownName) {
    detailPanel.hidden = false;
    setSelectedMarker(lat, lon);
    detailTitle.textContent = knownName || lat.toFixed(3) + "°, " + lon.toFixed(3) + "°";
    detailBody.innerHTML = '<p class="muted">Laster varsel …</p>';

    if (detailAbort) detailAbort.abort();
    var abort = detailAbort = new AbortController();

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

  function buildMeteogram(entry) {
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
    var html = "";

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
    map = L.map("map", {
      zoomControl: true,
      worldCopyJump: true
    }).setView([65.0, 13.0], 5); // Norge

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
                   ' | Værdata: <a href="https://api.met.no/">MET Norge</a> (CC BY 4.0)'
    }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);

    map.on("moveend", refreshGrid);
    map.on("click", function (ev) {
      openDetail(ev.latlng.lat, ev.latlng.lng);
    });

    slider.max = String(timeline.length - 1);
    setTimeIndex(0);

    probeIconBase();
    doRefreshGrid();
  }

  init();
})();
