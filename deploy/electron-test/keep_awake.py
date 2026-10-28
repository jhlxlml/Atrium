# -*- coding: utf-8 -*-
"""跑长回归时把显示器/系统"钉住别睡"，并顺便报告用户空闲了多久

为什么需要它：v1.20.5 的全量回归（约 5.5 分钟）里 `打包产物自检` 偶发红，
固定卡在「相框置顶」那两条；同一份产物**单跑 30 秒**永远绿。用 Win32 核对过
窗口扩展样式，确认系统那边真的没有 WS_EX_TOPMOST —— 也就是说不是我们代码的问题，
而是**这台机器在长时间无人操作后，系统开始拒绝置顶请求**（会话锁屏/显示器休眠时，
普通窗口的 z-order 操作会被忽略）。

用法：`python keep_awake.py <秒数>`，与 `node run_all.js` 并行跑。
每 20 秒打印一行 `idle=<秒>`，用来核对"失败那一刻机器是不是已经空闲很久了"。
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
ES_DISPLAY_REQUIRED = 0x00000002

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
user32 = ctypes.WinDLL('user32', use_last_error=True)


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [('cbSize', wt.UINT), ('dwTime', wt.DWORD)]


def idle_seconds():
    li = LASTINPUTINFO()
    li.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not user32.GetLastInputInfo(ctypes.byref(li)):
        return -1.0
    return (kernel32.GetTickCount() - li.dwTime) / 1000.0


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 600.0
    t0 = time.time()
    try:
        while time.time() - t0 < secs:
            kernel32.SetThreadExecutionState(
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
            print('t=%.0fs idle=%.0fs' % (time.time() - t0, idle_seconds()), flush=True)
            time.sleep(20)
    finally:
        kernel32.SetThreadExecutionState(ES_CONTINUOUS)
        print('released', flush=True)


if __name__ == '__main__':
    main()
