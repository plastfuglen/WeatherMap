# 🌦️ Værkart

Interaktivt værkart som viser varsel fra [Meteorologisk institutt / Yr](https://api.met.no/)
oppå [OpenStreetMap](https://www.openstreetmap.org/).

## Funksjoner

- **Værsymboler og temperatur** for hele kartutsnittet – oppdateres når du
  panorerer og zoomer
- **Tidslinje** nederst: dra i slideren eller trykk ▶ for å «spille av» været
  fremover – time for time de første 48 timene, deretter 6-timers steg opptil
  9 døgn frem
- **Stedssøk** (Nominatim/OpenStreetMap) – søk opp et sted og hopp dit
- **Klikk hvor som helst på kartet** for å få langtidsvarselet for punktet:
  time-for-time neste døgn, og dagsvarsel med min/maks-temperatur, nedbør og
  vind

## Teknologi

Helt statisk – ingen byggesteg, ingen server, ingen API-nøkler:

| Del | Løsning |
| --- | --- |
| Kart | [Leaflet](https://leafletjs.com/) + OpenStreetMap-fliser |
| Værdata | [MET Locationforecast 2.0](https://api.met.no/weatherapi/locationforecast/2.0/documentation) (CC BY 4.0) |
| Værsymboler | [metno/weathericons](https://github.com/metno/weathericons) via jsDelivr |
| Stedssøk | [Nominatim](https://nominatim.org/release-docs/latest/api/Search/) |
| Hosting | GitHub Pages |

Varsler hentes per punkt i et rutenett over kartutsnittet og caches i
nettleseren, så tidslinjen kan spilles av uten nye API-kall.

## Publisering til GitHub Pages

1. Gå til **Settings → Pages** i repoet
2. Under **Build and deployment**, velg **Source: GitHub Actions**
3. Push til `main` – workflowen `.github/workflows/deploy.yml` deployer
   automatisk

Siden blir tilgjengelig på `https://<brukernavn>.github.io/WeatherMap/`.

## Kjøre lokalt

Åpne `index.html` direkte i nettleseren, eller kjør en enkel server:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## Datakilder og vilkår

- Værdata fra Meteorologisk institutt ([NLOD](https://data.norge.no/nlod/no/2.0)/[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)) – husk kreditering ved videre bruk
- Kartdata © OpenStreetMap-bidragsytere ([ODbL](https://www.openstreetmap.org/copyright))
- Stedssøket bruker Nominatims offentlige instans – ment for lett bruk, se
  [bruksvilkårene](https://operations.osmfoundation.org/policies/nominatim/)
