# Woowil

En minimal browser bygget på Electron: en `BaseWindow` med to `WebContentsView`s
— en til toolbaren (tilbage/fremad/reload/adressefelt, `src/renderer/`) og en
til selve den browsede side.

CEF (Chromium Embedded Framework) blev oprindeligt valgt for at holde
RAM-forbruget lavere end Electron, men CEF's native Linux vindues-embedding
viste sig ustabil i dette udviklingsmiljøs KDE/KWin-session (vinduer der aldrig
blev realiseret korrekt, eller browser-oprettelse der aldrig færdiggjordes —
uafhængigt af threading-model). Electron bruger Chromium's egen, langt mere
gennemtestede vindueshåndtering og har ikke de samme problemer.

## Bygge / køre

```bash
npm install
npm start
```

## Distribuérbare builds

Bruger `electron-builder`. Output lander i `dist/`.

```bash
npm run build:linux   # dist/Woowil-<version>.AppImage — chmod +x og kør, ingen installation
npm run build:win     # dist/Woowil <version>.exe — portabel, dobbeltklik, ingen installation
npm run build:all     # begge på én gang
```

En rigtig Windows-installer (`npm run build:win-installer`, NSIS) kan også
bygges her fra Linux, men kræver `wine` installeret (`sudo apt install
wine`) — uden det fejler den signering af NSIS' interne elevate.exe med
"wine process failed ENOENT". Den portable .exe fra `build:win` kræver
ikke Wine og er derfor standardvalget.

## Auto-opdatering

Bruger `electron-updater` mod GitHub Releases i et **privat** repo
(`package.json` → `build.publish`). Linux/AppImage har altid rigtig
auto-opdatering; Windows får det kun hvis `wine` er installeret på
byggemaskinen (så der kan bygges en rigtig NSIS-installer) — uden Wine
bygges der i stedet en portabel .exe, som virker fint at køre men ikke
selv kan opdatere (electron-updater kræver en installer på Windows).

**Vigtigt om et privat repo + auto-update**: appen skal selv kunne læse
releases uden dig til at være logget ind — det kræver en GitHub-token
*indbygget i den udgivne app*. Alle der åbner appens filer kan i princippet
trække den token ud igen. Løsningen her bruger derfor **to forskellige
tokens** med vidt forskellig magt:

1. **Publish-token** (`GH_PUBLISH_TOKEN`, bruges kun på byggemaskinen,
   aldrig i appen): en klassisk PAT med `repo`-scope. Opretter releasen og
   uploader filerne — skal aldrig ligge i en fil, kun gives som
   miljøvariabel.
2. **Runtime-token** (`GH_RUNTIME_TOKEN`, indbygges i appen, alle brugere
   kan i princippet se den): en **fine-grained** PAT scopet til **kun
   dette ene repo**, med **kun** "Contents: Read-only" — intet andet.

### Udgiv en ny version

```bash
GH_PUBLISH_TOKEN=<classic PAT, repo-scope> \
GH_RUNTIME_TOKEN=<fine-grained PAT, read-only, kun dette repo> \
  npm run release
```

Kører `scripts/release.js`: bygger Linux (AppImage) og Windows (NSIS hvis
Wine er installeret, ellers portabel .exe), opretter/genbruger GitHub
release'en for den version der står i `package.json`, og uploader alle
filer dertil. Kan køres igen for samme version — den lægger nye filer op
over de gamle i stedet for at fejle.

### Opsætning (skal gøres én gang)

1. Opret et **privat** GitHub-repo, fx `<dit-brugernavn>/woowil`.
2. Udfyld `owner`/`repo` i `package.json` → `build.publish` med de rigtige
   værdier (står som `REPLACE_WITH_...` lige nu).
3. Opret de to tokens ovenfor på github.com → Settings → Developer settings
   → Personal access tokens.
4. Push koden til repoet (`git remote add origin ...`, `git push -u origin
   main`).
5. Kør `npm run release` (se ovenfor) for at lave den første udgivelse.

Efter det: appen tjekker selv for nye versioner ved opstart, downloader i
baggrunden, og viser en bjælke ("Woowil x.x.x er klar — genstart for at
opdatere") når den er klar — eller tjek manuelt via ☰-menuen → "Tjek for
opdateringer".

## Arkitektur

- `src/main.js` — Electron main-process: opretter vinduet, faneblade som
  `WebContentsView`s, profil-/adressefelt-logik, og alle `woowil:*`
  IPC-handlers.
- `src/preload.js` — eksponerer en minimal, sikker `window.woowil`-API til
  toolbar-UI'et (ingen Node-integration i selve UI'et).
- `src/renderer/` — toolbar-UI'et (faner, adressefelt, profil-vælger,
  bogmærke-knap).
- `src/profile-store.js` — læser/skriver profiler, indstillinger, historik og
  bogmærker som JSON under Electrons `userData`-mappe.
- `src/pages/` + `src/pages-preload.js` — interne `woowil://`-sider (ny
  fane, indstillinger, historik, favoritter), serveret via en custom
  protocol-handler.
- `assets/icon.png` — app-ikonet (sat som vinduesikon i `src/main.js`).

## Profiler ("brugere")

Lokale profiler (som Chrome-profiler) — hver har sin egen
historik/bogmærker/indstillinger og sin egen cookie-/localStorage-session
(Electron session-partition). Håndteres via sidepanelet (☰-knappen i
toolbaren, øverst til højre):

- **Opret**: navn + adgangskode + bekræft adgangskode (skal matche).
  Adgangskoden hashes (`crypto.scryptSync` + tilfældigt salt pr. bruger) —
  gemmes aldrig i klartekst.
- **Skift**: klik på en brugers navn. Har brugeren en adgangskode
  (🔒-ikon), vises et password-felt inline i stedet for at skifte direkte.
- **Slet**: klik på skraldespanden to gange (arm/bekræft, 3 sekunders
  vindue) — ikke muligt for den aktive bruger, og ikke for den sidste
  tilbageværende.

Ingen konto-sync endnu — kan tilføjes senere som en separat udvidelse.

## Tema

Lys/mørk vælges i `woowil://settings`, gemmes pr. profil, og opdaterer
toolbar + alle åbne interne `woowil://`-sider live uden reload.

## Genvejstaster

`Ctrl+T` ny fane · `Ctrl+W` luk fane · `Ctrl+Shift+T` genåbn lukket fane ·
`Ctrl+N` nyt vindue · `Ctrl+Shift+N` nyt privat vindue · `Ctrl+Tab` /
`Ctrl+Shift+Tab` skift fane · `Ctrl+1`-`9` gå til fane nr. · `Ctrl+L` marker
adressefelt · `Ctrl+F` find på siden · `Ctrl+D` bogmærk · `Ctrl+R`/`F5`
genindlæs · `Ctrl+Shift+R` genindlæs uden cache · `Ctrl++`/`Ctrl+-`/`Ctrl+0`
zoom · `Ctrl+P` udskriv · `Ctrl+J` downloads · `Ctrl+H` historik ·
`Ctrl+Shift+I`/`F12` DevTools · `Alt+←`/`Alt+→` tilbage/fremad.

## Arbejdsområder

Som i Vivaldi: faneblade hører til et arbejdsområde, og fanebjælken viser
kun det aktive arbejdsområdes faner — andre arbejdsområders faner lever
videre i baggrunden. Vælges/oprettes/omdøbes/slettes via 🗂-knappen i
øverste venstre hjørne. Navn og indhold gemmes pr. profil og genskabes ved
næste opstart (fanernes URL'er kun hvis "Gendan forrige session" er
slået til i indstillinger — selve arbejdsområderne huskes altid).
Bogmærker/historik/indstillinger er fælles for alle arbejdsområder.

## Andre funktioner

- **Højreklik på en fane**: dublikér, luk/luk andre/luk faner til højre,
  genåbn lukket fane, bogmærk — som i Chrome.
- **Højreklik-menu (på selve siden)**: tilbage/fremad/genindlæs, link- og
  billedhandlinger, klip/kopier/sæt ind, udskriv/gem som PDF, bogmærk,
  inspicér element.
- **Adresseforslag**: mens du skriver i adressefeltet vises matchende
  historik og favoritter til hurtig navigation.
- **Downloads**: vises på `woowil://downloads` med fremgang, annuller, åbn
  og vis-i-mappe; et lille tal-badge i toolbaren viser aktive downloads.
- **Session-gendannelse**: valgfri indstilling (`woowil://settings`) der
  genåbner de faner du havde sidst, i stedet for altid at starte på
  startsiden.
- **Privat vindue**: `Ctrl+Shift+N` eller sidepanelet åbner et nyt vindue
  med sin egen midlertidige (ikke-gemte) cookie-/login-session; historik
  gemmes ikke, men favoritter/indstillinger deles med den aktive profil.
- **Bloker annoncer og trackere**: valgfri indstilling der blokerer en
  indbygget liste af kendte annonce-/tracker-domæner (ikke en fuld
  filterliste-motor).
- **Site-tilladelser**: kamera/mikrofon, placering og notifikationer viser
  en Tillad/Bloker-bjælke i toolbaren i stedet for at blive givet
  automatisk.

- **Chrome-udvidelser**: installér fra `woowil://extensions` — en udpakket
  mappe, en `.crx`/`.zip`-fil, eller indsæt et link til/id fra Chrome Web
  Store (hentes direkte fra Googles opdaterings-endpoint, siden butikkens
  egen "Tilføj til Chrome"-knap ikke virker i Electron). Bruger
  `electron-chrome-extensions` for fuld `chrome.tabs`/popup-understøttelse
  — se `CLAUDE.md` → "Chrome-udvidelser" for detaljerne.

## Launcher

En skrivebords-launcher er installeret til den aktuelle bruger:
`~/.local/share/applications/woowil.desktop`. Den kører
`node_modules/.bin/electron` direkte mod projektmappen, så den ikke er
afhængig af `npm`/`npx` ved opstart.

## Licens

GNU General Public License v3.0 (eller senere) — se [LICENSE](LICENSE).
