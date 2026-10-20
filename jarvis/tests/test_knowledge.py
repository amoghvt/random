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
