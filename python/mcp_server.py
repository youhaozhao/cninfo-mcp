#!/usr/bin/env python3
"""
巨潮资讯 MCP 服务器
用于查询和下载 A 股年度报告的 MCP 工具服务
"""

import os
import sys
from typing import Optional

# 将当前目录加入模块搜索路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp.server import FastMCP
from spider import (
    query_annual_reports,
    download_annual_reports,
    query_prospectus,
    download_prospectus,
    saving_path,
)

# 创建 MCP 服务器实例
mcp = FastMCP(
    name="cninfo-server",
    instructions="CNINFO annual reports server - Query and download Chinese listed companies' annual reports from cninfo.com.cn",
)


@mcp.tool()
def query_annual_reports_tool(stock_code: str, year: Optional[int] = None) -> dict:
    """
    Query annual reports for a Chinese listed company

    Args:
        stock_code: Stock code (e.g., '000888' for峨眉山, '688777' for 中科德芯)
        year: Optional year to filter (e.g., 2024). If not provided, returns all available years

    Returns:
        Dictionary containing:
        - success: Boolean indicating if the query was successful
        - stock_code: The queried stock code
        - year: The filtered year (if any)
        - count: Number of reports found
        - reports: List of report details (announcementTitle, announcementTime, secCode, secName)
    """
    try:
        reports = query_annual_reports(stock_code, year)

        if not reports:
            return {
                "success": False,
                "stock_code": stock_code,
                "year": year,
                "count": 0,
                "reports": [],
                "message": f"No annual reports found for stock {stock_code}"
                + (f" in year {year}" if year else ""),
            }

        # 提取关键字段
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

        return {
            "success": True,
            "stock_code": stock_code,
            "year": year,
            "count": len(reports),
            "reports": report_details,
            "message": f"Found {len(reports)} annual report(s)"
            + (f" for year {year}" if year else ""),
        }

    except Exception as e:
        return {
            "success": False,
            "stock_code": stock_code,
            "year": year,
            "count": 0,
            "reports": [],
            "error": str(e),
            "message": f"Error querying annual reports: {str(e)}",
        }


@mcp.tool()
def download_annual_reports_tool(
    stock_code: str, year: Optional[int] = None, save_path: Optional[str] = None
) -> dict:
    """
    Download annual reports for a Chinese listed company

    Args:
        stock_code: Stock code (e.g., '000888' for 峨眉山, '688777' for 中科德芯)
        year: Optional year to filter (e.g., 2024). If not provided, downloads all available years
        save_path: Optional directory to save files (e.g., '/Users/me/reports'). Defaults to pdf/ in package directory

    Returns:
        Dictionary containing:
        - success: Boolean indicating if download was successful
        - stock_code: The stock code
        - year: The filtered year (if any)
        - downloaded: Number of files downloaded
        - path: Directory where files were saved
        - message: Status message
    """
    try:
        output_dir = save_path or saving_path
        os.makedirs(output_dir, exist_ok=True)

        result = download_annual_reports(stock_code, year, save_path=output_dir)
        result["stock_code"] = stock_code
        result["year"] = year

        return result

    except Exception as e:
        return {
            "success": False,
            "stock_code": stock_code,
            "year": year,
            "downloaded": 0,
            "path": save_path or saving_path,
            "error": str(e),
            "message": f"Error downloading annual reports: {str(e)}",
        }


@mcp.tool()
def query_prospectus_tool(stock_code: str) -> dict:
    """
    Query prospectus documents for a Chinese listed company

    Args:
        stock_code: Stock code (e.g., '000888' for 峨眉山, '688777' for 中科德芯)

    Returns:
        Dictionary containing:
        - success: Boolean indicating if the query was successful
        - stock_code: The queried stock code
        - count: Number of documents found
        - reports: List of document details (announcementTitle, announcementTime, secCode, secName)
    """
    try:
        reports = query_prospectus(stock_code)

        if not reports:
            return {
                "success": False,
                "stock_code": stock_code,
                "count": 0,
                "reports": [],
                "message": f"No prospectus found for stock {stock_code}",
            }

        base_url = "https://static.cninfo.com.cn/"
        report_details = [
            {
                "announcementTitle": r.get("announcementTitle", ""),
                "announcementTime": r.get("announcementTime", ""),
                "secCode": r.get("secCode", ""),
                "secName": r.get("secName", ""),
                "adjunctUrl": base_url + r.get("adjunctUrl", "")
                if r.get("adjunctUrl")
                else "",
            }
            for r in reports
        ]

        return {
            "success": True,
            "stock_code": stock_code,
            "count": len(reports),
            "reports": report_details,
            "message": f"Found {len(reports)} prospectus document(s)",
        }

    except Exception as e:
        return {
            "success": False,
            "stock_code": stock_code,
            "count": 0,
            "reports": [],
            "error": str(e),
            "message": f"Error querying prospectus: {str(e)}",
        }


@mcp.tool()
def download_prospectus_tool(stock_code: str, save_path: Optional[str] = None) -> dict:
    """
    Download prospectus documents for a Chinese listed company

    Args:
        stock_code: Stock code (e.g., '000888' for 峨眉山, '688777' for 中科德芯)
        save_path: Optional directory to save files (e.g., '/Users/me/reports'). Defaults to pdf/ in package directory

    Returns:
        Dictionary containing:
        - success: Boolean indicating if download was successful
        - stock_code: The stock code
        - downloaded: Number of files downloaded
        - path: Directory where files were saved
        - message: Status message
    """
    try:
        output_dir = save_path or saving_path
        os.makedirs(output_dir, exist_ok=True)

        result = download_prospectus(stock_code, save_path=output_dir)
        result["stock_code"] = stock_code

        return result

    except Exception as e:
        return {
            "success": False,
            "stock_code": stock_code,
            "downloaded": 0,
            "path": save_path or saving_path,
            "error": str(e),
            "message": f"Error downloading prospectus: {str(e)}",
        }


@mcp.resource("annual-reports-list://{stock_code}")
def get_annual_reports_list(stock_code: str) -> str:
    """返回指定股票代码的年度报告格式化列表"""
    try:
        reports = query_annual_reports(stock_code)

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
