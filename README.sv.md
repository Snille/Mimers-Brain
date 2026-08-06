# Mimers Brain

*[English](README.md)*

Ett självhostat långtidsminne för språkmodeller. Samma idé som
[OB1](https://github.com/NateBJones-Projects/OB1), men på egen hårdvara — och med
en nivå som aldrig lämnar det privata nätverket.

Vilken modell som helst som talar MCP kan läsa och skriva till minnet, så
kunskapen om ens system beskrivs en gång i stället för i varje ny konversation.
Hemligheter serveras bara på LAN; allt annat går att nå varifrån som helst.

| | |
| --- | --- |
| **[install.md](install.md)** | Komplett installationsguide för Proxmox LXC, Docker Desktop och Ubuntu Server |
| **[HowToUse.md](HowToUse.md)** | Koppla in en modell, och sätta upp allt igen efter en ominstallation |
| **[history.md](history.md)** | Vad som byggts, varför, och vad som gick fel |
| **[docs/nginx-brain.conf](docs/nginx-brain.conf)** | Färdig reverse-proxy-config |
| **[migrate/](migrate/)** | Engångsimport av befintlig kunskap |

> **Adresser i dokumentationen är platshållare.** `192.0.2.x`
> ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)) och `example.net`
> ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)) är reserverade just för
> dokumentation och pekar aldrig på något verkligt. Byt dem mot dina egna. Den
> som kör en installation kan hålla sina riktiga värden i
> `docs/deployment.local.md`, som är gitignorerad.

## Skärmbilder

![Mimers Brains tankelista med metadatafilter och en LAN-skyddad valvpost](assets/screenshots/mimers-brain-thoughts.png)

![Mimers Brains användningsstatistik med aktivitetsdiagram per dag och månad](assets/screenshots/mimers-brain-statistics.png)

Webbgränssnittet finns på engelska och svenska, väljer webbläsarens språk vid
första besöket och minns ett manuellt val. Nya översättningar är vanliga
JSON-kataloger; se [docs/translations.md](docs/translations.md).

## Varför två portar

Nivåuppdelningen bygger **inte** på att inspektera `X-Forwarded-For`. Den kan
sättas av vem som helst, så en enda header hade räckt för att lyfta ut hela
valvet. Istället är nivån en egenskap hos **lyssnaren**:

| Port | Innehåll | Vem |
| --- | --- | --- |
| **8790** | öppen + valv, plus webbgränssnittet | Endast LAN. **Proxa aldrig hit.** |
| **8791** | endast öppen nivå | Den enda port NPM ska vidarebefordra `brain.example.net` till |

MCP-servern på 8791 byggs utan förmågan att nå valvet — verktygen konstrueras med
`tiers = ['open']` och `delete_thought` registreras inte alls. Det finns ingen
parameter, header eller sökväg som ändrar det. En angripare som tar sig förbi
proxyn når fortfarande bara öppen kunskap.

Verifierat av `test-isolation.ps1` (22 kontroller, alla gröna):

```powershell
powershell -ExecutionPolicy Bypass -File .\test-isolation.ps1
```

Testerna täcker: valv-rader syns inte via öppna porten, hemligt innehåll läcker
aldrig ut, direkt id-uppslag av en valv-rad nekas, skrivförsök till valvet
utifrån nekas, statistik avslöjar inte ens att valvet finns, anslutningsguiden
lämnar inte ut valvnyckeln på den proxade lyssnaren, användningsloggen bär aldrig
innehåll, och fel nyckel ger 401.

## Kom igång lokalt

Se **[install.md](install.md)** för en fullständig förstagångsinstallation i
Proxmox LXC, Docker Desktop eller Ubuntu Server. Kortversionen för Docker Desktop:

```powershell
Copy-Item .env.example .env    # fyll i POSTGRES_PASSWORD, MCP_ACCESS_KEY, OPENROUTER_API_KEY
docker compose up -d --build
```

Gränssnittet: <http://localhost:8790>

Generera en nyckel:
```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

**OPENROUTER_API_KEY är inte valfri i praktiken.** Utan den får inget en
embedding, och då fungerar varken semantisk sökning eller `search_thoughts` —
bara listning och textsökning.

## Koppla in i Claude Code

```bash
claude mcp add --transport http mimers-brain http://192.0.2.41:8790/mcp --header "Authorization: Bearer <MCP_ACCESS_KEY>"
```

Utifrån (och för andra LLM:er) används `https://brain.example.net/mcp`, som pekar
på 8791.

## Inloggning

Fyra vägar in, i den ordning servern provar dem:

1. **Bearer-nyckel** (`Authorization: Bearer <MCP_ACCESS_KEY>`) — det MCP-klienter
   och skript använder.
2. **Cookie** — webbläsaren byter nyckeln mot en HttpOnly-cookie en gång via
   `POST /api/login`. Cookien härleds ur nyckeln, så det finns ingen
   sessionstabell att underhålla.
3. **Authelia** — endast på den öppna lyssnaren. nginx har då redan kört
   requesten förbi Authelia och satt `Remote-User`.
4. **Nyckel i URL:en** (`/mcp?key=<MCP_OPEN_KEY>`) — öppna lyssnaren, endast
   `/mcp`, och bara om `MCP_OPEN_KEY` är satt.

Punkt 3 och 4 är säkra *just där och bara där*: den lyssnaren kan över huvud taget
inte nå valv-rader, så det värsta en förfalskad header eller en läckt URL kan ge är
öppen kunskap som vem som helst på LAN:et ändå kan läsa från 8790. Gör aldrig
samma sak på den fulla lyssnaren.

Punkt 4 finns för att vissa klienter tar en URL och inte erbjuder något sätt att
skicka en header — Claude Desktops connector-dialog är fallet som tvingade fram
den. En nyckel i en URL är en verklig försämring: den sparas i klientens config
och skrivs till varje accesslogg i proxyn. Därför måste `MCP_OPEN_KEY` vara ett
**annat** värde än `MCP_ACCESS_KEY`, och `/mcp` har `access_log off` i
[docs/nginx-brain.conf](docs/nginx-brain.conf). Den snyggare lösningen för den
sortens klienter är OAuth, skissad men inte byggd i
[docs/oidc-connector-plan.md](docs/oidc-connector-plan.md).

Gränssnittet serveras på **båda** portarna. På 8790 (LAN) ser du valvet och loggar
in med nyckeln; via `brain.example.net` ser du bara öppen nivå och Authelia
sköter inloggningen.

## Webbgränssnittet

Tre vyer, och inloggningen ovan gäller alla tre.

**Tankar** är listan, sökningen och taggredigeringen.

**Anslut** är uppkopplingsanvisningarna för varje klient — Claude Code, Codex i
VS Code, Claude Desktops connector, Open WebUI, ChatGPT, en generisk MCP-klient —
återgivna med *den här* instansens adresser, nycklar och verktygslista i stället
för platshållare. Kopieringsknappar ger färdiga kommandon och färdig JSON.

Nycklarna är maskerade tills du ber om dem, och en regel avgör vilka som alls
ligger på sidan: `MCP_ACCESS_KEY` serveras **bara av LAN-lyssnaren**. Att nå
gränssnittet via proxyn betyder att autentiseraren släppte in dig, men att skicka
valvnyckeln den vägen hade tryckt ut den enda credential som låser upp valvet ur
huset och in i en webbläsarcache varje gång sidan öppnas. `MCP_OPEN_KEY` visas på
båda, eftersom den är gjord för att resa i URL:er och aldrig kan nå mer än öppen
nivå.

LAN-adressen på den sidan är **inlärd, inte konfigurerad**. Att fråga OS:et om den
inifrån en container ger Dockers bryggadress, och socketen ger samma sak eftersom
porten är NAT:ad — båda hade självsäkert skrivit ut en adress som inte fungerar
för någon. `Host`-headern på LAN-lyssnaren kan däremot inte vara fel på det sätt
som spelar roll: det är en adress en webbläsare precis kom fram på. Den tas alltså
från riktiga besök och sparas, vilket är varför sidan kan namnge LAN-adressen även
när du läser den via proxyn. `LAN_URL` går före om du hellre vill se ett värdnamn;
innan LAN-lyssnaren öppnats en gång säger sidan det i stället för att gissa.

**Statistik** svarar på vem som använder minnet och hur mycket: anrop per dag,
månad och år, nya minnen över samma spann, och en uppdelning per klient och per
verktyg.

Två saker är värda att veta om de siffrorna. MCP uppger **klientappen** — Claude
Code, Codex, en ChatGPT-connector — aldrig vilken modell som svarar inuti den;
modellnamnet finns inte på tråden, så sidan låtsas inte veta det. Och
användningsloggen innehåller inget innehåll: inte sökfrågan, inte minnet, inte
svaret. En trafiklogg som citerade valvsökningar tillbaka hade upphävt den
nivådelning den ligger bakom. Via proxyn räknas dessutom bara trafik som kom in
på den öppna lyssnaren, så sidan kan inte avslöja att valvtrafik existerar.

## Home Assistant över MQTT

Sätt `MQTT_URL` i `.env` så anmäler sig hjärnan via HA:s discovery som enheten
**Mimers Brain**, och publicerar sedan sina räknare var `MQTT_INTERVAL_S` sekund
och direkt efter varje skrivning.

Entitets-ID:n följer av enhetsnamnet plus varje sensornamn — inte av `object_id`,
vad dokumentationen än antyder — så de är ett kontrakt värt att behandla som ett:

| Entitet | Vad |
| --- | --- |
| `binary_sensor.mimers_brain_online` | uppkoppling, driven av last will |
| `sensor.mimers_brain_memories_total` / `_open` / `_vault` | minnets storlek |
| `sensor.mimers_brain_memories_today` / `_week` / `_month` / `_year` | tillväxt |
| `sensor.mimers_brain_calls_today` / `_week` / `_month` / `_year` / `_total` | trafik |
| `sensor.mimers_brain_reads_today`, `_writes_today` | läs/skriv |
| `sensor.mimers_brain_clients_week`, `_top_client` | vilka som använder det |
| `sensor.mimers_brain_last_memory`, `_last_call` | tidpunkter |
| `sensor.mimers_brain_status`, `_problem` | `ok` / `degraded` / `error`, och varför |
| `sensor.mimers_brain_uptime` | sekunder sedan start |

Alla sensorer läser ur en enda retained JSON-payload på `<prefix>/state`, så Home
Assistant fyller alla på nytt från ett meddelande efter en omstart i stället för
att visa `unknown` fram till nästa tick.

Availability-topicen bär en **last will**, och det är den delen som gör "lever
den" ärlig: dör processen publicerar brokern `offline` åt den. Utan en sådan ser
en död hjärna exakt ut som en frisk som inte har något nytt att säga. Ett planerat
stopp säger `offline` medvetet, så en omstart läses som en kort blink i stället
för ett fastnat `online`.

`sensor.mimers_brain_problem` läses på en ESPHome-display vars fonter har en fast
glyph-lista, så texten saneras mot den vokabulären före publicering — ett tecken
utanför listan ritas som *ingenting*, utan fallback-ruta, och äter tyst upp en del
av meningen. Det är därför fel separeras med `/` och inte `|`. Listan är en kopia
av `glyphs:`-raden i enhetens YAML; ändras den följer `DISPLAY_GLYPHS` i
`server/mqtt.mjs` med.

Bara räknare. Inget minnesinnehåll och inga sökfrågor går ut på brokern — brokern
står på hemnätet, men det är inget skäl att publicera något som inte behövde
publiceras. Antalet valvrader går däremot ut, vilket är värt att veta om brokern
delas.

Brokerlösenordet bor i `.env` bredvid de andra hemligheterna i stället för i en
inställningstabell, medvetet: databasen dumpas varje natt, och en credential som
ändras med ett `docker compose up -d` behöver inte ligga i backuperna också.

## Docker i LXC

I en oprivilegierad Proxmox-LXC kan containrar inte applicera en AppArmor-profil.
Varje containerstart failar med `runc run failed: unable to apply apparmor
profile`. Det visar sig lömskt nog som ett `npm install`-fel mitt i ett bygge —
läs hela loggen efter `runc run failed` innan du felsöker npm.

`security_opt: [apparmor=unconfined]` i compose-filen löser **körningen** och är
ofarligt på maskiner utan problemet. **Bygget** går inte att rädda inifrån
(varken BuildKit eller `DOCKER_BUILDKIT=0` tar `--security-opt`), så imagen byggs
på laptopen och skeppas över:

```powershell
docker build -t mimers-brain:latest ./server
docker save -o img.tar mimers-brain:latest
scp img.tar valv:/tmp/ ; ssh valv 'docker load -i /tmp/img.tar && rm /tmp/img.tar'
ssh valv 'cd ~/mimers-brain && docker compose up -d'
```

Compose har både `build:` och `image:`, så laptopen bygger med `--build` medan
servern använder den inlästa imagen utan.

**Permanent fix (rekommenderas)** — på Proxmox-värden, inte i containern:
lägg `lxc.apparmor.profile: unconfined` i `/etc/pve/lxc/<vmid>.conf`, kontrollera
att `features: nesting=1` är satt, starta om LXC:n. Då fungerar `docker compose
up -d --build` direkt på servern och hela skeppandet ovan försvinner.

## Deploy till Proxmox

1. Skapa en LXC på `192.0.2.12` (Debian 12, 2 vCPU, 2 GB RAM, 20 GB disk räcker
   gott — pgvector med några tusen minnen är litet).
2. Installera Docker, klona repot, fyll i `.env`, `docker compose up -d`.
3. I Nginx Proxy Manager: ny proxy host `brain.example.net` →
   `http://<lxc-ip>:8791`. **Kontrollera att det står 8791 och inte 8790.**
4. Authelia framför den: notera att MCP-klienter inte kan göra en interaktiv
   inloggning, så sökvägen `/mcp` behöver en bypass-regel — skyddet där är
   bearer-nyckeln. `/.well-known/oauth-*` behöver också en, som svarar **404**:
   bakom forward-auth omdirigerar den till en inloggningssida som svarar 200, och
   en klient som letar efter OAuth läser det som en auktoriseringsserver den måste
   registrera sig hos. Gränssnittet på 8791 visar enbart den öppna nivån.

## Migrera från Mimers Brain

De minnen som ligger i Supabase idag flyttas genom att läsa dem med
`list_thoughts` och skriva in dem med `capture_thought` mot 8790. De är få och
små. Koppla bort Supabase-connectorn efteråt så det bara finns en sanning, men
låt projektet ligga vilande ett tag som fallback.

## Schema

Samma form som OB1:s `thoughts`-tabell, plus `tier`. Det gör migreringen
triviell och håller metadata-formatet identiskt (`type`, `topics`, `people`).

En detalj i `upsert_thought`: en post kan **befordras** till valvet men aldrig
tyst falla ur det. Fångar samma innehåll upp igen med `tier='open'` behåller
raden `vault`.
