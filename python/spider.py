"""
从巨潮资讯下载年度报告和招股书
"""

import datetime
import logging
import os
import random
import re
import time
from typing import Optional, Union

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
            resp = requests.post(
                url, headers=_build_headers(), data=data, timeout=30
            )
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
    if result and "announcements" in result and result["announcements"]:
        return result["announcements"]
    return []


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
    try:
        hits = _post_json(TOP_SEARCH_URL, {"keyWord": stock_code, "maxNum": 10})
    except Exception as e:
        logger.warning("orgId 解析失败（%s）: %s", stock_code, e)
        return None

    if not isinstance(hits, list) or not hits:
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
        items = fetch_fn(page, stock)
        if not items:
            break
        all_items.extend(items)
        if len(items) < PAGE_SIZE:  # 不足一页说明已到最后一页
            break
    else:
        logger.warning("翻页达到上限 %s，结果可能被截断（%s）", MAX_PAGES, stock)
    return all_items


def _is_annual_report_title(
    title: str, year_filter: Optional[Union[int, str]] = None
) -> bool:
    """
    判断标题是否为“年度报告正文”。

    支持常见变体：
    - 2024年年度报告
    - 2024年度报告
    - 2024年报
    """
    compact_title = re.sub(r"\s+", "", title or "")

    # 非正文公告关键词过滤
    exclude_keywords = [
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
    if any(keyword in compact_title for keyword in exclude_keywords):
        return False

    year_expr = re.escape(str(year_filter)) if year_filter is not None else r"\d{4}"
    suffix_expr = r"(?:[（(]更新后[)）])?"
    patterns = [
        rf".*{year_expr}年年度报告{suffix_expr}",
        rf".*{year_expr}年度报告{suffix_expr}",
    ]
    if year_filter is not None:
        patterns.append(rf".*{year_expr}年报{suffix_expr}")

    return any(re.fullmatch(pattern, compact_title) for pattern in patterns)


# 深市 年度报告
def szseAnnual(page, stock):
    query = {
        "pageNum": page,  # 页码
        "pageSize": PAGE_SIZE,
        "tabName": "fulltext",
        "column": "szse",  # 深交所
        "stock": "",
        "searchkey": stock,  # 使用searchkey查询股票代码或公司名
        "secid": "",
        "plate": "sz",
        "category": "category_ndbg_szsh",  # 年度报告
        "trade": "",
        "seDate": _date_range(EARLIEST_DATE),  # 时间区间
    }

    return _query_announcements(query)


# 沪市 年度报告
def sseAnnual(page, stock):
    query = {
        "pageNum": page,  # 页码
        "pageSize": PAGE_SIZE,
        "tabName": "fulltext",
        "column": "sse",
        "stock": "",
        "searchkey": stock,  # 使用searchkey查询股票代码或公司名
        "secid": "",
        "plate": "sh",
        "category": "category_ndbg_szsh",  # 年度报告
        "trade": "",
        "seDate": _date_range(EARLIEST_DATE),  # 时间区间
    }

    return _query_announcements(query)


# 北交所 年度报告
def bseAnnual(page, stock):
    """北交所年报查询。

    stock 形如 "代码,orgId"，由 _resolve_org_id 解析得到。北交所必须
    通过 plate=bj + stock="代码,orgId" 查询，searchkey/裸代码均返回空。
    """
    query = {
        "pageNum": page,  # 页码
        "pageSize": PAGE_SIZE,
        "tabName": "fulltext",
        "column": "bj",  # 北交所
        "stock": stock,  # 必须为 "代码,orgId"
        "searchkey": "",
        "secid": "",
        "plate": "bj",
        "category": "category_ndbg_szsh",  # 年度报告
        "trade": "",
        "seDate": _date_range(EARLIEST_DATE),  # 时间区间
    }

    return _query_announcements(query)


# 深市 招股
def szseStock(page, stock):
    query = {
        "pageNum": page,  # 页码
        "pageSize": PAGE_SIZE,
        "tabName": "fulltext",
        "column": "szse",
        "stock": "",
        "searchkey": stock + " 招股",  # 组合搜索：股票代码 + 招股
        "secid": "",
        "plate": "sz",
        "category": "",
        "trade": "",
        "seDate": _date_range(EARLIEST_DATE),  # 时间区间
    }

    return _query_announcements(query)


# 沪市 招股
def sseStock(page, stock):
    query = {
        "pageNum": page,  # 页码
        "pageSize": PAGE_SIZE,
        "tabName": "fulltext",
        "column": "sse",
        "stock": "",
        "searchkey": stock + " 招股",  # 组合搜索：股票代码 + 招股
        "secid": "",
        "plate": "sh",
        "category": "",
        "trade": "",
        "seDate": _date_range(EARLIEST_DATE),  # 时间区间
    }

    return _query_announcements(query)


def Download(
    single_page,
    year_filter: Optional[Union[int, str]] = None,
    save_path: Optional[str] = None,
):
    """下载公告列表中的 PDF 文件"""
    if single_page is None:
        return

    allowed_list_2 = [
        "招股书",
        "招股说明书",
        "招股意向书",
    ]

    output_dir = (save_path or saving_path).rstrip("/") + "/"
    downloaded_count = 0

    for i in single_page:
        title = i["announcementTitle"]

        # 跳过确认意见、取消公告、摘要等非正文文件
        if "确认意见" in title or "取消" in title or "摘要" in title:
            continue

        # 年报标题匹配：支持“2024年年度报告/2024年度报告/2024年报”等变体
        is_annual_report = _is_annual_report_title(title, year_filter=year_filter)

        # 检查招股书
        is_prospectus = any(item in title for item in allowed_list_2)

        if is_annual_report or is_prospectus:
            download = download_path + i["adjunctUrl"]
            name = (
                i["secCode"]
                + "_"
                + i["secName"]
                + "_"
                + i["announcementTitle"]
                + ".pdf"
            )
            if "*" in name:
                name = name.replace("*", "")
            file_path = output_dir + name

            # 显示下载进度
            logger.info("↓ %s", name)

            # 确保目录存在
            os.makedirs(output_dir, exist_ok=True)

            time.sleep(random.random() * 2)

            r = requests.get(
                download, headers={"User-Agent": random.choice(User_Agent)}, timeout=30
            )
            r.raise_for_status()
            with open(file_path, "wb") as f:
                f.write(r.content)
            downloaded_count += 1
        else:
            continue

    return downloaded_count


def query_prospectus(stock_code):
    """查询指定股票代码的招股书公告列表"""
    all_announcements = []

    try:
        announcements_sse = _paginate(sseStock, stock_code)
        all_announcements.extend(announcements_sse)
    except Exception as e:
        logger.warning("沪市招股书查询失败: %s", e)

    try:
        announcements_szse = _paginate(szseStock, stock_code)
        all_announcements.extend(announcements_szse)
    except Exception as e:
        logger.warning("深市招股书查询失败: %s", e)

    prospectus_keywords = ["招股书", "招股说明书", "招股意向书"]
    filtered = [
        a
        for a in all_announcements
        if any(kw in a.get("announcementTitle", "") for kw in prospectus_keywords)
    ]

    return filtered


def download_prospectus(stock_code, save_path=None):
    """下载指定股票的招股书"""
    announcements = query_prospectus(stock_code)

    if not announcements:
        return {
            "success": False,
            "message": f"未找到股票 {stock_code} 的招股书",
            "downloaded": 0,
        }

    output_dir = save_path or saving_path
    count = Download(announcements, save_path=output_dir)

    downloaded = count or 0
    return {
        "success": downloaded > 0,
        "message": f"已下载 {stock_code} 招股书，共 {downloaded} 个文件"
        if downloaded > 0
        else f"未下载任何文件（{stock_code} 招股书）",
        "downloaded": downloaded,
        "path": output_dir,
    }


def query_annual_reports(stock_code, year=None):
    """查询指定股票的年度报告列表"""
    all_announcements = []

    # 查询沪市
    try:
        announcements_sse = _paginate(sseAnnual, stock_code)
        all_announcements.extend(announcements_sse)
    except Exception as e:
        logger.warning("沪市年报查询失败: %s", e)

    # 查询深市
    try:
        announcements_szse = _paginate(szseAnnual, stock_code)
        all_announcements.extend(announcements_szse)
    except Exception as e:
        logger.warning("深市年报查询失败: %s", e)

    # 查询北交所（代码以 4/8/9 开头）。北交所接口必须用 orgId，
    # 故先解析 orgId 再以 stock="代码,orgId" 翻页查询。
    if _is_bse_code(stock_code):
        try:
            resolved = _resolve_org_id(stock_code)
            if resolved:
                code, org_id = resolved
                announcements_bse = _paginate(bseAnnual, f"{code},{org_id}")
                all_announcements.extend(announcements_bse)
        except Exception as e:
            logger.warning("北交所年报查询失败: %s", e)

    # 按年份过滤
    if year:
        year_expr = re.escape(str(year))
        year_patterns = [
            rf"{year_expr}年年度报告",
            rf"{year_expr}年度报告",
            rf"{year_expr}年报",
        ]
        filtered = []
        for announcement in all_announcements:
            title = re.sub(r"\s+", "", announcement.get("announcementTitle", ""))
            # 这里故意使用宽松匹配作为“预筛选”以保留候选项。
            # 真正的严格判定（fullmatch + 排除词）在 Download() 的
            # _is_annual_report_title() 中执行，形成两层防线。
            if any(re.search(pattern, title) for pattern in year_patterns):
                filtered.append(announcement)
        all_announcements = filtered

    return all_announcements


def download_annual_reports(stock_code, year=None, save_path=None):
    """下载指定股票的年度报告"""
    announcements = query_annual_reports(stock_code, year)

    if not announcements:
        return {
            "success": False,
            "message": f"未找到股票 {stock_code} 的年度报告"
            + (f"（{year} 年）" if year else ""),
            "downloaded": 0,
        }

    output_dir = save_path or saving_path
    count = Download(announcements, year_filter=year, save_path=output_dir)

    downloaded = count or 0
    year_suffix = f"（{year} 年）" if year else ""
    return {
        "success": downloaded > 0,
        "message": f"已下载 {stock_code} 年度报告{year_suffix}，共 {downloaded} 个文件"
        if downloaded > 0
        else f"未下载任何文件（{stock_code} 年度报告{year_suffix}）",
        "downloaded": downloaded,
        "path": output_dir,
    }


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
    Download(annual_report)
    Download(stock_report)
    Download(annual_report_)
    Download(stock_report_)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    with open("company_id.txt") as file:
        lines = file.readlines()
        for line in lines:
            stock = line
            Run(1, line)
            logger.info("%s done", line.strip())
