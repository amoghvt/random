"""Tell the human. Always stdout; optionally a webhook (Discord, Slack, or any
endpoint that takes JSON). Set the URL in the env var named by notify.webhook_url_env."""

import json
import os
import sys
import urllib.request
from datetime import datetime


def say(msg, cfg=None, level="info"):
    line = "[%s] %s %s" % (datetime.now().strftime("%H:%M:%S"), level.upper(), msg)
    print(line, file=sys.stderr if level == "error" else sys.stdout, flush=True)
    url = os.environ.get((cfg or {}).get("notify", {}).get("webhook_url_env", ""), "")
    if url and level in ("alert", "error", "trade"):
        try:
            body = json.dumps({"content": line, "text": line}).encode()
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as e:  # notifications must never crash the loop
            print("[notify] webhook failed: %s" % e, file=sys.stderr)
