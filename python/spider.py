"""
从巨潮资讯查询和下载上市公司定期报告、招股书
"""

import datetime
import hashlib
import logging
import os
import random
import re
import tempfile
import time
from typing import Optional, Union
from urllib.parse import urljoin, urlsplit, urlunsplit

import requests

download_path = "https://static.cninfo.com.cn/"
# 使用脚本所在目录的相对路径
_saving_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pdf")
saving_path = _saving_path + "/"
logger = logging.getLogger(__name__)

# 巨潮资讯历史公告的实际下限约为 2001 会计年度，再往前查询无数据返回。
EARLIEST_DATE = "2001-01-01"
# 接口单页最大返回条数
PAGE_SIZE = 30
# 翻页安全上限，防止异常情况下无限循环
MAX_PAGES = 100
# 巨潮搜索联想接口：把股票代码/简称解析为 orgId（北交所查询必需）
TOP_SEARCH_URL = "http://www.cninfo.com.cn/new/information/topSearch/query"
# 公告查询接口
QUERY_URL = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
# 瞬时失败（网络抖动/限流）的重试次数与退避基数（秒）
MAX_RETRIES = 3
RETRY_BACKOFF = 1.0


REPORT_TYPE_ALIASES = {
    "annual": "annual",
    "annual_report": "annual",
    "yearly": "annual",
    "ndbg": "annual",
    "年报": "annual",
    "年度报告": "annual",
    "semiannual": "semiannual",
    "semi_annual": "semiannual",
    "half_year": "semiannual",
    "half-year": "semiannual",
    "bndbg": "semiannual",
    "半年度报告": "semiannual",
    "半年报": "semiannual",
    "中报": "semiannual",
    "q1": "q1",
    "first_quarter": "q1",
    "yjdbg": "q1",
    "一季报": "q1",
    "第一季度报告": "q1",
    "q3": "q3",
    "third_quarter": "q3",
    "sjdbg": "q3",
    "三季报": "q3",
    "第三季度报告": "q3",
    "prospectus": "prospectus",
    "ipo": "prospectus",
    "招股书": "prospectus",
    "招股说明书": "prospectus",
    "招股意向书": "prospectus",
}


REPORT_TYPE_SPECS = {
    "annual": {
        "label": "年度报告",
        "category": "category_ndbg_szsh",
        "patterns": [
            r".*{year}年年度报告{suffix}",
            r".*{year}年度报告{suffix}",
            r".*{year}年报{suffix}",
        ],
    },
    "semiannual": {
        "label": "半年度报告",
        "category": "category_bndbg_szsh",
        "patterns": [
            r".*{year}年半年度报告{suffix}",
            r".*{year}半年度报告{suffix}",
            r".*{year}年中期报告{suffix}",
        ],
    },
    "q1": {
        "label": "第一季度报告",
        "category": "category_yjdbg_szsh",
        "patterns": [
            r".*{year}年第一季度报告{suffix}",
            r".*{year}第一季度报告{suffix}",
            r".*{year}年一季度报告{suffix}",
            r".*{year}一季度报告{suffix}",
        ],
    },
    "q3": {
        "label": "第三季度报告",
        "category": "category_sjdbg_szsh",
        "patterns": [
            r".*{year}年第三季度报告{suffix}",
            r".*{year}第三季度报告{suffix}",
            r".*{year}年三季度报告{suffix}",
            r".*{year}三季度报告{suffix}",
        ],
    },
    "prospectus": {
        "label": "招股书",
        "category": "",
        "keywords": ["招股书", "招股说明书", "招股意向书"],
    },
}


COMMON_EXCLUDE_KEYWORDS = [
    "摘要",
    "确认意见",
    "取消",
    "更正",
    "补充",
    "说明",
    "提示",
    "致歉",
    "修订",
    "英文",
]


User_Agent = [
    "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Win64; x64; Trident/5.0; .NET CLR 3.5.30729; .NET CLR 3.0.30729; .NET CLR 2.0.50727; Media Center PC 6.0)",
    "Mozilla/5.0 (compatible; MSIE 8.0; Windows NT 6.0; Trident/4.0; WOW64; Trident/4.0; SLCC2; .NET CLR 2.0.50727; .NET CLR 3.5.30729; .NET CLR 3.0.30729; .NET CLR 1.0.3705; .NET CLR 1.1.4322)",
    "Mozilla/4.0 (compatible; MSIE 7.0b; Windows NT 5.2; .NET CLR 1.1.4322; .NET CLR 2.0.50727; InfoPath.2; .NET CLR 3.0.04506.30)",
    "Mozilla/5.0 (Windows; U; Windows NT 5.1; zh-CN) AppleWebKit/523.15 (KHTML, like Gecko, Safari/419.3) Arora/0.3 (Change: 287 c9dfb30)",
    "Mozilla/5.0 (X11; U; Linux; en-US) AppleWebKit/527+ (KHTML, like Gecko, Safari/419.3) Arora/0.6",
    "Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US; rv:1.8.1.2pre) Gecko/20070215 K-Ninja/2.1.1",
    "Mozilla/5.0 (Windows; U; Windows NT 5.1; zh-CN; rv:1.9) Gecko/20080705 Firefox/3.0 Kapiko/3.0",
]


BASE_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-HK;q=0.6,zh-TW;q=0.5",
    "Host": "www.cninfo.com.cn",
    "Origin": "http://www.cninfo.com.cn",
    "Referer": "http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice",
    "X-Requested-With": "XMLHttpRequest",
}


def supported_report_types() -> dict:
    """返回当前支持的报告类型。"""
    return {key: spec["label"] for key, spec in REPORT_TYPE_SPECS.items()}


def normalize_report_type(report_type: Optional[str]) -> str:
    """把英文/中文别名规范化为内部报告类型。"""
    key = str(report_type or "annual").strip().lower().replace(" ", "_")
    normalized = REPORT_TYPE_ALIASES.get(key)
    if normalized is None:
        supported = ", ".join(supported_report_types().keys())
        raise ValueError(
            f"Unsupported report_type '{report_type}'. Supported: {supported}"
        )
    return normalized


def normalize_stock_code(stock_code) -> str:
    """Require a six-digit security code; preserve leading zeroes."""
    code = str(stock_code).strip()
    if not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("stock_code must contain exactly six ASCII digits")
    return code


class QueryError(RuntimeError):
    """An incomplete query, optionally carrying already fetched reports."""

    def __init__(self, errors, reports=None, partial=False):
        self.errors = errors
        self.reports = reports or []
        self.status = "partial" if partial else "error"
        super().__init__("; ".join(errors))


def resolve_attachment_url(value: str, base: str = download_path) -> str:
    """Resolve attachment paths, allowing only HTTPS on CNINFO's static host."""
    if (
        not isinstance(value, str)
        or not value
        or re.search(r"[\s\\\x00-\x1f\x7f]", value)
    ):
        raise ValueError("Invalid attachment URL")
    parsed = urlsplit(urljoin(base, value))
    if (
        parsed.scheme != "https"
        or parsed.hostname != "static.cninfo.com.cn"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
    ):
        raise ValueError("Attachment URLs must use https://static.cninfo.com.cn")
    return urlunsplit(
        ("https", "static.cninfo.com.cn", parsed.path or "/", parsed.query, "")
    )


def format_reports(reports: list) -> list:
    """提取公告中稳定、有用的字段，并把附件路径补全为可访问的绝对 URL。

    放在 spider.py 是为了紧邻 download_path 前缀定义，避免调用方各自
    硬编码一份基址。
    """
    formatted = []
    for report in reports:
        adj = report.get("adjunctUrl", "")
        attachment_error = None
        try:
            url = resolve_attachment_url(adj) if adj else ""
        except ValueError as exc:
            url = ""
            attachment_error = str(exc)
        formatted.append(
            {
                "announcementTitle": report.get("announcementTitle", ""),
                "announcementTime": report.get("announcementTime", ""),
                "secCode": report.get("secCode", ""),
                "secName": report.get("secName", ""),
                "adjunctUrl": url,
            }
        )
        if attachment_error:
            formatted[-1]["attachmentError"] = attachment_error
    return formatted


def _build_headers() -> dict:
    """构造请求头，避免在并发场景下修改全局字典。"""
    headers = BASE_HEADERS.copy()
    headers["User-Agent"] = random.choice(User_Agent)
    return headers


def _post_json(url: str, data: dict) -> dict:
    """POST 请求并解析 JSON，仅对可重试的瞬时失败按指数退避重试。

    巨潮接口在批量/高频访问下会偶发超时或限流，导致本可成功的查询失败。
    可重试：网络异常（超时/连接错误）、5xx、429，以及空/截断响应导致的
    JSON 解析失败（requests 会抛 JSONDecodeError，实测多为限流时返回空体）。
    不可重试：4xx（除 429）等客户端错误，快速失败，避免无谓的退避等待。
    重试用尽后抛出最后一次异常，交由调用方的 try/except 记录并降级。
    """
    last_exc = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(url, headers=_build_headers(), data=data, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code if e.response is not None else None
            # 4xx（429 除外）不会自愈，立即失败，不浪费退避等待
            if status is not None and status != 429 and 400 <= status < 500:
                raise
            last_exc = e
        except requests.exceptions.RequestException as e:
            # 网络异常 + JSONDecodeError（空/截断响应，多为瞬时限流）
            last_exc = e
        if attempt < MAX_RETRIES - 1:
            time.sleep(RETRY_BACKOFF * (2**attempt) + random.random())
    if last_exc is not None:
        raise last_exc
    raise RuntimeError(f"_post_json 未执行任何请求（MAX_RETRIES={MAX_RETRIES}）")


def _query_announcements(query: dict) -> list:
    """调用公告查询接口并返回 announcements 列表（带重试）。"""
    result = _post_json(QUERY_URL, query)
    if not isinstance(result, dict) or "announcements" not in result:
        raise ValueError("Invalid announcement response")
    items = result["announcements"]
    if items is not None and not isinstance(items, list):
        raise ValueError("Invalid announcements list")
    return items or []


def _is_bse_code(stock_code) -> bool:
    """判断是否为北交所代码。

    北交所代码段：4xxxxx / 8xxxxx（原新三板平移），以及 92xxxx 标准段
    （920，2024-04 起启用，预留 920-929）。这里特意只匹配 92 而非整个 9
    开头，以排除沪市 B 股 900xxx，避免为其多发一次无效的北交所查询。
    """
    digits = re.sub(r"\D", "", str(stock_code or ""))
    return digits[:1] in ("4", "8") or digits[:2] == "92"


def _resolve_org_id(stock_code) -> Optional[tuple]:
    """通过巨潮搜索联想接口把股票代码解析为 (code, orgId)。

    北交所的 hisAnnouncement 接口不接受 searchkey 或裸代码，必须以
    stock="代码,orgId" 的形式查询，因此需要先解析 orgId。
    优先返回 code 完全等于输入的条目；找不到精确匹配则取第一条
    （同一公司新旧代码共用同一 orgId）。无结果返回 None。
    """
    hits = _post_json(TOP_SEARCH_URL, {"keyWord": stock_code, "maxNum": 10})
    if not isinstance(hits, list):
        raise ValueError("Invalid orgId response")
    if not hits:
        return None

    target = re.sub(r"\D", "", str(stock_code or ""))
    for it in hits:
        if str(it.get("code")) == target and it.get("orgId"):
            return str(it.get("code")), str(it.get("orgId"))
    first = hits[0]
    if first.get("orgId"):
        return str(first.get("code")), str(first.get("orgId"))
    return None


def _date_range(start_date: str) -> str:
    """构造查询时间区间，结束日期取当天，避免硬编码过期。"""
    datetime.datetime.strptime(start_date, "%Y-%m-%d")
    today = datetime.date.today().strftime("%Y-%m-%d")
    return f"{start_date}~{today}"


def _paginate(fetch_fn, stock):
    """
    对单页查询函数翻页，汇总所有页的公告。

    巨潮接口单页最多返回 PAGE_SIZE 条，放开时间区间后历史年报会跨越多页，
    必须翻页才能取全。以“返回数量不足一页”作为终止条件，并设安全上限。
    """
    all_items = []
    for page in range(1, MAX_PAGES + 1):
        try:
            items = fetch_fn(page, stock)
        except Exception as exc:
            raise QueryError([f"page {page}: {exc}"], all_items, page > 1) from exc
        if not items:
            break
        all_items.extend(items)
        if len(items) < PAGE_SIZE:
            break
    else:
        raise QueryError([f"Pagination limit reached ({MAX_PAGES})"], all_items, True)
    return all_items


def _compact_title(title: str) -> str:
    return re.sub(r"\s+", "", title or "")


def _is_report_title(
    title: str,
    report_type: str,
    year_filter: Optional[Union[int, str]] = None,
) -> bool:
    """判断标题是否为指定报告类型的正文。"""
    compact_title = _compact_title(title)
    normalized_type = normalize_report_type(report_type)
    spec = REPORT_TYPE_SPECS[normalized_type]

    if normalized_type == "prospectus":
        # Historical version labels vary; filter document kind below instead
        # of restricting prospectus versions to a fixed suffix vocabulary.
        match = re.fullmatch(
            r".*?(?:招股说明书|招股意向书|招股书)(?:\([^()（）]+\)|（[^()（）]+）)*",
            compact_title,
        )
        if not match:
            return False
        remainder = re.sub(r"招股说明书|招股意向书|招股书", "", compact_title)
        excluded = COMMON_EXCLUDE_KEYWORDS + [
            "关于",
            "意见",
            "核查",
            "验证",
            "问询",
            "回复",
            "公告",
            "审计报告",
            "附件",
            "附录",
        ]
        return not any(kw in remainder for kw in excluded)

    # 摘要/更正/修订等非正文变体应排除
    if any(keyword in compact_title for keyword in COMMON_EXCLUDE_KEYWORDS):
        return False

    year_expr = re.escape(str(year_filter)) if year_filter is not None else r"\d{4}"
    suffix_expr = r"(?:[（(]更新后[)）])?"
    patterns = [
        pattern.format(year=year_expr, suffix=suffix_expr)
        for pattern in spec["patterns"]
    ]
    return any(re.fullmatch(pattern, compact_title) for pattern in patterns)


def _is_annual_report_title(
    title: str, year_filter: Optional[Union[int, str]] = None
) -> bool:
    """兼容旧调用：判断标题是否为年度报告正文。"""
    return _is_report_title(title, "annual", year_filter=year_filter)


def _matches_year(
    announcement: dict, report_type: str, year: Optional[Union[int, str]]
):
    if year is None:
        return True
    normalized_type = normalize_report_type(report_type)
    if normalized_type == "prospectus":
        announcement_time = announcement.get("announcementTime", "")
        # announcementTime 通常是 "YYYY-MM-DD" 字符串；个别接口可能返回 epoch 毫秒
        if isinstance(announcement_time, (int, float)):
            announcement_time = datetime.datetime.fromtimestamp(
                announcement_time / 1000,
                tz=datetime.timezone(datetime.timedelta(hours=8)),
            ).strftime("%Y-%m-%d")
        return str(announcement_time).startswith(str(year))
    return _is_report_title(
        announcement.get("announcementTitle", ""), normalized_type, year_filter=year
    )


def _build_report_query(
    page: int,
    stock_code: str,
    report_type: str,
    column: str,
    plate: str,
    stock_value: str = "",
) -> dict:
    normalized_type = normalize_report_type(report_type)
    spec = REPORT_TYPE_SPECS[normalized_type]

    if normalized_type == "prospectus":
        searchkey = "招股" if stock_value else f"{stock_code} 招股"
    else:
        searchkey = "" if stock_value else stock_code

    return {
        "pageNum": page,
        "pageSize": PAGE_SIZE,
        "tabName": "fulltext",
        "column": column,
        "stock": stock_value,
        "searchkey": searchkey,
        "secid": "",
        "plate": plate,
        "category": spec["category"],
        "trade": "",
        "seDate": _date_range(EARLIEST_DATE),
    }


def _query_exchange_report(
    page: int,
    stock_code: str,
    report_type: str,
    column: str,
    plate: str,
    stock_value: str = "",
) -> list:
    query = _build_report_query(
        page=page,
        stock_code=stock_code,
        report_type=report_type,
        column=column,
        plate=plate,
        stock_value=stock_value,
    )
    return _query_announcements(query)


def _sanitize_filename(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "", name).strip()


# 深市 年度报告
def szseAnnual(page, stock):
    return _query_exchange_report(page, stock, "annual", "szse", "sz")


# 沪市 年度报告
def sseAnnual(page, stock):
    return _query_exchange_report(page, stock, "annual", "sse", "sh")


# 北交所 年度报告
def bseAnnual(page, stock):
    """北交所年报查询，stock 形如 "代码,orgId"。"""
    code = str(stock).split(",", 1)[0]
    return _query_exchange_report(page, code, "annual", "bj", "bj", stock_value=stock)


# 深市 招股
def szseStock(page, stock):
    return _query_exchange_report(page, stock, "prospectus", "szse", "sz")


# 沪市 招股
def sseStock(page, stock):
    return _query_exchange_report(page, stock, "prospectus", "sse", "sh")


def _get_attachment(url):
    """Follow at most five redirects, validating before every network request."""
    url = resolve_attachment_url(url)
    for redirects in range(6):
        response = requests.get(
            url,
            headers={"User-Agent": random.choice(User_Agent)},
            timeout=30,
            allow_redirects=False,
        )
        if response.status_code not in (301, 302, 303, 307, 308):
            return response
        try:
            if redirects == 5:
                raise ValueError("Too many attachment redirects")
            url = resolve_attachment_url(response.headers.get("Location", ""), base=url)
        finally:
            response.close()
    raise RuntimeError("Attachment redirect handling failed")


def _fetch_pdf(url):
    for attempt in range(MAX_RETRIES):
        try:
            response = _get_attachment(url)
            try:
                response.raise_for_status()
                content = response.content
                content_type = (
                    response.headers.get("Content-Type", "")
                    .lower()
                    .split(";", 1)[0]
                    .strip()
                )
                if content_type and content_type not in (
                    "application/pdf",
                    "application/octet-stream",
                    "binary/octet-stream",
                    "application/x-pdf",
                ):
                    raise ValueError(f"Unexpected PDF content type: {content_type}")
                if not content.startswith(b"%PDF-"):
                    raise ValueError("Empty or non-PDF response")
                return content
            finally:
                response.close()
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError):
            if attempt == MAX_RETRIES - 1:
                raise
        except requests.exceptions.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status != 429 and (status is None or status < 500):
                raise
            if attempt == MAX_RETRIES - 1:
                raise
        time.sleep(RETRY_BACKOFF * (2**attempt) + random.random())
    raise RuntimeError("No download attempts configured")


def Download(
    single_page,
    report_type: Optional[str] = None,
    year_filter: Optional[Union[int, str]] = None,
    save_path: Optional[str] = None,
    *,
    details=False,
):
    """Download independently and atomically; legacy callers receive a count."""
    output_dir = save_path or saving_path
    files, failures = [], []
    normalized_type = normalize_report_type(report_type) if report_type else None
    for report in single_page or []:
        title = report.get("announcementTitle", "")
        types = [normalized_type] if normalized_type else REPORT_TYPE_SPECS
        if not any(_is_report_title(title, kind, year_filter) for kind in types):
            continue
        adjunct_url = report.get("adjunctUrl", "")
        temporary_path = None
        try:
            if not adjunct_url:
                raise ValueError("Missing adjunctUrl")
            url = resolve_attachment_url(adjunct_url)
            # Full attachment digest keeps distinct URLs distinct, even with identical titles.
            attachment_id = hashlib.sha256(adjunct_url.encode("utf-8")).hexdigest()
            stem = _sanitize_filename(
                f"{report.get('secCode', '')}_{report.get('secName', '')}_{title}"
            )
            # Leave room for the digest on filesystems with a 255-byte name limit.
            stem = stem.encode("utf-8")[:160].decode("utf-8", errors="ignore")
            file_path = os.path.join(output_dir, f"{stem}_{attachment_id}.pdf")
            time.sleep(random.random() * 2)
            content = _fetch_pdf(url)
            os.makedirs(output_dir, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                dir=output_dir, suffix=".tmp", delete=False
            ) as fh:
                temporary_path = fh.name
                fh.write(content)
            os.replace(temporary_path, file_path)
            temporary_path = None
            files.append({"adjunctUrl": adjunct_url, "path": file_path})
        except Exception as exc:
            failures.append(
                {
                    "adjunctUrl": adjunct_url,
                    "announcementTitle": title,
                    "error": str(exc),
                }
            )
            logger.warning("Download failed (%s): %s", title, exc)
        finally:
            if temporary_path is not None:
                try:
                    os.unlink(temporary_path)
                except OSError as exc:
                    logger.warning(
                        "Could not remove temporary file %s: %s", temporary_path, exc
                    )
    result = {
        "downloaded": len(files),
        "files": files,
        "failed": len(failures),
        "failures": failures,
    }
    return result if details else len(files)


def query_reports(stock_code, report_type="annual", year=None):
    """Return complete results or raise QueryError carrying partial reports."""
    stock_code = normalize_stock_code(stock_code)
    normalized_type = normalize_report_type(report_type)
    all_announcements = []
    allowed_sec_codes = {stock_code}
    errors = []
    partial = False

    exchanges = [
        ("sse", "sh", "沪市"),
        ("szse", "sz", "深市"),
    ]
    for column, plate, label in exchanges:
        try:
            fetch_fn = lambda page, _stock, c=column, p=plate: _query_exchange_report(
                page, stock_code, normalized_type, c, p
            )
            all_announcements.extend(_paginate(fetch_fn, stock_code))
            partial = True
        except Exception as e:
            errors.append(f"{label}: {e}")
            if isinstance(e, QueryError):
                all_announcements.extend(e.reports)
                partial = partial or e.status == "partial"
            logger.warning(
                "%s%s查询失败: %s",
                label,
                REPORT_TYPE_SPECS[normalized_type]["label"],
                e,
            )

    if _is_bse_code(stock_code):
        try:
            resolved = _resolve_org_id(stock_code)
            if resolved:
                code, org_id = resolved
                allowed_sec_codes.add(code)
                stock_value = f"{code},{org_id}"
                fetch_fn = lambda page, _stock: _query_exchange_report(
                    page,
                    code,
                    normalized_type,
                    "bj",
                    "bj",
                    stock_value=stock_value,
                )
                all_announcements.extend(_paginate(fetch_fn, stock_value))
                partial = True
            else:
                raise ValueError(f"Could not resolve orgId for {stock_code}")
        except Exception as e:
            errors.append(f"北交所: {e}")
            if isinstance(e, QueryError):
                all_announcements.extend(e.reports)
                partial = partial or e.status == "partial"
            logger.warning(
                "北交所%s查询失败: %s",
                REPORT_TYPE_SPECS[normalized_type]["label"],
                e,
            )

    filtered = []
    seen = set()
    for announcement in all_announcements:
        title = announcement.get("announcementTitle", "")
        adjunct_url = announcement.get("adjunctUrl", "")
        sec_code = str(announcement.get("secCode", ""))
        if allowed_sec_codes and sec_code not in allowed_sec_codes:
            continue
        dedupe_key = (announcement.get("secCode"), title, adjunct_url)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        if not _is_report_title(title, normalized_type, year_filter=year):
            continue
        # 招股书标题不含年份，需按 announcementTime 另行核对；其余类型的年份
        # 已在 _is_report_title 内匹配，无需重复。
        if normalized_type == "prospectus" and not _matches_year(
            announcement, normalized_type, year
        ):
            continue
        filtered.append(announcement)

    if errors:
        raise QueryError(errors, filtered, partial)
    return filtered


def download_reports(stock_code, report_type="annual", year=None, save_path=None):
    """下载指定股票和报告类型的 PDF。"""
    stock_code = normalize_stock_code(stock_code)
    normalized_type = normalize_report_type(report_type)
    query_error = None
    try:
        announcements = query_reports(stock_code, normalized_type, year)
    except QueryError as exc:
        query_error = exc
        announcements = exc.reports
    output_dir = save_path or saving_path
    result = Download(announcements, normalized_type, year, output_dir, details=True)
    status = "complete"
    if query_error or result["failed"]:
        status = (
            "partial"
            if result["downloaded"] or (query_error and query_error.status == "partial")
            else "error"
        )
    result.update(
        success=status == "complete",
        status=status,
        query_status=query_error.status if query_error else "complete",
        path=output_dir,
        message=f"Downloaded {result['downloaded']} file(s); {result['failed']} failed. Status: {status}.",
    )
    if query_error:
        result["query_errors"] = query_error.errors
        result["error"] = str(query_error)
    elif result["failed"]:
        result["error"] = f"{result['failed']} download(s) failed"
    return result


def query_annual_reports(stock_code, year=None):
    """查询指定股票的年度报告列表。"""
    return query_reports(stock_code, "annual", year)


def download_annual_reports(stock_code, year=None, save_path=None):
    """下载指定股票的年度报告。"""
    return download_reports(stock_code, "annual", year=year, save_path=save_path)


def Run(page_number, stock):
    annual_report = []
    stock_report = []
    annual_report_ = []
    stock_report_ = []

    try:
        annual_report = szseAnnual(page_number, stock)
        stock_report = szseStock(page_number, stock)
        annual_report_ = sseAnnual(page_number, stock)
        stock_report_ = sseStock(page_number, stock)
    except Exception:
        logger.warning("%s page error, retrying", page_number)
        try:
            annual_report = szseAnnual(page_number, stock)
        except Exception:
            logger.warning("%s page error", page_number)
    Download(annual_report, report_type="annual")
    Download(stock_report, report_type="prospectus")
    Download(annual_report_, report_type="annual")
    Download(stock_report_, report_type="prospectus")


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    with open("company_id.txt") as file:
        lines = file.readlines()
        for line in lines:
            stock = line.strip()
            Run(1, stock)
            logger.info("%s done", stock)
