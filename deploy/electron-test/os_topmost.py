# -*- coding: utf-8 -*-
"""采样器 · 从**操作系统**看 Atrium 的窗口到底有没有 WS_EX_TOPMOST

为什么需要它：自检里 `setAlwaysOnTop(true)` 之后 `isAlwaysOnTop()` 偶尔仍报 false
（机器有负载时更容易）。这时有两种可能，处置方式完全相反：
  ① 窗口真的没置顶      → 是我们的问题，得改创建/置顶逻辑；
  ② 窗口其实置顶了，只是 Electron 的读回是假的
                        → 那是"📌 图标显示未按下"的另一类 bug，得改成别信读回值。
只看 Electron 自己的报数分不清这两种，所以用 Win32 直接读扩展样式：
`GetWindowLongW(hwnd, GWL_EXSTYLE) & 0x8`（WS_EX_TOPMOST）才是系统眼里的真相。

用法：`python os_topmost.py <秒数> [进程名]`
输出每行：`t=<毫秒> hwnd=... title=... topmost=0/1 visible=0/1`，只在状态变化时打印。
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

GWL_EXSTYLE = -20
WS_EX_TOPMOST = 0x8

user32 = ctypes.WinDLL('user32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def windows_of(pid):
    out = []

    def cb(hwnd, _lparam):
        wpid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value == pid:
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 2)
            user32.GetWindowTextW(hwnd, buf, n + 2)
            ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            out.append({
                'hwnd': hwnd,
                'title': buf.value,
                'topmost': 1 if (ex & WS_EX_TOPMOST) else 0,
                'visible': 1 if user32.IsWindowVisible(hwnd) else 0,
                'ex': ex & 0xFFFFFFFF,
            })
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def exe_name_of(pid):
    """取进程的可执行文件名（避免依赖 tasklist 的本地化/编码输出）"""
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ''
    try:
        size = wt.DWORD(1024)
        buf = ctypes.create_unicode_buffer(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value.replace('/', '\\').split('\\')[-1]
        return ''
    finally:
        kernel32.CloseHandle(h)


def pids_of(name):
    """按进程名找 pid：遍历所有顶层窗口，用 exe 名过滤（不引第三方库）"""
    found = set()

    def cb(hwnd, _lparam):
        wpid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(wpid))
        if wpid.value and wpid.value not in found:
            if exe_name_of(wpid.value).lower() == name.lower():
                found.add(wpid.value)
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return sorted(found)


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 40.0
    name = sys.argv[2] if len(sys.argv) > 2 else 'Atrium.exe'
    t0 = time.time()
    last = {}
    while time.time() - t0 < secs:
        pids = pids_of(name)
        for pid in pids:
            for w in windows_of(pid):
                key = (pid, w['hwnd'])
                state = (w['topmost'], w['visible'])
                if last.get(key) != state:
                    last[key] = state
                    print('t=%.0f pid=%d hwnd=%#x topmost=%d visible=%d ex=%#x title=%r'
                          % ((time.time() - t0) * 1000, pid, w['hwnd'], w['topmost'],
                             w['visible'], w['ex'], w['title']), flush=True)
        time.sleep(0.05)
    print('done', flush=True)


if __name__ == '__main__':
    main()
