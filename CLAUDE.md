# Woowil — projektnoter til Claude

Woowil er en tilpasset desktop-browser bygget på Electron, udviklet interaktivt
med brugeren (Trimlon) over mange sessioner. Denne fil er skrevet så en Claude
Code-session på en **anden maskine** hurtigt kan samle konteksten op igen.
Brugeren kommunikerer på dansk — svar på dansk medmindre andet aftales.

## Hvad appen er

En minimal, hjemmelavet browser — faneblade, lokale brugerprofiler (med
adgangskode), "arbejdsområder" (à la Vivaldi), bogmærker/historik/downloads,
lys/mørkt tema, adblock, inkognito, auto-opdatering. Ikke et wrapper-projekt
omkring en eksisterende browser — hele UI'et (toolbar, sidepanel, ny-fane-side
osv.) er skrevet fra bunden i almindeligt HTML/CSS/JS.

## Arkitektur — det vigtigste at forstå først

**`BaseWindow` + flere `WebContentsView`, ikke `BrowserWindow`/`BrowserView`.**
Dette er en bevidst, ret usædvanlig arkitekturbeslutning og forklarer flere
overraskelser i koden:

- Hvert vindue (`createWindow()` i `src/main.js`) har ét `toolbar`
  `WebContentsView` (fanebjælke, adressefelt, sidepanel — `src/renderer/`) og
  ét `WebContentsView` per åben fane. Kun toolbaren og den aktive fanes view
  er "attached" til vinduet ad gangen (`win.contentView.addChildView(...)`);
  andre faner/arbejdsområders views lever videre i baggrunden, bare ikke vist.
- **Panelet/adresseforslag/find-bar/permission-banner/update-banner er alle
  implementeret ved midlertidigt at gøre `toolbar`-viewet højere** (og
  gen-tilføje det for at rykke det øverst i z-order), i stedet for et rigtigt
  overlay-vindue. Se `layout()`, `pushExtra`/`floatExtra` i `main.js`.
- **Kendt konsekvens (fundet og rettet i v0.1.3)**: Electrons `app.quit()`
  prøver kun at lukke `BrowserWindow`-instanser først. Med `BaseWindow` er der
  intet for den at lukke, så `quit()` fuldførte aldrig efter
  `autoUpdater.quitAndInstall()` — den gamle proces blev hængende ved siden af
  den nye. Fix: eksplicit `app.exit(0)` efter en kort frist i
  `restartAndUpdate()`. **Hold øje med lignende steder** hvis noget "burde
  lukke appen" men ikke gør det — mistænk altid BaseWindow-vs-BrowserWindow
  først.
- **Kendt konsekvens (fundet og rettet efter migrering til en Wayland-baseret
  udviklingsmaskine)**: under Chromiums native Wayland Ozone-backend
  registrerer et rigtigt museklik på adressefeltet (eller et hvilket som
  helst andet felt i `toolbar`-viewet) aldrig tastaturfokus i den klikkede
  `WebContentsView` — feltet ser normalt ud, men intet sker når man skriver.
  Bekræftet ved at sammenligne CDP-simuleret input (virkede altid, fordi det
  går uden om selve klik-/fokus-routingen) med rigtige `xdotool`-klik/tastatur
  (virkede kun under X11/XWayland, ikke under native Wayland). Ramte ikke den
  oprindelige X11-udviklingsmaskine, kun en ny Wayland-session — endnu et
  eksempel på at BaseWindow+flere WebContentsViews er den usædvanlige
  arkitektur, der forklarer overraskelser. `app.commandLine.appendSwitch(
  'ozone-platform', 'x11')` retter det **ikke** — child-processer (renderer/
  GPU) arver switchen fint, men selve vinduets Ozone-backend er allerede
  valgt, før main.js's JS overhovedet kører, så vinduet bliver aldrig
  oprettet synligt (ingen fejl i loggen, det forsvinder bare). Den eneste
  pålidelige fix: helt øverst i `main.js`, før `electron` overhovedet
  kræves, genstarte hele processen med `--ozone-platform=x11` som ægte argv
  (`process.argv`), ikke som en switch tilføjet fra JS. Se koden øverst i
  `main.js`.
- **Manglende default-browser-håndtering (fundet ved rigtig brug: Claude
  Code CLI's login kunne ikke åbne forbindelsen, fordi det link, som skulle
  åbnes, blev fuldstændig ignoreret)**. `woowil-install-own-browser.sh` i
  woowil-os sætter korrekt `Exec=... %U` og `MimeType=text/html;
  x-scheme-handler/http;x-scheme-handler/https;` i det installerede
  `.desktop`-ikon — OS-siden af "sæt som standardbrowser" var altid korrekt.
  Manglen var i selve appen: `main.js` havde **ingen** `app.
  requestSingleInstanceLock()`/`'second-instance'`-håndtering og læste
  aldrig en URL fra `process.argv` ved opstart — ethvert link åbnet via
  `xdg-open`/en anden app endte enten i en helt ny, overflødig
  Electron-proces (uden single-instance-lock) eller i en tom "Ny fane", med
  selve URL'en droppet på gulvet. Fixet: `requestSingleInstanceLock()` +
  `'second-instance'`-handler (finder det fokuserede vindues `ctx` via
  `windowContexts`, åbner URL'en som ny fane, fokuserer vinduet) + samme
  URL-udtræk (`extractUrlFromArgv`, matcher `^https?://`) anvendt på
  `process.argv` ved koldstart. Verificeret med rigtige
  `electron . <url>`-kald: både koldstart-med-URL og
  allerede-kørende-instans+ny-URL åbner nu korrekt en ny fane i stedet for
  at tabe linket. **Ethvert nyt sted, der kan modtage et link udefra (nyt
  OS-integration, protokol-handler osv.), skal gå gennem `ctx.
  openExternalUrl`, ikke oprette et helt nyt vindue/instans.**
- **Kendt konsekvens af X11-tvangen (`getContentBounds()` er upålidelig)**:
  ved maksimering via vindueshåndteringen (ikke ved at trække et hjørne)
  under den tvungne X11-ozone-backend forblev `win.getContentBounds()` et
  stykke tid med den GAMLE, lille størrelse, selvom `win.isMaximized()` og
  `win.getBounds()` allerede var opdateret — resultatet var et stort sort
  område, fordi `toolbar`/fane-viewsne blev sat til den forkerte størrelse.
  `layout()` bruger nu `win.getBounds()` i stedet (vinduet har ingen egen
  OS-ramme/titellinje, så indhold = ydre størrelse her). Lyt også efter
  `'maximize'`/`'unmaximize'`, ikke kun `'resize'` — de fyrer uafhængigt.
- **`sendWorkspaces()` må ALDRIG også persistere** — den bruges både til
  rene forespørgsler (toolbarens `getWorkspaces()`-kald ved opstart, FØR
  `loadWorkspacesAndOpenTabs` har læst den rigtige gemte tilstand fra disk)
  og til at fortælle renderer'en om en reel ændring. Da den tidligere også
  kaldte `persistWorkspaceState()`, overskrev den allerførste forespørgsel
  hver eneste opstart den rigtige session med tomme standardværdier — det
  så ud som om browseren var "ren hver gang", uanset `restoreSession`.
  Fjern aldrig igen persistering herfra; kald `persistWorkspaceState()`
  eksplicit i de funktioner, der faktisk ændrer noget.
- **`woowil:navigate`-kanalen bruges af BÅDE `preload.js` (toolbarens
  adressefelt) OG `pages-preload.js` (alle interne `woowil://`-siders egne
  søge-/adressefelter, fx ny-fane-sidens)** — men handleren matchede kun
  `ctxFor` (kun toolbar-webContents), ikke `tabCtxFor` (fane-webContents).
  Ny-fane-sidens søgefelt gjorde derfor ingenting ved indsendelse. Handleren
  skal altid tjekke begge: `ctxFor(event) ?? tabCtxFor(event)`.

**Sikkerhedsgrænser (kontroller inden nye funktioner ændrer disse):**
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` overalt.
- `src/preload.js` (kun til toolbaren) vs. `src/pages-preload.js` (til alle
  faner, men eksponerer kun `window.woowilPages` når
  `location.protocol === 'woowil:'` — en almindelig hjemmeside ser aldrig
  IPC-broen).
- `servePage()` i `main.js` har en **allowlist** af kendte interne sider
  (`newtab`, `settings`, `history`, `bookmarks`, `downloads`, `extensions`)
  plus et path-resolution-tjek. Der var oprindeligt en
  path-traversal-sårbarhed her (hostname `".."` kunne læse filer uden for
  `pages/`) — allerede fundet og rettet, men **enhver ændring af
  `servePage`/`KNOWN_PAGES` skal bevare begge lag** af beskyttelsen.
- **En installeret Chrome-udvidelse er en langt større tillidsgrænse end
  en almindelig hjemmeside** — den kan læse/ændre indhold på tværs af alle
  sider den har `matches`-adgang til, uafhængigt af denne apps egne
  `contextIsolation`/`sandbox`-grænser (det er sådan extension-API'et er
  designet til at virke, ikke en fejl her). Der er bevidst ingen
  signatur-/kilde-verificering af installerede `.crx`/.zip-filer eller
  mapper — brugeren installerer udelukkende noget de selv aktivt har
  valgt en fil til, samme tillidsmodel som når man selv slår
  "udviklertilstand" til i rigtige Chrome.
- Adressefeltet blokerer `javascript:`/`vbscript:`-URL'er eksplicit
  (`UNSAFE_SCHEMES` i `main.js`) — en kendt anti-social-engineering-detalje
  fra rigtige browsere, tilføjet efter en sikkerhedsgennemgang.
- IPC-dispatch til flere vinduer går gennem `windowContexts`/`tabContextMap`
  (event.sender.id → ctx-objekt) — al ny IPC skal følge dette mønster, ikke
  registrere handlers direkte inde i `createWindow()` (det ville fejle med
  flere vinduer, da `ipcMain.on/handle` er globale).

## Chrome-udvidelser

Per-profil (samme model som Chrome selv, og matcher projektets eksisterende
per-profil session-partitions) — ikke ét globalt sæt delt af alle profiler.
Ingen adgang til selve Chrome Web Store (Electron har ikke det); brugeren
installerer fra en udpakket mappe eller en .crx-/.zip-fil via
`woowil://extensions`.

- **`session.loadExtension()`/`.removeExtension()`/`session.on('extension-
  loaded', ...)` er forældede i denne Electron-version — brug
  `session.fromPartition(partition).extensions.*` i stedet.** Bekræftet
  direkte (ikke kun ud fra en deprecation-advarsel) med et minimalt
  standalone script før noget af dette blev kodet ind i `main.js`: den
  gamle vej virker stadig, men logger en advarsel; hele API-fladen
  (`loadExtension`, `removeExtension`, `getAllExtensions`, begge events)
  findes identisk under `.extensions`.
- **En session skal have `persist:`-præfiks for overhovedet at kunne
  indlæse udvidelser** — et bart `session.fromPartition(id)` (uden
  `persist:`) fejler med "Extensions cannot be loaded in a temporary
  session", bekræftet direkte. Incognito-vinduers partition har bevidst
  intet `persist:`-præfiks (se `incognitoPartition` i `main.js`) — matcher
  heldigvis også hvordan rigtige browsere som udgangspunkt opfører sig
  (udvidelser kører ikke i incognito), så `ensureExtensionsHandled()`
  springer indlæsning helt over for den slags partitions, og
  installations-funktionerne afviser eksplicit med en fejlbesked frem for
  at ramme denne exception blindt.
- **Egen `storageId` (en UUID vi selv genererer), ikke Chromes egen
  `extension.id`, er nøglen i `extensions.json` og for selve mappenavnet
  under `extensionsDir()`.** Chromes id afhænger af enten en `key` i
  manifestet eller — når den mangler, som for stort set alt der ikke er
  hentet fra selve Web Store — en hash af den absolutte installationssti.
  At forsøge at omdøbe en allerede indlæst udvidelses mappe til at matche
  dens egen afledte id bagefter virker ikke pålideligt (den indlæste
  instans peger stadig på den gamle sti internt i Chromium). Løsningen: stien
  vi installerer til rører vi aldrig igen — `extensionMetadata()` i
  `main.js` udleder `storageId` tilbage fra `extension.path`s eget
  mappenavn hver gang, så der aldrig er tvivl om hvilken installeret post
  et indlæst `extension.id` hører til.
- **Ægte, reproducerbar hænge-fejl fundet og rettet under test**: at lukke
  extension-popup'en (`closeExtensionPopup()`) ved at fjerne dens
  `WebContentsView` og bagefter nulstille state kunne re-entre sig selv —
  `removeChildView()` udløser popup'ens eget `'blur'`-event synkront som
  en sideeffekt, og den blur-handler kalder `closeExtensionPopup()` igen,
  som (fordi state endnu ikke var nulstillet) forsøgte at lukke den samme
  `webContents` en gang til og frøs hele appen (bekræftet live — selv CDP
  stoppede med at svare). Rettelsen: nulstil `extensionPopupView`/
  `extensionPopupOwnerId` til `null` **før** `removeChildView()`/
  `webContents.close()` kaldes, ikke bagefter — samme
  nulstil-state-før-du-river-ned-mønster er værd at huske hvis flere
  synkrone "luk denne overlay"-funktioner tilføjes senere.
- **Popup'en er sin egen `WebContentsView`, ikke HTML inde i toolbarens
  egen side** — i modsætning til adresseforslag/workspace-switcher (som
  bruger `setOverlayOpen()` til bare at gøre toolbar-viewet højere, fordi
  det indhold allerede ligger i toolbarens eget dokument). En udvidelses
  popup skal køre med sin egen `chrome-extension://<id>/`-origin for
  overhovedet at få `chrome.*`-API'erne, så den kan ikke bare indlejres som
  et iframe i en anden sides DOM. `extensionAction()` opretter/positionerer
  derfor en helt ny `WebContentsView` under den klikkede knap (koordinater
  sendt fra `toolbar.js` via `getBoundingClientRect()`), på samme måde som
  faner selv oprettes og fjernes.
- **Værktøjslinjens ikon-knapper er bygget fra bunden i `toolbar.js`** (der
  er jo ingen indbygget Chrome-værktøjslinje her) — selve ikonet sendes som
  en `data:`-URL fra main-processen (læst og base64-encodet direkte fra
  udvidelsens egen manifest-refererede fil), så renderer-processen aldrig
  selv behøver at kunne hente `chrome-extension://`-indhold.
- **Testet grundigt live** med en minimal selvlavet MV3-testudvidelse
  (indlæsning, ikon i værktøjslinjen, klik åbner/lukker popup, aktiver/
  deaktiver, fjern, persistering på disk) og en standalone-test af selve
  CRX/ZIP-udpakningen (inkl. en simuleret CRX med falske header-bytes foran
  den rigtige ZIP).
- **`dialog.showOpenDialog()` skal have et vindue som første argument, eller
  crasher appen på rigtig hardware** — fundet efter v0.2.0 var udgivet: den
  native filvælger-dialog kunne slet ikke testes i dette projekts eget
  sandboxede/remote skrivebordsmiljø (samme miljøbegrænsning som ramte
  VM-testing i woowil-os — portal-baserede dialoger ser ikke ud til at
  kunne åbne rigtigt der; kaldet hang bare, uden fejl), så det blev udgivet
  utestet. Brugeren rapporterede et rigtigt crash på egen maskine.
  `src/main.js` havde allerede et velfungerende eksempel at sammenligne
  med (`dialog.showSaveDialog(win, {...})`, brugt til "udskriv til PDF")
  — det ENESTE der manglede i de to nye `dialog.showOpenDialog(...)`-kald
  var selve `win`-argumentet, som i denne apps helt igennem
  `BaseWindow`-baserede arkitektur er langt fra "optional" i praksis, uanset
  hvad Electrons egen dokumentation antyder. **Enhver ny `dialog.*`-brug
  skal altid have `ctx.win` (eller det tilsvarende vindue) som første
  argument** — spring det aldrig over, selv når det ser ud til at virke i
  test.
- **`dialog.showOpenDialog()` kan stadig SIGSEGV'e, selv med korrekt
  `ctx.win`, hvis den native dialog routes gennem xdg-desktop-portal** —
  fundet efter v0.2.1 (som fixede ovenstående `ctx.win`-bug) stadig
  crashede på brugerens rigtige KDE-maskine "kort efter" udvidelsessiden.
  Denne gang lykkedes det faktisk at reproducere crashet på en delt
  udviklingsmaskine (i modsætning til den rene sandbox, hvor portal-dialoger
  bare hænger uden fejl): `coredumpctl` viste et rigtigt SIGSEGV i
  hovedtråden inde i en GLib main-context-iteration, umiddelbart efter
  loggen registrerede portalens `application/vnd.portal.filetransfer`/
  `application/vnd.portal.files`-atomer — dvs. under selve
  xdg-desktop-portal FileChooser D-Bus-handshaket, ikke i vores egen JS.
  Kunne ikke gentvinge crashet 100% deterministisk via CDP-simulerede klik
  (samme begrænsning som før — ægte portal-interaktion kræver en rigtig
  bruger), så fixet er baseret på stack-trace-beviset, ikke en direkte
  "crashede før, crasher ikke nu"-verifikation. Fix: `process.env.
  GTK_USE_PORTAL = '0'` sat allerført i `main.js`, før noget GTK-relateret
  initialiseres (også før den eksisterende X11-genstart-logik, så flaget
  arver med over i den respawnede proces) — tvinger GTK til sin klassiske
  in-process filvælger i stedet for portal-D-Bus-vejen. Udgivet som v0.2.2;
  bed altid brugeren bekræfte på rigtig hardware efter denne slags fix, da
  sandboxen ikke selv kan give en fuld positiv verifikation.
- **RETTELSE til ovenstående: v0.2.2 løste IKKE brugerens crash** —
  brugeren rapporterede stadig crash, og det viste sig at være noget helt
  andet: ikke vores `woowil://extensions`-side eller nogen `dialog.*`-kald
  overhovedet, men selve **chromewebstore.google.com**-webstedet (hvor
  brugeren prøvede at hente Bitwarden/Claude-udvidelser). Denne gang blev
  det gentvunget 100% deterministisk (to gange, samme absolutte
  krasch-adresse begge gange) ved at starte appen under `gdb` med
  `catch signal SIGSEGV` og bare navigere til en `/detail/<id>`-side på
  Chrome Web Store — ingen klik krævedes overhovedet. Disassemblen viste et
  reelt null-pointer-kald (`mov 0x0,%rcx` efterfulgt af `call *0x40(%rcx)`,
  dvs. et virtuelt kald gennem et null-objekt) i browser-processens
  hovedtråd. En websøgning fandt den præcise, allerede kendte årsag: dette
  er en ægte fejl i **Electron 44.3.0 selv** (ikke i vores kode) —
  Chromium eksponerer `chrome.webstorePrivate` til almindelige websider på
  Chrome Web Store uden nogen `WebstorePrivateAPIDelegate` bagved i
  Electron, og butikkens egen side kalder
  `chrome.webstorePrivate.getReferrerChain()` med det samme en
  produktside renderes — det null-delegate-kald er præcis det der
  segfaulter hele browser-processen (og dermed alle vinduer/faner på
  samme tid). Rettet opstrøms i Electron 44.4.0 (udgivet 2026-09-15):
  `chrome.webstorePrivate` er nu helt utilgængelig, og de core-registrerede
  funktioner svarer med en fejl i stedet for at kalde ind i en null
  delegate. **Fix: opgraderet `electron`-devDependency fra `^44.0.0`
  (reelt installeret: 44.3.0) til `^44.4.3`.** Verificeret ved at gentage
  præcis den samme gdb+navigations-reproduktion efter opgraderingen — ingen
  crash, siden loader fint (butikkens egen JS kaster nu bare en harmløs
  "Uncaught (in promise) Error" i stedet for at tage hele appen ned).
  Udgivet som v0.2.3. **Lære for fremtiden**: når et rapporteret crash ikke
  forsvinder efter et målrettet fix, så tro ikke automatisk at den første
  hypotese var forkert i detaljen — overvej om det er en helt anden,
  endnu ikke identificeret fejl, og brug `gdb`+`catch signal` til en
  virkelig deterministisk reproduktion frem for at gætte videre på
  stack-traces fra `coredumpctl` alene. En hurtig websøgning på den
  konkrete krasch-signatur (nulpointer + Electron-version + hvilken
  hjemmeside) sparede meget tid her.
- GTK_USE_PORTAL=0-fixet fra forrige punkt er stadig i koden og skader
  ikke noget, men det var altså aldrig den egentlige årsag til brugerens
  gentagne crash-rapporter — hold det adskilt i hovedet fra
  webstorePrivate-fejlen ovenfor, hvis der nogensinde dukker endnu et
  `dialog.*`-relateret crash op.
- **Chrome Web Stores egen "Tilføj til Chrome"-knap kan aldrig komme til at
  virke i denne app, crash eller ej** — selv efter v0.2.3-fixet ovenfor
  (som kun forhindrer at et stray `chrome.webstorePrivate`-kald crasher
  browser-processen) er `chrome.webstorePrivate` stadig fuldstændig
  ikke-implementeret i Electron: siden kalder nu bare ind i en stub der
  svarer med en fejl i stedet for at installere noget. Det er en bevidst
  Electron-arkitekturbeslutning, ikke noget der kan rettes fra appens side.
  Løsning: `installExtensionFromWebStore(input)` i `main.js` — brugeren
  indsætter et Chrome Web Store-link (eller bare id'et) i et nyt felt på
  `woowil://extensions`, og vi henter selve `.crx`-filen direkte fra
  Googles offentlige opdaterings-endpoint
  (`clients2.google.com/service/update2/crx?...`) — samme endpoint en
  rigtig installeret Chrome selv bruger til at opdatere udvidelser, ikke
  scraping eller en privat API. Verificeret direkte mod den rigtige
  Bitwarden-udvidelse (23 MB, gyldig CRX3, udpakkes korrekt gennem den
  eksisterende `extractExtensionArchive()`). Genbruger
  `installExtensionFromArchive()` internt (skriver de hentede bytes til en
  midlertidig fil i `os.tmpdir()`, kalder den eksisterende
  fil-installations-vej, rydder den midlertidige fil op bagefter) —ingen
  duplikeret install-/valideringslogik.
- **`resolveManifestName()`** (ny hjælpefunktion, bruges alle steder et
  udvidelsesnavn vises) — nogle udvidelser (Bitwarden inklusiv) sætter
  `manifest.json`'s `name`-felt til en bogstavelig `__MSG_xxx__`-placeholder
  og forventer at en rigtig Chrome slår den op i
  `_locales/<default_locale>/messages.json`. Uden dette ville sådan en
  udvidelse vise `__MSG_extName__` som sit navn i UI'en i stedet for
  "Bitwarden Password Manager" — fundet ved at teste den rigtige
  Bitwarden-crx, ikke noget der var synligt med den tidligere
  minimale MV2-testudvidelse.
- Udgivet som v0.2.4.
- **`electron-chrome-extensions` integreret — rigtige udvidelser (Bitwarden
  m.fl.) virker nu, inklusiv popup'er, efter appen selv gik open source
  under GPL-3.0** (se README → "Licens"): den tidligere licenskonflikt er
  væk (begge er nu GPL-3.0-kompatible), og det viste sig — modsat hvad en
  ældre version af bibliotekets README antydede — at biblioteket (v4.9.0)
  reelt tager `Electron.BaseWindow` overalt i sin type-signatur
  (`addTab(tab: WebContents, window: BaseWindow)`,
  `PopupView`'s `parent: BaseWindow`), ikke `BrowserWindow` — bekræftet
  direkte i den installerede pakkes egne `.d.ts`-filer, ikke i README'en,
  så tjek altid selve typerne ved en fremtidig opdatering af biblioteket
  frem for at stole på dokumentationens ordlyd. Verificeret med en
  minimal standalone `BaseWindow`+`WebContentsView`-testapp (samme
  arkitekturmønster som denne app) FØR noget blev rørt i `main.js` —
  samme disciplin som resten af dette projekt.
  - **Hvad der ændrede sig**: `ensureExtensionsHandled()` opretter nu også
    én `ElectronChromeExtensions`-instans pr. partition (i
    `chromeExtensionsApiByPartition`), med `createTab`/`selectTab`/
    `removeTab`-callbacks der finder det rigtige vindue via den nye
    `findWindowContextForPartition()` (flere vinduer kan dele samme
    profils partition — vælger det fokuserede, ellers det første).
    `createTab()`/`switchToTab()`/`closeTab()` kalder nu selv
    `chromeExtensionsApi.addTab()`/`.selectTab()`/`.removeTab()` den anden
    vej, så biblioteket altid ved hvilke faner der findes. Hele det gamle
    håndbyggede popup-lag (`extensionPopupView`, `closeExtensionPopup()`,
    `extensionAction()`, `sendExtensions()`, `woowil:extension-action`-IPC,
    `#extensions-bar`/`.extension-btn` i toolbar.js/html/css) er fjernet —
    erstattet af `<browser-action-list>`-elementet
    (`electron-chrome-extensions/browser-action`), som selv tegner ikoner
    (via `crx://`-protokollen) og styrer popup'en (som en helt separat,
    rigtig `BrowserWindow`, ikke en `WebContentsView` som før).
  - **Vores eget installations-/administrationslag (`installExtension*`,
    `woowil://extensions`-siden, `profile-store.js`'s `extensions.json`,
    `loadedExtensionsByPartition`/`ensureExtensionsHandled`'s
    `extension-loaded`/`-unloaded`-lyttere) er UÆNDRET** — biblioteket
    erstatter kun "hvilke chrome.*-API'er virker for allerede-indlæste
    udvidelser + værktøjslinje-ikon/popup-UI'et", ikke hvordan udvidelser
    installeres/fjernes/gemmes.
  - **`crx://`-protokollen skal håndteres på toolbar'ens EGEN session
    (default session), ikke på hver profils partition-session** — fundet
    ved at læse selve bibliotekets kompilerede kildekode (ikke kun
    typedefinitionerne): `handleCRXProtocol(session)` registrerer sig på
    den session der MODTAGER forespørgslen (her: toolbar'en, som altid
    kører på `session.defaultSession`, se kommentaren ved
    `protocol.handle('woowil', ...)`), og slår selv den RIGTIGE
    målpartition op via et `?partition=`-query-param på selve
    `crx://`-URL'en. At kalde den på profil-sessionen (min første,
    forkerte antagelse, baseret på min egen standalone-test hvor
    værktøjslinjen ved en fejl delte session med fanerne) gjorde intet.
  - **Reel opstarts-race fundet og fikset ved rigtig test, ikke gættet
    frem**: `<browser-action-list>` forsøger at forespørge "aktiv fane"-
    tilstand med det samme den monteres i DOM'en — men `ensureExtensions
    Handled()` (og dermed selve `ElectronChromeExtensions`-instansen, som
    globalt kun første gang registrerer IPC-kanalen `crx-msg-remote` for
    HELE appen via bibliotekets interne `RoutingDelegate`-singleton) blev
    tidligere først kaldt dovent inde i `createTab()`, som kører EFTER
    værktøjslinjens side allerede er loadet og har nået at forsøge sit
    første kald. Symptom set live: konsol-fejl "No handler registered for
    'crx-msg-remote'" og en permanent tom værktøjslinje (ingen ikoner
    overhovedet), fordi elementet ikke selv prøver igen efter et
    mislykket første forsøg. Fix: `ensureExtensionsHandled()` for det
    aktive vindues partition kaldes nu tidligt i `createWindow()`, FØR
    `toolbar.webContents.loadFile(...)`.
  - **Sandboxede preloads kan ikke `require()` npm-pakker direkte** —
    `electron-chrome-extensions/browser-action`'s `injectBrowserAction()`
    skal ind i værktøjslinjens preload, men den er (med god grund)
    `sandbox: true`; et almindeligt `require()` af pakken fejlede live med
    "module not found" selv om den samme `require()` virker fint
    u-sandboxed. Løsning: `scripts/bundle-preloads.js` (esbuild, kaldt fra
    `prestart` og fra `release.js` før hvert build) bundler
    `src/toolbar-preload-entry.js` (som blot `require()`'r både det
    gamle `preload.js` og `injectBrowserAction()`) til én selvstændig
    `src/toolbar-preload.bundle.js` (git-ignoreret, altid regenereret) —
    `main.js`'s toolbar-`WebContentsView` peger på den bundlede fil, ikke
    på `preload.js` direkte længere.
  - **`alignment="bottom right"`** sat eksplicit på `<browser-action-list>`
    i `toolbar.html` — biblioteket kalder det "bottom left" som sin egen
    standard, hvilket i denne apps layout (værktøjslinjen sidder øverst)
    placerede popup'en delvist UDENFOR skærmen foroven ved et første,
    forkert `alignment="top right"`-forsøg (fanget live: `xdotool
    getwindowgeometry` viste `y: -10`) — "bottom" betyder popup'en åbner
    NED under knappen, "right" at dens højre kant flugter med knappens,
    samme visuelle mønster som en rigtig Chrome.
  - Testet grundigt live, ende-til-ende, mod den ægte Bitwarden-udvidelse
    (ikke kun en minimal testudvidelse): installation via
    `installExtensionFromWebStore`, ikon vises korrekt i værktøjslinjen,
    klik åbner en rigtig popup der når helt frem til Bitwardens egen
    onboarding-UI (`#/intro-carousel`, ikke længere fanget på en evig
    indlæsnings-spinner), samt en regressionstest af almindelig
    fane-oprettelse/navigation/inkognito-vinduer efter ændringerne.
  - **Kendt, ikke-blokerende støj**: Bitwardens baggrunds-service-worker
    (formentlig dens `alarms`-brug) udløser periodisk (hvert ~10. sekund)
    `NOTREACHED hit. Unexpected view type found: 0` i Electrons/Chromiums
    egen extensions-kode — logges, men crasher ikke og påvirker ikke
    synligt funktionaliteten; ikke undersøgt yderligere, da det ikke
    blokerer den faktiske brug.
  - Udgivet som v0.2.6.

## Password manager (gemme/udfylde brugernavne+adgangskoder, eksport)

Endnu ikke udgivet i noget versionsnummer — bygget hen over flere sessioner,
denne beskrivelse dækker det samlede resultat.

- **Kryptering via `safeStorage` (OS'ets egen nøglering: libsecret/DPAPI/
  Keychain), ikke selvskrevet kryptografi.** `encryptPassword`/
  `decryptPassword` i `main.js` er tynde wrappere om
  `safeStorage.encryptString`/`.decryptString`. Hvis
  `safeStorage.isEncryptionAvailable()` er `false` (ingen understøttet
  nøglering overhovedet), nægter appen bevidst at gemme i klartekst —
  kaster i stedet en klar fejl, samme "fail loudly" -princip som
  woowil-mails egen keyring-fallback.
- **`credentials.json`/`never-save-origins.json` er nye per-profil-filer i
  `profile-store.js`**, samme mønster som eksisterende bogmærker/historik/
  udvidelser (`upsertCredential` matcher på origin+brugernavn og
  opdaterer in-place, `findCredentialsForOrigin`, `addNeverSaveOrigin` osv.).
- **Login-formular-detektion og autofill sker i `pages-preload.js`, uden
  at eksponere NOGET kaldbart til selve siden** — `contextIsolation`
  isolerer kun JS-objekter/globals mellem side og preload, ikke selve
  DOM-træet, så preload-scriptet kan læse/skrive formularfelter direkte på
  en hvilken som helst side uden en `contextBridge`-bro en ondsindet side
  kunne misbruge. Formular-submit fanges i capture-fasen (ser stadig
  submittet selvom sidens egen JS kalder `preventDefault()` og selv
  håndterer login via `fetch`/XHR, meget almindeligt på moderne
  login-sider), og autofill sker ved `DOMContentLoaded` via et
  `ipcRenderer.invoke('woowil:get-autofill', location.origin)`-kald.
- **Gem-adgangskode-bjælken i toolbaren følger nøjagtig samme mønster som
  `permission-bar`/`update-bar`** — `main.js` sporer selv
  `passwordBannerOpen`/`PASSWORD_BAR_HEIGHT` (40px, samme højde som de to
  andre) og kalder `updateExtras()` til at ændre selve
  `WebContentsView`'ens højde; `toolbar.js`/`.html`/`.css` viser/skjuler
  bare `#password-bar` baseret på `password-prompt`-IPC-eventet, ingen
  egen højde-logik nødvendig i renderer'en. Tre knapper: "Gem" (krypterer
  og gemmer), "Aldrig for denne side" (`addNeverSaveOrigin`, ingen
  kryptering involveret), "×" (Ikke nu — luk bjælken, spørg igen næste
  gang). Panelet har et nyt "🔑 Adgangskoder"-link (samme
  `data-nav`-mønster som de andre interne sider, ingen ekstra JS
  nødvendig).
- **`woowil://passwords`-siden viser ALDRIG en adgangskode i klartekst som
  standard** — `getPasswordsPage()` returnerer kun id/origin/brugernavn/
  opdateringstidspunkt; kun et eksplicit "Vis"-klik pr. række kalder
  `revealPasswordPage(id)`, som dekrypterer netop den ene adgangskode. Har
  søgefelt, "Skjul" til at maskere igen, og "Fjern" (med `confirm()`).
  "Eksportér…"-knappen viser en `dialog.showMessageBox`-advarsel FØR selve
  gem-dialogen (samme to-trins-advarsel som Chrome/Firefox selv viser før
  en adgangskode-eksport), skriver Chromes eget CSV-format
  (`name,url,username,password`) for interoperabilitet med andre
  password-managere.
- **Bogmærke-eksport bruger Netscape Bookmark File Format**
  (`<!DOCTYPE NETSCAPE-Bookmark-file-1>`) — det universelle
  import/eksport-format alle browsere allerede forstår, i stedet for et
  Woowil-specifikt JSON-dump ingen andre kan læse. `exportBookmarksPage()`
  i `main.js` var allerede færdig fra en tidligere session; det eneste der
  manglede var selve "Eksportér bogmærker…"-knappen på
  `woowil://bookmarks`-siden (nu tilføjet, samme fejlvisnings-mønster som
  adgangskode-sidens eksportknap - `result.error` vises, `result.canceled`
  ignoreres stille).

### VIGTIGT: `safeStorage` kan fryse HELE hovedprocessen i dette
sandboxede udviklingsmiljø — testet, ikke gættet

Fundet ved rigtig, live test af "Gem"-knappen: at klikke den hængte
appen fuldstændig (alle vinduer/faner, selve CDP-debug-forbindelsen
holdt op med at svare) i titusindvis af millisekunder, gentagne gange.
Roden er ikke en fejl i denne apps kode: `dbus/object_proxy.cc`-logs viste
`org.kde.KWallet.open`/`.isEnabled`-kald der løb ud efter det klassiske
D-Bus-timeout (~25 sekunder) med `DBus.Error.NoReply`, efterfulgt (på et
senere forsøg) af et forsøg på at (gen)starte `kwalletd6` via den gamle
`org.kde.KLauncher`-tjeneste, som fejlede med det samme
(`ServiceUnknown: The name is not activatable`) — denne fjernstyrede
udviklingsmaskines KDE-session er tydeligvis delvis/ufuldstændig (ingen
rigtig `klauncher` kørende), ikke en fejl i selve Woowil Browser.

**Hvorfor dette er værre end woowil-mails tilsvarende keyring-fund**:
Electrons `safeStorage.encryptString()`/`.decryptString()` er 100%
synkrone og blokerer bogstaveligt hele Electron-hovedprocessens
event-loop, ikke bare én HTTP-request-handler-tråd som i Python/FastAPI.
Der findes ingen async-variant af `safeStorage` at skifte til. Denne app
kan derfor ikke selv forhindre en lignende fastfrysning på en rigtig
brugers maskine, hvis DENNE brugers nøglering-daemon også skulle være
langsom/utilgængelig et splitsekund - det er en grundlæggende
Electron/OS-begrænsning, ikke noget der kan patches herfra.

**Hvad der BLEV testet med succes i dette miljø** (alt hvad der ikke
rører `safeStorage` direkte): formular-submit udløser bjælken med korrekt
tekst, "Ikke nu" og "Aldrig for denne side" virker begge korrekt (ingen af
dem kalder kryptering), et "aldrig gem"-origin viser aldrig bjælken igen
ved efterfølgende submits, panel-linket navigerer korrekt til
`woowil://passwords`, siden viser sin tomme-tilstand og eksportknappen
findes, en bogmærke blev oprettet og vist korrekt på `woowil://bookmarks`
med den nye eksportknap, og at klikke "Eksportér bogmærker…" åbnede den
native gem-dialog uden at fryse processen (samme allerede-dokumenterede
begrænsning som andre native dialoger i dette repo - selve
dialog-interaktionen kan ikke automatiseres i sandboxen, men selve kaldet
virker).

**Hvad der IKKE kunne verificeres her**: at rent faktisk gemme en
adgangskode (klik "Gem"), at genindlæse en side og se autofill ske, og at
"Vis"-knappen på `woowil://passwords` rent faktisk dekrypterer noget - alt
sammen fordi det kræver et rigtigt `safeStorage`-kald, som hænger i dette
miljø. **Bed brugeren bekræfte disse tre specifikke ting på deres egen
rigtige Woowil OS-maskine** (som har en normal, fuldt fungerende
KDE/KWallet-session) før dette regnes for færdigt testet - samme
"kan ikke verificeres i sandbox, spørg brugeren"-mønster som de native
fil-dialoger og AltGr-tastatur-kvirken andetsteds i denne fil.

## Woowil-konto (valgfrit, per-profil login til den centrale konto-tjeneste)

Ny, separat tjeneste (`Trimlon/woowil-account`, se dens egen CLAUDE.md for
den fulde arkitektur) giver et centralt "Woowil-konto"-login på tværs af
browser/mail/en standalone "Woowil Konto"-app - helt valgfrit, aldrig et
krav for at bruge browseren.

- **Per-profil, ikke globalt** - `src/profile-store.js`'s
  `getWoowilAccount(id)`/`setWoowilAccount(id, account)`/
  `clearWoowilAccount(id)` gemmer `{userId, email, username,
  encryptedToken}` direkte i den enkelte profils post i `profiles.json`
  (samme fil som `passwordHash`) - matcher at alt andet her allerede er
  profil-scopet, og lader forskellige lokale profiler uafhængigt linke
  nul-eller-én Woowil-konto.
- **Genbruger den eksisterende `encryptPassword`/`decryptPassword`**
  (allerede generiske `safeStorage`-wrappere fra password manager-
  funktionen, ikke adgangskode-specifikke) til at kryptere session-tokenet
  før det rammer disken - ingen ny lokal krypteringsvej bygget.
- **To login-veje, samme lokale "adopter en session"-logik**:
  `loginWoowilAccount(identifier, password)` (kaldt fra panelets egen
  formular via `woowil:account-login`-IPC) og `checkWoowilAccountPendingFile()`
  (kaldt ved vinduesopstart og hver gang panelet åbnes) ender begge i
  `adoptWoowilAccountSession(profileId, token, user)`. Den sidste tjekker
  `~/.config/woowil-account/pending/browser.json` - en delt, OS-niveau-
  mappe (IKKE inde i denne apps egen `userData`), som den separate
  "Woowil Konto"-manager-app dropper en token i, så den kan logge browseren
  ind uden at spørge om adgangskoden igen. Se woowil-account-repoets
  CLAUDE.md for hele handoff-designet.
- **En Woowil-konto får sin EGEN lokale profil, ikke den der tilfældigvis
  var aktiv ved login** - oprindeligt tagede login bare `currentProfileId`
  direkte, hvilket i praksis betød at logge ind som dig selv omdøbte/
  overtog "Standard"-profilen. Rettet efter direkte tilbagemelding: begge
  login-veje kalder nu først `resolveWoowilProfile(user)`, som leder efter
  en eksisterende profil hvis `woowilAccount.userId` matcher (så gen-login
  genbruger samme profil i stedet for at hobe nye op) - findes ingen,
  oprettes en helt ny profil (navngivet efter `user.username`), som
  derefter aktiveres via `activateProfile()` (samme fulde profilskifte-rutine
  som panelets egen profilvælger bruger - persisterer også som den nye
  standard-profil ved næste opstart, via `store.setActiveProfileId`).
  **Sletter eller rører aldrig andre profiler** - hverken "Standard" eller
  nogen anden, kun tilføjer. Verificeret direkte mod den rigtige
  `ProfileStore`-klasse (ingen `safeStorage` involveret i selve
  profil-opslags-/oprettelseslogikken, så det var fuldt testbart her): ny
  profil oprettes og bliver aktiv ved første login, "Standard" er urørt og
  har ingen Woowil-konto-link, gen-login med samme bruger genbruger samme
  profil (ingen dubletter), og en anden Woowil-bruger får sin egen tredje
  profil.
- **Log ud er ikke-destruktivt** - `logoutWoowilAccount()` rydder kun
  selve konto-linket (`store.clearWoowilAccount`), rører aldrig bogmærker/
  adgangskoder/historik.
- **Arver den kendte, udokumenterede `safeStorage`-hæng-risiko** fra
  password manager-funktionen ovenfor - ingen ny afhjælpning forsøgt her.
- **Verificeret live** (mod en lokal dev-instans af woowil-account-
  backend'en): panel-login virker og gemmer et genuint krypteret (ikke
  klartekst) token i `profiles.json`, log ud rydder det korrekt, og
  pending-fil-handoff'et (simuleret som om manager-appen havde skrevet den)
  bliver korrekt samlet op ved panel-åbning og filen slettet bagefter.

## Fanehåndtering: ny-vindue-links, træk-for-at-omarrangere, træk-ud-til-nyt-vindue (v0.4.2)

Tre ting rapporteret fra en rigtig, frisk installation:

- **`window.open()`/`target="_blank"` åbnede et bart, "ufuldstændigt"
  vindue** - der var slet ingen `setWindowOpenHandler` sat noget sted, så
  Electrons helt generiske standardopførsel tog over: en almindelig
  `BrowserWindow` med kun siden i, ingen af denne apps egen toolbar/faner.
  Rettet i `createTab()` (`src/main.js`): `view.webContents.
  setWindowOpenHandler((details) => {...})` afviser altid selve default-
  handlingen (`{action:'deny'}`) og styrer det manuelt i stedet -
  `disposition === 'new-window'` (siden bad eksplicit om et separat
  top-niveau-vindue, typisk `window.open(url,'_blank','popup,width=...')`)
  går gennem det SAMME `createWindow()` som Ctrl+N allerede bruger (så det
  får en fuld Woowil-toolbar+faner, ikke Electrons afklædte popup); alt
  andet (almindeligt `target="_blank"`, et bart `window.open()`) åbner som
  en ny fane i samme vindue via `createTab()`, som en almindelig browser.
  **RETTELSE (v0.4.3) til "uundgåelig konsekvens" ovenfor - det var den
  ikke**: at afvise+genskabe ALTID betød `window.open()` returnerede `null`
  virkede fint for almindelige links, men ødelagde enhver popup-baseret
  login-strøm (Google/Microsoft/GitHub-login m.fl.), som er fuldstændig
  afhængig af at siden selv har et rigtigt håndtag til popup'en
  (`window.opener`/`postMessage` tilbage til den, eller selve
  `window.open()`-returværdien) for nogensinde at opdage at login lykkedes
  og lukke popup'en igen. Fundet live: login på claude.ai med en
  Google-konto åbnede popup'en, login lykkedes der, men claude.ai's egen
  fane fandt aldrig ud af det og kom aldrig videre.
  **Fix**: `setWindowOpenHandler` tjekker nu også `details.features` - en
  SCRIPTET popup (ikke-tom `features`-streng, præcis sådan stort set alle
  login-popup'er åbnes, fx `window.open(url,'oauth','popup,width=500,
  height=600')`) får nu `{action:'allow'}` i stedet, så Chromium selv
  opretter det rigtige barn-vindue med `window.opener` korrekt forbundet -
  siden får en ægte, ikke-null returværdi, og hele login-tilbage-flowet
  virker som i en almindelig browser. En USCRIPTET ny-vindue-forespørgsel
  (tom `features`, fx et almindeligt midt-klik "åbn i nyt vindue") har intet
  sådant afhængighedsforhold og går stadig gennem `createWindow()`/
  `createTab()` som før, så den beholder en fuld Woowil-toolbar+faner.
  **Verificeret** med en minimal selvstændig Electron-testapp (samme
  disciplin som ellers i dette repo): et scriptet `window.open(url,name,
  'popup,width=...')`-kald fik en ikke-null returværdi (handleren valgte
  `allow`), mens et bart `window.open(url)` uden argumenter fortsat gav
  `null` (uændret `deny`-sti) - bekræftede samtidig at Chromium klassificerer
  et HELT bart `window.open(url)` som `disposition: 'foreground-tab'`, ikke
  `'new-window'`, så det allerede gik gennem `createTab()`-grenen i forvejen.
  **Ikke testet**: en ægte, fuld Google-login-strøm med rigtige klik (samme
  miljøbegrænsning som andre klik-/popup-tunge funktioner i dette repo) -
  bed brugeren bekræfte det virker på deres egen maskine.

- **Faner kunne ikke trækkes for at omarrangeres** - `tabstrip.js` fik
  fuld HTML5 drag-and-drop: hver `.tab` er nu `draggable=true`, med
  `dragstart`/`dragend` på selve fanen og `dragover`/`drop` på selve
  `#tabstrip`-beholderen (indsætningsindeks beregnet fra musens X-position
  relativt til hver fanes midtpunkt). Ny IPC `woowil:reorder-tab` →
  `reorderTab(id, targetIndex)` i `main.js` omarrangerer selve `tabs[]`.
  **Ikke helt trivielt**: `tabs[]` er ÉT array der fletter ALLE
  arbejdsområders faner sammen (fanestrimlen viser kun det aktive
  arbejdsområdes egne, via `sendTabs()`s eget filter) - `reorderTab` regner
  derfor kun positionen om inden for samme arbejdsområdes egen delsekvens,
  og rører aldrig andre arbejdsområders indbyrdes rækkefølge. Verificeret
  med et selvstændigt Node-script mod selve algoritmen (ikke kun læst
  igennem): flytning til venstre/højre/start/slut, no-op ved "slip på
  samme plads", og et blandet to-arbejdsområde-array, alle gav korrekt
  resultat.

- **Træk en fane helt ud → nyt vindue** - samme drag-gestus som rigtige
  browsere ("træk fanen langt nok væk fra stripet"): `dragend` tjekker om
  `event.dataTransfer.dropEffect !== 'move'` - `'move'` sættes KUN af
  stripets egen `dragover`-handler, så hvis den aldrig fyrede (fanen blev
  trukket uden for selve `#tabstrip`s grænser, fx ned i sideindholdet eller
  helt ud af vinduet), betyder det "droppet udenfor" og udløser ny IPC
  `woowil:detach-tab` → `detachTabToWindow(id)`. **Bevidst forenklet
  implementering**: genbruger `closeTab()`+`createWindow(store,
  {startupUrl: url})` (begge allerede afprøvede kodeveje) frem for at
  flytte selve den LEVENDE `WebContentsView` til det nye vindue - hver
  `view.webContents.on(...)`-lytter sat op i `createTab()` (did-navigate,
  context-menu, `setWindowOpenHandler` osv.) lukker over DETTE vindues
  egen `toolbar`/`tabs`/`activeTabId`, så en ren view-transplantation ville
  efterlade den tavst forbundet til det forkerte (gamle) vindue uden en
  betydelig omstrukturering af hvordan disse lyttere registreres. Prisen:
  siden genindlæses i det nye vindue (samme URL), så frem/tilbage-historik
  og upsat JS-tilstand på siden går tabt - en reel, bevidst afvejning, ikke
  en tilfældig begrænsning.

**Ikke testet live i denne session** - denne sandkasse har ingen fungerende
`xdotool`/skærmbillede-pipeline lige nu (se andre steder i denne fil), og
ægte museklik-baseret drag-and-drop kan ikke simuleres pålideligt via CDP's
`Input.dispatchMouseEvent` alene for HTML5 drag-events (de kræver browserens
egen interne drag-source-tracking, ikke bare musebevægelser). Kun
statisk kodelæsning + den isolerede algoritme-test af `reorderTab` ovenfor.
**Bed brugeren bekræfte alle tre punkter på egen maskine** før dette regnes
for færdigt verificeret.

## Fanetræk på tværs af skærme/vinduer + synlig træk-feedback (v0.4.6)

Tre relaterede ønsker fra brugeren samtidig: en fane trukket helt fri landede
altid på den indbyggede skærm uanset hvor den blev sluppet; en fane kunne
ikke trækkes ind i et allerede åbent Woowil-vindue; selve trækket havde
ingen synlig feedback (Chrome viser en lille flydende fane-miniature der
følger musen).

**Fælles rodårsag, én fælles fix**: HTML5 drag-and-drop (den eksisterende
omarrangerings-/udtræk-gestus fra v0.4.2 ovenfor) giver kun renderer'en
DOM-events mens musen er over EN ELLER ANDEN Chromium-overflade - så snart
den forlader kilde-vinduets grænser (ud på skrivebordet, et andet
skærmbillede, eller et helt andet Woowil-vindue), får renderer'en intet
før `dragend` fyrer tilbage i det OPRINDELIGE vindue, uden koordinater og
uden nogen måde at vide hvor dropped faktisk skete. Løsningen: én global
"drag-session" i `main.js`, drevet af at polle
`screen.getCursorScreenPoint()` (virker uanset hvilket vindue/skærm/app
musen er over lige nu) - den polled position driver både et lille
altid-øverst preview-vindue (synlig feedback, hver "tick") OG - ved drop -
afgør om fanen skal flettes ind i et andet åbent Woowil-vindue eller åbne
et nyt på den rigtige skærm.

**Implementering** (alt nyt i `src/main.js`, uden om det eksisterende
`reorderTab`/in-strip-drop, som er uændret):
- `startTabDrag(sourceCtx, tabId, title)` (kaldt fra `dragstart`, via ny IPC
  `woowil:tab-drag-start`) opretter et lille frameless, transparent,
  `alwaysOnTop`, `skipTaskbar`, `focusable:false` `BrowserWindow` (bevidst
  IKKE `BaseWindow`+`WebContentsView` som app-hovedvinduerne - intet behov
  for fane-multipleksering her, kun en engangs-visuel overlay, så det
  simplere værktøj er det rigtige), med `setIgnoreMouseEvents(true)` så det
  aldrig stjæler selve droppet fra det der reelt ligger under musen.
  `setInterval(..., 16)` flytter det til `screen.getCursorScreenPoint()`
  hver "tick".
- `finishTabDrag(sourceCtx, tabId)` (kaldt fra `dragend` via ny IPC
  `woowil:tab-drag-end`, men KUN når `dropEffect !== 'move'` - en almindelig
  omarrangering inden i samme stribe går stadig den uændrede vej og rydder
  blot preview-vinduet op via samme kald med et `wasReordered`-flag) læser
  den sidste polled musepositon og tjekker FØRST om den ligger inden for et
  andet åbent, IKKE-inkognito-mismatchende vindues `win.getBounds()`
  (aldrig tilbyd fletning på tværs af inkognito/almindelig-grænsen, samme
  forventning som Chrome selv håndhæver) - hvis ja, `otherCtx.adoptTab(url)`
  + `sourceCtx.closeTab(tabId)` direkte (IKKE via `detachTabToWindow`, hvis
  "kun denne ene fane tilbage"-værn er forkert her: at flette et vindues
  sidste fane ind i et andet er en ægte, meningsfuld handling, og
  `closeTab()` lukker allerede det nu-tomme kildevindue helt af sig selv).
  Ellers (intet vindue under musen): `screen.getDisplayNearestPoint(point)`
  + clamp til den skærms `workArea` afgør det nye vindues `x`/`y`, sendt
  videre til `createWindow(store, { startupUrl, position })` (ny
  `opts.position`, blot spredt ind i `BaseWindow`-konstruktørens `x`/`y`).

**Verificeret live** med en selvstændig CDP-testrig MED rigtig musestyring
(denne sandkasse har - i modsætning til tidligere antaget - en rigtig
X11-session med fungerende `xdotool`/`wmctrl`, bekræftet denne session):
kaldte `window.woowil.tabDragStart/tabDragEnd` direkte via CDP (ægte
museklik-drevet HTML5-drag kan stadig ikke simuleres pålideligt, som
tidligere noteret - men selve main-proces-logikken, som er det nye her, er
fuldstændig uafhængig af hvordan drag-eventet selv blev udløst), med
`xdotool mousemove` til at flytte den RIGTIGE markør undervejs:
- Preview-vindue oprettes ved `tabDragStart` (bekræftet som nyt CDP-target)
  og ryddes korrekt op igen BÅDE ved en almindelig omarrangering (intet nyt
  vindue, ingen lækage) og ved et ægte udtræk.
- Ægte udtræk UDEN et andet vindue under musen åbnede et nyt vindue, der
  landede tæt på det faktiske droppunkt (testet droppet ved (1500,850) på
  en 1920×1080-skærm - nye vindue landede på (966,628), markant forskudt
  fra standardplaceringen og korrekt klemt inden for skærmens grænser) -
  den oprindelige klage ("lander altid på indbygget skærm") er løst for
  positionering inden for ÉN skærm.
- Fletning: oprettede et andet vindue, flyttede markøren til midten af dets
  rigtige, virkelige X11-vindue (fundet via `wmctrl -l -G`, ikke gættet),
  droppede der - fanetallet i kildevinduet faldt med 1, måltallet steg med
  1, intet tredje vindue blev oprettet. Testede specifikt kant-tilfældet
  "kildevinduets sidste fane" separat fra denne måling (se kommentaren i
  `finishTabDrag`) for ikke at blande det ind i en simpel optælling.

**Ikke verificeret**: rigtig multi-skærm-placering (`getDisplayNearestPoint`
vælger korrekt skærm) - denne sandkasse har kun ét skærmbillede (1920×1080),
samme begrænsning som ramte woowil-os-taskbar-arbejdet. Mekanismen er den
tekstbogs-korrekte, standard Electron-måde at gøre det på, men **bed
brugeren bekræfte på deres egen rigtige multi-skærm-opsætning** at et nyt
vindue rent faktisk lander på den skærm, fanen blev sluppet på.

**Også fundet og rettet undervejs (ikke en del af selve featuren)**: denne
sessions egne CDP-testscripts lækkede gentagne Electron-processer - `child.
kill()` dræbte kun `npx`-wrapperen, ikke selve Electron-processen, fordi
`main.js`s eget `--ozone-platform=x11`-genstart-trick (se filens egen
header-kommentar) bruger en FULDT DETACHED `spawn()`, som overlever sin
launcher uden problemer. 8 forældreløse Electron-instanser var ophobet, da
dette blev opdaget og ryddet op (`pkill -9 -f <user-data-dir>` i stedet for
`child.kill()` i test-scriptet fremover) - ikke en fejl i selve appen, kun i
testriggen, men værd at huske til senere CDP-baserede tests i dette repo.

### Opfølgning: fletning ind i et andet vindue virkede ikke på rigtig PC

Rapporteret direkte af brugeren umiddelbart efter v0.4.6: "Jeg kan ikke
trække en fane tilbage i en åben browser." Præciseret via opfølgende
spørgsmål: fanen "hopper tilbage i sit eget vindue, eller åbner på en ny
skærm hvis [det andet] vindue er på en anden skærm end hvor jeg trækker den
fra" - dvs. fletnings-forgreningen i `finishTabDrag` ramte ALDRIG, og faldt
hver gang igennem til "åbn nyt vindue"-stien (som i sig selv ramte den
rigtige skærm korrekt, bare uden at flette).

**Kunne ikke reproducere direkte** - denne sandkasse kan, som tidligere
noteret, ikke simulere et ægte, museknap-holdt HTML5-drag der krydser fra ét
rigtigt OS-vindue til et andet (kun det CDP-drevne IPC-genvejstest fra
v0.4.6's egen verifikation, som aldrig rørte den ægte browser-/OS-niveau
drag-håndtering). Mest sandsynlige root cause, ræsonneret ud fra hvordan
`dragend` opfører sig én gang det native OS-drag (XDND, pga. den tvungne
X11-ozone-backend) overtager fra almindelige DOM-events: selve `dragend`s
timing, når musen rent faktisk forlader kildevinduet, er ikke nødvendigvis
præcist synkroniseret med det ægte museknap-slip-øjeblik over målvinduet -
en enkelt `screen.getCursorScreenPoint()`-læsning PRÆCIS når `dragend` fyrer
kan derfor nemt ramme en position der endnu ikke er over mål-vinduet, eller
en anelse forkert, hver gang.

**Fix, defensiv frem for en enkelt sikker rettelse** (da selve timing-teorien
ikke kunne bekræftes direkte her):
- Ny delt `windowAtPoint(point, sourceCtx)` (brugt begge steder nu) sporer
  nu KONTINUERLIGT, i samme 16ms-polling der allerede flytter preview-
  vinduet, hvilket vindue (hvis noget) musen er over lige nu
  (`dragSession.lastHoveredCtx`). `finishTabDrag` foretrækker denne senest
  kendte værdi frem for kun at læse én gang helt til sidst - fanger dermed
  et musetræk der reelt VAR over mål-vinduet et splitsekund før selve
  `dragend` fyrer, selvom den allersidste læsning skulle vise sig at være
  en anelse for tidlig/sent.
- `windowAtPoint` fik desuden en 24px margin udenfor hvert vindues egne
  `getBounds()` - endnu et hedge, denne gang mod at `getBounds()` ikke
  nødvendigvis stemmer 1:1 med vindueshåndteringens EGEN dekorerede ramme
  på alle Linux-desktopmiljøer, og folk naturligt sigter efter kanten/toppen
  af et vindue (hvor en rigtig fanestrimmel sidder), ikke dets midte.

**Stadig ikke verificeret live mod et ægte museklik-drevet tværvindue-drag**
(samme begrænsning som hele resten af denne feature i v0.4.6 - se ovenfor).
Kørte den eksisterende synteset-/IPC-baserede regressionstest igen efter
denne ændring for at bekræfte selve omlægningen ikke havde ødelagt noget
(fletning virkede stadig korrekt, ingen tredje vindue, ingen krasch) - men
det tester ikke den egentlige, formodede timing-race, som kun kan bekræftes
af brugeren selv på deres rigtige maskine. **Bed brugeren prøve igen efter
denne opdatering, og hvis den STADIG fejler, bed om præcis hvor på
mål-vinduet de slipper fanen** (midt i/nær en kant) for at indsnævre det
yderligere.

## Sikkerhedsfund fra en review (rettet)

Tre reelle, ikke-teoretiske huller fundet ved en sikkerhedsgennemgang af
password manager-koden, alle rettet og verificeret live:

- **Path traversal → vilkårlig rekursiv filsletning i `ProfileStore.
  removeExtensionEntry()`** (`src/profile-store.js`) - `fs.rmSync(...,
  {recursive:true, force:true})` kørte tidligere ubetinget på en sti bygget
  fra `storageId`, uden at tjekke at id'et matchede en reelt installeret
  udvidelse, og uden den samme "bliv-inden-for-mappen"-kontrol som
  `servePage()` allerede har. Nås via `window.woowilPages.
  removeExtension(storageId)`, tilgængelig fra al JS med fodfæste på en
  `woowil://`-side. Rettet med to spærringer: (1) no-op hvis `storageId`
  ikke matcher en eksisterende post, (2) samme `startsWith(extensionsDir +
  path.sep)`-indeslutningstjek som `servePage()`. Samme mangel fandtes i
  `setExtensionEnabledPage()` (`src/main.js`) - kunne indlæse en vilkårlig
  mappe som "udvidelse" - rettet med samme to spærringer.
  **Verificeret live**: et angreb med `storageId =
  "../../../../../../tmp/pwned-canary-dir"` mod begge funktioner returnerer
  nu uændret liste og rører aldrig filsystemet udenfor `extensions/` (en
  kanariefil udenfor blev bekræftet urørt); normal aktiver/deaktiver/fjern
  af en rigtig installeret udvidelse (testet mod den ægte Bitwarden-
  udvidelse) virker uændret.
- **CSV-formula-injection i adgangskode-eksport** (`csvField()` i
  `src/main.js`) - et brugernavn fanges verbatim fra et login-felt på en
  hvilken som helst besøgt side (se `pages-preload.js`), så en ondsindet
  side kunne plante en "credential" hvis brugernavn er en
  regnearks-formel-payload (`=HYPERLINK(...)` osv.) - klassisk OWASP
  CSV-injection, rammer hvis den eksporterede fil åbnes i Excel/
  LibreOffice/Sheets. Rettet ved at prefixe enhver værdi der starter med
  `=`/`+`/`-`/`@`/tab/CR med et foranstillet `'`, som neutraliserer
  formlen uden at ændre den synlige værdi for normale felter.
  **Verificeret** (isoleret enhedstest af selve funktionen, da hele
  eksport-flowet kræver et rigtigt `safeStorage`-kald som hænger i dette
  sandboxede miljø - se ovenfor): formel-payloads får korrekt `'`-prefix,
  normale værdier og eksisterende anførselstegn-escaping er upåvirket.

## Bogmærke-mapper + favoritter-undermenu i panelet

Rapporteret direkte af brugeren: bogmærke-baren viste alt fladt på én linje,
ingen måde at organisere i mapper, og ingen steds at se hele listen uden at
gå til `woowil://bookmarks`. Besluttet sammen med brugeren: **behold den
eksisterende bogmærke-bar som den er** (flad linje af "pills"), men gør
`★ Favoritter` i selve panelet (den der allerede har Indstillinger/Historik/
Downloads osv.) til en udvides-i-panelet undermenu med mapper+bogmærker — og
vælg mappe *når* man bogmærker, ikke bagefter.

- **Datamodel** (`src/profile-store.js`): `bookmarks.json` var en flad
  array — nu `{ folders: [...], items: [...] }`, med `folderId: null` for
  "ingen mappe". **Bagudkompatibelt uden migrering af selve filen**:
  `getBookmarksData()` normaliserer en gammel flad array til den nye form
  ved hver læsning; filen skrives i det nye format først ved næste reelle
  ændring. Verificeret direkte (ikke kun læst igennem) med et standalone
  Node-script: en simuleret gammel flad `bookmarks.json` læses korrekt,
  mappe-opret/omdøb/ikke-destruktiv-sletning (bogmærker flytter til "ingen
  mappe", slettes aldrig) og duplikat-bogmærke-forebyggelse virker alle som
  forventet.
- **Tilføj-bogmærke-flowet ændrede sig**: at klikke ☆ på en ikke-bogmærket
  side åbner nu en popover (samme floatExtra/`setOverlayOpen`-mønster som
  adresseforslag/workspace-switcher — ingen ny main-process-layoutlogik
  nødvendig) med titel + mappevalg (eksisterende mappe eller "+ Ny mappe…"),
  i stedet for at bogmærke med det samme. Bogmærket skrives først ved
  "Gem" (`confirmAddBookmarkAction` i `main.js`). At klikke ★ på en allerede
  bogmærket side fjerner den stadig med det samme, ingen popover. "Annuller"
  er ren renderer-side (intet er skrevet i main-processen før "Gem").
- **Panelets `★ Favoritter`** (`favorites-section`/`favorites-toggle`/
  `favorites-tree` i `toolbar.html`/`.js`) udvider sig nu INDE i panelet
  (ingen ny main-process-logik her enten — panelet dækker allerede hele
  vinduet når det er åbent) og viser mapper (collapsible, klik for at
  folde ud/ind) + bogmærker (klik navigerer og lukker panelet), med et
  "Administrer bogmærker →"-link til den fulde `woowil://bookmarks`-side
  for omdøb/slet-mappe/flyt-bogmærke/eksport.
- **`woowil://bookmarks`-siden** fik mappe-grupperet visning, "+ Ny
  mappe"-knap, omdøb-mappe (samme dobbeltklik-for-at-redigere-mønster som
  arbejdsområde-navne i panelet), slet-mappe (ikke-destruktiv — bogmærker
  flytter til "Ingen mappe") og en per-bogmærke `<select>` til at flytte
  mellem mapper. Netscape-bogmærke-eksporten nester nu også mapper som
  `<H3>`-undermapper, i stedet for at eksportere alt fladt.
- **Verificeret ende-til-ende mod den rigtige kørende app, ikke kun
  kodelæst**: et CDP-script (`Runtime.evaluate` mod toolbar- og
  `woowil://bookmarks`-WebContents' egne CDP-targets, fundet via
  `--remote-debugging-port`+`/json`) kørte hele flowet gennem de ægte
  `window.woowil`/`window.woowilPages`-bridge-funktioner: opret mappe +
  bogmærke, flyt bogmærke til "ingen mappe" via den fulde side, slet mappen
  og bekræft bogmærket overlevede. Et andet CDP-script brugte ægte
  synthetic `.click()`/`.dispatchEvent()` på selve DOM'en (stjerneknap,
  mappe-`<select>`, Gem-knap, panel-toggle) for at bekræfte selve UI'et:
  popover åbner uden at bogmærke med det samme, "+ Ny mappe" afslører
  tekstfeltet, Gem lukker popoveren og opdaterer stjerne-ikonet til ★,
  panelets favoritter-undermenu viser den nye mappe når den foldes ud, og
  et andet ★-klik på en allerede bogmærket side fjerner den og nulstiller
  ikonet til ☆. **Husk at køre `node scripts/bundle-preloads.js` (eller
  `npm start`, som har det som `prestart`) efter enhver `preload.js`-ændring
  før test** — ramte selv dette: en stale `toolbar-preload.bundle.js` gav
  "`window.woowil.onBookmarkTree is not a function`" ved første testkørsel.
- **Ikke testet**: ægte museklik/tastatur på en rigtig skærm (samme
  miljøbegrænsning som andre klik-tunge funktioner i dette repo — kun
  synthetic `.click()` kunne køres her). Bed brugeren bekræfte visuelt på
  egen maskine, særligt popoverens placering under ★-knappen ved forskellige
  vinduesbredder.

## Filoversigt

- `src/main.js` — main-process. Alt: vinduer, faner, arbejdsområder, profiler,
  downloads, adblock, permissions, auto-updater, extensions, alle
  IPC-handlers.
- `src/preload.js` — `window.woowil` API til toolbaren. IKKE brugt direkte
  som preload længere — se `toolbar-preload-entry.js`.
- `src/toolbar-preload-entry.js` — `require()`'r `preload.js` +
  `electron-chrome-extensions/browser-action`; bundles til
  `src/toolbar-preload.bundle.js` (git-ignoreret) af
  `scripts/bundle-preloads.js`, som er det toolbar-`WebContentsView`'en
  reelt bruger som sin `preload`.
- `src/pages-preload.js` — `window.woowilPages` API, kun på `woowil://`.
- `src/profile-store.js` — JSON-baseret lager under Electrons `userData`
  (`~/.config/woowil/profiles/<id>/`): settings, historik, bogmærker,
  downloads, workspace-state (navngivne arbejdsområder + hvilke faner der
  hørte til hvert, bruges til session-gendannelse), installerede
  udvidelser (`extensions.json` + selve de udpakkede mapper under
  `extensions/<storageId>/`).
- `src/renderer/` — selve toolbar-UI'et (faner, adressefelt, sidepanel,
  find-bar, permission-banner, update-banner, workspace-switcher,
  extension-knapper).
- `src/pages/` — interne `woowil://`-sider, serveret af `servePage()`,
  inkl. `extensions/` (installer/liste/fjern udvidelser) og `passwords/`
  (liste/vis/fjern/eksportér gemte adgangskoder).
- `scripts/release.js` — se "Udgivelse" nedenfor.

## Udgivelse / distribution — læs dette før du bygger noget

Brug `npm run release` (kræver `GH_PUBLISH_TOKEN` + `GH_RUNTIME_TOKEN` som
miljøvariabler, se nedenfor). Det bygger Linux (AppImage) og Windows (NSIS
hvis `wine` er installeret, ellers en portabel .exe uden auto-update), og
opretter/genbruger GitHub-releasen for versionen i `package.json`.

**To tokens, med vidt forskellig magt — bland dem aldrig sammen:**
1. `GH_PUBLISH_TOKEN` — klassisk PAT, `repo`-scope. Bruges *kun* på
   byggemaskinen til at oprette releasen og uploade filer. Må aldrig ende i en
   fil, kun gives som miljøvariabel ved kørsel.
2. `GH_RUNTIME_TOKEN` — fine-grained PAT, **kun** "Contents: Read-only",
   scopet til **kun** `Trimlon/woowil-browser`. Bages ind i selve appen
   (`app-update.yml`) så den kan læse releases uden brugeren er logget ind.
   Alle der pakker appen ud kan læse denne token igen — det er accepteret,
   fordi den kun kan læse, aldrig skrive.

Ingen af tokens'ene er gemt noget sted i repoet eller i min hukommelse —
brugeren har dem, og skal give dem igen hvis en ny udgivelse skal laves.
**`GH_RUNTIME_TOKEN` har en udløbsdato på GitHub** (brugeren har tidligere
glemt at sætte "No expiration"/lang dato) — hvis auto-opdatering pludselig
holder op med at virke for alle brugere på én gang, tjek om denne er udløbet
først. Se `README.md` → "Auto-opdatering" for den fulde opsætningsguide.

**Repoet blev gjort offentligt og GPL-3.0-licenseret** (brugerens eget
bevidste valg — se `LICENSE`/`README.md` → "Licens"). `build.publish.private`
i `package.json` er sat til `false` til at matche. `GH_RUNTIME_TOKEN` er
teknisk set ikke længere *nødvendig* (et offentligt repos releases kan
læses uden token), men skader ikke at blive ved med at bruge — den er
stadig kun read-only. Fuld git-historik blev tjekket for lækkede tokens
(`git log --all -p` grep'et for `ghp_`/`github_pat_`-mønstre) **før**
repoet blev slået offentligt — fandt intet, men husk samme tjek hvis der
nogensinde er tvivl om historikken igen.

**Kendt miljø-kvirk (ramt flere gange)**: lange baggrundskommandoer
(bygning + upload af 100+ MB filer tager flere minutter) bliver upålideligt
afbrudt hvis de startes via en agent-harness' eget "kør i baggrunden"-flag på
tværs af flere svar/turns. **Brug altid `nohup ... > log 2>&1 & disown`** til
den slags, og poll log-filen bagefter — det har været 100% stabilt gennem
hele udviklingen, i modsætning til andre baggrunds-mekanismer.

**Windows kræver Wine på Linux-byggemaskinen** for at lave en rigtig
NSIS-installer (`sudo apt install wine`). Uden Wine bygger
`electron-builder --win nsis` en tom/ødelagt fil (fejler med
"wine process failed ENOENT" på signering af `elevate.exe`) — scriptet falder
automatisk tilbage til en portabel .exe i så fald, som virker fint at køre,
men ikke selv kan auto-opdatere.

Windows-builden er **usigneret** (intet kodesignerings-certifikat) — nogle
Windows-opsætninger (Smart App Control på Windows 11 særligt) kan blokere den
helt lydløst, uden nogen synlig advarsel. Hvis en bruger siger "der sker
ingenting", er det første mistænkte altid dette, ikke en bug i appen.

**Linux AppImages kræver FUSE2** på visse distroer (Arch har det ikke
installeret som standard) — `sudo pacman -S fuse2`, eller kør med
`--appimage-extract-and-run` som workaround.

**AppImage-artefaktet hedder bevidst `Woowil.AppImage`, ikke
`Woowil-${version}.AppImage`** (sat via `build.linux.artifactName` i
`package.json`) — electron-builders standardnavn INKLUDERER versionen, men
det ødelægger auto-opdatering i praksis. Fundet ved at læse
`electron-updater`s egen kilde (`AppImageUpdater.js`, `doInstall()`) efter
brugeren rapporterede at deres skrivebords-genvej døde ved hver
opdatering: hvis filnavnet på den kørende AppImage matcher `\d+\.\d+\.\d+`,
sletter opdateringen den GAMLE fil og opretter en NY med det nye
versionsnummer i navnet i stedet for at overskrive samme sti — enhver
genvej der peger på det gamle filnavn er død i samme øjeblik. Med et
versionsløst navn overskriver `autoUpdater.quitAndInstall()` altid præcis
samme fil/sti, for evigt. Bagside: GitHub-assetet hedder nu det samme
(`Woowil.AppImage`) for hver eneste release — versionen kan stadig ses på
selve release-siden/taggen, bare ikke i filnavnet man downloader.
**Woowil OS's eget `woowil-install-own-browser.sh` (i `woowil-os`-repoet)
har en `ls .../Woowil-*.AppImage`-glob der forudsætter det GAMLE,
versionerede navn** — det skal opdateres/omgås når/hvis en fremtidig
browser-opdatering skal staged ind i en ny woowil-os ISO, ellers matcher
globen ingenting.

## Sådan blev appen testet under udvikling (ingen `xdotool`/`wmctrl` installeret)

- `python3-xlib`-scripts til klik/tastatur (`Xlib.ext.xtest.fake_input`) og
  til at rejse/fokusere/lukke vinduer ordentligt (der er focus-follows-mouse
  og andre vinduer på denne maskine, så `_NET_ACTIVE_WINDOW` alene er ikke
  nok — flyt også musemarkøren ind i vinduet).
- Skærmbilleder via `import -window <id>` (ImageMagick), ikke et
  headless-værktøj.
- **Klik-koordinater er absolutte skærm-koordinater**, ikke vindues-relative
  — læg altid vinduets `+x+y`-offset fra `xwininfo` til, ellers rammer klik
  et helt andet vindue (skete flere gange).
- Dansk tastaturlayout gør visse tegn (`:`, `/`, `_` osv.) upålidelige at
  synteticere direkte — skift midlertidigt til `setxkbmap us` når der skal
  skrives URL'er/tekst i tests, skift tilbage til `dk` bagefter.
- Denne maskines X-display-nummer skifter mellem sessioner (`:0`, `:10`,
  `:20` er alle set) — tjek `who`/`ls /tmp/.X11-unix/` hvis et vindue ikke kan
  findes, i stedet for at antage `:0`.

## Nuværende status (opdatér denne sektion når noget ændrer sig)

- Seneste version: se `package.json` (bumpes ved hver release).
- GitHub: **offentligt** repo `Trimlon/woowil-browser` (GPL-3.0-or-later
  siden v0.2.6), gren `main`.
- Kørende hos brugeren: primært en rigtig Woowil OS-installation nu (efter
  at have skiftet fra almindelig Arch). Udvikling/test i denne session er
  foregået på en delt, fjernstyret cloud-udviklingsmaskine (KDE + krdp) —
  **ikke** brugerens rigtige maskine. Vigtig lære fra det: den maskines
  fjernskrivebordsforbindelse har sin egen, ægte fejl i AltGr-tastatur-
  tilstand (Chromium glemmer at AltGr stadig er holdt nede mellem
  keydown-events — bekræftet med rå input-logning: `alt: true` på selve
  AltGr-tasten, men `alt: false` på den efterfølgende taste, der skulle
  være AltGr-skiftet). Det gav "@" (og formentlig andre AltGr-tegn) som
  bare den ukombinerede tast i stedet. **Bekræftet IKKE at ske på brugerens
  egen, rigtige Woowil OS-maskine** — det er et miljø-specifikt kvirk ved
  denne ene udviklingsmaskines input-videresendelse, ikke en Woowil
  Browser-bug. Antag ikke det samme gælder næste gang; test på rigtig
  hardware hvis muligt, og mistænk denne artefakt før noget andet hvis
  AltGr-tegn opfører sig mystisk her.
- Ingen automatiserede tests findes endnu — al verifikation har været manuel
  (se testmetode ovenfor).

## User-agent — rettet "browser not supported"-bannere på visse sider

Rapporteret live af brugeren: `console.hetzner.com` viste en "Browser not
supported"-banner i toppen ved første besøg. Root cause: Electrons egen
standard-UA indeholder ` Electron/44.4.3` i slutningen (bekræftet direkte med
et minimalt headless `session.defaultSession.getUserAgent()`-testscript, ikke
gættet) — sider der allowlister UA-strenge mod kendte browsere genkender ikke
det token og viser en advarsel, selvom den underliggende Chromium er fuldt
funktionsduelig.

**Fix**: ny `ensureUserAgentHandled(partition)` i `src/main.js` (samme
`XHandledPartitions`-guard-mønster som `ensureProtocolHandled`/
`ensurePermissionsHandled` osv., kaldt fra `createTab()`), som sætter
sessionens UA til `session.getUserAgent()` med ` Woowil/<version>`- og
` Electron/<version>`-tokens fjernet via regex — samme tilgang som Brave/
Vivaldi/Opera selv bruger. Verificeret live: original UA var
`...Chrome/152.0.7977.130 Electron/44.4.3 Safari/537.36`, renset bliver den
`...Chrome/152.0.7977.130 Safari/537.36`. Bemærk: `Woowil/`-stripningen var i
dette testmiljø et no-op (app-navnet optræder ikke i UA'en når appen køres
upakket via `npx electron .`) — behold den alligevel som sikkerhedsnet, da en
*pakket* build (med `productName: "Woowil"` fra `package.json`) potentielt
kunne indsætte det token; ikke verificeret i en rigtig pakket AppImage endnu.

## Netflix / DRM-sider — kendt begrænsning, bevidst ikke løst

Netflix viser "make sure sites can play protected content" ved afspilning —
klassisk Widevine-CDM-mangel. Electron bundler (ligesom almindelig Chromium)
aldrig selve Widevine CDM'en, i modsætning til rigtig Chrome. Undersøgt
grundigt (webresearch, ikke kun gættet):

- **castLabs' Widevine-patchede Electron-fork** (`castlabs/electron-releases`,
  "Electron for Content Security") findes og er den etablerede løsning for
  Electron+DRM generelt — men deres nyeste Electron 44-build er
  `v44.0.0-alpha.1+wvcus`, stadig alpha og **tre patch-versioner bagud** for
  Woowils nuværende `44.4.3`. Deres sidste egentlige stabile serie er
  `43.0.0+wvcus`.
- **At skifte nu ville reintroducere et allerede rettet crash**: se
  "chrome.webstorePrivate"-segfault-fundet ovenfor under "Chrome-udvidelser"
  — det blev først fixet opstrøms i stock-Electron **44.4.0**. castLabs'
  `44.0.0-alpha.1` ligger før den fix.
- **Widevine på Linux er uanset begrænset til sikkerhedsniveau L3** (software-
  only, ingen hardware-TEE) — samme begrænsning ægte Chrome/Firefox har på
  Linux. Netflix capper selv med en fuldt virkende CDM til maks. 720p på
  Linux, uanset browser (industristandard-begrænsning, ikke noget
  Woowil-specifikt).
- **Brugerens beslutning (2026-10-07)**: lad Netflix/DRM-sider stå som en
  kendt, accepteret begrænsning for nu. Genoptag kun hvis castLabs udgiver en
  stabil build der matcher/overgår `44.4.x`, og vurdér da på ny om 720p-capet
  stadig gør det værd besværet.

## Kopiér-knapper i kodebokse virkede ikke altid

Rapporteret direkte af brugeren: uanset hvilken side med en "copy"-knap i en
kodeboks, virkede klik på den nogle gange ikke (ingen fejl synlig for
brugeren, bare intet kopieret) — markér teksten og højreklik → kopiér virkede
altid som workaround.

**Root cause**: `ensurePermissionsHandled()`'s `setPermissionRequestHandler`
i `src/main.js` havde en hvidliste på kun `['media', 'geolocation',
'notifications']` — enhver anden tilladelse blev afvist stille med
`callback(false)`, uden varsel til brugeren. De fleste moderne "copy"-knapper
bruger `navigator.clipboard.writeText()` (Chromiums `clipboard-sanitized-
write`-tilladelse), i stedet for det gamle `document.execCommand('copy')`
(som ikke kræver nogen tilladelse og derfor altid virkede) — det forklarer
hvorfor det kun ramte NOGLE sider. Markér+højreklik-kopiér går helt uden om
JS Clipboard-API'et (bruger OS'ets udklipsholder direkte via konteksmenuen),
derfor virkede det altid.

**Fix**: `clipboard-sanitized-write` godkendes nu med det samme
(`callback(true)`), uden om prompt-bjælken — matcher hvordan en rigtig
browser (Chrome m.fl.) selv håndterer det: at skrive til udklipsholderen fra
et rigtigt klik kræver ikke et samtykke-UI i nogen gængs browser, kun en
faktisk menneske-udløst handling (som Chromium allerede selv sikrer via sin
egen "transient activation"-kontrol, uafhængigt af denne apps egen
tilladelses-hvidliste).

**Verificeret direkte, begge veje** (CDP mod en rigtig kørende `npx
electron .`-instans, en lokal `http://127.0.0.1:<port>`-side med en knap der
kalder `navigator.clipboard.writeText()` — `http://127.0.0.1` tæller som en
"secure context" i Chromium, i modsætning til en `data:`-URL, som IKKE gør og
derfor gav et helt andet, vildledende resultat i et første testforsøg):
uden fixet fejlede kaldet med nøjagtig `"Failed to execute 'writeText' on
'Clipboard': Write permission denied."`; med fixet lykkedes det. `clipboard-
read` (JS-initieret "paste", bruges langt sjældnere af almindelige sider) er
bevidst IKKE tilføjet til hvidlisten — det er en mere sensitiv handling (kan
læse hvad som helst brugeren har kopieret fra andre apps) og rammer ikke
denne konkrete klage.

## itch.io login hang på "udfører sikkerhedsverificering" (Cloudflare Turnstile)

Rapporteret direkte af brugeren: login på itch.io kommer aldrig videre fra
"verificér at du er et menneske". Undersøgt live med CDP mod en rigtig
kørende `npx electron .`-instans (samme disciplin som clipboard-fixet
ovenfor) — ikke kun gættet.

**Konkret fund**: itch.io's `/login` svarer med HTTP 403 og en Cloudflare
"Udfører sikkerhedsverificering"-side, som loader en **Turnstile**-widget,
men widgettens egen iframe bliver ALDRIG indsat i DOM'et (bekræftet:
`document.querySelectorAll('iframe')` tomt 30+ sekunder i træk) — den sidder
altså fast for evigt, ikke bare langsom.

**Root cause isoleret (sammenlignede `navigator.userAgent` mod
`navigator.userAgentData`)**: `ensureUserAgentHandled()` renser allerede den
klassiske UA-streng til at se ud som rigtig Google Chrome (se afsnittet
ovenfor om Hetzner-bannret) — men Electrons SEPARATE, strukturerede Client
Hints (`navigator.userAgentData.brands`, og `Sec-CH-UA`/`Sec-CH-UA-Full-
Version-List`-headerne sendt på hver request, bekræftet direkte via CDP's
`Network.requestWillBeSentExtraInfo`) rapporterede ærligt kun `"Chromium"`,
ALDRIG `"Google Chrome"` — der findes ingen simpel switch for dette, i
modsætning til den klassiske UA-streng. Den uoverensstemmelse (påstår Chrome
ét sted, indrømmer "bare Chromium" et andet, maskinlæsbart sted) er præcis
den slags inkonsistens bot-detection som Cloudflares er bygget til at fange
— værre end ærligt at udgive sig for en anden, men INTERN konsistent browser
(Brave/Vivaldi/Edge klarer sig fint, fordi DE er konsistente om deres eget
brand). Siden UA-strengen allerede bevidst blev gjort Chrome-lignende (for at
fixe Hetzner), er den konsekvente fix at få Client Hints til at stemme
overens med det valg, ikke at fortryde det.

**Fix, begge halvdele**:
- `ensureUserAgentHandled()` (`src/main.js`) sætter nu også
  `webRequest.onBeforeSendHeaders` på partitionen, som tilføjer `"Google
  Chrome";v="<major>"` til `Sec-CH-UA` og `"Google Chrome";v="<fuld
  version>"` til `Sec-CH-UA-Full-Version-List`, udledt af samme rensede
  UA-streng.
- `src/pages-preload.js` (kører på ALLE almindelige faner, ikke kun
  `woowil://`) patcher `navigator.userAgentData` tilsvarende via
  `contextBridge.executeInMainWorld` — skal være main-world-koden, ikke en
  almindelig tildeling i selve preload-scriptet, fordi `contextIsolation`
  giver preloadet sin EGEN isolerede `navigator`, adskilt fra den siden selv
  læser.

**Verificeret delvist, ikke fuldt ud konkluderende**: headerrettelsen er
bekræftet virker live (`Sec-CH-UA` indeholder nu faktisk `"Google Chrome"` —
set direkte via CDP). Men et gentaget testforsøg MED fixet aktivt sad
*stadig* fast på samme "verificerer"-side — mens et tidligere testforsøg,
hvor fixet ved en fejl IKKE blev ramt (navigerede ved en fejl toolbar'ens
eget `webContents` i stedet for en rigtig fane), **kom hele vejen igennem**
til den rigtige login-side. Det peger på mindst to confoundere der ikke kan
udelukkes herfra:
1. **Denne sandkasse har ingen rigtig GPU** (`No available adapters` i
   konsollen ved WebGPU-forsøg, bekræftet live) — kan i sig selv gøre
   fingeraftrykket usædvanligt for Cloudflare, uafhængigt af UA/Client
   Hints, og er sandsynligvis IKKE til stede på brugerens rigtige PC.
2. **Gentagne automatiserede testforsøg fra samme IP på kort tid** kan i sig
   selv have opbygget en dårligere omdømme-score hos Cloudflare for selve
   denne sandkasses IP — adskilt fra noget som helst Woowil-specifikt.

Begge rettelser er reelle, korrekte forbedringer af et ægte, verificeret
inkonsistent fingeraftryk, og burde hjælpe generelt (Cloudflare Turnstile
bruges af mange sites, ikke kun itch.io) — men **kan ikke fra denne sandkasse
bekræftes som den FULDE løsning på brugerens konkrete oplevelse**. Bed
brugeren prøve login på itch.io igen på deres egen maskine efter denne
opdatering, og sig til hvis den stadig sidder fast.

## Ting brugeren bevidst har fravalgt/udskudt

- Konto-sync på tværs af enheder (kun lokale profiler).
- Kodesignering af Windows-builden (koster penge, ikke gjort endnu).
- DRM/Widevine-support (Netflix m.fl.) — se "Netflix / DRM-sider" ovenfor.
