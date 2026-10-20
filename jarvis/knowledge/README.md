# Your knowledge goes here

Drop anything you want the brain to read: notes, playbooks, journals, research,
exported chats, PDFs. Supported: `.md .txt .json .csv .html .pdf` (PDF needs
`pdftotext` on the PATH). Subfolders are fine.

Then run `python3 jarvis.py ingest`. The index is rebuilt from scratch each time.

**Databases and folders elsewhere on your machine** don't need copying. Point
ingest at them and they are read in place:

```bash
python3 jarvis.py ingest --dir ~/oracle --dir ~/aether
```

or list them once under `knowledge.extra_dirs` in `config.json`. SQLite files
(`.db .sqlite .sqlite3`) are read table by table, one row per line, up to 5000
rows per table, binary columns skipped. Other databases (Postgres, MySQL, a
platform's export) should be dumped to CSV or JSON into one of those folders
first; their rows then index like any other file.

Two kinds of file:

- **`playbook.md`** is injected whole on every decision. Put your actual rules
  there: what you trade, what you never trade, the setups, the tells, your own
  known failure modes. Keep it under about two pages. See `playbook.example.md`.
- **Everything else** is chunked and searched. The brain gets the handful of
  chunks that best match the current market picture.

The index file `knowledge_index.json` is generated; don't edit it.
