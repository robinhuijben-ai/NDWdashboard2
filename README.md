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
   Sleep **de inhoud** van de uitgepakte map erin (dus `fetch.py`, `ndw.py`,
   `README.md`, de map `web` en de map `.github`) en klik *Commit changes*.
   > Op een Mac is de map `.github` verborgen. Druk in Finder op
   > **Cmd + Shift + .** om hem te tonen, zodat je hem mee kunt slepen.
   > Lukt dat niet: kies in de repository *Add file → Create new file*, typ als naam
   > `.github/workflows/update.yml` en plak de inhoud van dat bestand erin.
3. **Pages aanzetten.** *Settings → Pages →* bij *Source* kies **GitHub Actions**.
4. **Eerste run starten.** Tabblad *Actions →* "NDW-data bijwerken" → *Run workflow*.
   De eerste keer duurt het een paar minuten (de meetlocatietabel en het
   landelijke verkeersbordenbestand worden dan opgehaald).
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
  `HISTORY_DAYS` (bijv. `30`). De straal rond de brug stel je in met `RADIUS_KM`
  (standaard `12`).
- **Projecten** worden in je eigen browser bewaard. Via het menu ⋮ kun je een
  project **delen via een link** (de ontvanger krijgt een eigen kopie), of
  exporteren/importeren als bestand.
- **Actief houden.** GitHub zet geplande workflows uit als een repository
  60 dagen niet gewijzigd is. De workflow voorkomt dat zelf met een lege commit
  na 45 dagen. Staat hij toch uit, dan zie je een knop *Enable workflow* onder *Actions*.
- **Kosten.** Voor een openbare repository zijn GitHub Actions en Pages gratis.

## Wat zit erin

| Laag | NDW-bestand | Ververst |
|---|---|---|
| Reistijden | `traveltime.xml.gz` + `measurement_current.xml.gz` (ligging, dagelijks) | elke run |
| Matrixborden (MSI) | `Matrixsignaalinformatie.xml.gz` + `ndw_msi_shapefiles_latest.zip` | elke run |
| DRIP's | `dynamische_route_informatie_paneel.xml.gz` (beeld + tekst) | elke run |
| Verkeersborden | `verkeersborden_actueel_beeld.csv.gz` | wekelijks |

Bestanden: `fetch.py` (bouwt de data), `ndw.py` (leest de NDW-formaten),
`web/` (het dashboard), `.github/workflows/update.yml` (de planning).
