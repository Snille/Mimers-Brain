# Installera Mimers Brain

*[English](install.md)*

Mimers Brain körs som en enda Docker Compose-stack: en Node.js-container för
applikationen (`valv-app`) och en PostgreSQL/pgvector-container (`valv-db`).
Compose är det enda sättet som stöds, oavsett värd.

Stegen, i ordning:

1. [Förbered värden](#1-förbered-värden) — Proxmox-LXC, Docker Desktop eller Ubuntu Server
2. [Ställ in `.env`](#2-ställ-in-env)
3. [Starta stacken](#3-starta-stacken)
4. [Nätverk och reverse proxy](#4-nätverk-och-reverse-proxy) (valfritt)
5. [Backup](#5-backup)
6. [Uppdatera](#6-uppdatera)
7. [Justera sökgränserna](#7-justera-sökgränserna) (när du har minnen)
8. [Kör inbäddningsmodellen lokalt](#8-kör-inbäddningsmodellen-lokalt) (valfritt)
9. [Testa motsägelsemodellen](#9-testa-motsägelsemodellen) (valfritt)

[Felsökning](#felsökning) finns sist.

## Innan du börjar

- **Resurser:** 2 CPU-kärnor, 2 GB RAM, 20 GB disk. Några tusen minnen är en
  liten databas.
- **Utgående HTTPS** till GitHub och Docker Hub för installationen, och till
  OpenRouter (eller en annan modelleverantör) för inbäddningar och metadata.
- **Tre portar**, var och en med olika räckvidd:

| Port | Ger | Exponering |
| --- | --- | --- |
| `8790` | öppen nivå + valv, webbgränssnitt, alla verktyg | bara betrott LAN/VPN. **Lägg den aldrig bakom en reverse proxy.** |
| `8791` | bara öppen nivå, webbgränssnitt | den enda port en publik reverse proxy får peka på |
| `8792` | bara öppen nivå, bara läsverktyg, inget webbgränssnitt | valfri; för en modell som inte får skriva |

- **Data** ligger i Docker-volymen `mimers-valv_valv-data`, inte i git-klonen.

> **Ta aldrig bort `name: mimers-valv` ur `docker-compose.yml`, byt aldrig namn
> på volymen och kör aldrig `docker compose down -v`.** Det fasta projektnamnet
> håller kvar volymen när katalogen för klonen ändras. `-v` raderar volymen och
> alla minnen i den.

## 1. Förbered värden

Välj ett alternativ och fortsätt sedan i [avsnitt 2](#2-ställ-in-env).

### Alternativ A: Proxmox VE, oprivilegierad Ubuntu-LXC

Docker i en LXC delar kärnan med Proxmox-värden, och AppArmor-undantaget nedan
försvagar LXC-gränsen. Använd en egen container på en betrodd värd, eller en
liten VM om Docker ska ha en egen kärna.

Skapa containern med Ubuntu 24.04 LTS, **oprivilegierad**, 2 kärnor, 2 GB RAM,
20 GB disk, en fast adress eller DHCP-reservation, start vid uppstart, och
funktionerna `nesting` och `keyctl`:

```bash
pct set <VMID> -features nesting=1,keyctl=1
```

Tillåt sedan Docker att starta containrar. På Proxmox-värden:

```bash
pct stop <VMID>
echo "lxc.apparmor.profile: unconfined" >> /etc/pve/lxc/<VMID>.conf
pct start <VMID>
```

Utan den raden misslyckas varje containerstart med `runc run failed: unable to
apply apparmor profile`, ofta förklätt till ett `npm install`-fel mitt i
bygget. Raderna `security_opt` i Compose-filen räddar bara körande containrar;
att bygga i LXC:n kräver inställningen på värden.

Logga in i LXC:n och fortsätt med [Alternativ C](#alternativ-c-ubuntu-server).

### Alternativ B: Docker Desktop (Windows eller macOS)

Installera [Docker Desktop](https://docs.docker.com/desktop/) med
Linux-containrar (WSL 2 på Windows). I PowerShell:

```powershell
docker version
docker compose version
git clone https://github.com/Snille/Mimers-Brain.git
Set-Location Mimers-Brain
Copy-Item .env.example .env
```

På macOS använder du `cd Mimers-Brain` och `cp .env.example .env`. Sätt
`CITATION_BASE_URL=http://localhost:8790/thoughts` i `.env` och lämna
`PUBLIC_URL` tom.

Docker Desktop publicerar portarna på alla nätverkskort, så blockera inkommande
trafik som ingen bett om i värdens brandvägg. Det passar för utveckling och
utvärdering; en installation som alltid är igång är enklare att driva och ta
backup på en server.

### Alternativ C: Ubuntu Server

Hoppa över Docker-installationen om `docker version` och `docker compose
version` redan fungerar. Annars, enligt Dockers instruktioner för apt-förrådet:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Logga ut och in igen. Kontrollera sedan Docker, att portarna är lediga, och
klona:

```bash
docker run --rm hello-world
sudo ss -ltnp | grep -E ':(8790|8791|8792)\b' || true
git clone https://github.com/Snille/Mimers-Brain.git ~/mimers-brain
cd ~/mimers-brain
cp .env.example .env
```

Medlemskap i gruppen `docker` är i praktiken root på värden. Lägg bara till
betrodda administratörer.

## 2. Ställ in `.env`

`.env` ignoreras av git; committa den aldrig. Varje variabel förklaras i
[.env.example](.env.example). Sätt åtminstone dessa:

| Variabel | Behövs | Syfte |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | ja | databasens lösenord (containern publiceras inte) |
| `MCP_ACCESS_KEY` | ja | full åtkomst, valvet inräknat; också inloggningen i webbgränssnittet på 8790 |
| `OPENROUTER_API_KEY` | ja, i praktiken | inbäddningar och metadata. Utan en leverantör finns ingen semantisk sökning. |
| `CITATION_BASE_URL` | ja | början på länken en klient får till ett minne, t.ex. `http://192.0.2.41:8790/thoughts` |
| `PUBLIC_URL` | med en publik proxy | t.ex. `https://brain.example.net`; visas på sidan Anslut |
| `MCP_OPEN_KEY` | valfri | nyckel i adressen (`/mcp?key=`) för klienter på öppen nivå som inte kan skicka en header |
| `MCP_READ_KEY` | med port 8792 | läsportens nyckel. Tom betyder att 8792 tar emot `MCP_ACCESS_KEY`. |
| `CORS_ORIGINS` | för Open WebUI | webbläsarursprung som får anropa `/openapi.json` och `/tools/*` |
| `SETTINGS_KEY` | valfri | krypterar leverantörsnycklar som skrivs in på rutan Modeller |
| `MQTT_URL` | valfri | Home Assistant-integration; se [docs/home-assistant.md](docs/home-assistant.md) |

Skapa varje hemlighet för sig, som lång hex (säker i databasens adress):

```bash
openssl rand -hex 32
```

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

`MCP_ACCESS_KEY`, `MCP_OPEN_KEY` och `MCP_READ_KEY` måste vara tre olika
värden. En nyckel i adressen hamnar i klientinställningar och proxyloggar; den
fulla nyckeln låser upp valvet; en läsklient som fick den öppna nyckeln skulle
kunna skriva på 8791.

Lämna `LAN_URL` tom: servern lär sig sin LAN-adress vid ditt första besök på
port 8790. Sätt `STATS_TZ` till din IANA-tidszon, t.ex. `Europe/Stockholm`.

Andra modelleverantörer än OpenRouter (OpenAI, Ollama, vilken
OpenAI-kompatibel server som helst) kan ställas in i `.env` eller senare på
rutan **Modeller** på sidan **Inställningar**. Där väljs också modellerna för
inbäddning, metadata och motsägelser, och sökgränserna; ett värde som sparas
där går före `.env`.

## 3. Starta stacken

Från repots rot (samma kommandon fungerar i PowerShell):

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

Första starten bygger imagen och skapar databasen. Vänta tills `valv-db` är
frisk och `valv-app` körs, och kontrollera sedan de tre lyssnarna:

```bash
curl -fsS http://127.0.0.1:8790/healthz   # "tier":"full","writable":true
curl -fsS http://127.0.0.1:8791/healthz   # "tier":"open","writable":true
curl -fsS http://127.0.0.1:8792/healthz   # "tier":"open","writable":false
```

På Windows använder du `curl.exe`. Öppna `http://<server>:8790` (eller
<http://localhost:8790>) och logga in med `MCP_ACCESS_KEY`. Gå sedan till
**Anslut** för att koppla in din första modell; [HowToUse.sv.md](HowToUse.sv.md)
förklarar valen.

## 4. Nätverk och reverse proxy

Låt bara betrodda klienter på LAN eller VPN nå `8790`. Publicerade
Docker-portar går förbi enkla UFW-regler, så sätt gränsen i Proxmox
brandvägg, i routern/VLAN:et eller i Dockers kedja `DOCKER-USER`.

Publik åtkomst är valfri. Så slår du på den:

1. Skapa ett DNS-namn, t.ex. `brain.example.net`, och avsluta TLS i proxyn.
2. Peka det på `http://<server>:8791`. **Kontrollera att det står 8791, inte 8790.**
3. Utgå från [docs/nginx-brain.conf](docs/nginx-brain.conf) (nginx eller Nginx
   Proxy Manager).

Om en autentiserare som Authelia skyddar webbgränssnittet:

- `/mcp`, `/openapi.json` och `/tools/` måste gå förbi den. De klienterna
  skickar en bearer-nyckel och kan inte fylla i en inloggningssida.
- `/.well-known/oauth-*` måste svara **404**. Bakom forward auth leder de
  sökvägarna till en inloggningssida som svarar 200, och en MCP-klient försöker
  då registrera sig hos en OAuth-server som inte finns.
- `/mcp` behöver `proxy_buffering off` (MCP håller en ström öppen).

Mallen gör alla tre. Låt applikationen sköta CORS: en proxy med `add_header
Access-Control-Allow-Origin` ovanpå appens egen header ger en dubblett, som
webbläsare avvisar.

Publicera inte webbgränssnittet för den öppna nivån utan en autentiserare. Utan
en, proxa bara `/mcp` och `/healthz`, eller håll 8791 privat.

För port 8792 pekar du ett andra värdnamn dit på samma sätt.

## 5. Backup

Imagen går att slänga; volymen gör det inte. `backup.sh` tar en gzippad
`pg_dump`, kontrollerar att den är giltig och innehåller tabellen `thoughts`,
och roterar först därefter bort gamla dumpar. De tio senaste behålls.

```bash
chmod +x backup.sh restore.sh
BACKUP_DIR="$HOME/valv-backups" ./backup.sh
```

Varje natt, med cron:

```cron
10 0 * * * BACKUP_DIR=/home/mimer/valv-backups /home/mimer/mimers-brain/backup.sh >> /home/mimer/valv-backups/backup.log 2>&1
```

Anpassa sökvägarna efter din användare. Variabler: `BACKUP_DIR` (standard
`/home/mimer/valv-backups`), `BACKUP_KEEP` (10), och `DB_USER` / `DB_NAME` om
du har ändrat `POSTGRES_USER` / `POSTGRES_DB`.

En återställning ersätter hela databasen. Ta en ny backup först:

```bash
./restore.sh "$HOME/valv-backups/valv-YYYYMMDD-HHMM.sql.gz"
```

Den skriver ut antalet rader före och efter. En logisk dump går också att
återställa i delar, t.ex. ett enda minne, vilket en VM-avbild inte kan.

## 6. Uppdatera

```bash
cd ~/mimers-brain
BACKUP_DIR="$HOME/valv-backups" ./backup.sh
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 app
```

Appen lägger till nya tabeller och kolumner när den startar. `db/init.sql` körs
bara när en ny, tom volym skapas.

## 7. Justera sökgränserna

Sökningen visar minnen med en likhet över **0,3**, och recall-hooken över
**0,5**. De värdena mättes med `openai/text-embedding-3-small` på en hjärna.
När din har några dussin minnen, mät dem med dina egna frågor. Gör det igen
efter varje byte av inbäddningsmodell, eftersom en annan modell ger samma text
en annan poäng.

**1. Skriv en frågesamling.** Kopiera
[eval/recall-questions.example.json](eval/recall-questions.example.json) till
`eval/recall-questions.local.json` (ignoreras av git: den beskriver dina system).

```json
{ "questions": [
  { "id": "proxy-port", "q": "Vilken port pekar reverse proxyn på?", "expect": ["<minnes-id>"] },
  { "id": "weather",    "q": "Hur blir vädret i helgen?",               "expect": [] }
] }
```

- `q` är en fråga du verkligen skulle ställa, med dina egna ord. Frågor från
  riktiga sessioner är värda mest.
- `expect` listar id för de minnen som svarar på frågan; vilket som helst av dem
  räknas som en träff. Kopiera ett id med **Kopiera referens** på sidan **Tankar**.
- `expect: []` markerar en fråga som inget minne ska svara på. De mäter brus
  från recall-hooken.
- För ett förslag behöver du minst **3 frågor med svar och 1 utan**. Ungefär
  40 och 5 ger stabila siffror.

**2. Mät.** Öppna **Inställningar → Modeller → Sökgränser** på port 8790. Välj
**Ladda upp frågor** och sedan **Mät**. Det körs i bakgrunden och tar några
sekunder per fråga; inget ändras.

**3. Läs resultatet.**

| Rad | Betyder | Bra |
| --- | --- | --- |
| Rätt först | rätt minne är första sökträffen | 75 % eller mer |
| Bland fem första | rätt minne finns bland de fem första | 90 % eller mer |
| Minnestips: rätt / brus | hooken visar rätt minne / visar något för en fråga utan svar | högt / 0 % |
| "*n* förväntade minnen finns inte längre eller har ersatts" | en fråga pekar på ett ersatt eller raderat minne | rätta id:t i `expect` och ladda upp igen |

**4. Använd.** Om varningarna är borta och förslaget verkar rimligt, välj
**Använd förslaget**. Det gäller direkt, utan omstart. **Byt** sätter värdena
för hand; ett tomt fält ger tillbaka standardvärdet.

**När du byter inbäddningsmodell:** vänta tills den nya inbäddningen är klar,
men byt inte än. Välj **Mät** för den *nya* modellen och **Spara förslaget**
för den. Dess gränser börjar då gälla i samma steg som **Byt till den nya
modellen**.

Samma mätning går att köra från kommandoraden, med varianter av vikterna för
rangordningen; se [docs/how-it-works.md](docs/how-it-works.md#measuring-recall).

Samma ruta har två gränser till, **Motsägelser** och **Dubbletter**. Frågorna
mäter inte dem; ställ in dem för hand efter ett modellbyte, se
[avsnitt 8](#8-kör-inbäddningsmodellen-lokalt).

## 8. Kör inbäddningsmodellen lokalt

OpenRouter är standard och kräver inget på värden. En öppen inbäddningsmodell
som `bge-m3` kan i stället köras i Ollama bredvid hjärnan: ingen kostnad per
anrop, och texten lämnar aldrig nätverket. Metadata och motsägelser kan ligga
kvar på OpenRouter. Modellen går bra på CPU, men kontrollera två saker först.

**Disk.** Ollama-imagen och `bge-m3` tar cirka **10 GB**. LXC:n på 16 GB från
Alternativ A blir full till 100 % - utöka den först (på Proxmox-värden:
`pct resize <vmid> rootfs +16G`) och kontrollera med `df -h /` inne i
containern. En full disk kan skada databasen.

**Trådar.** I en LXC ser Ollama alla värdens kärnor och startar mycket fler
trådar än containern får använda. På en LXC med 4 kärnor tog en kort text då
20 sekunder i stället för 0,3. `/v1/embeddings` tar inte emot inställningar,
så lägg antalet trådar i en modellvariant. Använd antalet kärnor containern
har (`nproc`).

Ollama som en egen stack, t.ex. `~/ollama/docker-compose.yml`. Den publicerar
ingen port; hjärnan når den via hjärnans eget Compose-nätverk:

```yaml
name: ollama

services:
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: unless-stopped
    security_opt:
      - apparmor=unconfined
    environment:
      OLLAMA_KEEP_ALIVE: "-1"
      OLLAMA_MAX_LOADED_MODELS: "1"
    volumes:
      - ollama-models:/root/.ollama
    mem_limit: 2560m
    networks:
      - mimers-valv_default

volumes:
  ollama-models:

networks:
  mimers-valv_default:
    external: true
```

Starta den, hämta modellen och gör varianten (här för 4 kärnor):

```bash
cd ~/ollama && docker compose up -d
docker exec ollama ollama pull bge-m3
printf "FROM bge-m3\nPARAMETER num_thread 4\n" > Modelfile.bge-m3-cpu4
docker cp Modelfile.bge-m3-cpu4 ollama:/tmp/Modelfile
docker exec ollama ollama create bge-m3:cpu4 -f /tmp/Modelfile
```

Öppna sedan **Inställningar → Modeller** på port 8790:

1. Sätt Ollamas adress till `http://ollama:11434`.
2. **Testa** inbäddningen med leverantören Ollama och modellen `bge-m3:cpu4`.
   Ett bra resultat är långt under en sekund.
3. Välj **Starta ny inbäddning**. Det tar några sekunder per minne.
4. Mät den nya modellen och spara dess förslag (se
   [avsnitt 7](#7-justera-sökgränserna)), och välj sedan **Byt till den nya
   modellen**. Bytet tar bort de gamla vektorerna, så kör `./backup.sh` först.
5. Ställ in **Motsägelser** och **Dubbletter** under **Sökgränser → Byt**.
   Frågorna mäter inte dem. Med `bge-m3` jämför 0,65 ungefär lika många par som
   0,6 gjorde med text-embedding-3-small (vid 0,6 jämförde den fem gånger så
   många), och 0,82 för dubbletter behåller alla par som slogs ihop för hand
   (vid 0,86 var listan tom).

Bestäm variantens namn före bytet. Ett nytt namn räknas som en ny modell, och
en ny modell betyder en ny inbäddning av alla minnen. Om containern senare får
fler kärnor, gör en ny variant och bädda in på nytt till den.

**Hitta par-gränserna för en annan modell.** Värdena ovan gäller `bge-m3`. För
en annan modell jämför du samma par med båda modellerna: backupen som togs före
bytet har kvar de gamla vektorerna.

1. Läs in dumpen i en tillfällig container utan nätverk
   (`docker run --rm --network none ... pgvector/pgvector:pg17`), så att den
   aldrig kan förväxlas med den riktiga databasen.
2. Exportera där varje par med likhet 0,6 eller mer, med sin gamla likhet
   (`1 - (a.embedding <=> b.embedding)`), till CSV.
3. Läs in CSV-filen i en temporär tabell i den riktiga databasen och lägg till
   varje pars nya likhet.
4. **Motsägelser:** välj den nya gräns som släpper igenom ungefär lika många
   aktuella par som den gamla gjorde.
   **Dubbletter:** titta på de par du slagit ihop, ersatt eller behållit på
   sidan **Granska** (`duplicate_resolutions`); välj en gräns strax under det
   lägsta par du slagit ihop eller ersatt.
5. Stoppa den tillfälliga containern och radera CSV-filen: den namnger dina minnen.

## 9. Testa motsägelsemodellen

Varje natt läser motsägelsemodellen par av liknande minnen och lägger de par
den kallar motsägelser på sidan **Granska**. En modell som ropar varg fyller
den sidan; en som missar låter ett gammalt portnummer leva kvar bredvid ett
nytt. **Inställningar → Test av motsägelser** ställer den nattliga
kontrollens egen fråga till en eller två modeller, för par där du vet rätt
svar. Inget ändras. Du behöver det bara när du funderar på en annan
motsägelsemodell, eller ibland för att se att den som används fortfarande håller.

**1. Skriv en testsamling.** Kopiera
[eval/contradiction-cases.example.json](eval/contradiction-cases.example.json)
till `eval/contradiction-cases.local.json` (ignoreras av git).

- `left` och `right` är var för sig ett minnes-id eller själva texten. Med text
  kan du plantera en motsägelse mot ett riktigt minne: ta ett minne som säger
  port 8791 och skriv "proxyn pekar på port 8790".
- `expect` är `"conflict"` eller `"consistent"`. Utelämna det för ett par du
  inte har bedömt än: det körs och visas, men räknas inte.
- Bra källor: par du har avfärdat på sidan **Granska** (consistent), par
  modellen flaggat där du höll med (conflict), och planterade motsägelser. Ett
  dussin av varje ger en användbar bild.

**2. Mät.** Välj **Ladda upp fall**, ange en andra modell om du vill jämföra,
och välj **Mät**. Modell 1 är alltid den som används.

**3. Läs resultatet.**

| Kolumn | Betyder | Bra |
| --- | --- | --- |
| Hittade motsägelser | planterade eller bekräftade motsägelser som modellen hittade | alla |
| Falsklarm | par du vet är OK som den kallade en motsägelse | 0 |
| Fel | anrop som misslyckades | 0 |

Under tabellen visar **Fall som behöver dig** bara det som behöver en
människa: ett fall som en modell svarade fel på, och ett fall utan svar där
modellerna inte är överens eller en av dem ser en motsägelse. Fall utan svar
som alla modeller kallar OK är dolda. **Visa** öppnar båda minnena; svara
**motsägelse** eller **ingen motsägelse**, så räknas siffrorna om direkt, utan
att modellerna frågas igen. Svaret sparas i hjärnan; **Ladda ner fall** sparar
samlingen, med svaren, tillbaka till din lokala fil.

**4. Använd.** **Använd för motsägelser** gör den modellen till den som den
nattliga kontrollen använder. Par som den gamla modellen bedömt bedöms igen.

## Felsökning

**Bygget misslyckas i `npm install` i en LXC.** Sök i loggen efter `runc run
failed` / `unable to apply apparmor profile`. Gör inställningen på värden i
[Alternativ A](#alternativ-a-proxmox-ve-oprivilegierad-ubuntu-lxc). Att byta
npm-register hjälper inte.

**Webbgränssnittet fungerar men inte den semantiska sökningen.** Ingen
leverantör för inbäddningar är inställd. Sätt `OPENROUTER_API_KEY` (eller en
leverantör på rutan **Modeller**) och kör `docker compose up -d`. Listning och
textsökning fungerar utan.

**Ett ändrat värde i `.env` har ingen effekt.** Kör `docker compose up -d` för
att skapa om containern. En *ny* variabel måste också stå under
`app.environment` i `docker-compose.yml`, annars når den aldrig containern.

**Databasen ser tom ut.** Sluta skriva. Kontrollera att `name: mimers-valv`
fortfarande står överst i `docker-compose.yml`, och sedan:

```bash
docker volume ls | grep valv
```

Ett ändrat projektnamn kopplar in en ny, tom volym medan den gamla finns kvar.
Radera ingenting förrän du vet vilken som är vilken.

**Diagnostik:**

```bash
docker compose ps
docker compose logs --tail=200 app db
docker exec valv-db pg_isready
```

**Kontrollera gränsen mellan nivåerna.** `test-isolation.ps1` kontrollerar att
den öppna porten och läsporten inte kan nå valvet eller skriva där de inte får.
Skriptet läser nycklarna från `.env`; `-HostName` pekar det mot en annan maskin.

```powershell
.\test-isolation.ps1          # bara läskontroller
.\test-isolation.ps1 -Write   # alla kanarieprov; testraderna tas bort efteråt
```

## Plattformsdokumentation

- [Docker Engine på Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker Desktop](https://docs.docker.com/desktop/)
- [Proxmox `pct`](https://pve.proxmox.com/pve-docs/pct.1.html)
