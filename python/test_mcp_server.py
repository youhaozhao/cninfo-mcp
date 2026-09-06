from unittest.mock import Mock

import mcp_server
from spider import QueryError


def test_query_empty_is_complete(monkeypatch):
    monkeypatch.setattr(mcp_server, "query_reports", lambda *args: [])
    result = mcp_server.query_annual_reports_tool("000001")
    assert result["success"] is True
    assert result["status"] == "complete"
    assert result["count"] == 0


def test_query_partial_reports_survive_tool_and_resource(monkeypatch):
    rows = [{"secCode": "000001", "announcementTitle": "2024年年度报告"}]
    monkeypatch.setattr(
        mcp_server,
        "query_reports",
        Mock(side_effect=QueryError(["page two failed"], rows, True)),
    )
    result = mcp_server.query_annual_reports_tool("000001")
    assert result["status"] == "partial"
    assert result["count"] == 1
    assert result["error"] == "page two failed"
    resource = mcp_server.get_annual_reports_list("000001")
    assert "Query incomplete" in resource
    assert "2024年年度报告" in resource


def test_query_outage_is_error(monkeypatch):
    monkeypatch.setattr(
        mcp_server, "query_reports", Mock(side_effect=QueryError(["offline"]))
    )
    result = mcp_server.query_annual_reports_tool("000001")
    assert result["status"] == "error"
    assert result["success"] is False
    assert "No annual reports found" not in result["message"]


def test_invalid_download_does_not_create_directory(tmp_path):
    target = tmp_path / "invalid"
    result = mcp_server.download_annual_reports_tool("", save_path=str(target))
    assert result["status"] == "error"
    assert not target.exists()
