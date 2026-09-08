#!/usr/bin/env python3
"""巨潮年报接口连通性探测。

每个市场用若干「历史悠久、必然有多年年报」的稳定标的探测：只要任一标的
返回年报即判该市场连通正常；只有当某市场所有标的都查不到年报（或全部抛错）
才判为异常。这样单只股票的偶发抖动不会误报，只有真正的接口/连通故障才触发。

异常时以非零退出码结束，供 CI 据此通知 repo owner。
"""

import os
import sys
import time

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python")
)

import spider  # noqa: E402

# 各市场的稳定探测标的（均为上市多年、年报齐全的公司）
PROBES = {
    "沪市 SSE": ["600519", "601398"],  # 贵州茅台、工商银行
    "深市 SZSE": ["000001", "000333"],  # 平安银行、美的集团
    "北交所 BSE": ["835185", "920019"],  # 贝特瑞、铜冠矿建
}

MARKET_PROBE_ATTEMPTS = 2
MARKET_PROBE_RETRY_DELAY_SECONDS = 30


def probe_market(
    codes,
    attempts: int = MARKET_PROBE_ATTEMPTS,
    retry_delay: int = MARKET_PROBE_RETRY_DELAY_SECONDS,
):
    """返回 (是否连通, 各标的明细)。任一标的有年报即视为连通。"""
    last_details = []
    for attempt in range(1, attempts + 1):
        ok = False
        details = []
        for code in codes:
            try:
                n = len(spider.query_annual_reports(code))
                details.append(f"{code}={n}")
                if n > 0:
                    ok = True
            except Exception as e:  # noqa: BLE001 - 探测需捕获一切异常并如实记录
                details.append(f"{code}!ERR({e})")
        if ok:
            return True, details
        last_details = details
        if attempt < attempts:
            print(
                f"市场探测第 {attempt} 次失败，{retry_delay} 秒后重试...",
                flush=True,
            )
            time.sleep(retry_delay)
    return False, last_details


def main():
    failures = []
    for market, codes in PROBES.items():
        ok, details = probe_market(codes)
        status = "OK  " if ok else "FAIL"
        print(f"[{status}] {market}: {', '.join(details)}", flush=True)
        if not ok:
            failures.append(f"{market}: {', '.join(details)}")

    if failures:
        print("\n探测发现异常：", flush=True)
        for f in failures:
            print(f"  - {f}", flush=True)
        sys.exit(1)

    print("\n全部市场连通正常。", flush=True)


if __name__ == "__main__":
    main()
