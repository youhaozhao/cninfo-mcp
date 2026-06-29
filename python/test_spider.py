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
