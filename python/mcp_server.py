#!/usr/bin/env python3
"""
巨潮资讯 MCP 服务器
用于查询和下载 A 股定期报告、招股书的 MCP 工具服务
"""

import json
import os
import sys
from typing import Optional

# 将当前目录加入模块搜索路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp.server.mcpserver import MCPServer
from spider import (
    query_reports,
    QueryError,
    normalize_stock_code,
    download_reports,
    format_reports,
    saving_path,
    supported_report_types,
)


def _package_version(default: str = "0.0.0") -> str:
    """从 package.json 读取版本，避免与 npm 包版本各写一份而漂移。

    package.json 始终随 npm 包发布（不受 files 白名单影响），因此在已安装的
    包里也能读到。读取失败时退回 default，不让版本号问题挡住服务器启动。
    """
    manifest = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "package.json"
    )
    try:
        with open(manifest, encoding="utf-8") as fh:
            return json.load(fh).get("version") or default
    except (OSError, ValueError):
        return default


# 创建 MCP 服务器实例
mcp = MCPServer(
    name="cninfo-server",
    instructions="CNINFO reports server - Query and download Chinese listed companies' periodic reports from cninfo.com.cn",
    version=_package_version(),
)


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
        - success: True only for complete queries, including empty results
        - status: complete, partial, or error; incomplete queries include error details
        - stock_code: The queried stock code
        - report_type: The requested report type
        - year: The filtered year (if any)
        - count: Number of reports found
        - reports: List of report details (announcementTitle, announcementTime, secCode, secName, adjunctUrl)
    """
    try:
        stock_code = normalize_stock_code(stock_code)
        reports = query_reports(stock_code, report_type, year)

        if not reports:
            return {
                "success": True,
                "status": "complete",
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
            "status": "complete",
            "stock_code": stock_code,
            "report_type": report_type,
            "year": year,
            "count": len(reports),
            "reports": format_reports(reports),
            "message": f"Found {len(reports)} {report_type} report(s)"
            + (f" for year {year}" if year else ""),
        }

    except QueryError as e:
        return {
            "success": False,
            "status": e.status,
            "stock_code": stock_code,
            "report_type": report_type,
            "year": year,
            "count": len(e.reports),
            "reports": format_reports(e.reports),
            "errors": e.errors,
            "error": str(e),
            "message": f"Query incomplete: {str(e)}",
        }

    except Exception as e:
        return {
            "success": False,
            "status": "error",
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
        - success: True only when the query and all downloads completed
        - status: complete, partial, or error
        - query_status: Whether the source query completed
        - files / failures: Successful paths and per-attachment errors
        - failed: Number of failed attachments
        - stock_code: The stock code
        - report_type: The requested report type
        - year: The filtered year (if any)
        - downloaded: Number of files downloaded
        - path: Directory where files were saved
        - message: Status message
    """
    try:
        output_dir = save_path or saving_path
        stock_code = normalize_stock_code(stock_code)

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
            "status": "error",
            "stock_code": stock_code,
            "report_type": report_type,
            "year": year,
            "downloaded": 0,
            "files": [],
            "failed": 0,
            "failures": [],
            "query_status": "error",
            "path": save_path or saving_path,
            "error": str(e),
            "message": f"Error downloading reports: {str(e)}. Supported report_type values: {_supported_report_types_text()}",
        }


@mcp.resource("annual-reports-list://{stock_code}")
def get_annual_reports_list(stock_code: str) -> str:
    """返回指定股票代码的年度报告格式化列表"""
    try:
        warning = ""
        try:
            reports = query_reports(stock_code, "annual")
        except QueryError as exc:
            reports = exc.reports
            warning = f"Query incomplete ({exc.status}): {exc}"

        if not reports and warning:
            return warning
        if not reports:
            return f"No annual reports found for stock {stock_code}"

        output = [f"Annual Reports for {stock_code}:", "=" * 60]
        if warning:
            output.append(warning)

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
