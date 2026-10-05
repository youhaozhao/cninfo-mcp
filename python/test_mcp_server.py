import asyncio
import os
from unittest.mock import Mock

import pytest

import mcp_server
from spider import QueryError


@pytest.fixture
def download_root(tmp_path, monkeypatch):
    root = tmp_path / "root"
    monkeypatch.setenv(mcp_server.DOWNLOAD_DIR_ENV, str(root))
    return root


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


def test_invalid_download_does_not_create_directory(download_root):
    target = download_root / "invalid"
    result = mcp_server.download_annual_reports_tool("", save_path=str(target))
    assert result["status"] == "error"
    assert "six ASCII digits" in result["error"]
    assert not download_root.exists()


def test_tool_annotations_declare_read_and_write_boundaries():
    tools = {
        tool.name: tool.model_dump(by_alias=True)["annotations"]
        for tool in asyncio.run(mcp_server.mcp.list_tools())
    }
    query = tools["query_annual_reports_tool"]
    assert query["readOnlyHint"] is True
    assert query["destructiveHint"] is False
    download = tools["download_annual_reports_tool"]
    assert download["readOnlyHint"] is False
    assert download["destructiveHint"] is False


def test_default_download_root_is_under_home(tmp_path, monkeypatch):
    monkeypatch.delenv(mcp_server.DOWNLOAD_DIR_ENV, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    expected = os.path.realpath(tmp_path / "Downloads" / "cninfo-mcp")
    assert mcp_server._download_root() == expected


@pytest.mark.parametrize("save_path", [None, "", "  "])
def test_download_defaults_to_download_root(download_root, monkeypatch, save_path):
    download = Mock(return_value={"status": "complete"})
    monkeypatch.setattr(mcp_server, "download_reports", download)
    mcp_server.download_annual_reports_tool("000001", save_path=save_path)
    assert download.call_args.kwargs["save_path"] == os.path.realpath(download_root)


@pytest.mark.parametrize("save_path", ["annual/2024", "{root}/annual/2024"])
def test_download_accepts_save_path_inside_root(download_root, monkeypatch, save_path):
    download = Mock(return_value={"status": "complete"})
    monkeypatch.setattr(mcp_server, "download_reports", download)
    mcp_server.download_annual_reports_tool(
        "000001", save_path=save_path.format(root=download_root)
    )
    expected = os.path.realpath(download_root / "annual" / "2024")
    assert download.call_args.kwargs["save_path"] == expected


@pytest.mark.parametrize(
    "save_path", ["..", "../outside", "annual/../../outside", "{outside}"]
)
def test_download_rejects_save_path_outside_root(
    download_root, tmp_path, monkeypatch, save_path
):
    download = Mock()
    monkeypatch.setattr(mcp_server, "download_reports", download)
    outside = tmp_path / "outside"
    result = mcp_server.download_annual_reports_tool(
        "000001", save_path=save_path.format(outside=outside)
    )
    assert result["status"] == "error"
    assert "download directory" in result["error"]
    assert result["path"] == os.path.realpath(download_root)
    download.assert_not_called()
    assert not outside.exists()
    assert not download_root.exists()


def test_download_rejects_symlink_escaping_root(download_root, tmp_path, monkeypatch):
    download = Mock()
    monkeypatch.setattr(mcp_server, "download_reports", download)
    outside = tmp_path / "outside"
    outside.mkdir()
    download_root.mkdir()
    try:
        (download_root / "link").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are not available")
    result = mcp_server.download_annual_reports_tool("000001", save_path="link/sub")
    assert result["status"] == "error"
    assert "download directory" in result["error"]
    download.assert_not_called()
    assert not (outside / "sub").exists()
