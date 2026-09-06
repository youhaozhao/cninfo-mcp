"""
spider.py 纯逻辑单元测试（无网络）。

覆盖标题匹配、报告类型归一化、年份匹配等核心逻辑——这些是功能的关键且
对巨潮标题格式变动较敏感，最值得用快速、离线的测试守护。

运行：python -m pytest python/test_spider.py -q
"""

import pytest

from spider import (
    _is_report_title,
    _matches_year,
    normalize_report_type,
    supported_report_types,
)


# ---------------------------------------------------------------------------
# normalize_report_type
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "raw,expected",
    [
        ("annual", "annual"),
        ("Annual", "annual"),
        ("年报", "annual"),
        ("年度报告", "annual"),
        ("ndbg", "annual"),
        ("SEMI_ANNUAL", "semiannual"),
        ("半年报", "semiannual"),
        ("中报", "semiannual"),
        (" 中报 ", "semiannual"),
        ("q1", "q1"),
        ("一季报", "q1"),
        ("Q3", "q3"),
        ("三季报", "q3"),
        ("IPO", "prospectus"),
        ("招股书", "prospectus"),
        (None, "annual"),
        ("", "annual"),
    ],
)
def test_normalize_report_type(raw, expected):
    assert normalize_report_type(raw) == expected


def test_normalize_report_type_invalid_raises():
    with pytest.raises(ValueError) as exc:
        normalize_report_type("xyz")
    # 报错应列出支持的取值，便于调用方修正
    assert "annual" in str(exc.value)


def test_supported_report_types_keys():
    assert set(supported_report_types()) == {
        "annual",
        "semiannual",
        "q1",
        "q3",
        "prospectus",
    }


# ---------------------------------------------------------------------------
# _is_report_title —— 正例
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "title,report_type",
    [
        ("贵州茅台2023年年度报告", "annual"),
        ("某公司2023年度报告", "annual"),
        ("某公司2023年年度报告（更新后）", "annual"),
        ("平安银行2023年半年度报告", "semiannual"),
        ("某公司2023年中期报告", "semiannual"),
        ("贵州茅台2024年第一季度报告", "q1"),
        ("某公司2024年一季度报告", "q1"),
        ("平安银行2023年第三季度报告", "q3"),
        ("某公司2023年三季度报告", "q3"),
        ("中科德芯招股说明书", "prospectus"),
        ("某公司招股意向书", "prospectus"),
    ],
)
def test_is_report_title_positive(title, report_type):
    assert _is_report_title(title, report_type) is True


# ---------------------------------------------------------------------------
# _is_report_title —— 摘要/更正等变体应被排除（含招股书，回归 #2）
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "title,report_type",
    [
        ("贵州茅台2023年年度报告摘要", "annual"),
        ("某公司2023年年度报告（更正）", "annual"),
        ("某公司2023年半年度报告摘要", "semiannual"),
        ("某公司2024年第一季度报告（修订）", "q1"),
        # 回归 #2：招股书的摘要/更正变体此前会被误判为正文
        ("中科德芯招股说明书摘要", "prospectus"),
        ("某公司招股意向书更正公告", "prospectus"),
    ],
)
def test_is_report_title_excludes_variants(title, report_type):
    assert _is_report_title(title, report_type) is False


# ---------------------------------------------------------------------------
# _is_report_title —— 跨类型隔离
# ---------------------------------------------------------------------------
def test_is_report_title_cross_type_isolation():
    assert _is_report_title("某公司2024年第三季度报告", "q1") is False
    assert _is_report_title("某公司2024年第一季度报告", "q3") is False
    assert _is_report_title("某公司2023年半年度报告", "annual") is False
    assert _is_report_title("某公司2023年年度报告", "semiannual") is False


# ---------------------------------------------------------------------------
# _is_report_title —— 年份过滤
# ---------------------------------------------------------------------------
def test_is_report_title_year_filter():
    assert _is_report_title("某公司2024年年度报告", "annual", year_filter=2024) is True
    assert _is_report_title("某公司2023年年度报告", "annual", year_filter=2024) is False
    # 字符串年份同样可用
    assert (
        _is_report_title("某公司2024年年度报告", "annual", year_filter="2024") is True
    )


# ---------------------------------------------------------------------------
# _matches_year —— 招股书按 announcementTime 匹配
# ---------------------------------------------------------------------------
def test_matches_year_none_is_always_true():
    assert _matches_year({"announcementTime": "2020-05-01"}, "prospectus", None) is True


def test_matches_year_prospectus_string_date():
    ann = {"announcementTime": "2024-03-15"}
    assert _matches_year(ann, "prospectus", 2024) is True
    assert _matches_year(ann, "prospectus", 2023) is False


def test_matches_year_prospectus_epoch_ms():
    # 回归 #4：announcementTime 若为 epoch 毫秒，不应静默漏掉全部结果。
    # 2024-03-15 00:00:00 本地时区附近的毫秒时间戳。
    import datetime

    epoch_ms = int(datetime.datetime(2024, 3, 15, 12, 0, 0).timestamp() * 1000)
    ann = {"announcementTime": epoch_ms}
    assert _matches_year(ann, "prospectus", 2024) is True
    assert _matches_year(ann, "prospectus", 2023) is False


def test_matches_year_non_prospectus_uses_title():
    ann = {"announcementTitle": "某公司2024年年度报告"}
    assert _matches_year(ann, "annual", 2024) is True
    assert _matches_year(ann, "annual", 2023) is False


# Failure-path regressions use only mocked HTTP responses.
import os
from pathlib import Path
from unittest.mock import Mock

import requests
import spider


def report(url="a.pdf", code="000001"):
    return {
        "secCode": code,
        "secName": "公司",
        "announcementTitle": "2024年年度报告",
        "adjunctUrl": url,
    }


@pytest.mark.parametrize(
    "code",
    ["", "  ", None, "abc", "00001", "0000001", "SZ000001", "０００００１", "000 001"],
)
def test_invalid_stock_has_no_side_effects(monkeypatch, tmp_path, code):
    def unexpected(*args, **kwargs):
        pytest.fail("Invalid input must not make requests")

    monkeypatch.setattr(spider.requests, "post", unexpected)
    target = tmp_path / "downloads"
    with pytest.raises(ValueError, match="six ASCII digits"):
        spider.download_reports(code, save_path=str(target))
    assert not target.exists()


def test_normalized_code_scopes_query_and_filter(monkeypatch):
    seen = []

    def fetch(page, code, *args):
        seen.append(code)
        return [report(), report(code="000002")]

    monkeypatch.setattr(spider, "_query_exchange_report", fetch)
    assert spider.query_reports(" 000001 ") == [report()]
    assert seen == ["000001", "000001"]


def test_query_outage_is_not_empty_success(monkeypatch):
    monkeypatch.setattr(
        spider, "_query_exchange_report", Mock(side_effect=requests.Timeout("offline"))
    )
    with pytest.raises(spider.QueryError) as caught:
        spider.query_reports("000001")
    assert caught.value.status == "error"
    assert caught.value.reports == []
    assert len(caught.value.errors) == 2


def test_query_preserves_page_one(monkeypatch):
    rows = [report(f"{i}.pdf") for i in range(spider.PAGE_SIZE)]

    def fetch(page, code, kind, column, plate):
        if column == "szse":
            return []
        if page == 2:
            raise requests.Timeout("page two")
        return rows

    monkeypatch.setattr(spider, "_query_exchange_report", fetch)
    with pytest.raises(spider.QueryError) as caught:
        spider.query_reports("000001")
    assert caught.value.status == "partial"
    assert caught.value.reports == rows
    assert "page 2" in str(caught.value)


def test_pagination_limit_is_partial(monkeypatch):
    monkeypatch.setattr(spider, "MAX_PAGES", 1)
    with pytest.raises(spider.QueryError, match="Pagination limit") as caught:
        spider._paginate(lambda *args: [report()] * spider.PAGE_SIZE, "000001")
    assert len(caught.value.reports) == spider.PAGE_SIZE


def test_bse_resolution_failure_surfaces(monkeypatch):
    monkeypatch.setattr(spider, "_query_exchange_report", lambda *a: [])
    monkeypatch.setattr(
        spider, "_post_json", Mock(side_effect=requests.Timeout("org offline"))
    )
    with pytest.raises(spider.QueryError, match="org offline"):
        spider.query_reports("920001")


def test_bse_migrated_code_remains_allowed(monkeypatch):
    monkeypatch.setattr(spider, "_resolve_org_id", lambda code: ("920001", "org123"))

    def fetch(page, code, kind, column, plate, **kwargs):
        if column == "bj":
            assert kwargs["stock_value"] == "920001,org123"
            return [report(code="920001"), report(code="920002")]
        return []

    monkeypatch.setattr(spider, "_query_exchange_report", fetch)
    assert spider.query_reports("830001") == [report(code="920001")]


@pytest.fixture
def pdf_http(monkeypatch):
    monkeypatch.setattr(spider.time, "sleep", lambda *a: None)

    def response(body=b"%PDF-1.7\nexample", content_type="application/pdf"):
        result = Mock(
            content=body, headers={"Content-Type": content_type}, status_code=200
        )
        result.raise_for_status.return_value = None
        return result

    return response


def test_distinct_attachments_and_atomic_failure(monkeypatch, tmp_path, pdf_http):
    monkeypatch.setattr(
        spider.requests,
        "get",
        Mock(side_effect=[pdf_http(b"%PDF-first"), pdf_http(b"%PDF-second")]),
    )
    rows = [report("one.pdf"), report("two.pdf")]
    result = spider.Download(rows, save_path=str(tmp_path), details=True)
    paths = [Path(f["path"]) for f in result["files"]]
    assert result["downloaded"] == 2
    assert paths[0] != paths[1]
    assert [p.read_bytes() for p in paths] == [b"%PDF-first", b"%PDF-second"]
    monkeypatch.setattr(
        spider.requests, "get", lambda *a, **kw: pdf_http(b"%PDF-replacement")
    )
    monkeypatch.setattr(spider.os, "replace", Mock(side_effect=OSError("disk error")))
    result = spider.Download(rows[:1], save_path=str(tmp_path), details=True)
    assert result["failed"] == 1
    assert paths[0].read_bytes() == b"%PDF-first"
    assert not list(tmp_path.glob("*.tmp"))


def test_download_continues_after_failure(monkeypatch, tmp_path, pdf_http):
    monkeypatch.setattr(
        spider, "query_reports", lambda *a: [report(f"{i}.pdf") for i in range(3)]
    )
    get = Mock(
        side_effect=[pdf_http()]
        + [requests.Timeout("timeout")] * spider.MAX_RETRIES
        + [pdf_http()]
    )
    monkeypatch.setattr(spider.requests, "get", get)
    result = spider.download_reports("000001", save_path=str(tmp_path))
    assert result["downloaded"] == 2
    assert result["failed"] == 1
    assert result["status"] == "partial"
    assert result["success"] is False
    assert result["failures"][0]["adjunctUrl"] == "1.pdf"
    assert len(list(tmp_path.glob("*.pdf"))) == 2
    assert get.call_count == 2 + spider.MAX_RETRIES


@pytest.mark.parametrize(
    "body,kind",
    [
        (b"", "application/pdf"),
        (b"<html>denied</html>", "application/pdf"),
        (b"%PDF-fake", "text/html"),
    ],
)
def test_invalid_pdf_not_saved(monkeypatch, tmp_path, pdf_http, body, kind):
    get = Mock(return_value=pdf_http(body, kind))
    monkeypatch.setattr(spider.requests, "get", get)
    result = spider.Download([report()], save_path=str(tmp_path), details=True)
    assert result["downloaded"] == 0
    assert result["failed"] == 1
    assert not list(tmp_path.iterdir())
    assert get.call_count == 1


def test_partial_query_can_download_retained_reports(monkeypatch, tmp_path, pdf_http):
    monkeypatch.setattr(
        spider,
        "query_reports",
        Mock(side_effect=spider.QueryError(["page 2 failed"], [report()], True)),
    )
    monkeypatch.setattr(spider.requests, "get", lambda *a, **kw: pdf_http())
    result = spider.download_reports("000001", save_path=str(tmp_path))
    assert result["downloaded"] == 1
    assert result["query_status"] == result["status"] == "partial"
    assert result["query_errors"] == ["page 2 failed"]


@pytest.mark.parametrize(
    "title",
    [
        "保荐机构关于招股说明书的核查意见",
        "关于招股说明书",
        "律师对招股说明书的验证报告",
        "招股说明书问询回复",
        "招股说明书（核查意见）",
    ],
)
def test_prospectus_supporting_documents_excluded(title):
    assert not spider._is_report_title(title, "prospectus")


@pytest.mark.parametrize("suffix", ["", "（申报稿）", "（注册稿）", "(上会稿)"])
def test_prospectus_document_versions(suffix):
    assert spider._is_report_title(
        "某公司首次公开发行股票并上市招股说明书" + suffix, "prospectus"
    )


@pytest.mark.skipif(not hasattr(spider.time, "tzset"), reason="tzset unavailable")
@pytest.mark.parametrize("zone", ["Asia/Shanghai", "UTC", "America/Edmonton"])
def test_prospectus_china_new_year(monkeypatch, zone):
    previous = os.environ.get("TZ")
    try:
        os.environ["TZ"] = zone
        spider.time.tzset()
        # 2024-01-01 00:00:00 at UTC+08:00, independent of host timezone.
        assert spider._matches_year(
            {"announcementTime": 1704038400000}, "prospectus", 2024
        )
        assert not spider._matches_year(
            {"announcementTime": 1704038399999}, "prospectus", 2024
        )
    finally:
        if previous is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = previous
        spider.time.tzset()


@pytest.mark.parametrize(
    "status,attempts,downloaded", [(404, 1, 0), (429, 2, 1), (503, 2, 1)]
)
def test_download_http_retry_policy(
    monkeypatch, tmp_path, pdf_http, status, attempts, downloaded
):
    bad = requests.Response()
    bad.status_code = status
    bad._content = b"error"
    bad._content_consumed = True
    get = Mock(side_effect=[bad, pdf_http()])
    monkeypatch.setattr(spider.requests, "get", get)
    result = spider.Download([report()], save_path=str(tmp_path), details=True)
    assert get.call_count == attempts
    assert result["downloaded"] == downloaded


def test_download_empty_query_is_complete(monkeypatch, tmp_path):
    monkeypatch.setattr(spider, "query_reports", lambda *args: [])
    target = tmp_path / "absent"
    result = spider.download_reports("000001", save_path=str(target))
    assert result["success"] is True
    assert result["status"] == "complete"
    assert result["downloaded"] == result["failed"] == 0
    assert not target.exists()


@pytest.mark.parametrize(
    "value",
    [
        "folder/report.pdf",
        "/folder/report.pdf",
        "https://static.cninfo.com.cn/folder/report.pdf",
        "//static.cninfo.com.cn/folder/report.pdf",
    ],
)
def test_attachment_urls_shared_by_format_and_download(
    monkeypatch, tmp_path, pdf_http, value
):
    expected = "https://static.cninfo.com.cn/folder/report.pdf"
    assert spider.format_reports([report(value)])[0]["adjunctUrl"] == expected
    get = Mock(return_value=pdf_http())
    monkeypatch.setattr(spider.requests, "get", get)
    assert spider.Download([report(value)], save_path=str(tmp_path)) == 1
    assert get.call_args.args[0] == expected
    assert get.call_args.kwargs["allow_redirects"] is False


@pytest.mark.parametrize(
    "value",
    [
        "https://example.org/report.pdf",
        "//127.0.0.1/report.pdf",
        "https://static.cninfo.com.cn.example.org/report.pdf",
        "https://static.cninfo.com.cn@evil.example/report.pdf",
        "https://user@static.cninfo.com.cn/report.pdf",
        "https://static.cninfo.com.cn:8443/report.pdf",
        "http://static.cninfo.com.cn/report.pdf",
        "file:///etc/passwd",
        "https://static.cninfo.com.cn\\@evil.example/report.pdf",
        "https://static.cninfo.com.cn/\nreport.pdf",
    ],
)
def test_unsafe_attachment_never_requested_or_linked(monkeypatch, tmp_path, value):
    get = Mock(side_effect=AssertionError("must not request unsafe URL"))
    monkeypatch.setattr(spider.requests, "get", get)
    formatted = spider.format_reports([report(value)])[0]
    assert formatted["adjunctUrl"] == ""
    assert formatted["attachmentError"]
    result = spider.Download([report(value)], save_path=str(tmp_path), details=True)
    assert result["failed"] == 1
    assert result["downloaded"] == 0
    get.assert_not_called()


@pytest.mark.parametrize(
    "location",
    [
        "https://evil.example/a.pdf",
        "//127.0.0.1/a.pdf",
        "http://static.cninfo.com.cn/a.pdf",
        "",
    ],
)
def test_redirect_rejected_before_following(monkeypatch, pdf_http, location):
    redirect = Mock(status_code=302, headers={"Location": location})
    get = Mock(return_value=redirect)
    monkeypatch.setattr(spider.requests, "get", get)
    with pytest.raises(ValueError):
        spider._fetch_pdf("https://static.cninfo.com.cn/a.pdf")
    assert get.call_count == 1
    assert get.call_args.kwargs["allow_redirects"] is False
    redirect.close.assert_called_once()


def test_safe_relative_redirects_and_later_unsafe_hop(monkeypatch, pdf_http):
    first = Mock(status_code=302, headers={"Location": "../new.pdf"})
    good = pdf_http()
    get = Mock(side_effect=[first, good])
    monkeypatch.setattr(spider.requests, "get", get)
    assert spider._fetch_pdf("https://static.cninfo.com.cn/folder/a.pdf").startswith(
        b"%PDF-"
    )
    assert get.call_args_list[1].args[0] == "https://static.cninfo.com.cn/new.pdf"
    first.close.assert_called_once()
    good.close.assert_called_once()
    second = Mock(status_code=307, headers={"Location": "https://evil.example/a.pdf"})
    get.reset_mock(side_effect=True)
    get.side_effect = [first, second]
    with pytest.raises(ValueError):
        spider._fetch_pdf("https://static.cninfo.com.cn/folder/a.pdf")
    assert get.call_count == 2
    second.close.assert_called_once()


def test_redirect_loop_is_bounded(monkeypatch, pdf_http):
    response = Mock(status_code=308, headers={"Location": "/loop.pdf"})
    get = Mock(return_value=response)
    monkeypatch.setattr(spider.requests, "get", get)
    with pytest.raises(ValueError, match="Too many"):
        spider._fetch_pdf("loop.pdf")
    assert get.call_count == 6
    assert response.close.call_count == 6
