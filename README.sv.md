# Mimers Brain

*[English](README.md)*

Ett självhostat långtidsminne för språkmodeller. Samma idé som
[OB1](https://github.com/NateBJones-Projects/OB1), men på egen hårdvara, med en
nivå som aldrig lämnar det lokala nätverket.

Alla klienter som talar MCP (eller OpenAPI) kan söka i och skriva till minnet. Det
du vet om dina system skrivs ner en gång i stället för att förklaras om i varje
konversation.

- **Två nivåer.** *Öppen* kunskap nås var som helst via en reverse proxy.
  *Valvet* — känslig kontext och `SECRET_REF`-pekare — finns bara på LAN.
  Råa lösenord, tokens och nycklar vägras vid varje skrivning.
- **Sökning på betydelse**, med metadata, granskningsstatus och kvitton som visar
  vilka hämtade minnen som faktiskt användes.
- **Webbgränssnitt** på svenska och engelska för att bläddra, redigera, granska
  och ansluta klienter.

![Minneslistan med metadatafilter och en valvpost som bara syns på LAN](assets/screenshots/mimers-brain-thoughts.png)

## Dokumentation

| | |
| --- | --- |
| **[install.md](install.md)** | Installation på Proxmox LXC, Docker Desktop eller Ubuntu Server: konfiguration, reverse proxy, backup, uppdatering (engelska) |
| **[HowToUse.sv.md](HowToUse.sv.md)** | Ansluta Claude Code, Codex, Claude Desktop, ChatGPT, Open WebUI; vad som hör hemma i minnet |
| **[docs/how-it-works.md](docs/how-it-works.md)** | Nivågränsen, autentisering, minnesmodellen, sökning, modeller, underhåll (engelska) |
| **[docs/home-assistant.md](docs/home-assistant.md)** | MQTT-sensorer för Home Assistant (engelska) |
| **[tools/hooks/](tools/hooks/README.md)** | Claude Code-hook som lägger relevanta minnen vid varje fråga |
| **[docs/nginx-brain.conf](docs/nginx-brain.conf)** | Mall för reverse proxy |
| **[docs/translations.md](docs/translations.md)** | Lägga till ett språk i gränssnittet |
| **[migrate/](migrate/README.md)** | Engångsimport av befintliga anteckningar |
| **[history.sv.md](history.sv.md)** | Vad som byggts, varför, och vad som gick fel |

> **Adresserna i dokumentationen är platshållare.** `192.0.2.x`
> ([RFC 5737](https://www.rfc-editor.org/rfc/rfc5737)) och `example.net`
> ([RFC 2606](https://www.rfc-editor.org/rfc/rfc2606)) pekar ingenstans. Byt mot
> dina egna och spara de riktiga värdena i `docs/deployment.local.md`
> (gitignorerad).

## Snabbstart

Kräver Docker med Compose. Fullständiga instruktioner: [install.md](install.md).

```bash
git clone https://github.com/Snille/Mimers-Brain.git && cd Mimers-Brain
cp .env.example .env    # sätt POSTGRES_PASSWORD, MCP_ACCESS_KEY, OPENROUTER_API_KEY, CITATION_BASE_URL
docker compose up -d --build
```

Öppna <http://localhost:8790>, logga in med `MCP_ACCESS_KEY` och gå till
**Anslut**: där finns färdiga inställningar att kopiera för varje klient, ifyllda
med den här instansens adresser och nycklar. För Claude Code på LAN:

```bash
claude mcp add --transport http mimers-brain http://192.0.2.41:8790/mcp --header "Authorization: Bearer <MCP_ACCESS_KEY>"
```

Utan `OPENROUTER_API_KEY` (eller en annan leverantör) får inget en embedding, och
bara listning och textsökning fungerar.

## Tre portar

| Port | Innehåll | Vem får nå den |
| --- | --- | --- |
| **8790** | öppet + valv, webbgränssnitt, alla verktyg | bara LAN/VPN. **Proxa den aldrig.** |
| **8791** | öppen nivå, webbgränssnitt | den enda port en publik reverse proxy pekar på |
| **8792** | öppen nivå, bara läsverktyg, inget gränssnitt | en modell som får slå upp men inte skriva |

Nivån avgörs av vilken port en förfrågan kommer in på, aldrig av en header: den
öppna och den läsande lyssnaren byggs utan möjlighet att nå valvrader. Se
[docs/how-it-works.md](docs/how-it-works.md#the-tier-boundary).

## MCP-verktyg

| Verktyg | 8790 | 8791 | 8792 |
| --- | :-: | :-: | :-: |
| `memory_digest` — stående regler; anropas en gång per session | ✓ | ✓ | ✓ |
| `search_thoughts` — sök på betydelse | ✓ | ✓ | ✓ |
| `list_thoughts`, `thought_stats` | ✓ | ✓ | ✓ |
| `search` + `fetch` — paret ChatGPT förväntar sig | ✓ | ✓ | ✓ |
| `report_memory_usage` — kvitto för en sökning | ✓ | ✓ | ✓ |
| `capture_thought`, `preview_ingest` + `apply_ingest` | ✓ | ✓ | |
| `supersede_thought`, `review_memory`, `delete_thought` | ✓ | | |

Samma verktyg finns som REST för OpenAPI-klienter: `GET /openapi.json` och
`POST /tools/<namn>` (med `fetch_thought` i stället för `search`/`fetch`).

## Webbgränssnittet

| Sida | Till för |
| --- | --- |
| **Tankar** | Lista, hybridsökning, filter, redigering, fästa minnen i startpaketet (`memory_digest`) |
| **Granska** | Agentminnen som väntar på granskning, dubbletter, möjliga motsägelser, sällan till nytta, nyligen raderade |
| **Statistik** | En 3D-karta över minnet, hälsa, hur användbara hämtade minnen är, klientaktivitet, MQTT-status |
| **Anslut** | Inställningar för varje klient; på port 8790 även kortet **Modeller** (leverantörer, modeller, sökgränser) |

Gränssnittet finns på 8790 (logga in med `MCP_ACCESS_KEY`) och 8791 (öppen nivå,
bakom din autentisering). Texterna laddas från JSON-kataloger, webbläsarens språk
väljs första gången och ett manuellt val sparas.

![Minnets hälsa, recall-kvalitet och aktivitet](assets/screenshots/mimers-brain-statistics.png)

## Utveckling

```bash
cd server
npm ci
npm test          # databastesterna hoppas över utan TEST_DATABASE_URL
npm run audit     # läsande kvalitetsrapport över databasen i DATABASE_URL
```

Databastesterna behöver en tillfällig Postgres med pgvector; se början av
`server/testing/db.mjs`. En ny miljövariabel ska läggas i `.env.example` och
skickas under `app.environment` i `docker-compose.yml`.

Compose-projektet, containrarna och volymen behåller sina gamla `valv`-namn med
flit; att byta namn skulle starta en tom databas. Se
[docs/how-it-works.md](docs/how-it-works.md#naming).
