# Använda Mimers Brain

*[English](HowToUse.md)*

Hur du ansluter en modell till minnet, vad som ska in i det, och hur du ansluter
igen efter en ominstallation. Installationen av servern finns i
[install.sv.md](install.sv.md).

> **Börja med sidan Anslut.** Öppna webbgränssnittet och gå till **Anslut**:
> samma instruktioner som nedan, ifyllda med din instans adresser, nycklar och
> verktygslista, med kopieringsknappar. Det här dokumentet förklarar valen och
> tar upp det som sidan inte kan.

## Välj adress

| Adress | Når | Använd för |
| --- | --- | --- |
| `http://192.0.2.41:8790/mcp` | öppet **+ valv** | dina egna klienter på LAN eller VPN |
| `https://brain.example.net/mcp` | bara öppet | allt annat, även klienter som körs i molnet |
| `http://192.0.2.41:8792/mcp` | öppet, **bara läsning** | en modell som ska slå upp men inte skriva |

| Nyckel | Öppnar |
| --- | --- |
| `MCP_ACCESS_KEY` | 8790 och 8791, som bearer-header |
| `MCP_OPEN_KEY` | bara 8791, som `?key=` i adressen, för klienter utan headerfält |
| `MCP_READ_KEY` | bara 8792, som header eller `?key=` |

Den öppna adressen kan inte nå valvet hur den än anropas, så vilken extern modell
som helst kan pekas dit.

**Bestäm medvetet innan du ger en molnmodell valvet.** Valvadressen fungerar från
alla klienter som körs på din dator, men varje valvminne en sökning returnerar
hamnar i modellens kontext och därmed hos modelleverantören. Peka klienten mot
den öppna adressen när det spelar roll.

På läsporten får modellen veta att den inte kan spara något, så den ber dig i
stället för att lova att komma ihåg.

## Anslut en klient

### Claude Code

```bash
claude mcp add --transport http mimers-brain http://192.0.2.41:8790/mcp --header "Authorization: Bearer <MCP_ACCESS_KEY>"
```

Det skrivs till `~/.claude.json` under `mcpServers`. Lägg gärna till den publika
adressen som en andra post (`mimers-brain-remote`), så finns den öppna nivån kvar
utanför hemnätet. Nya sessioner läser in ändringen.

Valfritt: [recall-hooken](tools/hooks/README.md) lägger relevanta minnen vid varje
fråga utan att modellen behöver söka.

**Claude Code och Claude Desktop är olika klienter**, även i samma skrivbordsapp.
Fliken *Code* använder `~/.claude.json`; chatten använder kontots connectors. En
server som läggs till i den ena syns inte i den andra.

### Codex (VS Code)

```bash
codex mcp add mimers-brain --url http://192.0.2.41:8790/mcp --bearer-token-env-var MIMERS_VALV_KEY
```

Det skriver `[mcp_servers.mimers-brain]` i `~/.codex/config.toml`. Nyckeln hålls
utanför filen: sätt `MIMERS_VALV_KEY` som användarvariabel och starta om VS Code.
`codex` följer med tillägget
(`~/.vscode/extensions/openai.chatgpt-*/bin/<plattform>/codex`); kontrollera med
`codex mcp list`. Om Codex ignorerar serverinstruktionerna, lägg minnespolicyn
från sidan Anslut i `~/.codex/AGENTS.md`.

### Claude Desktop (chatten)

Lägg till en egen connector under *Inställningar → Connectors*. Två begränsningar
gäller: adressen måste vara **https**, och anslutningen görs från Anthropics
servrar, inte från din dator. Chatten når alltså **bara den öppna nivån**, via den
publika adressen. Dialogen har inget headerfält, så nyckeln ligger i adressen:

```text
https://brain.example.net/mcp?key=<MCP_OPEN_KEY>
```

Finns en autentisering framför måste proxyn svara **404** på
`/.well-known/oauth-*`, annars misslyckas connectorn med *couldn't register with
the sign-in service*. Kontrollera:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://brain.example.net/.well-known/oauth-authorization-server
```

`404` är rätt; `302` betyder att connectorn kommer att misslyckas. Mallen i
[docs/nginx-brain.conf](docs/nginx-brain.conf) sköter detta.

Vill du ändå nå valvet från chatten, brygga lokalt med
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) i
`claude_desktop_config.json` (`%APPDATA%\Claude\` på Windows) och starta om appen.
Alla versioner läser inte filen; dyker servern aldrig upp, gör valvarbetet i
Claude Code.

```json
{
  "mcpServers": {
    "mimers-brain": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://192.0.2.41:8790/mcp",
               "--header", "Authorization: Bearer <MCP_ACCESS_KEY>"]
    }
  }
}
```

### ChatGPT, Gemini och andra MCP-klienter

Använd den publika adressen med en bearer-header. Klienter som förväntar sig ett
enkelt sök-och-hämta-par får `search` och `fetch`. Ge aldrig en molnklient
adressen till 8790.

### Open WebUI och andra OpenAPI-klienter

Open WebUI:s verktygsservrar talar OpenAPI, inte MCP. Samma verktyg finns som REST
på alla lyssnare:

| | |
| --- | --- |
| `GET /openapi.json` | beskrivningen; ingen nyckel behövs |
| `POST /tools/<namn>` | en endpoint per verktyg; bearer-nyckel krävs |

I Open WebUI, *Settings → Tools*: lägg till `http://192.0.2.41:8791`, välj bearer
och klistra in `MCP_ACCESS_KEY`. Tillåt sedan Open WebUI-sidans origin i `.env`
och kör `docker compose up -d`:

```dotenv
CORS_ORIGINS=http://192.0.2.19:8080,https://llm.example.net
```

Går du via proxyn i stället måste `/openapi.json` och `/tools/` slippa förbi
autentiseringen; nginx-mallen gör det.

### En klient som bara läser

```bash
claude mcp add --transport http mimers-brain-read http://192.0.2.41:8792/mcp --header "Authorization: Bearer <MCP_READ_KEY>"
```

För att nå 8792 utifrån, peka ett andra värdnamn mot den.

### Kontrollera anslutningen

```bash
curl -s -X POST https://brain.example.net/mcp \
  -H "Authorization: Bearer <MCP_ACCESS_KEY>" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

En verktygslista betyder att det fungerar: 10 verktyg på den öppna porten, 13 på
8790, 7 på 8792. `401` betyder fel nyckel. En `302` till din autentisering betyder
att proxyn skickar `/mcp` genom forward auth; det får den inte.

## Hur en modell ska använda minnet

Varje klient får en kort användningspolicy när den ansluter, och hela policyn från
`memory_digest`. Sidan Anslut visar policyn för klienter som ignorerar
serverinstruktioner; klistra in den i deras system- eller globala instruktioner.

Det viktigaste:

- **Börja** sessionen med `memory_digest`.
- **Sök** med `search_thoughts` innan du svarar om dina system, och före varje
  bygge, deploy eller steg med inloggningsuppgifter.
- **Rapportera** varje sökning som gav träffar med `report_memory_usage`: dess
  `trace_id` och vilka id som användes och ignorerades. Tre sökningar betyder tre
  rapporter. En sökning utan rapport visas som *väntar på rapport*, och som
  försenad efter tio minuter.
- **Kontrollera historiken.** `fetch` kan returnera ett ersatt minne; när
  `superseded_by` finns, hämta det i stället.
- **Spara** bara varaktig, verifierad kunskap som skulle ändra ett framtida svar,
  ett ämne per minne. Minnen som en agent skriver börjar som väntande bevis tills
  du granskat dem. Sätt `user_confirmed` bara när du godkänt exakt den texten.
- **Rätta** med `supersede_thought` i stället för att lägga till ett motsägande
  minne.
- **Lång text** (1 200 tecken eller mer) går genom `preview_ingest` och
  `apply_ingest`.

## Vad som hör hemma i minnet

Skriv varje minne som ett **fristående påstående** som går att förstå om flera år.
"Det funkade" är värdelöst; "Lagersystem-deployen avbryts om `data/languages/`
skiljer sig från origin, eftersom översättningsverktyget skriver filerna på
servern" är användbart.

- **Spara:** var saker finns och hur man når dem, beslut och skälen till dem,
  rutiner, och fällor som kostat tid.
- **Spara inte:** projektstatus, avslutat arbete, releasenoter eller
  sessionshistorik. Det hör hemma i repots README och historikfiler.
- **Valvet:** känslig kontext, och `SECRET_REF`-pekare till var en nyckel, ett
  lösenord eller en token finns. Aldrig själva värdet; servern vägrar text som ser
  ut som inloggningsuppgifter. Allt annat är öppet, vilket är bättre: vilken
  modell som helst kan använda det, var som helst.

## Redigera i webbgränssnittet

Håll muspekaren över ett minne under **Tankar** och välj **Redigera** för att
ändra text, titel, sammanfattning, typ, livscykel, uppgiftsstatus, projekt,
ämnen, personer, system, nivå eller verifieringsdatum, eller fästa det i
startpaketet (`memory_digest`). När du sparar bäddas minnet in igen, eftersom titel och
sammanfattning ingår i det sökningen jämför. **Kopiera referens** kopierar id och
titel på en rad, att klistra in i en chatt med en ansluten modell följt av vad som
ska ändras.

## Ansluta igen efter en ominstallation

**En klientdator** har inget viktigt kvar: kunskapen finns på servern. Registrera
MCP-servern igen enligt ovan. Hämta en nyckel från servern:

```bash
ssh <server> 'grep ^MCP_ACCESS_KEY= ~/mimers-brain/.env | cut -d= -f2'
```

På Windows, skapa SSH-nyckeln från `cmd`, inte PowerShell, som gör `-N '""'` till
en lösenfras av två citattecken:

```powershell
cmd /c 'ssh-keygen -t ed25519 -C "mimers-brain" -f C:\Users\<du>\.ssh\mimers_brain -N ""'
```

**Servern:** installera enligt [install.sv.md](install.sv.md) och återställ sedan
senaste dumpen med `./restore.sh`. Återanvänd gamla `.env` om du har den; en ny
`MCP_ACCESS_KEY` betyder att varje klient måste uppdateras.
