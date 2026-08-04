# Mimers Brain

Ett självhostat långtidsminne för språkmodeller. Samma idé som
[OB1](https://github.com/NateBJones-Projects/OB1), men på egen hårdvara — och med
en nivå som aldrig lämnar det privata nätverket.

Vilken modell som helst som talar MCP kan läsa och skriva till minnet, så
kunskapen om ens system beskrivs en gång i stället för i varje ny konversation.
Hemligheter serveras bara på LAN; allt annat går att nå varifrån som helst.

| | |
| --- | --- |
| **[HowToUse.md](HowToUse.md)** | Koppla in en modell, och sätta upp allt igen efter en ominstallation |
| **[history.md](history.md)** | Vad som byggts, varför, och vad som gick fel |
| **[docs/nginx-brain.conf](docs/nginx-brain.conf)** | Färdig reverse-proxy-config |
| **[migrate/](migrate/)** | Engångsimport av befintlig kunskap |

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

Verifierat av `test-isolation.ps1` (11 kontroller, alla gröna):

```powershell
powershell -ExecutionPolicy Bypass -File .\test-isolation.ps1
```

Testerna täcker: valv-rader syns inte via öppna porten, hemligt innehåll läcker
aldrig ut, direkt id-uppslag av en valv-rad nekas, skrivförsök till valvet
utifrån nekas, statistik avslöjar inte ens att valvet finns, och fel nyckel ger
401.

## Kom igång lokalt

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

Tre vägar in, i den ordning servern provar dem:

1. **Bearer-nyckel** (`Authorization: Bearer <MCP_ACCESS_KEY>`) — det MCP-klienter
   och skript använder.
2. **Cookie** — webbläsaren byter nyckeln mot en HttpOnly-cookie en gång via
   `POST /api/login`. Cookien härleds ur nyckeln, så det finns ingen
   sessionstabell att underhålla.
3. **Authelia** — endast på den öppna lyssnaren. nginx har då redan kört
   requesten förbi Authelia och satt `Remote-User`.

Punkt 3 är säker *just där och bara där*: den lyssnaren kan över huvud taget inte
nå valv-rader, så det värsta headern kan ge är öppen kunskap som vem som helst på
LAN:et ändå kan läsa från 8790. Gör aldrig samma sak på den fulla lyssnaren.

Gränssnittet serveras på **båda** portarna. På 8790 (LAN) ser du valvet och loggar
in med nyckeln; via `brain.example.net` ser du bara öppen nivå och Authelia
sköter inloggningen.

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
   bearer-nyckeln. Gränssnittet ligger ändå bara på 8790 och exponeras inte alls.

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
