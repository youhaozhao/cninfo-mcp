#!/usr/bin/env python3
"""
巨潮资讯 MCP 服务器
用于查询和下载 A 股定期报告、招股书的 MCP 工具服务
"""

import os
import sys
from typing import Optional

# 将当前目录加入模块搜索路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp.server import FastMCP
from spider import (
    query_reports,
    download_reports,
    saving_path,
    supported_report_types,
)

# 创建 MCP 服务器实例
mcp = FastMCP(
    name="cninfo-server",
    instructions="CNINFO reports server - Query and download Chinese listed companies' periodic reports from cninfo.com.cn",
)


def _format_reports(reports: list) -> list:
    """提取 MCP 返回中稳定、有用的公告字段。"""
    base_url = "https://static.cninfo.com.cn/"
    report_details = []
    for report in reports:
        adj = report.get("adjunctUrl", "")
        report_details.append(
            {
                "announcementTitle": report.get("announcementTitle", ""),
                "announcementTime": report.get("announcementTime", ""),
                "secCode": report.get("secCode", ""),
                "secName": report.get("secName", ""),
                "adjunctUrl": base_url + adj if adj else "",
            }
        )
    return report_details


def _supported_report_types_text() -> str:
    return ", ".join(supported_report_types().keys())


@mcp.tool()
def query_annual_reports_tool(
    stock_code: str, year: Optional[int] = None, report_type: str = "annual"
) -> dict:
    """
    Query periodic reports for a Chinese listed company.

    Args:
        stock_code: Stock code (e.g., '000888' for 峨眉山, '688777' for 中科德芯)
        year: Optional year to filter (e.g., 2024). If not provided, returns all available years
        report_type: Optional report type. Supported values: annual, semiannual, q1, q3, prospectus. Defaults to annual for backward compatibility.

    Returns:
        Dictionary containing:
        - success: Boolean indicating if the query was successful
        - stock_code: The queried stock code
        - report_type: The requested report type
        - year: The filtered year (if any)
        - count: Number of reports found
        - reports: List of report details (announcementTitle, announcementTime, secCode, secName, adjunctUrl)
    """
    try:
        reports = query_reports(stock_code, report_type, year)

        if not reports:
            return {
                "success": False,
                "stock_code": stock_code,
                "report_type": report_type,
                "year": year,
                "count": 0,
                "reports": [],
                "message": f"No {report_type} reports found for stock {stock_code}"
                + (f" in year {year}" if year else ""),
            }

        return {
            "success": True,
            "stock_code": stock_code,
            "report_type": report_type,
            "year": year,
            "count": len(reports),
            "reports": _format_reports(reports),
            "message": f"Found {len(reports)} {report_type} report(s)"
            + (f" for year {year}" if year else ""),
        }

    except Exception as e:
        return {
            "success": False,
            "stock_code": stock_code,
            "report_type": report_type,
            "year": year,
            "count": 0,
            "reports": [],
            "error": str(e),
            "message": f"Error querying reports: {str(e)}. Supported report_type values: {_supported_report_types_text()}",
        }


@mcp.tool()
def download_annual_reports_tool(
    stock_code: str,
    year: Optional[int] = None,
    save_path: Optional[str] = None,
    report_type: str = "annual",
) -> dict:
    """
    Download periodic reports for a Chinese listed company.

    Args:
        stock_code: Stock code (e.g., '000888' for 峨眉山, '688777' for 中科德芯)
        year: Optional year to filter (e.g., 2024). If not provided, downloads all available years
        save_path: Optional directory to save files (e.g., '/Users/me/reports'). Defaults to pdf/ in package directory
        report_type: Optional report type. Supported values: annual, semiannual, q1, q3, prospectus. Defaults to annual for backward compatibility.

    Returns:
        Dictionary containing:
        - success: Boolean indicating if download was successful
        - stock_code: The stock code
        - report_type: The requested report type
        - year: The filtered year (if any)
        - downloaded: Number of files downloaded
        - path: Directory where files were saved
        - message: Status message
    """
    try:
        output_dir = save_path or saving_path
        os.makedirs(output_dir, exist_ok=True)

        result = download_reports(
            stock_code, report_type, year=year, save_path=output_dir
        )
        result["stock_code"] = stock_code
        result["report_type"] = report_type
        result["year"] = year

        return result

    except Exception as e:
        return {
            "success": False,
            "stock_code": stock_code,
            "report_type": report_type,
            "year": year,
            "downloaded": 0,
            "path": save_path or saving_path,
            "error": str(e),
            "message": f"Error downloading reports: {str(e)}. Supported report_type values: {_supported_report_types_text()}",
        }


@mcp.resource("annual-reports-list://{stock_code}")
def get_annual_reports_list(stock_code: str) -> str:
    """返回指定股票代码的年度报告格式化列表"""
    try:
        reports = query_reports(stock_code, "annual")

        if not reports:
            return f"No annual reports found for stock {stock_code}"

        output = [f"Annual Reports for {stock_code}:", "=" * 60]

        for report in reports:
            title = report.get("announcementTitle", "N/A")
            time = report.get("announcementTime", "N/A")
            name = report.get("secName", "N/A")
            output.append(f"\n📄 {title}")
            output.append(f"   Company: {name}")
            output.append(f"   Date: {time}")

        output.append("\n" + "=" * 60)
        output.append(f"Total: {len(reports)} report(s)")

        return "\n".join(output)

    except Exception as e:
        return f"Error retrieving annual reports: {str(e)}"


if __name__ == "__main__":
    # 以 stdio 方式运行服务器
    mcp.run()
