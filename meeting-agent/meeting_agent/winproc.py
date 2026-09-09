"""
PID -> process name and window title, through ctypes rather than psutil.

The agent already needs pyaudiowpatch, pycaw, numpy and onnxruntime. Adding
psutil for two calls that kernel32 and user32 answer directly would be a fifth
wheel on a machine where every dependency has to have a cp314 wheel.
"""
import ctypes
from ctypes import wintypes

_k32 = ctypes.WinDLL("kernel32", use_last_error=True)
_u32 = ctypes.WinDLL("user32", use_last_error=True)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def process_name(pid: int) -> str:
    """Executable name for a pid, or '' when it cannot be read.

    A pid we may not open is normal (pid 0 is the system sounds session), so an
    empty string is a real answer here rather than an error.
    """
    if not pid:
        return ""
    h = _k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if _k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value.rsplit("\\", 1)[-1].lower()
        return ""
    finally:
        _k32.CloseHandle(h)


def window_title(pid: int) -> str:
    """The main window title of a process — the meeting's name, for free.

    'Weekly Sync | Microsoft Teams' is a better title than 'ms-teams.exe', and
    it costs no calendar integration and no network call. The longest visible
    top-level title wins, because the meeting window is the one with a real
    name while the helper windows are blank or one word.
    """
    best = ""
    if not pid:
        return best

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lparam):
        nonlocal best
        owner = wintypes.DWORD()
        _u32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value != pid or not _u32.IsWindowVisible(hwnd):
            return True
        n = _u32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        _u32.GetWindowTextW(hwnd, buf, n + 1)
        if len(buf.value) > len(best):
            best = buf.value
        return True

    _u32.EnumWindows(cb, 0)
    return best.strip()
