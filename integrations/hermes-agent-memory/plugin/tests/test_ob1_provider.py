"""Tests for the Hermes OB1 memory provider plugin.

Covers pure helpers, lifecycle, the OB1 v1 schema shapes (recall + writeback
request bodies), prefetch + queue_prefetch caching, sync_turn writeback,
session-end / pre-compress hooks, and the seven tool handlers.

Network is mocked at urllib.request.urlopen — tests run offline.
"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Tuple
from unittest.mock import MagicMock, patch

import pytest

# Tests live alongside the plugin package; import the module under test.
PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))

# Stub the two hermes-agent modules the plugin imports.
if "agent.memory_provider" not in sys.modules:
    import types as _t
    fake_pkg = _t.ModuleType("agent")
    fake_mp = _t.ModuleType("agent.memory_provider")

    class _StubProvider:
        def initialize(self, session_id, **kwargs): pass
        def shutdown(self): pass
        def on_turn_start(self, *a, **kw): pass
        def system_prompt_block(self): return ""
        def prefetch(self, query, *, session_id=""): return ""
        def queue_prefetch(self, query, *, session_id=""): pass
        def sync_turn(self, *a, **kw): pass
        def get_tool_schemas(self): return []
        def handle_tool_call(self, *a, **kw): return ""
        def is_available(self): return False
        def get_config_schema(self): return []
        def save_config(self, *a, **kw): pass
        @property
        def name(self): return "stub"

    fake_mp.MemoryProvider = _StubProvider
    sys.modules["agent"] = fake_pkg
    sys.modules["agent.memory_provider"] = fake_mp

if "tools.registry" not in sys.modules:
    import types as _t
    fake_tools = _t.ModuleType("tools")
    fake_reg = _t.ModuleType("tools.registry")

    def _tool_error(msg: str) -> str:
        return json.dumps({"error": msg})

    fake_reg.tool_error = _tool_error
    sys.modules["tools"] = fake_tools
    sys.modules["tools.registry"] = fake_reg

import __init__ as ob1_module  # noqa: E402
from __init__ import (  # noqa: E402
    OB1MemoryProvider,
    _OB1Client,
    _RECALL_SCHEMA_VERSION,
    _WRITEBACK_SCHEMA_VERSION,
    _PREFETCH_TTL_SECONDS,
    _clean_text_for_capture,
    _default_config,
    _extract_findings,
    _format_recall_context,
    _format_relative_time,
    _is_trivial_message,
    _read_hermes_active_model,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in (
        "OPENBRAIN_KEY", "OPENBRAIN_URL", "OPENBRAIN_WORKSPACE_ID",
        "OPENBRAIN_PROJECT_ID", "HERMES_HOME",
    ):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def hermes_home(tmp_path):
    home = tmp_path / "hermes_home"
    home.mkdir()
    return home


@pytest.fixture
def configured(hermes_home, monkeypatch):
    """Provider with endpoint + key wired up but urlopen still mocked elsewhere."""
    (hermes_home / "ob1.json").write_text(json.dumps({
        "endpoint": "http://test/api/v1/plugins/agent-memory",
        "workspace_id": "ws-test",
        "project_id": "proj-test",
        "auto_recall": True,
        "auto_capture": True,
        "max_recall_results": 5,
        "default_confidence": 0.6,
        "require_review_by_default": True,
    }))
    monkeypatch.setenv("OPENBRAIN_KEY", "test-key-123")
    return hermes_home


def _mock_urlopen_response(body: Dict[str, Any], status: int = 200):
    """Build a context-manager mock that mimics urllib's urlopen response."""
    payload = json.dumps(body).encode("utf-8")
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=MagicMock(read=lambda: payload))
    cm.__exit__ = MagicMock(return_value=False)
    return cm


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class TestPureHelpers:

    def test_default_config_has_expected_keys(self):
        cfg = _default_config()
        assert cfg["workspace_id"] == "default"
        assert cfg["auto_recall"] is True
        assert cfg["auto_capture"] is True
        assert cfg["require_review_by_default"] is True
        assert 0 <= cfg["default_confidence"] <= 1

    @pytest.mark.parametrize("text,expected", [
        ("ok", True), ("OK", True), ("thanks", True),
        ("yes", True), ("nope.", True), ("k", True),
        ("Could you help with the deployment plan?", False),
        ("", False),
        ("ok this is a longer reply that is not trivial", False),
    ])
    def test_is_trivial_message(self, text, expected):
        assert _is_trivial_message(text) is expected

    def test_clean_text_strips_ob1_context(self):
        msg = "Real content.\n<ob1-context>\nrecalled stuff\n</ob1-context>\nMore content."
        cleaned = _clean_text_for_capture(msg)
        assert "ob1-context" not in cleaned
        assert "recalled stuff" not in cleaned
        assert "Real content" in cleaned
        assert "More content" in cleaned

    def test_clean_text_handles_no_wrapper(self):
        assert _clean_text_for_capture("plain text").strip() == "plain text"

    def test_format_recall_context_empty(self):
        assert _format_recall_context([], 5) == ""

    def test_format_recall_context_renders_provenance_tags(self):
        out = _format_recall_context([
            {
                "summary": "Always run migrations off-hours.",
                "use_policy": {"can_use_as_instruction": True, "requires_user_confirmation": False},
                "freshness": {"created_at": "2026-05-09T10:00:00Z", "last_confirmed_at": None, "stale_after": None},
            },
            {
                "summary": "Last build took 12 minutes.",
                "use_policy": {"can_use_as_evidence": True},
            },
        ], 5)
        assert "<ob1-context>" in out
        assert "Always run migrations" in out
        assert "[instruction]" in out
        assert "[evidence]" in out

    def test_format_recall_context_reads_the_plugins_freshness(self):
        from datetime import datetime, timezone, timedelta
        written = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
        confirmed = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        out = _format_recall_context([
            {"summary": "written", "freshness": {"created_at": written, "last_confirmed_at": None}},
            {"summary": "confirmed", "freshness": {"created_at": written, "last_confirmed_at": confirmed}},
        ], 5)
        assert "- [3d ago] written" in out
        assert "- [2h ago] confirmed" in out

    def test_format_recall_context_truncates_to_max(self):
        items = [{"summary": f"memory {i}"} for i in range(10)]
        out = _format_recall_context(items, max_results=3)
        # Each rendered line starts with "- " (and a leading prefix space when
        # there are no provenance tags). Count occurrences of the body marker.
        assert out.count("memory ") == 3

    def test_format_relative_time_recent(self):
        from datetime import datetime, timezone, timedelta
        ts = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        assert _format_relative_time(ts) == "just now"

    def test_format_relative_time_handles_garbage(self):
        assert _format_relative_time("") == ""
        assert _format_relative_time("not-a-date") == ""


class TestExtractFindings:

    def test_extracts_decisions(self):
        msgs = [{"role": "assistant", "content": "We decided to use Postgres for the queue."}]
        findings = _extract_findings(msgs)
        assert "decisions" in findings
        assert any("Postgres" in d for d in findings["decisions"])

    def test_extracts_constraints(self):
        msgs = [{"role": "user", "content": "We must not exceed 50 RPS on this endpoint."}]
        findings = _extract_findings(msgs)
        assert "constraints" in findings

    def test_extracts_failures(self):
        msgs = [{"role": "assistant", "content": "The build failed because the schema migration broke the tests."}]
        findings = _extract_findings(msgs)
        assert "failures" in findings

    def test_skips_short_lines(self):
        msgs = [{"role": "user", "content": "Failed."}]  # <20 chars
        findings = _extract_findings(msgs)
        assert findings == {}

    def test_skips_overlong_lines(self):
        msgs = [{"role": "user", "content": "We decided to " + "x" * 500}]
        findings = _extract_findings(msgs)
        assert findings == {}

    def test_per_category_limit(self):
        msgs = [{"role": "user", "content": " ".join([
            f"We decided to do thing {i} for the project quickly." for i in range(20)
        ])}]
        findings = _extract_findings(msgs, per_category_limit=3)
        assert len(findings.get("decisions", [])) <= 3

    def test_first_match_wins(self):
        # "decided" is decisions; "next time" is lessons. Decisions wins.
        msgs = [{"role": "user", "content": "We decided to fix it next time around."}]
        findings = _extract_findings(msgs)
        assert "decisions" in findings
        assert "lessons" not in findings


class TestResolveWorkspaceId:
    """Per-agent workspace mode resolution (mirrors OpenClaw plugin's workspaceMode)."""

    def test_shared_mode_returns_fallback(self):
        from __init__ import _resolve_workspace_id
        assert _resolve_workspace_id(
            mode="shared", prefix="ignored-", agent_identity="nina", fallback="fleet",
        ) == "fleet"

    def test_per_agent_mode_uses_agent_identity(self):
        from __init__ import _resolve_workspace_id
        assert _resolve_workspace_id(
            mode="per-agent", prefix="", agent_identity="nina", fallback="fleet",
        ) == "nina"

    def test_per_agent_with_prefix(self):
        from __init__ import _resolve_workspace_id
        assert _resolve_workspace_id(
            mode="per-agent", prefix="hermes-", agent_identity="nina", fallback="fleet",
        ) == "hermes-nina"

    def test_per_agent_falls_back_when_identity_is_default(self):
        # "default" is the placeholder when no agent identity is set —
        # must fall back to the configured workspace, not "default" the literal.
        from __init__ import _resolve_workspace_id
        assert _resolve_workspace_id(
            mode="per-agent", prefix="", agent_identity="default", fallback="fleet",
        ) == "fleet"

    def test_per_agent_falls_back_when_identity_empty(self):
        from __init__ import _resolve_workspace_id
        assert _resolve_workspace_id(
            mode="per-agent", prefix="", agent_identity="", fallback="fleet",
        ) == "fleet"

    def test_unknown_mode_treated_as_shared(self):
        from __init__ import _resolve_workspace_id
        assert _resolve_workspace_id(
            mode="garbage", prefix="x-", agent_identity="nina", fallback="fleet",
        ) == "fleet"


class TestReadHermesActiveModel:
    """Regression tests for the bug where a line-scan matched stt.local.model."""

    def test_returns_empty_when_no_config(self, hermes_home):
        out = _read_hermes_active_model(str(hermes_home))
        assert out == {"model": "", "provider": ""}

    def test_reads_nested_model_default(self, hermes_home, monkeypatch):
        monkeypatch.setattr(ob1_module, "_read_hermes_active_model", _read_hermes_active_model)
        (hermes_home / "config.yaml").write_text(
            "model:\n"
            "  default: anthropic/claude-opus-4.6\n"
            "  provider: openrouter\n"
            "  base_url: https://openrouter.ai/api/v1\n"
            "stt:\n"
            "  local:\n"
            "    model: base\n"
        )
        out = _read_hermes_active_model(str(hermes_home))
        assert out["model"] == "anthropic/claude-opus-4.6"
        assert out["provider"] == "openrouter"

    def test_treats_provider_auto_as_empty(self, hermes_home):
        (hermes_home / "config.yaml").write_text(
            "model:\n"
            "  default: anthropic/claude-opus-4.6\n"
            "  provider: auto\n"
        )
        out = _read_hermes_active_model(str(hermes_home))
        assert out["provider"] == ""  # let prefix derivation pick it up

    def test_falls_back_to_top_level_default_model(self, hermes_home):
        (hermes_home / "config.yaml").write_text(
            "default_model: openai/gpt-5\n"
            "stt:\n"
            "  local:\n"
            "    model: base\n"
        )
        out = _read_hermes_active_model(str(hermes_home))
        assert out["model"] == "openai/gpt-5"

    def test_does_not_match_stt_local_model(self, hermes_home):
        # Critical regression: nested `model:` is a dict, not a value — the
        # old line-scan picked up `model: base` from stt.local.
        (hermes_home / "config.yaml").write_text(
            "stt:\n  local:\n    model: base\n"
        )
        out = _read_hermes_active_model(str(hermes_home))
        assert out["model"] != "base"


# ---------------------------------------------------------------------------
# OB1 client — schema shape on the wire
# ---------------------------------------------------------------------------


class TestOB1Client:

    def _capture_request(self):
        captured: Dict[str, Any] = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["method"] = req.get_method()
            captured["headers"] = dict(req.header_items())
            captured["body"] = json.loads(req.data.decode("utf-8")) if req.data else None
            return _mock_urlopen_response({"request_id": "req-001", "memories": []})

        return captured, fake_urlopen

    def test_recall_payload_uses_v1_schema_version(self):
        captured, fake = self._capture_request()
        client = _OB1Client("http://x", "key", 5.0)
        with patch("urllib.request.urlopen", fake):
            client.recall(
                workspace_id="ws-1", project_id="proj-1", task_type="general",
                query="hello",
            )
        body = captured["body"]
        assert body["schema_version"] == _RECALL_SCHEMA_VERSION
        assert body["workspace_id"] == "ws-1"
        assert body["project_id"] == "proj-1"
        assert body["task_type"] == "general"
        assert body["query"] == "hello"
        assert body["scope"]["project_only"] is True

    def test_recall_uses_x_brain_key_header(self):
        captured, fake = self._capture_request()
        client = _OB1Client("http://x", "secret-key", 5.0)
        with patch("urllib.request.urlopen", fake):
            client.recall(workspace_id="w", project_id=None, task_type="t", query="q")
        # urllib lowercases header keys in header_items()
        headers_lc = {k.lower(): v for k, v in captured["headers"].items()}
        assert headers_lc.get("x-brain-key") == "secret-key"
        # Critical: must NOT use Authorization Bearer
        assert "authorization" not in headers_lc

    def test_writeback_payload_shape(self):
        captured, fake = self._capture_request()
        client = _OB1Client("http://x", "k", 5.0)
        with patch("urllib.request.urlopen", fake):
            client.writeback(
                workspace_id="ws", project_id="proj",
                memory_payload={"decisions": ["chose Postgres"]},
                runtime={"name": "hermes", "version": "0.13.0"},
                models_used=[{"provider": "openrouter", "model": "anthropic/claude-opus-4.6", "role": "primary"}],
                provenance={"default_status": "generated", "confidence": 0.7, "requires_review": True},
                task_id="task-1", flow_id="flow-1",
            )
        body = captured["body"]
        assert body["schema_version"] == _WRITEBACK_SCHEMA_VERSION
        assert body["memory_payload"]["decisions"] == ["chose Postgres"]
        assert body["runtime"]["name"] == "hermes"
        # runtime carries name and version alone.
        assert set(body["runtime"].keys()) <= {"name", "version"}
        assert body["models_used"][0]["model"] == "anthropic/claude-opus-4.6"
        assert body["task_id"] == "task-1"
        assert body["flow_id"] == "flow-1"

    def test_report_usage_shape(self):
        captured, fake = self._capture_request()
        client = _OB1Client("http://x", "k", 5.0)
        with patch("urllib.request.urlopen", fake):
            client.report_usage("req-1", used=["m1", "m2"], ignored=["m3"])
        assert captured["url"] == "http://x/recalls/req-1/usage"
        assert captured["method"] == "POST"
        body = captured["body"]
        assert body["used_memory_ids"] == ["m1", "m2"]
        assert body["ignored"] == [{"memory_id": "m3"}]

    def test_routes_are_the_plugins(self):
        # Each call on the agent-memory plugin's route: the reads on GET with
        # their input in the query string and no body, the writes with a body.
        client = _OB1Client("http://x/api/v1/plugins/agent-memory/", "k", 5.0)
        calls = [
            (lambda: client.recall(workspace_id="w", project_id=None, task_type="t", query="q"), "POST", "/recall", None),
            (lambda: client.writeback(workspace_id="w", project_id=None, memory_payload={"lessons": ["l"]}), "POST", "/writeback", None),
            (lambda: client.list_memories(workspace_id="w s", project_id="p", review_status="pending", limit=5),
             "GET", "/memories?workspace_id=w+s&project_id=p&review_status=pending&limit=5", None),
            (lambda: client.get_review_queue(workspace_id="w"), "GET", "/review-queue?workspace_id=w", None),
            (lambda: client.get_review_queue(workspace_id="w", project_id="p"), "GET", "/review-queue?workspace_id=w&project_id=p", None),
            (lambda: client.review_memory("m/1", action="confirm"), "PATCH", "/memories/m%2F1/review", {"action": "confirm", "actor_label": "ob1-plugin"}),
            (lambda: client.get_recall_trace("req-1"), "GET", "/recalls/req-1", None),
        ]
        for call, method, path, body in calls:
            captured, fake = self._capture_request()
            with patch("urllib.request.urlopen", fake):
                call()
            assert captured["method"] == method, path
            assert captured["url"] == "http://x/api/v1/plugins/agent-memory" + path
            if method == "GET":
                assert captured["body"] is None, path
                assert "content-type" not in {k.lower() for k in captured["headers"]}, path
            elif body is not None:
                assert captured["body"] == body, path

    def test_review_memory_edit_sends_content_and_summary(self):
        captured, fake = self._capture_request()
        client = _OB1Client("http://x", "k", 5.0)
        with patch("urllib.request.urlopen", fake):
            client.review_memory("m1", action="edit", notes="n", actor_label="hermes:a",
                                 content="new text", summary="new summary")
        # The plugin refuses a field it does not know: the reviewer is actor_label.
        assert captured["body"] == {"action": "edit", "actor_label": "hermes:a", "notes": "n",
                                    "content": "new text", "summary": "new summary"}

    def test_http_error_is_raised(self):
        import urllib.error
        client = _OB1Client("http://x", "k", 5.0)
        err = urllib.error.HTTPError(
            url="http://x/recall", code=400, msg="Bad",
            hdrs=None, fp=io.BytesIO(b'{"code":"REFUSED_INPUT","issues":[]}'),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(RuntimeError, match="HTTP 400 REFUSED_INPUT"):
                client.recall(workspace_id="w", project_id=None, task_type="t", query="q")

    def test_refusal_carries_code_message_and_retry_after(self):
        import email.message
        import urllib.error
        hdrs = email.message.Message()
        hdrs["Retry-After"] = "5"
        client = _OB1Client("http://x", "k", 5.0)
        err = urllib.error.HTTPError(
            url="http://x/recall", code=503, msg="Unavailable", hdrs=hdrs,
            fp=io.BytesIO(b'{"code":"PROVIDER_UNAVAILABLE","message":"the brain\'s embedding provider did not answer"}'),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(ob1_module.OB1RequestError) as caught:
                client.recall(workspace_id="w", project_id=None, task_type="t", query="q")
        assert caught.value.status == 503
        assert caught.value.code == "PROVIDER_UNAVAILABLE"
        assert caught.value.retry_after == "5"
        assert "embedding provider did not answer" in str(caught.value)

    def _parts(self):
        """A fake urlopen that answers each write-back with one id per memory, and the bodies and timeouts it saw."""
        bodies: List[Dict[str, Any]] = []
        timeouts: List[Any] = []

        def fake(req, timeout=None):
            body = json.loads(req.data.decode("utf-8")) if req.data else {}
            bodies.append(body)
            timeouts.append(timeout)
            n = sum(len(v) for k, v in (body.get("memory_payload") or {}).items() if k != "entities")
            return _mock_urlopen_response({"schema_version": "v", "memories": [{"memory_id": f"m{len(bodies)}-{i}"} for i in range(n)]})

        return bodies, timeouts, fake

    def test_writeback_past_a_part_is_sent_in_parts(self):
        # 60 memories go as six parts of ten (the plugin takes at most 50, and each memory is a capture with its model
        # calls): in order, the answers' memories joined, a key given made each part's own, the entities on the first.
        bodies, timeouts, fake = self._parts()
        client = _OB1Client("http://x", "k", 5.0, writeback_timeout=90.0)
        payload = {"decisions": [f"d{i}" for i in range(30)], "lessons": [f"l{i}" for i in range(30)], "entities": {"repos": ["r"]}}
        with patch("urllib.request.urlopen", fake):
            out = client.writeback(workspace_id="w", project_id=None, memory_payload=payload, idempotency_key="key")
        sizes = [sum(len(v) for k, v in b["memory_payload"].items() if k != "entities") for b in bodies]
        assert sizes == [10] * 6
        sent = [item for b in bodies for k, v in b["memory_payload"].items() if k != "entities" for item in v]
        assert sent == payload["decisions"] + payload["lessons"]
        assert bodies[0]["memory_payload"]["entities"] == {"repos": ["r"]} and all("entities" not in b["memory_payload"] for b in bodies[1:])
        assert [b["idempotency_key"] for b in bodies] == [f"key:part{n}" for n in range(6)]
        assert all("step_id" not in b for b in bodies)
        assert len(out["memories"]) == 60 and out["memories"][10]["memory_id"] == "m2-0"
        # Each part under the write-back's own timeout, not the reads'.
        assert timeouts == [90.0] * 6

    def test_parts_without_a_key_each_have_a_step(self):
        # With no key the plugin makes one of the step and the text, and the memory's index in the request: each
        # part's own step keeps the same text at the same index of two parts two memories, as in one write-back.
        bodies, _, fake = self._parts()
        client = _OB1Client("http://x", "k", 5.0)
        with patch("urllib.request.urlopen", fake):
            client.writeback(workspace_id="w", project_id=None, memory_payload={"lessons": ["same"] * 20})
            client.writeback(workspace_id="w", project_id=None, memory_payload={"lessons": ["same"] * 20}, step_id="s1")
        assert [b.get("step_id") for b in bodies] == ["step:part0", "step:part1", "s1:part0", "s1:part1"]
        assert all("idempotency_key" not in b for b in bodies)

    def test_a_long_key_stays_within_the_plugins_bound(self):
        bodies, _, fake = self._parts()
        client = _OB1Client("http://x", "k", 5.0)
        key = "k" * 198
        with patch("urllib.request.urlopen", fake):
            client.writeback(workspace_id="w", project_id=None, memory_payload={"lessons": [f"l{i}" for i in range(11)]}, idempotency_key=key)
        keys = [b["idempotency_key"] for b in bodies]
        assert all(len(k) <= 200 for k in keys) and len(set(keys)) == 2 and keys[0].endswith(":part0")
        assert ob1_module._part_id(key, 0) == keys[0]  # the same key and part, the same id: a resend keys alike

    def test_writeback_of_a_part_is_one_call(self):
        bodies, timeouts, fake = self._parts()
        client = _OB1Client("http://x", "k", 5.0)
        with patch("urllib.request.urlopen", fake):
            client.writeback(workspace_id="w", project_id=None, memory_payload={"outputs": [f"o{i}" for i in range(10)]}, idempotency_key="key")
            client.recall(workspace_id="w", project_id=None, task_type="t", query="q")
        assert len(bodies) == 2 and bodies[0]["idempotency_key"] == "key" and "step_id" not in bodies[0]
        assert timeouts == [ob1_module._DEFAULT_WRITEBACK_TIMEOUT, 5.0]

    @pytest.mark.parametrize("given,kept", [(999, 255.0), (1, 8.0), ("soon", 60.0)])
    def test_writeback_timeout_is_configured(self, hermes_home, monkeypatch, given, kept):
        # At most the brain's idle timeout (255 s), at least the reads' default (8 s), 60 s for a value that is no number.
        (hermes_home / "ob1.json").write_text(json.dumps({"endpoint": "http://x", "writeback_timeout": given}))
        monkeypatch.setenv("OPENBRAIN_KEY", "k")
        p = OB1MemoryProvider()
        p.initialize(session_id="s", hermes_home=str(hermes_home))
        assert p._client._writeback_timeout == kept

    def test_an_unsplit_long_key_is_hashed(self):
        bodies, _, fake = self._parts()
        client = _OB1Client("http://x", "k", 5.0)
        with patch("urllib.request.urlopen", fake):
            client.writeback(workspace_id="w", project_id=None, memory_payload={"lessons": ["l"]}, idempotency_key="k" * 201)
            client.writeback(workspace_id="w", project_id=None, memory_payload={"lessons": ["l"]}, idempotency_key="k" * 200)
        assert len(bodies[0]["idempotency_key"]) == 64 and bodies[1]["idempotency_key"] == "k" * 200

    def test_parts_stop_at_the_deadline(self, monkeypatch):
        # Each part 25 s on a fake clock, a deadline 60 s out: the parts wait 60, 35 and 10 s, and the fourth is never
        # started; the cut says the 30 memories kept and the 30 not sent.
        clock = [1000.0]
        monkeypatch.setattr(ob1_module.time, "monotonic", lambda: clock[0])
        bodies, timeouts, fake = self._parts()

        def slow(req, timeout=None):
            clock[0] += 25
            return fake(req, timeout)

        client = _OB1Client("http://x", "k", 5.0)
        with patch("urllib.request.urlopen", slow):
            with pytest.raises(ob1_module.OB1WritebackCut) as cut:
                client.writeback(workspace_id="w", project_id=None, memory_payload={"lessons": [f"l{i}" for i in range(60)]}, deadline=1060.0)
        assert timeouts == [60.0, 35.0, 10.0]
        assert len(cut.value.memories) == 30 and cut.value.unsent == 30

    def test_nothing_is_sent_past_the_deadline(self, monkeypatch):
        bodies, _, fake = self._parts()
        client = _OB1Client("http://x", "k", 5.0)
        client.stop_by(ob1_module.time.monotonic() - 1)
        with patch("urllib.request.urlopen", fake):
            with pytest.raises(ob1_module.OB1WritebackCut) as cut:
                client.writeback(workspace_id="w", project_id=None, memory_payload={"lessons": ["l1", "l2"]})
        assert bodies == [] and cut.value.unsent == 2 and cut.value.memories == []


    @pytest.mark.parametrize("raw", [b"<html>login</html>", b"[1, 2]", b"\xff\xfe not utf-8", b""])
    def test_ok_answer_that_is_no_json_object_raises(self, raw):
        # A 200 that is not a JSON object is no answer of the plugin's (an endpoint pointing at some other page):
        # a coded error, never a parse, decode or attribute error.
        cm = MagicMock()
        cm.__enter__ = MagicMock(return_value=MagicMock(read=lambda: raw, status=200))
        cm.__exit__ = MagicMock(return_value=False)
        client = _OB1Client("http://x", "k", 5.0)
        with patch("urllib.request.urlopen", return_value=cm):
            with pytest.raises(ob1_module.OB1RequestError, match="HTTP 200 not the plugin's answer"):
                client.recall(workspace_id="w", project_id=None, task_type="t", query="q")

    def test_non_json_error_body_is_kept(self):
        import urllib.error
        client = _OB1Client("http://x", "k", 5.0)
        err = urllib.error.HTTPError(
            url="http://x/recall", code=502, msg="Bad Gateway",
            hdrs=None, fp=io.BytesIO(b"<html>bad gateway</html>"),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with pytest.raises(ob1_module.OB1RequestError, match="HTTP 502 <html>bad gateway</html>") as caught:
                client.recall(workspace_id="w", project_id=None, task_type="t", query="q")
        assert caught.value.code is None


# ---------------------------------------------------------------------------
# Provider lifecycle
# ---------------------------------------------------------------------------


class TestProviderLifecycle:

    def test_name_is_ob1(self):
        assert OB1MemoryProvider().name == "ob1"

    def test_inactive_without_key(self, configured, monkeypatch):
        monkeypatch.delenv("OPENBRAIN_KEY", raising=False)
        p = OB1MemoryProvider()
        p.initialize(session_id="s", hermes_home=str(configured))
        assert p._active is False

    def test_inactive_without_endpoint(self, hermes_home, monkeypatch):
        monkeypatch.setenv("OPENBRAIN_KEY", "k")
        p = OB1MemoryProvider()
        p.initialize(session_id="s", hermes_home=str(hermes_home))
        assert p._active is False

    def test_active_when_both_present(self, configured):
        p = OB1MemoryProvider()
        p.initialize(session_id="s", hermes_home=str(configured))
        assert p._active is True
        assert p._workspace_id == "ws-test"
        assert p._project_id == "proj-test"

    def test_subagent_context_disables_writes(self, configured):
        p = OB1MemoryProvider()
        p.initialize(session_id="s", hermes_home=str(configured),
                     agent_context="subagent")
        assert p._write_enabled is False

    def test_initialize_makes_no_request(self, configured):
        # The plugin has no keyless health route: initialize() asks nothing,
        # and the provider is active on its config alone.
        p = OB1MemoryProvider()
        with patch("urllib.request.urlopen") as mock_open:
            p.initialize(session_id="s", hermes_home=str(configured))
        assert p._active is True
        mock_open.assert_not_called()

    def test_save_config_persists_only_known_keys(self, hermes_home):
        p = OB1MemoryProvider()
        p.save_config({
            "endpoint": "http://new/api",
            "workspace_id": "ws-2",
            "auto_recall": False,
            "max_recall_results": 12,
            "ignored_garbage_key": "should not persist",
        }, str(hermes_home))
        loaded = json.loads((hermes_home / "ob1.json").read_text())
        assert loaded["endpoint"] == "http://new/api"
        assert loaded["workspace_id"] == "ws-2"
        assert loaded["auto_recall"] is False
        assert loaded["max_recall_results"] == 12
        assert "ignored_garbage_key" not in loaded


# ---------------------------------------------------------------------------
# Per-turn hooks
# ---------------------------------------------------------------------------


class TestOnTurnStart:

    def test_caches_kwargs(self, configured):
        p = OB1MemoryProvider()
        p.initialize(session_id="s", hermes_home=str(configured))
        p.on_turn_start(3, "msg", model="anthropic/claude-opus-4.6", remaining_tokens=1200)
        assert p._last_turn_meta["model"] == "anthropic/claude-opus-4.6"
        assert p._last_turn_meta["turn_number"] == 3
        assert p._last_turn_meta["remaining_tokens"] == 1200

    def test_resolve_model_provider_uses_cached_kwargs(self, configured):
        p = OB1MemoryProvider()
        p.initialize(session_id="s", hermes_home=str(configured))
        p._last_turn_meta = {"model": "openrouter/stepfun/step-3.5-flash"}
        out = p._resolve_model_provider()
        assert out["model"] == "openrouter/stepfun/step-3.5-flash"
        # Provider derived from prefix
        assert out["provider"] == "openrouter"

    def test_resolve_model_provider_falls_back_to_config(self, configured):
        # No on_turn_start kwargs cached — should read config.yaml
        (Path(configured) / "config.yaml").write_text(
            "model:\n  default: anthropic/claude-opus-4.6\n  provider: openrouter\n"
        )
        p = OB1MemoryProvider()
        p.initialize(session_id="s", hermes_home=str(configured))
        out = p._resolve_model_provider()
        assert out["model"] == "anthropic/claude-opus-4.6"
        assert out["provider"] == "openrouter"


class TestPrefetchAndCache:

    def _patched(self, configured) -> OB1MemoryProvider:
        p = OB1MemoryProvider()
        p.initialize(session_id="sess", hermes_home=str(configured))
        return p

    def test_inactive_prefetch_returns_empty(self, hermes_home):
        p = OB1MemoryProvider()
        # Not initialized — should return empty without raising
        assert p.prefetch("query") == ""

    def test_cold_prefetch_does_sync_recall(self, configured):
        p = self._patched(configured)
        calls: List[str] = []

        def fake_do_recall(query, *, session_id=""):
            calls.append(query)
            return f"<ctx>{query}</ctx>", "req-1"

        p._do_recall = fake_do_recall
        out = p.prefetch("hello")
        assert "hello" in out
        assert calls == ["hello"]
        assert p._last_request_id == "req-1"

    def test_queue_prefetch_caches_result(self, configured):
        p = self._patched(configured)
        results = []

        def fake_do_recall(query, *, session_id=""):
            results.append(query)
            return f"<ctx>{query}</ctx>", "req-bg"

        p._do_recall = fake_do_recall
        p.queue_prefetch("warm-up")
        # Wait for thread (deterministic — wait on the thread itself)
        if p._prefetch_thread:
            p._prefetch_thread.join(timeout=5)
        assert p._prefetch_cache is not None
        cached_query, cached_ctx, cached_req, _ts = p._prefetch_cache
        assert cached_query == "warm-up"
        assert "warm-up" in cached_ctx
        assert cached_req == "req-bg"
        assert results == ["warm-up"]

    def test_warm_prefetch_consumes_cache_without_recall(self, configured):
        p = self._patched(configured)
        recall_calls = []

        def fake_do_recall(query, *, session_id=""):
            recall_calls.append(query)
            return f"<ctx>{query}</ctx>", "req-X"

        p._do_recall = fake_do_recall
        p.queue_prefetch("warm-up")
        if p._prefetch_thread:
            p._prefetch_thread.join(timeout=5)
        # Now prefetch with a DIFFERENT query — should still use cache.
        out = p.prefetch("totally different query")
        assert "warm-up" in out  # cached context returned
        assert len(recall_calls) == 1  # only the bg recall, no new sync recall
        assert p._prefetch_cache is None  # cache cleared after consumption

    def test_stale_cache_is_discarded(self, configured):
        p = self._patched(configured)
        recall_calls = []

        def fake_do_recall(query, *, session_id=""):
            recall_calls.append(query)
            return f"<ctx>{query}</ctx>", "req-fresh"

        p._do_recall = fake_do_recall
        # Inject stale cache
        p._prefetch_cache = ("stale-q", "<stale-ctx>", "old-req",
                             time.monotonic() - _PREFETCH_TTL_SECONDS - 10)
        out = p.prefetch("new query")
        assert "stale-ctx" not in out
        assert "new query" in out
        assert recall_calls == ["new query"]

    def test_burst_queue_prefetch_dedups(self, configured):
        p = self._patched(configured)
        slow_started = threading.Event()
        slow_release = threading.Event()
        recall_calls = []

        def slow_recall(query, *, session_id=""):
            recall_calls.append(query)
            slow_started.set()
            slow_release.wait(timeout=2)
            return "<ctx>", "req"

        p._do_recall = slow_recall
        p.queue_prefetch("first")
        slow_started.wait(timeout=2)
        # Second call while first is still running — must be a no-op.
        p.queue_prefetch("second")
        slow_release.set()
        if p._prefetch_thread:
            p._prefetch_thread.join(timeout=3)
        assert recall_calls == ["first"]

    def test_queue_prefetch_inactive_is_noop(self, hermes_home):
        p = OB1MemoryProvider()
        # Not initialized
        p.queue_prefetch("anything")
        assert p._prefetch_thread is None
        assert p._prefetch_cache is None

    def test_shutdown_joins_threads_and_clears_cache(self, configured):
        p = self._patched(configured)
        p._prefetch_cache = ("q", "ctx", "r", time.monotonic())
        p.shutdown()
        assert p._prefetch_cache is None
        assert p._prefetch_thread is None


class TestSyncTurn:

    def _patched(self, configured) -> Tuple[OB1MemoryProvider, List[Dict[str, Any]]]:
        p = OB1MemoryProvider()
        p.initialize(session_id="sess", hermes_home=str(configured))
        recorded: List[Dict[str, Any]] = []

        def fake_writeback(**kwargs):
            recorded.append(kwargs)
            return {"memory_id": "m-1"}

        p._client.writeback = fake_writeback  # type: ignore[assignment]
        return p, recorded

    def test_skips_trivial_user_message(self, configured):
        p, recorded = self._patched(configured)
        p.sync_turn("ok", "long enough assistant content here")
        time.sleep(0.1)
        assert recorded == []

    def test_skips_short_assistant(self, configured):
        p, recorded = self._patched(configured)
        p.sync_turn("Real question with enough content", "k.")
        time.sleep(0.1)
        assert recorded == []

    def test_skips_when_writes_disabled(self, configured):
        p, recorded = self._patched(configured)
        p._write_enabled = False
        p.sync_turn("Real question with enough content", "Real assistant content here")
        time.sleep(0.1)
        assert recorded == []

    def test_writeback_payload_uses_outputs_category(self, configured):
        p, recorded = self._patched(configured)
        p.sync_turn(
            "Real user question with enough content",
            "Real assistant content with enough length here",
        )
        if p._sync_thread:
            p._sync_thread.join(timeout=5)
        assert len(recorded) == 1
        body = recorded[0]
        assert "outputs" in body["memory_payload"]
        assert body["task_id"] == "sess"
        assert body["runtime"]["name"] == "hermes"
        # runtime must not have extra keys
        assert set(body["runtime"].keys()) <= {"name", "version"}

    def test_writeback_strips_ob1_context_wrapper(self, configured):
        p, recorded = self._patched(configured)
        user_with_ctx = "<ob1-context>recalled\n</ob1-context>\nReal user question with content"
        p.sync_turn(user_with_ctx, "Real assistant content with enough length")
        if p._sync_thread:
            p._sync_thread.join(timeout=5)
        body = recorded[0]
        for line in body["memory_payload"].get("outputs", []):
            assert "ob1-context" not in line
            assert "recalled" not in line


class TestSessionEnd:

    def _patched(self, configured) -> Tuple[OB1MemoryProvider, List[Dict[str, Any]]]:
        p = OB1MemoryProvider()
        p.initialize(session_id="sess", hermes_home=str(configured))
        recorded: List[Dict[str, Any]] = []

        def fake_writeback(**kwargs):
            recorded.append(kwargs)
            return {"memory_id": "m"}

        p._client.writeback = fake_writeback  # type: ignore[assignment]
        return p, recorded

    def test_extracts_findings_and_writes_synchronously(self, configured):
        p, recorded = self._patched(configured)
        msgs = [
            {"role": "user", "content": "We need to fix the slow build pipeline."},
            {"role": "assistant", "content": "We decided to switch to Bun for speed."},
            {"role": "user", "content": "TODO: write the migration scripts before friday."},
        ]
        p.on_session_end(msgs)
        # synchronous — recorded immediately
        assert len(recorded) == 1
        payload = recorded[0]["memory_payload"]
        assert any("Bun" in d for d in payload.get("decisions", []))
        assert any("TODO" in n for n in payload.get("next_steps", []))

    def test_long_session_is_written_back_whole(self, configured):
        # Ten findings in each of six categories: 60 memories, past the plugin's 50 a write-back holds (it would
        # refuse the 60 whole). The client sends them in parts of ten, each under the write-back timeout.
        p = OB1MemoryProvider()
        p.initialize(session_id="sess", hermes_home=str(configured))
        sent: List[int] = []

        def fake(req, timeout=None):
            body = json.loads(req.data.decode("utf-8"))
            sent.append(sum(len(v) for k, v in body["memory_payload"].items() if k != "entities"))
            return _mock_urlopen_response({"memories": []})

        lines = []
        for i in range(10):
            lines += [f"We decided to use tool number {i} for the job.", f"Lesson learned: check item {i} before the release.",
                      f"The deploy job is capped at {i} parallel runners.", f"TODO: write the migration script part {i} soon.",
                      f"It is unclear whether option {i} still works.", f"The build failed because of module {i} again."]
        with patch("urllib.request.urlopen", fake):
            p.on_session_end([{"role": "assistant", "content": line} for line in lines])
        assert sent == [10] * 6, sent

    def test_exit_waits_one_deadline_and_logs_what_was_cut(self, configured, monkeypatch, caplog):
        # Session end and shutdown share one deadline (the write-back timeout from the first of them): a long
        # session's parts stop at it, and what was not sent is logged at warning.
        clock = [1000.0]
        monkeypatch.setattr(ob1_module.time, "monotonic", lambda: clock[0])
        p = OB1MemoryProvider()
        p.initialize(session_id="sess", hermes_home=str(configured))
        sent: List[int] = []

        def slow(req, timeout=None):
            clock[0] += 25
            body = json.loads(req.data.decode("utf-8"))
            sent.append(sum(len(v) for k, v in body["memory_payload"].items() if k != "entities"))
            return _mock_urlopen_response({"memories": [{"memory_id": "m"}] * sent[-1]})

        lines = [f"We decided to use tool number {i} for the job." for i in range(10)] + [f"Lesson learned: check item {i} before the release." for i in range(10)] \
            + [f"The build failed because of module {i} again." for i in range(10)]
        with patch("urllib.request.urlopen", slow), caplog.at_level("WARNING"):
            p.on_session_end([{"role": "assistant", "content": line} for line in lines])
            deadline = p._exit_at
            p.shutdown()
        assert deadline == 1060.0 and p._exit_at == deadline  # shutdown kept the session end's deadline
        assert sent == [10, 10, 10]  # 25 s each: the third part started at 50 s, under the 60 s deadline
        clock[0] = 1000.0
        assert not any("not written back" in r.message for r in caplog.records)
        p2 = OB1MemoryProvider()
        p2.initialize(session_id="sess", hermes_home=str(configured))
        sent.clear()

        def slower(req, timeout=None):
            clock[0] += 40
            return slow(req, timeout)

        with patch("urllib.request.urlopen", slower), caplog.at_level("WARNING"):
            p2.on_session_end([{"role": "assistant", "content": line} for line in lines])
        assert sent == [10]  # 65 s each: the first part ends past the 60 s deadline, so no other starts
        assert any("20 finding(s) not written back by the exit deadline" in r.message for r in caplog.records)

    def test_shutdown_waits_for_every_background_writeback(self, configured, caplog):
        # Every background write-back is kept, not only the latest: shutdown joins each until the exit deadline,
        # and says how many it cut.
        p = OB1MemoryProvider()
        p.initialize(session_id="sess", hermes_home=str(configured))
        quick_done = threading.Event()
        hold = threading.Event()
        p._start_writeback(lambda: (time.sleep(0.05), quick_done.set()), "w1")
        p._start_writeback(lambda: hold.wait(5), "w2")
        p._exit_at = time.monotonic() + 0.3
        with caplog.at_level("WARNING"):
            p.shutdown()
        hold.set()
        assert quick_done.is_set()
        assert any("1 background write-back(s) still running at the exit deadline" in r.message for r in caplog.records)
        assert p._writeback_threads == []

    def test_shutdown_waits_for_an_earlier_writeback_too(self, configured):
        # A write-back that outlives the 2 s a later one gives it is still kept: shutdown waits for it, not only the latest.
        p = OB1MemoryProvider()
        p.initialize(session_id="sess", hermes_home=str(configured))
        earlier_done = threading.Event()
        p._start_writeback(lambda: (time.sleep(2.4), earlier_done.set()), "w1")
        p._start_writeback(lambda: None, "w2")  # waits 2 s for w1, which is still running after
        p._exit_at = time.monotonic() + 2.0
        p.shutdown()
        assert earlier_done.is_set()

    def test_skips_when_inactive(self, configured, monkeypatch):
        monkeypatch.delenv("OPENBRAIN_KEY", raising=False)
        p = OB1MemoryProvider()
        p.initialize(session_id="s", hermes_home=str(configured))
        # Active should be False without key
        assert p._active is False
        p.on_session_end([{"role": "user", "content": "We decided to do X."}])
        # Should not crash — no client to call


class TestPreCompress:

    def test_returns_summary_string_with_findings(self, configured):
        p = OB1MemoryProvider()
        p.initialize(session_id="sess", hermes_home=str(configured))
        recorded: List[Dict[str, Any]] = []

        def fake_writeback(**kwargs):
            recorded.append(kwargs)
            return {"memory_id": "m"}

        p._client.writeback = fake_writeback  # type: ignore[assignment]
        msgs = [
            {"role": "assistant", "content": "We decided to use Postgres for the queue."},
        ]
        out = p.on_pre_compress(msgs)
        assert "Decisions" in out
        assert "Postgres" in out
        # Background writeback should fire
        if p._sync_thread:
            p._sync_thread.join(timeout=5)
        assert len(recorded) == 1

    def test_returns_empty_when_no_findings(self, configured):
        p = OB1MemoryProvider()
        p.initialize(session_id="s", hermes_home=str(configured))
        # Trivial messages with no extractable findings
        out = p.on_pre_compress([{"role": "user", "content": "ok"}])
        assert out == ""


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


class TestTools:

    @pytest.fixture
    def active(self, configured) -> OB1MemoryProvider:
        p = OB1MemoryProvider()
        p.initialize(session_id="sess", hermes_home=str(configured))
        return p

    def test_returns_seven_schemas(self, active):
        names = {s["name"] for s in active.get_tool_schemas()}
        expected = {
            "ob1_recall", "ob1_writeback", "ob1_search",
            "ob1_report_usage", "ob1_list_review_queue",
            "ob1_review_memory", "ob1_get_recall_trace",
        }
        assert names == expected

    def test_unknown_tool_returns_error(self, active):
        out = active.handle_tool_call("ob1_nonsense", {})
        assert "Unknown tool" in out

    def test_tool_call_when_inactive_returns_error(self, hermes_home):
        p = OB1MemoryProvider()
        out = p.handle_tool_call("ob1_recall", {"query": "x"})
        assert "not configured" in out

    def test_recall_routes_to_client(self, active):
        with patch.object(active._client, "recall", return_value={"request_id": "r1", "memories": []}) as mock:
            out = active.handle_tool_call("ob1_recall", {"query": "find me"})
        assert mock.called
        kwargs = mock.call_args.kwargs
        assert kwargs["query"] == "find me"
        assert kwargs["task_type"] == "general"
        assert active._last_request_id == "r1"
        assert json.loads(out)["request_id"] == "r1"

    def test_recall_requires_query(self, active):
        out = active.handle_tool_call("ob1_recall", {})
        assert "query is required" in out

    def test_writeback_maps_memory_type_to_category(self, active):
        with patch.object(active._client, "writeback", return_value={"memory_id": "m1"}) as mock:
            active.handle_tool_call("ob1_writeback", {
                "summary": "Avoid mocking Postgres in tests.",
                "memory_type": "lesson",
            })
        body = mock.call_args.kwargs
        assert "lessons" in body["memory_payload"]
        assert body["memory_payload"]["lessons"]

    def test_writeback_default_to_outputs(self, active):
        with patch.object(active._client, "writeback", return_value={"memory_id": "m"}) as mock:
            active.handle_tool_call("ob1_writeback", {"summary": "Some summary content."})
        body = mock.call_args.kwargs
        # default memory_type is "lesson" so it maps to lessons
        assert "lessons" in body["memory_payload"]

    def test_writeback_unknown_type_falls_back_to_outputs(self, active):
        with patch.object(active._client, "writeback", return_value={"memory_id": "m"}) as mock:
            active.handle_tool_call("ob1_writeback", {
                "summary": "Some summary.",
                "memory_type": "completely_unknown_type",
            })
        body = mock.call_args.kwargs
        assert "outputs" in body["memory_payload"]

    def test_writeback_requires_summary_or_content(self, active):
        out = active.handle_tool_call("ob1_writeback", {})
        assert "summary or content is required" in out

    def test_report_usage_uses_last_request_id_when_omitted(self, active):
        active._last_request_id = "req-cached"
        with patch.object(active._client, "report_usage", return_value={"ok": True}) as mock:
            active.handle_tool_call("ob1_report_usage", {"used": ["m1"], "ignored": ["m2"]})
        assert mock.call_args.args[0] == "req-cached"

    def test_review_memory_validates_action(self, active):
        out = active.handle_tool_call("ob1_review_memory", {"memory_id": "m", "action": "bogus"})
        assert "Invalid action" in out

    def test_review_memory_passes_through(self, active):
        with patch.object(active._client, "review_memory", return_value={"ok": True}) as mock:
            active.handle_tool_call("ob1_review_memory", {
                "memory_id": "m1", "action": "confirm", "notes": "looks good",
            })
        assert mock.call_args.args[0] == "m1"
        kwargs = mock.call_args.kwargs
        assert kwargs["action"] == "confirm"
        assert kwargs["notes"] == "looks good"
        assert kwargs["actor_label"] == "hermes:default"

    def test_review_memory_edit_needs_content_or_summary(self, active):
        with patch.object(active._client, "review_memory") as mock:
            out = active.handle_tool_call("ob1_review_memory", {"memory_id": "m1", "action": "edit"})
        assert "content, summary or both" in out
        mock.assert_not_called()
        with patch.object(active._client, "review_memory", return_value={"memory": {}}) as mock:
            active.handle_tool_call("ob1_review_memory", {"memory_id": "m1", "action": "edit", "content": "new"})
        assert mock.call_args.kwargs["content"] == "new"
        assert mock.call_args.kwargs["summary"] is None


# ---------------------------------------------------------------------------
# system_prompt_block
# ---------------------------------------------------------------------------


class TestSystemPromptBlock:

    def test_empty_when_inactive(self, hermes_home):
        p = OB1MemoryProvider()
        assert p.system_prompt_block() == ""

    def test_lists_tools_and_workspace_when_active(self, configured):
        p = OB1MemoryProvider()
        p.initialize(session_id="s", hermes_home=str(configured))
        block = p.system_prompt_block()
        assert "OpenBrain" in block
        assert "ws-test" in block
        assert "ob1_recall" in block
        assert "ob1_writeback" in block
