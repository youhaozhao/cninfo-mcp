"""
从巨潮资讯下载年度报告和招股书
"""

import os
import random
import time

import requests

download_path = "https://static.cninfo.com.cn/"
# 使用脚本所在目录的相对路径
_saving_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pdf")
saving_path = _saving_path + "/"

User_Agent = [
    "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Win64; x64; Trident/5.0; .NET CLR 3.5.30729; .NET CLR 3.0.30729; .NET CLR 2.0.50727; Media Center PC 6.0)",
    "Mozilla/5.0 (compatible; MSIE 8.0; Windows NT 6.0; Trident/4.0; WOW64; Trident/4.0; SLCC2; .NET CLR 2.0.50727; .NET CLR 3.5.30729; .NET CLR 3.0.30729; .NET CLR 1.0.3705; .NET CLR 1.1.4322)",
    "Mozilla/4.0 (compatible; MSIE 7.0b; Windows NT 5.2; .NET CLR 1.1.4322; .NET CLR 2.0.50727; InfoPath.2; .NET CLR 3.0.04506.30)",
    "Mozilla/5.0 (Windows; U; Windows NT 5.1; zh-CN) AppleWebKit/523.15 (KHTML, like Gecko, Safari/419.3) Arora/0.3 (Change: 287 c9dfb30)",
    "Mozilla/5.0 (X11; U; Linux; en-US) AppleWebKit/527+ (KHTML, like Gecko, Safari/419.3) Arora/0.6",
    "Mozilla/5.0 (Windows; U; Windows NT 5.1; en-US; rv:1.8.1.2pre) Gecko/20070215 K-Ninja/2.1.1",
    "Mozilla/5.0 (Windows; U; Windows NT 5.1; zh-CN; rv:1.9) Gecko/20080705 Firefox/3.0 Kapiko/3.0",
]


headers = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-HK;q=0.6,zh-TW;q=0.5",
    "Host": "www.cninfo.com.cn",
    "Origin": "http://www.cninfo.com.cn",
    "Referer": "http://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice",
    "X-Requested-With": "XMLHttpRequest",
}


# 深市 年度报告
def szseAnnual(page, stock):
    query_path = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
    headers["User-Agent"] = random.choice(User_Agent)  # 定义User_Agent
    query = {
        "pageNum": page,  # 页码
        "pageSize": 30,
        "tabName": "fulltext",
        "column": "szse",  # 深交所
        "stock": "",
        "searchkey": stock,  # 使用searchkey查询股票代码或公司名
        "secid": "",
        "plate": "sz",
        "category": "category_ndbg_szsh",  # 年度报告
        "trade": "",
        "seDate": "2020-01-01~2026-02-15",  # 时间区间
    }

    namelist = requests.post(query_path, headers=headers, data=query)
    result = namelist.json()
    if result and "announcements" in result and result["announcements"]:
        return result["announcements"]
    return []


# 沪市 年度报告
def sseAnnual(page, stock):
    query_path = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
    headers["User-Agent"] = random.choice(User_Agent)  # 定义User_Agent
    query = {
        "pageNum": page,  # 页码
        "pageSize": 30,
        "tabName": "fulltext",
        "column": "sse",
        "stock": "",
        "searchkey": stock,  # 使用searchkey查询股票代码或公司名
        "secid": "",
        "plate": "sh",
        "category": "category_ndbg_szsh",  # 年度报告
        "trade": "",
        "seDate": "2020-01-01~2026-02-15",  # 时间区间
    }

    namelist = requests.post(query_path, headers=headers, data=query)
    result = namelist.json()
    if result and "announcements" in result and result["announcements"]:
        return result["announcements"]
    return []


# 深市 招股
def szseStock(page, stock):
    query_path = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
    headers["User-Agent"] = random.choice(User_Agent)  # 定义User_Agent
    query = {
        "pageNum": page,  # 页码
        "pageSize": 30,
        "tabName": "fulltext",
        "column": "szse",
        "stock": "",
        "searchkey": stock + " 招股",  # 组合搜索：股票代码 + 招股
        "secid": "",
        "plate": "sz",
        "category": "",
        "trade": "",
        "seDate": "2015-01-01~2026-02-15",  # 时间区间
    }

    namelist = requests.post(query_path, headers=headers, data=query)
    result = namelist.json()
    if result and "announcements" in result and result["announcements"]:
        return result["announcements"]
    return []


# 沪市 招股
def sseStock(page, stock):
    query_path = "http://www.cninfo.com.cn/new/hisAnnouncement/query"
    headers["User-Agent"] = random.choice(User_Agent)  # 定义User_Agent
    query = {
        "pageNum": page,  # 页码
        "pageSize": 30,
        "tabName": "fulltext",
        "column": "sse",
        "stock": "",
        "searchkey": stock + " 招股",  # 组合搜索：股票代码 + 招股
        "secid": "",
        "plate": "sh",
        "category": "",
        "trade": "",
        "seDate": "2015-01-01~2026-02-15",  # 时间区间
    }

    namelist = requests.post(query_path, headers=headers, data=query)
    result = namelist.json()
    if result and "announcements" in result and result["announcements"]:
        return result["announcements"]
    return []


def Download(single_page, year_filter=None, save_path=None):
    """下载公告列表中的 PDF 文件"""
    if single_page is None:
        return

    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,zh-HK;q=0.6,zh-TW;q=0.5",
        "Host": "www.cninfo.com.cn",
        "Origin": "http://www.cninfo.com.cn",
    }

    # 按年份筛选允许下载的标题
    allowed_list = []
    if year_filter:
        allowed_list = [
            f"{year_filter}年年度报告（更新后）",
            f"{year_filter}年年度报告",
        ]
    else:
        # 默认下载 2016-2025 年
        for year in range(2016, 2026):
            allowed_list.append(f"{year}年年度报告（更新后）")
            allowed_list.append(f"{year}年年度报告")

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

        # 检查标题是否精确匹配（避免"摘要"等变体被误下载）
        allowed = False
        for item in allowed_list:
            if title == item:
                allowed = True
                break

        # 检查招股书
        for item in allowed_list_2:
            if item in title:
                allowed = True
                break

        if allowed:
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
            print(f"  ↓ {name}")

            # 确保目录存在
            os.makedirs(output_dir, exist_ok=True)

            time.sleep(random.random() * 2)

            headers["User-Agent"] = random.choice(User_Agent)
            r = requests.get(download)

            f = open(file_path, "wb")
            f.write(r.content)
            f.close()
            downloaded_count += 1
        else:
            continue

    return downloaded_count


def query_prospectus(stock_code):
    """查询指定股票代码的招股书公告列表"""
    all_announcements = []

    try:
        announcements_sse = sseStock(1, stock_code)
        all_announcements.extend(announcements_sse)
    except Exception as e:
        print(f"沪市招股书查询失败: {e}")

    try:
        announcements_szse = szseStock(1, stock_code)
        all_announcements.extend(announcements_szse)
    except Exception as e:
        print(f"深市招股书查询失败: {e}")

    prospectus_keywords = ["招股书", "招股说明书", "招股意向书"]
    filtered = [
        a for a in all_announcements
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
        announcements_sse = sseAnnual(1, stock_code)
        all_announcements.extend(announcements_sse)
    except Exception as e:
        print(f"沪市年报查询失败: {e}")

    # 查询深市
    try:
        announcements_szse = szseAnnual(1, stock_code)
        all_announcements.extend(announcements_szse)
    except Exception as e:
        print(f"深市年报查询失败: {e}")

    # 按年份过滤
    if year:
        year_str = str(year)
        filtered = []
        for announcement in all_announcements:
            if year_str in announcement.get("announcementTitle", ""):
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
    try:
        annual_report = szseAnnual(page_number, stock)
        stock_report = szseStock(page_number, stock)
        annual_report_ = sseAnnual(page_number, stock)
        stock_report_ = sseStock(page_number, stock)
    except Exception:
        print(page_number, "page error, retrying")
        try:
            annual_report = szseAnnual(page_number, stock)
        except Exception:
            print(page_number, "page error")
    Download(annual_report)
    Download(stock_report)
    Download(annual_report_)
    Download(stock_report_)


if __name__ == "__main__":
    with open("company_id.txt") as file:
        lines = file.readlines()
        for line in lines:
            stock = line
            Run(1, line)
            print(line, "done")
