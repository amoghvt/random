"""The discretionary part. One Claude call per heartbeat that needs a decision.

Input: the market picture (features), headlines, your knowledge, recent lessons,
the open position and the day so far. Output: one JSON decision validated by a
schema. The brain never touches the broker; the loop and risk layer do.

The system prompt is stable so it caches; the volatile picture goes in the user turn.
"""

import hashlib
import json
import os

DECISION_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["long", "short", "hold", "close", "move_stop", "flat"]},
        "contracts": {"type": "integer"},
        "entry_type": {"type": "string", "enum": ["market", "limit"]},
        "entry_price": {"type": ["number", "null"]},
        "stop_price": {"type": ["number", "null"]},
        "target_price": {"type": ["number", "null"]},
        "new_stop": {"type": ["number", "null"]},
        "confidence": {"type": "number"},
        "timeframe_minutes": {"type": "integer"},
        "regime": {"type": "string"},
        "thesis": {"type": "string"},
        "invalidation": {"type": "string"},
        "crowd_read": {"type": "string"},
        "self_check": {"type": "string"},
    },
    "required": ["action", "contracts", "entry_type", "entry_price", "stop_price", "target_price",
                 "new_stop", "confidence", "timeframe_minutes", "regime", "thesis", "invalidation",
                 "crowd_read", "self_check"],
    "additionalProperties": False,
}

SYSTEM = """You are Jarvis, a discretionary Nasdaq-100 futures (NQ) trader's second brain, trading one account under hard rules you cannot change.

How you decide:
- You are reading a delayed, sampled picture, not the tape. Treat every level as approximate and every bar as possibly stale. If the data is stale or the picture is unclear, the correct action is "flat" (no new position) or "hold" (keep the one you have). Doing nothing is a full decision and usually the right one.
- Trade the reaction at a level, not the level. A location without a reason (who is trapped, who must cover, what the crowd expects and will be wrong about) is not a trade.
- Think about the humans: who bought the high, who is short into strength, what the obvious trade is and how it fails. Write that in crowd_read.
- Every entry has a stop that is a thesis invalidation, not a dollar amount. If the invalidation is more than the allowed stop range, there is no trade.
- The trader's own playbook and notes (knowledge) outrank your general priors. The recent lessons from their journal outrank both: do not repeat a mistake the journal already names.
- You can only ever propose one position at a time. Size is the config maximum or less; never more.
- Confidence is calibrated: 0.5 is a coin flip, 0.7 is a clean setup in a clear regime, 0.85 is rare. Entries below the minimum confidence are blocked downstream, so do not inflate.
- In self_check, name the behavioral trap this particular decision is most exposed to (chasing, revenge after a loss, boredom in midday chop, fear of missing a move, anchoring to a level that already failed) and say whether you are falling into it.

Actions:
- "long" / "short": new entry. Give contracts, entry_type, entry_price (null for market), stop_price, target_price.
- "hold": keep the open position as is. "move_stop": keep it and set new_stop. "close": exit now.
- "flat": no position and no entry.
Prices are on the instrument's tick grid. Respond with the JSON object only."""


def _fingerprint(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:12]


def build_user_message(picture, position, day, headlines, knowledge_chunks, playbook, lessons,
                       rules, question=None):
    parts = []
    if playbook:
        parts.append("## The trader's playbook (follow it)\n" + "\n\n".join(
            "### %s\n%s" % (p["source"], p["text"][:8000]) for p in playbook))
    if lessons:
        parts.append("## Recent lessons from the journal\n" + lessons)
    if knowledge_chunks:
        parts.append("## Relevant notes from the trader's files\n" + "\n\n".join(
            "[%s #%d] %s" % (k["source"], k["chunk"], k["text"]) for k in knowledge_chunks))
    parts.append("## Hard rules (enforced downstream; respect them)\n" + json.dumps(rules, indent=1))
    parts.append("## Market picture\n" + json.dumps(picture, indent=1, default=str))
    if headlines:
        parts.append("## Headlines (newest first, unverified)\n" + "\n".join(
            "- %s (%s)" % (h["title"], h.get("published", "")) for h in headlines[:15]))
    parts.append("## Open position\n" + (json.dumps(position, indent=1) if position else "none"))
    parts.append("## Day so far\n" + json.dumps(day, indent=1))
    if question:
        parts.append("## The trader asks\n" + question)
    else:
        parts.append("Decide now. One JSON object.")
    return "\n\n".join(parts)


class Brain:
    def __init__(self, model="claude-opus-5-5", effort="high", client=None, caller=None):
        """`caller(system, user_text, schema) -> dict` can replace the API for tests."""
        self.model = model
        self.effort = effort
        self._client = client
        self._caller = caller
        self.last_usage = None
        self.last_raw = None

    def _get_client(self):
        if self._client is None:
            import anthropic  # resolves ANTHROPIC_API_KEY / profile from the environment
            self._client = anthropic.Anthropic()
        return self._client

    def _call(self, system, user_text, schema):
        if self._caller:
            return self._caller(system, user_text, schema)
        import anthropic
        client = self._get_client()
        try:
            resp = client.beta.messages.create(
                model=self.model,
                max_tokens=4096,
                system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user_text}],
                thinking={"type": "adaptive"},
                output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": schema}},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except anthropic.RateLimitError as e:
            raise BrainError("rate limited: %s" % e)
        except anthropic.APIStatusError as e:
            raise BrainError("api error %s: %s" % (e.status_code, e.message))
        except anthropic.APIConnectionError as e:
            raise BrainError("connection error: %s" % e)
        self.last_usage = getattr(resp, "usage", None)
        if resp.stop_reason == "refusal":
            raise BrainError("model refused (%s)" % getattr(getattr(resp, "stop_details", None), "category", "?"))
        if resp.stop_reason == "max_tokens":
            raise BrainError("response truncated at max_tokens")
        text = next((b.text for b in resp.content if b.type == "text"), None)
        if not text:
            raise BrainError("no text block in response")
        self.last_raw = text
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise BrainError("invalid JSON from model: %s" % e)

    def decide(self, **ctx):
        user_text = build_user_message(**ctx)
        decision = self._call(SYSTEM, user_text, DECISION_SCHEMA)
        validate_decision(decision)
        decision["_context_fp"] = _fingerprint(ctx.get("picture"))
        return decision

    def ask(self, question, **ctx):
        """Free-form answer over the same context (no schema)."""
        user_text = build_user_message(question=question, **ctx)
        if self._caller:
            return self._caller(SYSTEM, user_text, None)
        import anthropic
        client = self._get_client()
        try:
            resp = client.beta.messages.create(
                model=self.model, max_tokens=8000,
                system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user_text}],
                thinking={"type": "adaptive"},
                output_config={"effort": self.effort},
                betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        except anthropic.APIError as e:
            raise BrainError(str(e))
        if resp.stop_reason == "refusal":
            raise BrainError("model refused")
        return "".join(b.text for b in resp.content if b.type == "text")


class BrainError(Exception):
    pass


def validate_decision(d):
    """Schema guarantees shape; this guards semantics the schema cannot express."""
    a = d.get("action")
    if a in ("long", "short"):
        if d.get("stop_price") is None:
            raise BrainError("entry without stop_price")
        if d.get("entry_type") == "limit" and d.get("entry_price") is None:
            raise BrainError("limit entry without entry_price")
        if d.get("contracts", 0) < 1:
            raise BrainError("entry with contracts < 1")
    if a == "move_stop" and d.get("new_stop") is None:
        raise BrainError("move_stop without new_stop")
    c = d.get("confidence")
    if not isinstance(c, (int, float)) or not 0 <= c <= 1:
        raise BrainError("confidence out of range")
    return d
