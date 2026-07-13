#!/usr/bin/env python3
"""
cnae_liquidation_scraper.py
===========================

Sourcing tool for the Spain power-anchored brownfield program (see Doc 02).

Purpose
-------
Fetch, parse and structure company-directory search results for companies:

  * registered under heavy-manufacturing CNAE 2009 codes (paper, chemicals,
    ceramics/bricks, basic metals, ...),
  * located in the target provinces (Zaragoza, Huesca, Teruel, Madrid,
    Guadalajara),
  * whose registry status is "En liquidación", "Concurso de acreedores"
    or "Inactiva".

Directory portals (Infocif, El Economista Ranking de Empresas, Expansion,
Axesor/eInforma, ...) each have their own URL schemes and markup. Rather than
hard-coding one site's HTML (which breaks weekly and may violate a portal's
terms of service), this script uses pluggable ``DirectoryAdapter`` classes
with PLACEHOLDER url templates and CSS selectors that you fill in per portal
after reviewing that portal's robots.txt and terms. A fully working offline
demo adapter is included so the whole pipeline (fetch -> parse -> filter ->
score -> CSV/JSON) is executable out of the box:

    python cnae_liquidation_scraper.py --adapter demo --out targets.csv

For production data quality, prefer official/paid structured sources
(BORME open data at boe.es/diario_borme, eInforma/Axesor APIs) and use the
same ``CompanyRecord`` schema; an adapter stub for a JSON API is included.

Politeness / compliance
-----------------------
* robots.txt is checked before every fetch (--ignore-robots to override
  only if you have explicit permission).
* Rate-limited (default 1 request / 2.5 s, jittered) with retries+backoff.
* Identifies itself with a descriptive User-Agent.

Dependencies:  pip install requests beautifulsoup4  (see requirements.txt)
"""

from __future__ import annotations

import argparse
import csv
import dataclasses
import json
import logging
import random
import re
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, Iterator, Optional
from urllib import robotparser
from urllib.parse import urljoin, urlparse

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:  # pragma: no cover
    print("Missing dependencies. Run:  pip install requests beautifulsoup4",
          file=sys.stderr)
    raise

LOG = logging.getLogger("cnae-scraper")

# --------------------------------------------------------------------------
# Screening configuration (mirrors Doc 02 §3)
# --------------------------------------------------------------------------

TARGET_PROVINCES = {
    "zaragoza", "huesca", "teruel",          # Aragon
    "madrid", "guadalajara",                 # Madrid + Henares spillover
}

# CNAE 2009 prefixes for heavy-power industry. A company matches if its CNAE
# code starts with any of these.
TARGET_CNAE_PREFIXES = {
    "1711": "Pulp (papelera)",
    "1712": "Paper & board (papelera)",
    "172":  "Paper articles",
    "201":  "Basic chemicals",
    "202":  "Agro-chemicals",
    "203":  "Paints/coatings",
    "205":  "Other chemicals",
    "206":  "Man-made fibres",
    "231":  "Glass",
    "232":  "Refractories",
    "233":  "Ceramic building materials (ladrillera)",
    "235":  "Cement / lime / plaster",
    "236":  "Concrete products",
    "241":  "Basic iron & steel (siderurgia)",
    "242":  "Steel tubes",
    "243":  "Other primary steel",
    "244":  "Non-ferrous metals",
    "245":  "Casting of metals (fundicion)",
    "27":   "Electrical equipment",
    "383":  "Materials recovery / recycling",
}

# Registry / activity status flags that qualify a target (accent-insensitive,
# lower-cased matching).
TARGET_STATUS_PATTERNS = [
    r"en\s+liquidacion",
    r"liquidacion",
    r"concurso\s+de\s+acreedores",
    r"concursad[ao]",
    r"inactiva",
    r"sin\s+actividad",
    r"extinguida",
    r"disuelta",
    r"cierre\s+de\s+hoja",
]

DEFAULT_USER_AGENT = (
    "BrownfieldResearchBot/1.0 (+industrial-site-research; contact via "
    "operator email; respects robots.txt)"
)


def _norm(text: str) -> str:
    """Lower-case and strip accents for robust Spanish matching."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text).strip().lower()


def status_matches(status: str) -> bool:
    s = _norm(status)
    return any(re.search(p, s) for p in TARGET_STATUS_PATTERNS)


def cnae_matches(cnae: str) -> Optional[str]:
    """Return sector label if the CNAE code is a heavy-industry target."""
    digits = re.sub(r"\D", "", cnae or "")
    for prefix, label in TARGET_CNAE_PREFIXES.items():
        if digits.startswith(prefix):
            return label
    return None


def province_matches(province: str) -> bool:
    return _norm(province) in TARGET_PROVINCES


# --------------------------------------------------------------------------
# Data model
# --------------------------------------------------------------------------

@dataclass
class CompanyRecord:
    name: str
    cnae: str = ""
    cnae_sector: str = ""
    status: str = ""
    province: str = ""
    municipality: str = ""
    address: str = ""
    nif: str = ""
    source: str = ""
    source_url: str = ""
    notes: str = ""
    power_score_hint: int = 0     # crude prior on legacy MW by sector

    SECTOR_POWER_PRIOR = {
        "papelera": 9, "chemical": 8, "siderurgia": 9, "fundicion": 7,
        "ladrillera": 5, "ceramic": 5, "cement": 7, "glass": 7,
        "recycling": 6, "electrical": 4, "fibres": 6, "steel": 8,
        "non-ferrous": 8, "refractor": 5, "concrete": 3, "paints": 4,
        "agro": 4, "pulp": 9, "paper": 6,
    }

    def finalize(self) -> "CompanyRecord":
        label = _norm(self.cnae_sector)
        self.power_score_hint = max(
            (v for k, v in self.SECTOR_POWER_PRIOR.items() if k in label),
            default=3,
        )
        return self

    def qualifies(self) -> bool:
        return bool(
            self.name
            and cnae_matches(self.cnae)
            and status_matches(self.status)
            and (not self.province or province_matches(self.province))
        )


# --------------------------------------------------------------------------
# Polite HTTP client
# --------------------------------------------------------------------------

class PoliteFetcher:
    def __init__(self, delay: float = 2.5, timeout: float = 30.0,
                 max_retries: int = 3, user_agent: str = DEFAULT_USER_AGENT,
                 ignore_robots: bool = False):
        self.delay = delay
        self.timeout = timeout
        self.max_retries = max_retries
        self.ignore_robots = ignore_robots
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": user_agent,
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.5",
        })
        self._robots: dict[str, robotparser.RobotFileParser] = {}
        self._last_request = 0.0

    def _robots_ok(self, url: str) -> bool:
        if self.ignore_robots:
            return True
        origin = "{0.scheme}://{0.netloc}".format(urlparse(url))
        rp = self._robots.get(origin)
        if rp is None:
            rp = robotparser.RobotFileParser()
            try:
                rp.set_url(urljoin(origin, "/robots.txt"))
                rp.read()
            except Exception:
                # Unreachable robots.txt -> be conservative but don't hard-fail
                LOG.warning("Could not read robots.txt for %s", origin)
            self._robots[origin] = rp
        try:
            return rp.can_fetch(self.session.headers["User-Agent"], url)
        except Exception:
            return True

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request
        wait = self.delay + random.uniform(0, self.delay * 0.4) - elapsed
        if wait > 0:
            time.sleep(wait)
        self._last_request = time.monotonic()

    def get(self, url: str, params: Optional[dict] = None) -> Optional[str]:
        if not self._robots_ok(url):
            LOG.warning("Blocked by robots.txt, skipping: %s", url)
            return None
        for attempt in range(1, self.max_retries + 1):
            self._throttle()
            try:
                resp = self.session.get(url, params=params,
                                        timeout=self.timeout)
                if resp.status_code == 200:
                    return resp.text
                if resp.status_code in (403, 429):
                    backoff = 10 * attempt
                    LOG.warning("%s from %s - backing off %ss",
                                resp.status_code, url, backoff)
                    time.sleep(backoff)
                    continue
                LOG.warning("HTTP %s from %s", resp.status_code, url)
                return None
            except requests.RequestException as exc:
                LOG.warning("Attempt %d/%d failed for %s: %s",
                            attempt, self.max_retries, url, exc)
                time.sleep(2 ** attempt)
        return None


# --------------------------------------------------------------------------
# Directory adapters
# --------------------------------------------------------------------------

class DirectoryAdapter:
    """Base class. Subclass per portal and fill the placeholders."""

    name = "base"

    def __init__(self, fetcher: PoliteFetcher):
        self.fetcher = fetcher

    def search(self, cnae_prefix: str, province: str,
               max_pages: int) -> Iterator[CompanyRecord]:
        raise NotImplementedError


class HtmlDirectoryAdapter(DirectoryAdapter):
    """
    Generic HTML list-page adapter driven by a config dict of URL template +
    CSS selectors. Concrete portal adapters below only supply CONFIG.
    """

    #: PLACEHOLDER — override in subclasses after inspecting the portal.
    CONFIG: dict = {
        # {cnae}, {province}, {page} are formatted in.
        "url_template": "https://example.invalid/empresas?cnae={cnae}"
                        "&provincia={province}&estado=liquidacion&pag={page}",
        "row_selector": "div.result-item",            # one node per company
        "fields": {                                   # selector, attr|text
            "name":         ("h2 a", "text"),
            "detail_url":   ("h2 a", "href"),
            "cnae":         (".cnae", "text"),
            "status":       (".estado", "text"),
            "province":     (".provincia", "text"),
            "municipality": (".localidad", "text"),
            "address":      (".direccion", "text"),
            "nif":          (".nif", "text"),
        },
        "next_page_selector": "a[rel=next]",
    }

    def _extract(self, node, selector: str, attr: str) -> str:
        el = node.select_one(selector)
        if el is None:
            return ""
        if attr == "text":
            return el.get_text(" ", strip=True)
        return el.get(attr, "") or ""

    def search(self, cnae_prefix: str, province: str,
               max_pages: int) -> Iterator[CompanyRecord]:
        cfg = self.CONFIG
        for page in range(1, max_pages + 1):
            url = cfg["url_template"].format(
                cnae=cnae_prefix, province=province, page=page)
            html = self.fetcher.get(url)
            if html is None:
                break
            soup = BeautifulSoup(html, "html.parser")
            rows = soup.select(cfg["row_selector"])
            if not rows:
                LOG.info("[%s] no rows on page %d (%s) - stopping",
                         self.name, page, url)
                break
            for row in rows:
                f = cfg["fields"]
                rec = CompanyRecord(
                    name=self._extract(row, *f["name"]),
                    cnae=self._extract(row, *f["cnae"]) or cnae_prefix,
                    cnae_sector=TARGET_CNAE_PREFIXES.get(cnae_prefix, ""),
                    status=self._extract(row, *f["status"]),
                    province=self._extract(row, *f["province"]) or province,
                    municipality=self._extract(row, *f["municipality"]),
                    address=self._extract(row, *f["address"]),
                    nif=self._extract(row, *f["nif"]),
                    source=self.name,
                    source_url=urljoin(url, self._extract(row,
                                                          *f["detail_url"])),
                ).finalize()
                yield rec
            if cfg.get("next_page_selector") and not soup.select_one(
                    cfg["next_page_selector"]):
                break


class InfocifAdapter(HtmlDirectoryAdapter):
    """
    PLACEHOLDER adapter for Infocif (www.infocif.es).
    Before use: review Infocif's terms of service & robots.txt, then inspect
    a live search-results page and replace url_template + selectors.
    Infocif exposes company pages with CNAE, estado (activa / inactiva /
    en liquidacion), province and registry data.
    """
    name = "infocif"
    CONFIG = dict(HtmlDirectoryAdapter.CONFIG)
    CONFIG.update({
        # PLACEHOLDER: real Infocif search URL pattern goes here.
        "url_template": "https://www.infocif.es/directorio-empresas"
                        "?cnae={cnae}&provincia={province}&pagina={page}",
        # PLACEHOLDER selectors — update after inspecting live markup:
        "row_selector": "div.listado-empresas div.empresa",
        "fields": {
            "name":         ("a.nombre-empresa", "text"),
            "detail_url":   ("a.nombre-empresa", "href"),
            "cnae":         ("span.cnae", "text"),
            "status":       ("span.situacion", "text"),
            "province":     ("span.provincia", "text"),
            "municipality": ("span.poblacion", "text"),
            "address":      ("span.domicilio", "text"),
            "nif":          ("span.cif", "text"),
        },
        "next_page_selector": "a.paginacion-siguiente",
    })


class ElEconomistaAdapter(HtmlDirectoryAdapter):
    """
    PLACEHOLDER adapter for El Economista's 'Ranking de Empresas'
    (ranking-empresas.eleconomista.es), which lists companies by CNAE and
    province with estado flags. Same drill: verify ToS, inspect markup,
    replace placeholders.
    """
    name = "eleconomista"
    CONFIG = dict(HtmlDirectoryAdapter.CONFIG)
    CONFIG.update({
        "url_template": "https://ranking-empresas.eleconomista.es"
                        "/empresas-CNAE-{cnae}-{province}.html?pag={page}",
        "row_selector": "table.tabla-ranking tbody tr",
        "fields": {
            "name":         ("td.nombre a", "text"),
            "detail_url":   ("td.nombre a", "href"),
            "cnae":         ("td.cnae", "text"),
            "status":       ("td.situacion", "text"),
            "province":     ("td.provincia", "text"),
            "municipality": ("td.localidad", "text"),
            "address":      ("td.direccion", "text"),
            "nif":          ("td.cif", "text"),
        },
        "next_page_selector": "a.siguiente",
    })


class JsonApiAdapter(DirectoryAdapter):
    """
    Stub for structured/paid sources (eInforma, Axesor, BORME open-data
    mirrors). Point BASE_URL at the API, map the JSON keys, done. This is
    the recommended production path: stable schema, contractual access.
    """
    name = "jsonapi"
    BASE_URL = "https://api.example.invalid/v1/companies"   # PLACEHOLDER
    API_KEY = ""                                            # PLACEHOLDER

    def search(self, cnae_prefix: str, province: str,
               max_pages: int) -> Iterator[CompanyRecord]:
        for page in range(1, max_pages + 1):
            body = self.fetcher.get(self.BASE_URL, params={
                "cnae": cnae_prefix, "province": province,
                "status": "liquidacion,inactiva", "page": page,
                "api_key": self.API_KEY,
            })
            if body is None:
                break
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                LOG.error("[jsonapi] non-JSON response on page %d", page)
                break
            items = payload.get("results", [])
            if not items:
                break
            for it in items:
                yield CompanyRecord(
                    name=it.get("name", ""),
                    cnae=str(it.get("cnae", cnae_prefix)),
                    cnae_sector=TARGET_CNAE_PREFIXES.get(cnae_prefix, ""),
                    status=it.get("status", ""),
                    province=it.get("province", province),
                    municipality=it.get("city", ""),
                    address=it.get("address", ""),
                    nif=it.get("tax_id", ""),
                    source=self.name,
                    source_url=it.get("url", ""),
                ).finalize()


class DemoAdapter(DirectoryAdapter):
    """Offline fixture so the pipeline runs end-to-end with no network."""
    name = "demo"

    _FIXTURE = [
        # name, cnae, status, province, municipality
        ("Papelera del Ebro S.A.", "1712", "En liquidación", "Zaragoza",
         "El Burgo de Ebro"),
        ("Cerámicas Aragonesas S.L.", "2332", "Inactiva", "Zaragoza",
         "Casetas"),
        ("Química del Cinca S.A.", "2013", "Concurso de acreedores - fase "
         "de liquidación", "Huesca", "Monzón"),
        ("Fundiciones Henares S.L.", "2451", "En liquidación", "Madrid",
         "Torrejón de Ardoz"),
        ("Logística Activa S.L.", "5210", "Activa", "Madrid", "Coslada"),
        ("Aceros del Jarama S.A.", "2410", "Inactiva", "Madrid", "Arganda "
         "del Rey"),
        ("Ladrillera Turolense S.L.", "2332", "Disuelta y en liquidación",
         "Teruel", "Andorra"),
        ("Textil Moderno S.L.", "1310", "En liquidación", "Zaragoza",
         "Zaragoza"),  # non-target CNAE -> filtered out
    ]

    def search(self, cnae_prefix: str, province: str,
               max_pages: int) -> Iterator[CompanyRecord]:
        for (name, cnae, status, prov, muni) in self._FIXTURE:
            if not cnae.startswith(cnae_prefix):
                continue
            if _norm(prov) != _norm(province):
                continue
            yield CompanyRecord(
                name=name, cnae=cnae,
                cnae_sector=TARGET_CNAE_PREFIXES.get(cnae_prefix, ""),
                status=status, province=prov, municipality=muni,
                source=self.name, source_url="demo://fixture",
            ).finalize()


ADAPTERS = {
    "demo": DemoAdapter,
    "infocif": InfocifAdapter,
    "eleconomista": ElEconomistaAdapter,
    "jsonapi": JsonApiAdapter,
}

# --------------------------------------------------------------------------
# Pipeline
# --------------------------------------------------------------------------

def run(adapter: DirectoryAdapter, provinces: Iterable[str],
        cnae_prefixes: Iterable[str], max_pages: int) -> list[CompanyRecord]:
    results: dict[str, CompanyRecord] = {}
    for province in provinces:
        for cnae in cnae_prefixes:
            LOG.info("Searching %s | provincia=%s cnae=%s",
                     adapter.name, province, cnae)
            for rec in adapter.search(cnae, province, max_pages):
                if not rec.qualifies():
                    LOG.debug("Filtered out: %s (%s / %s)",
                              rec.name, rec.cnae, rec.status)
                    continue
                key = rec.nif or _norm(rec.name)
                if key not in results:
                    results[key] = rec
    ranked = sorted(results.values(),
                    key=lambda r: r.power_score_hint, reverse=True)
    return ranked


def write_csv(records: list[CompanyRecord], path: str) -> None:
    fields = [f.name for f in dataclasses.fields(CompanyRecord)]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        for rec in records:
            writer.writerow(dataclasses.asdict(rec))


def write_json(records: list[CompanyRecord], path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump([dataclasses.asdict(r) for r in records], fh,
                  ensure_ascii=False, indent=2)


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description="Screen Spanish company directories for heavy-industry "
                    "CNAE companies in liquidation/inactive status "
                    "(Aragon & Madrid brownfield sourcing).")
    ap.add_argument("--adapter", choices=sorted(ADAPTERS), default="demo",
                    help="Directory source (default: demo, offline fixture)")
    ap.add_argument("--provinces", nargs="+",
                    default=["Zaragoza", "Huesca", "Teruel", "Madrid",
                             "Guadalajara"])
    ap.add_argument("--cnae", nargs="+",
                    default=sorted(TARGET_CNAE_PREFIXES),
                    help="CNAE prefixes to sweep")
    ap.add_argument("--max-pages", type=int, default=5,
                    help="Max result pages per (province, cnae) pair")
    ap.add_argument("--delay", type=float, default=2.5,
                    help="Base seconds between requests")
    ap.add_argument("--ignore-robots", action="store_true",
                    help="Skip robots.txt check (only with permission)")
    ap.add_argument("--out", default="brownfield_targets.csv",
                    help="Output CSV path")
    ap.add_argument("--json", dest="json_out", default=None,
                    help="Optional JSON output path")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s")

    fetcher = PoliteFetcher(delay=args.delay,
                            ignore_robots=args.ignore_robots)
    adapter = ADAPTERS[args.adapter](fetcher)

    records = run(adapter, args.provinces, args.cnae, args.max_pages)

    write_csv(records, args.out)
    if args.json_out:
        write_json(records, args.json_out)

    LOG.info("%d qualified targets written to %s", len(records), args.out)
    for rec in records[:15]:
        LOG.info("  [%2d] %-38s %s | %s | %s", rec.power_score_hint,
                 rec.name, rec.cnae, rec.status, rec.municipality)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
