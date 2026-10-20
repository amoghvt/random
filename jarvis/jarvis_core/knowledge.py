"""Your intel, indexed. Drop files into jarvis/knowledge/ and run `jarvis.py ingest`.

Reads .md .txt .json .csv .html .pdf (via pdftotext if installed). Chunks each file,
builds a BM25 index with no dependencies, and the brain pulls the top-k chunks that
match the current market picture. Files listed in knowledge.always_include (your
playbook) are injected whole, every time.
"""

import json
import math
import os
import re
import subprocess

INDEX_NAME = "knowledge_index.json"
TOKEN = re.compile(r"[a-z0-9]+(?:[.'][a-z0-9]+)?")
TEXT_EXT = {".md", ".txt", ".json", ".csv", ".html", ".htm", ".rst", ".log"}


def tokenize(text):
    return TOKEN.findall(text.lower())


def _read(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        try:
            out = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, timeout=120)
            return out.stdout.decode("utf-8", "replace") if out.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            return ""
    if ext not in TEXT_EXT:
        return ""
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    if ext in (".html", ".htm"):
        text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", text, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", text)
    return text


def chunk(text, size=900, overlap=150):
    text = re.sub(r"\r\n?", "\n", text)
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks, cur = [], ""
    for p in paras:
        if len(cur) + len(p) + 1 > size and cur:
            chunks.append(cur)
            cur = cur[-overlap:] + "\n" + p if overlap else p
        else:
            cur = (cur + "\n" + p) if cur else p
    if cur:
        chunks.append(cur)
    # very long paragraphs
    out = []
    for c in chunks:
        while len(c) > size * 2:
            out.append(c[:size])
            c = c[size - overlap:]
        out.append(c)
    return out


def build_index(kdir, exclude=()):
    docs = []
    for root, _dirs, files in os.walk(kdir):
        for name in sorted(files):
            if name.startswith(".") or name == INDEX_NAME or name in exclude:
                continue
            if name == "README.md" or name.endswith(".example.md"):
                continue
            path = os.path.join(root, name)
            text = _read(path)
            if not text.strip():
                continue
            rel = os.path.relpath(path, kdir)
            for i, c in enumerate(chunk(text)):
                docs.append({"source": rel, "n": i, "text": c, "tokens": tokenize(c)})
    df = {}
    for d in docs:
        for term in set(d["tokens"]):
            df[term] = df.get(term, 0) + 1
    avgdl = (sum(len(d["tokens"]) for d in docs) / len(docs)) if docs else 0
    index = {"docs": [{"source": d["source"], "n": d["n"], "text": d["text"], "len": len(d["tokens"]),
                       "tf": _tf(d["tokens"])} for d in docs],
             "df": df, "N": len(docs), "avgdl": avgdl}
    return index


def _tf(tokens):
    tf = {}
    for t in tokens:
        tf[t] = tf.get(t, 0) + 1
    return tf


def save_index(index, kdir):
    with open(os.path.join(kdir, INDEX_NAME), "w", encoding="utf-8") as fh:
        json.dump(index, fh)


def load_index(kdir):
    p = os.path.join(kdir, INDEX_NAME)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def search(index, query, k=6, k1=1.5, b=0.75):
    if not index or not index["docs"]:
        return []
    q = tokenize(query)
    N, avgdl, df = index["N"], index["avgdl"] or 1, index["df"]
    scored = []
    for d in index["docs"]:
        s = 0.0
        for term in q:
            f = d["tf"].get(term)
            if not f:
                continue
            idf = math.log(1 + (N - df.get(term, 0) + 0.5) / (df.get(term, 0) + 0.5))
            s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d["len"] / avgdl))
        if s > 0:
            scored.append((s, d))
    scored.sort(key=lambda x: -x[0])
    return [{"source": d["source"], "chunk": d["n"], "score": round(s, 3), "text": d["text"]}
            for s, d in scored[:k]]


def always_include(kdir, names):
    out = []
    for n in names or []:
        p = os.path.join(kdir, n)
        if os.path.exists(p):
            out.append({"source": n, "text": _read(p)})
    return out
