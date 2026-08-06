# Translating the web interface

The web UI loads its text from JSON catalogs in `server/public/lang/`. English
is the fallback language, and the first visit selects the best match from the
browser's language list. A manual choice in the header is saved in
`localStorage` and wins on later visits.

To add a language:

1. Copy `server/public/lang/en.json` to a file named with a BCP 47 language code,
   for example `de.json` or `pt-BR.json`.
2. Translate values only. Keep every key and placeholders such as `{count}`,
   `{version}` and `{listener}` unchanged. Values containing HTML must preserve
   their tags.
3. Add the language to `server/public/lang/languages.json`:

   ```json
   { "code": "de", "name": "Deutsch" }
   ```

4. Reload the page. The language immediately appears in the selector; no view
   code or server route needs changing.

If a key is missing from a translation, the English value is used. If a catalog
cannot be loaded, the complete interface falls back to English.
