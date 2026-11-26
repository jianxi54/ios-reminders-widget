"""检查宿主窗口是否真的裁了圆角（读窗口 region，判断角点是否在区域内）"""
import ctypes
from ctypes import wintypes
import subprocess

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

PROC = "RemindersWidget.exe"


def hwnds():
    out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {PROC}", "/FO", "CSV", "/NH"],
                         capture_output=True, text=True, errors="ignore").stdout
    pids = set()
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == PROC.lower():
            try:
                pids.add(int(parts[1]))
            except ValueError:
                pass

    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value in pids and user32.IsWindowVisible(h):
            n = user32.GetWindowTextLengthW(h)
            buf = ctypes.create_unicode_buffer(n + 2)
            user32.GetWindowTextW(h, buf, n + 2)
            r = wintypes.RECT()
            user32.GetWindowRect(h, ctypes.byref(r))
            if buf.value:
                found.append((h, buf.value, r.right - r.left, r.bottom - r.top))
        return True

    user32.EnumWindows(cb, 0)
    return found


gdi32.CreateRectRgn.restype = wintypes.HRGN
gdi32.CreateRectRgn.argtypes = [ctypes.c_int] * 4
gdi32.GetRgnBox.argtypes = [wintypes.HRGN, ctypes.POINTER(wintypes.RECT)]
gdi32.DeleteObject.argtypes = [wintypes.HRGN]
user32.GetWindowRgn.restype = ctypes.c_int
user32.GetWindowRgn.argtypes = [wintypes.HWND, wintypes.HRGN]
gdi32.PtInRegion.argtypes = [wintypes.HRGN, ctypes.c_int, ctypes.c_int]

for h, title, w, hgt in hwnds():
    rgn = gdi32.CreateRectRgn(0, 0, 0, 0)
    t = user32.GetWindowRgn(h, rgn)
    box = wintypes.RECT()
    gdi32.GetRgnBox(rgn, ctypes.byref(box))
    print(f"窗口 {title!r} 尺寸={w}x{hgt} region类型={t} (0=NULL,1=SIMPLE,2=COMPLEX,3=ERROR以外)")
    if t:
        for pt in [(2, 2), (w - 3, 2), (2, hgt - 3), (w - 3, hgt - 3), (w // 2, 2), (w // 2, hgt // 2)]:
            inside = gdi32.PtInRegion(rgn, pt[0], pt[1])
            print(f"   点{pt} 在区域内: {bool(inside)}")
    else:
        print("   → 没有设置窗口区域（直角）")
    gdi32.DeleteObject(rgn)
