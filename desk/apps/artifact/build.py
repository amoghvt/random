"""Builds index.html (the published page) from page.src.html with data.json embedded, so the page needs no fetch."""
import json, pathlib
here = pathlib.Path(__file__).parent
data = json.dumps(json.loads((here / "data.json").read_text()), separators=(",", ":")).replace("</", "<\\/")
(here / "index.html").write_text((here / "page.src.html").read_text().replace("__SNAPSHOT__", data))
print("index.html", (here / "index.html").stat().st_size, "bytes")
