# Verkeersdashboard Van Brienenoordbrug

Online kaartdashboard voor de verkeerssituatie rond de Van Brienenoordbrug,
gevoed met open data van NDW. Er hoeft niets geïnstalleerd te worden: GitHub
haalt de feeds ongeveer elke 5 minuten op en publiceert het dashboard als
website (GitHub Pages).

## Eenmalig instellen (± 5 minuten)

1. **Repository aanmaken.** Ga naar https://github.com/new, kies een naam
   (bijv. `brienenoord-verkeer`), zet hem op **Public** en klik *Create repository*.
   *(Private kan ook, maar GitHub Pages werkt daar alleen met een betaald abonnement.)*
2. **Bestanden uploaden.** Klik op de lege repository op *uploading an existing file*.
   Sleep **de inhoud** van de uitgepakte map erin (dus `fetch.py`, `ndw.py`, `ov.py`, `archive.py`,
   `README.md`, de map `web` en de map `.github`) en klik *Commit changes*.
   > Op een Mac is de map `.github` verborgen. Druk in Finder op
   > **Cmd + Shift + .** om hem te tonen, zodat je hem mee kunt slepen.
   > Lukt dat niet: kies in de repository *Add file → Create new file*, typ als naam
   > `.github/workflows/update.yml` en plak de inhoud van dat bestand erin.
3. **Pages aanzetten.** *Settings → Pages →* bij *Source* kies **GitHub Actions**.
4. **Eerste run starten.** Tabblad *Actions →* "NDW-data bijwerken" → *Run workflow*.
   De eerste keer duurt het 10–20 minuten: dan worden de meetlocatietabel, de
   wegvakgeometrie, het landelijke verkeersbordenbestand en de OV-dienstregeling
   opgehaald. Daarna duurt een run meestal 1–3 minuten.
5. **Openen.** Het adres staat bij *Settings → Pages* en in de run:
   `https://<jouw-gebruikersnaam>.github.io/<repository>/`. Zet het in je
   bladwijzers; het werkt ook op telefoon en tablet, en je kunt het delen met collega's.

Daarna loopt alles vanzelf.

## Goed om te weten

- **Verversen.** De planning staat op elke 5 minuten. In de praktijk start GitHub
  soms 5–15 minuten later, vooral op drukke momenten. Rechtsboven zie je hoe oud
  de data is; is die ouder dan 30 minuten, dan kleurt de stip oranje.
- **Historie.** Reistijden worden 14 dagen bewaard (genoeg voor een nulmeting).
  Aanpassen: *Settings → Secrets and variables → Actions → Variables* →
  `HISTORY_DAYS` (bijv. `30`). Andere instellingen op dezelfde plek:
  `RADIUS_KM` (straal voor reistijden, standaard `12`), `LOOP_RADIUS_KM`
  (lusdetectie, `8`), `OV_RADIUS_KM` (OV-laag, `8`) en `OV_HISTORY_DAYS`
  (bewaartermijn OV-voertuigposities, `3`).
- **Archief.** Afgeronde dagen (reistijden, lusdata, matrixborden, DRIP's en
  situaties) worden elke dag ook opgeslagen in de branch `data` van deze
  repository, zodat de historie niet verloren gaat als GitHub de werkcache
  opruimt. Het dashboard haalt oude dagen daar vanzelf vandaan; in de tijdbalk en
  de grafieken kun je dus verder terug dan `HISTORY_DAYS`. Bewaartermijn: Variable
  `ARCHIVE_DAYS` (standaard `365`, `0` = onbeperkt). Reken bij een straal van
  35 km op ruwweg 1,5–2 GB per jaar. De branch bestaat steeds uit één commit,
  zodat oude versies geen extra ruimte innemen. Niet handmatig in die branch werken.
- **Projecten** worden in je eigen browser bewaard. Via het menu ⋮ kun je een
  project **delen via een link** (de ontvanger krijgt een eigen kopie), of
  exporteren/importeren als bestand.
- **Actief houden.** GitHub zet geplande workflows uit als een repository
  60 dagen niet gewijzigd is. De workflow voorkomt dat zelf met een lege commit
  na 45 dagen. Staat hij toch uit, dan zie je een knop *Enable workflow* onder *Actions*.
- **Kosten.** Voor een openbare repository zijn GitHub Actions en Pages gratis.

## Wat zit erin

| Laag | Bron | Ververst |
|---|---|---|
| Reistijden (500 m-vakken RWS, gemeente Rotterdam, PZH) | NDW `traveltime.xml.gz`; ligging uit `measurement_current.xml.gz` en `ndw_avg_meetlocaties_shapefile.zip` | elke run (ligging dagelijks) |
| Lusdetectie (snelheid + intensiteit per rijstrook) | NDW `trafficspeed.xml.gz` + `measurement_current.xml.gz` | elke run |
| Actuele situaties (files, afsluitingen, maatregelen, ongevallen, brugopeningen) | NDW `actueel_beeld.xml.gz` (DATEX II v3) | elke run |
| Planning werkzaamheden & evenementen | NDW `planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz` + `planningsfeed_brugopeningen.xml.gz` | elk uur |
| Matrixborden (MSI) | NDW `Matrixsignaalinformatie.xml.gz` + `ndw_msi_shapefiles_latest.zip` | elke run |
| DRIP's | NDW `dynamische_route_informatie_paneel.xml.gz` (beeld + tekst) | elke run |
| Verkeersborden | NDW `verkeersborden_actueel_beeld.csv.gz` | wekelijks |
| OV-lijnen en haltes | OpenOV `gtfs-nl.zip` | dagelijks |
| OV-voertuigen en storingen | OpenOV GTFS-realtime `vehiclePositions.pb` + `alerts.pb` | elke run |

Bestanden: `fetch.py` (bouwt de data), `ndw.py` (leest de NDW-formaten),
`ov.py` (leest GTFS en GTFS-realtime), `archive.py` (archief in de branch `data`), `web/` (het dashboard),
`.github/workflows/update.yml` (de planning).

## Bronvermelding en gebruik

- Verkeersdata: **NDW** (Nationaal Dataportaal Wegverkeer), open data.
- OV-data: **OpenOV / OVapi** (gtfs.ovapi.nl), afgeleid van NDOV. Het script
  haalt de realtime-bestanden hooguit eens per run (±5 minuten) op en de
  dienstregeling eens per dag, met een herkenbare User-Agent, conform het
  verzoek van OpenOV om de servers niet zwaarder te belasten dan nodig.
  De voertuigposities zijn dus een momentopname, geen live-volgsysteem.
- Kaart: **PDOK / Kadaster** (BRT-achtergrondkaart en luchtfoto).
