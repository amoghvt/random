import os
import tempfile
import unittest

from _fx import ET
from jarvis_core import knowledge


class Knowledge(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        with open(os.path.join(self.d, "vwap.md"), "w") as f:
            f.write("# VWAP\n\nOn trend days the first pullback to VWAP holds. Buy the hold, stop below the pullback low.\n\n" * 3)
        with open(os.path.join(self.d, "fomc.txt"), "w") as f:
            f.write("FOMC days: the first move after 14:00 is usually faked. Wait for the second move.\n")
        with open(os.path.join(self.d, "playbook.md"), "w") as f:
            f.write("never trade the first five minutes")
        with open(os.path.join(self.d, "image.png"), "wb") as f:
            f.write(b"\x89PNG")

    def test_build_search_roundtrip(self):
        idx = knowledge.build_index(self.d)
        self.assertGreater(idx["N"], 0)
        knowledge.save_index(idx, self.d)
        idx2 = knowledge.load_index(self.d)
        hits = knowledge.search(idx2, "pullback to vwap on a trend day", k=2)
        self.assertEqual(hits[0]["source"], "vwap.md")
        hits = knowledge.search(idx2, "fomc 14:00", k=1)
        self.assertEqual(hits[0]["source"], "fomc.txt")

    def test_always_include(self):
        pb = knowledge.always_include(self.d, ["playbook.md", "missing.md"])
        self.assertEqual(len(pb), 1)
        self.assertIn("five minutes", pb[0]["text"])

    def test_chunking(self):
        text = "\n\n".join("para %d " % i + "x" * 300 for i in range(10))
        chunks = knowledge.chunk(text, size=900, overlap=100)
        self.assertGreater(len(chunks), 2)
        self.assertTrue(all(len(c) <= 1900 for c in chunks))

    def test_index_skips_itself_and_binaries(self):
        idx = knowledge.build_index(self.d)
        knowledge.save_index(idx, self.d)
        idx = knowledge.build_index(self.d)
        srcs = {d["source"] for d in idx["docs"]}
        self.assertNotIn(knowledge.INDEX_NAME, srcs)
        self.assertNotIn("image.png", srcs)


if __name__ == "__main__":
    unittest.main()


class Databases(unittest.TestCase):
    def test_sqlite_and_extra_dir(self):
        import sqlite3
        kdir = tempfile.mkdtemp()
        extra = tempfile.mkdtemp()
        con = sqlite3.connect(os.path.join(extra, "oracle.db"))
        con.execute("create table notes (id integer, title text, body text, blob_col blob)")
        con.execute("insert into notes values (1, 'FOMC playbook', 'fade the first move after the statement', x'00ff')")
        con.execute("insert into notes values (2, 'VWAP', 'reclaim with volume is the tell', NULL)")
        con.execute("create table empty (x text)")
        con.commit(); con.close()
        with open(os.path.join(extra, "aether.csv"), "w") as f:
            f.write("date,level,note\n2026-10-19,29900,prior day high rejected twice\n")
        idx = knowledge.build_index(kdir, extra_dirs=[extra])
        srcs = {d["source"] for d in idx["docs"]}
        tag = os.path.basename(extra) + "/"
        self.assertIn(tag + "oracle.db:notes", srcs)
        self.assertIn(tag + "aether.csv", srcs)
        self.assertNotIn(tag + "oracle.db:empty", srcs)
        hit = knowledge.search(idx, "fade first move fomc statement", k=1)[0]
        self.assertTrue(hit["source"].endswith("oracle.db:notes"))
        self.assertIn("title: FOMC playbook", hit["text"])
        hit = knowledge.search(idx, "prior day high rejected", k=1)[0]
        self.assertTrue(hit["source"].endswith("aether.csv"))

    def test_missing_extra_dir_is_ignored(self):
        idx = knowledge.build_index(tempfile.mkdtemp(), extra_dirs=["/nonexistent/path"])
        self.assertEqual(idx["N"], 0)

    def test_unreadable_db_is_skipped(self):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "broken.db"), "wb") as f:
            f.write(b"not a database")
        self.assertEqual(knowledge.build_index(d)["N"], 0)
