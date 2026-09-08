import importlib.util
from pathlib import Path
from unittest.mock import Mock


def _load_probe_module():
    path = Path(__file__).resolve().parents[1] / "scripts" / "connectivity_probe.py"
    spec = importlib.util.spec_from_file_location("connectivity_probe", path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_probe_market_retries_then_succeeds(monkeypatch):
    probe = _load_probe_module()
    query = Mock(
        side_effect=[
            RuntimeError("504"),
            RuntimeError("502"),
            [{"dummy": 1}],
            [],
        ]
    )
    sleep = Mock()
    monkeypatch.setattr(probe.spider, "query_annual_reports", query)
    monkeypatch.setattr(probe.time, "sleep", sleep)

    ok, details = probe.probe_market(
        ["600519", "601398"], attempts=2, retry_delay=0
    )

    assert ok is True
    assert details == ["600519=1", "601398=0"]
    assert query.call_count == 4
    sleep.assert_called_once_with(0)


def test_probe_market_exhausts_attempts(monkeypatch):
    probe = _load_probe_module()
    query = Mock(side_effect=[RuntimeError("504")] * 4)
    sleep = Mock()
    monkeypatch.setattr(probe.spider, "query_annual_reports", query)
    monkeypatch.setattr(probe.time, "sleep", sleep)

    ok, details = probe.probe_market(
        ["600519", "601398"], attempts=2, retry_delay=0
    )

    assert ok is False
    assert len(details) == 2
    assert all("!ERR(504)" in item for item in details)
    assert query.call_count == 4
    sleep.assert_called_once_with(0)
