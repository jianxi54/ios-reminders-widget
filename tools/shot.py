"""截取小组件窗口画面（纯 ctypes + GDI，无第三方依赖）"""
import ctypes
from ctypes import wintypes
import struct, zlib, sys, os

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

PROCNAME = "RemindersWidget.exe"


def find_pids():
    import subprocess
    out = subprocess.run(
        ["tasklist", "/FI", f"IMAGENAME eq {PROCNAME}", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, errors="ignore"
    ).stdout
    pids = set()
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == PROCNAME.lower():
            try:
                pids.add(int(parts[1]))
            except ValueError:
                pass
    return pids


def windows_of(pids):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, lparam):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids:
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 2)
            user32.GetWindowTextW(hwnd, buf, n + 2)
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            found.append({
                "hwnd": hwnd, "title": buf.value, "cls": cls.value,
                "visible": bool(user32.IsWindowVisible(hwnd)),
                "rect": (r.left, r.top, r.right, r.bottom),
            })
        return True

    user32.EnumWindows(cb, 0)
    return found


def png_write(path, w, h, bgra, scale=1):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        row = bgra[y * stride:(y + 1) * stride]
        line = bytearray()
        for x in range(w):
            b, g, r = row[x * 4], row[x * 4 + 1], row[x * 4 + 2]
            line += bytes((r, g, b)) * scale
        for _ in range(scale):
            raw += line

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w * scale, h * scale, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def capture(hwnd, path, scale=1):
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    if w <= 0 or h <= 0:
        return None

    hdc = user32.GetWindowDC(hwnd)
    mdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mdc, bmp)

    # PW_RENDERFULLCONTENT = 2，可捕获 WebView2 这类分层渲染内容
    ok = user32.PrintWindow(hwnd, mdc, 2)
    if not ok:
        gdi32.BitBlt(mdc, 0, 0, w, h, hdc, 0, 0, 0x00CC0020)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h  # 负值 = 自上而下
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0

    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bi), 0)
    png_write(path, w, h, buf.raw, scale)

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mdc)
    user32.ReleaseDC(hwnd, hdc)
    return (w, h)


if __name__ == "__main__":
    pids = find_pids()
    print("PIDs:", pids or "(none)")
    wins = windows_of(pids)
    for w in wins:
        print(f"  hwnd={w['hwnd']} vis={w['visible']} cls={w['cls']} title={w['title']!r} rect={w['rect']}")

    targets = [w for w in wins if w["visible"] and w["title"]]
    if not targets:
        targets = [w for w in wins if w["visible"]]
    if not targets:
        print("没有可截图的窗口")
        sys.exit(1)

    t = targets[0]
    user32.ShowWindow(t["hwnd"], 5)
    user32.SetForegroundWindow(t["hwnd"])
    import time
    time.sleep(0.6)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shot.png")
    scale = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    size = capture(t["hwnd"], out, scale)
    print("saved:", os.path.abspath(out), size)
