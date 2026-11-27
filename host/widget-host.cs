// widget-host.cs — iOS 提醒事项 Win11 桌面小组件 · 原生宿主
// 功能：
//   1. WebView2 无边框窗口，纯色不透明卡片（深色，与页面底色一致，加载时不会闪白）
//   2. 「固定到桌面」：窗口挂到桌面层 WorkerW，Win+D 不受影响、不遮挡其他窗口、自动从任务栏消失
//   3. 托盘常驻图标（显示/隐藏、固定/取消固定、开机自启、退出）
//   4. 无感拉起本地同步服务（Node 隐藏进程，无任何控制台窗口）
// 编译：dotnet build host/WidgetHost.csproj -c Release（产物拷到 host/RemindersWidget.exe）

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace RemindersWidgetHost
{
    static class Program
    {
        // 单实例：一个登录会话里只允许一个宿主进程
        private const string MUTEX_NAME = @"Local\RemindersWidget.Host.SingleInstance";
        private const string ACTIVATE_EVENT = @"Local\RemindersWidget.Host.Activate";
        private static Mutex _instanceMutex;

        [STAThread]
        static void Main()
        {
            // 已经有实例在跑 → 通知它把窗口显示出来，然后自己退出
            if (!AcquireSingleInstance())
            {
                SignalExistingInstance();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e)
            {
                Log("UNHANDLED: " + e.ExceptionObject);
            };
            Application.ThreadException += delegate(object s, System.Threading.ThreadExceptionEventArgs e)
            {
                Log("THREAD-EX: " + e.Exception);
            };
            Log("Main start");
            try
            {
                Application.Run(new WidgetForm());
                Log("Main exit (form closed)");
            }
            catch (Exception ex)
            {
                Log("FATAL: " + ex);
                MessageBox.Show("小组件启动失败：" + ex.Message + "\n\n日志：" + LogPath, "提醒事项小组件",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                ReleaseSingleInstance();
            }
        }

        /** 命名事件：第二个实例 Set，当前实例收到后把窗口显示出来 */
        internal static EventWaitHandle CreateActivateEvent()
        {
            return new EventWaitHandle(false, EventResetMode.AutoReset, ACTIVATE_EVENT);
        }

        private static bool AcquireSingleInstance()
        {
            try
            {
                _instanceMutex = new Mutex(false, MUTEX_NAME);
                try
                {
                    return _instanceMutex.WaitOne(0, false);
                }
                catch (AbandonedMutexException)
                {
                    return true;   // 上一个实例是异常退出的，直接接管
                }
            }
            catch (Exception ex)
            {
                Log("single-instance check failed: " + ex.Message);
                return true;   // 连检查都失败时，宁可让用户能打开
            }
        }

        private static void ReleaseSingleInstance()
        {
            try
            {
                if (_instanceMutex == null) return;
                _instanceMutex.ReleaseMutex();
                _instanceMutex.Dispose();
                _instanceMutex = null;
            }
            catch { }
        }

        private static void SignalExistingInstance()
        {
            // 已有实例可能刚启动、监听还没建好，重试约 1.5 秒
            for (int i = 0; i < 15; i++)
            {
                try
                {
                    EventWaitHandle ev;
                    if (EventWaitHandle.TryOpenExisting(ACTIVATE_EVENT, out ev))
                    {
                        ev.Set();
                        ev.Close();
                        Log("second instance: signaled existing instance");
                        return;
                    }
                }
                catch { }
                System.Threading.Thread.Sleep(100);
            }
            Log("second instance: no listener, exit");
        }

        internal static string LogPath = Path.Combine(Path.GetTempPath(), "RemindersWidgetHost.log");
        internal static void Log(string msg)
        {
            try { File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + msg + Environment.NewLine); }
            catch { }
        }
    }

    internal class WidgetForm : Form
    {
        private const string SERVER_URL = "http://127.0.0.1:8642/";
        private const int SERVER_PORT = 8642;
        private const string APP_VERSION = "0.04";   // 与服务端 lib/version.js 保持一致（CI 会校验）

        private WebView2 webView;
        private NotifyIcon tray;
        private ToolStripMenuItem miPin;
        private EventWaitHandle _activateEvent;
        private bool pinned = false;
        private bool settingsPinned = false;   // 上次退出时是否处于固定状态
        private long savedStyle = 0;
        private string theme = "dark";   // dark | light，与页面设置保持一致

        // 给 WebView2 瘦身：只留渲染这个小组件需要的能力
        private const string BROWSER_ARGS =
            "--disable-background-networking --disable-component-update --disable-sync " +
            "--disable-breakpad --no-pings --disable-features=msEdgeFluentOverlayScrollbar " +
            "--disk-cache-size=8388608 --media-cache-size=1048576 --js-flags=--max-old-space-size=64";

        // ---------- Win32 ----------
        private const int GWL_STYLE = -16;
        private const long WS_CHILD = 0x40000000L;
        private const long WS_POPUP = 0x80000000L;
        private const int WM_SPAWN_WORKER = 0x052C;
        private const int WM_NCLBUTTONDOWN = 0xA1;
        private static readonly IntPtr HTCAPTION = (IntPtr)0x2;

        [DllImport("user32.dll")] private static extern IntPtr FindWindow(string cls, string title);
        [DllImport("user32.dll")] private static extern IntPtr SetParent(IntPtr hWnd, IntPtr parent);
        [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
        [DllImport("user32.dll")] private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int w, int h, uint flags);
        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessage(string name);
        [DllImport("user32.dll", EntryPoint = "SendMessageW")] private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wp, IntPtr lp);
        [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetWindowLongPtrW")] private static extern long GetWindowLongPtr(IntPtr hWnd, int index);
        [DllImport("user32.dll", SetLastError = true, EntryPoint = "SetWindowLongPtrW")] private static extern long SetWindowLongPtr(IntPtr hWnd, int index, long value);
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int w, int h);
        [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(ref Point p);

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        public WidgetForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            Text = "提醒事项小组件";
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(28, 28, 30);
            DoubleBuffered = true;
            ShowInTaskbar = true;

            Program.Log("ctor: before WebView2");
            webView = new WebView2();
            webView.Dock = DockStyle.Fill;
            webView.DefaultBackgroundColor = ThemeBackdrop(); // 不透明底色，避免加载瞬间白屏
            Controls.Add(webView);
            Program.Log("ctor: done");
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            try
            {
                float scale = 1f;
                using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f;
                int w = (int)(420 * scale), h = (int)(400 * scale);
                Rectangle wa = Screen.PrimaryScreen.WorkingArea;
                Size = new Size(w, h);
                Location = new Point(wa.Right - w - (int)(24 * scale), wa.Top + (int)(40 * scale));
                RestorePosition(); // 恢复上次窗口位置

                Program.Log("OnLoad: window effects");
                ApplyWindowEffects();
                ApplyRoundRegion(); // 近似 iOS 小组件的大圆角（20px）
                Program.Log("OnLoad: tray");
                InitTray();
                StartActivateListener();   // 第二个实例点开时把窗口叫出来
                Program.Log("OnLoad: done");
            }
            catch (Exception ex) { Program.Log("OnLoad: " + ex); }
            BootAsync();
        }

        // ---------- 启动 ----------
        private async void BootAsync()
        {
            try
            {
                EnsureServer();
                for (int i = 0; i < 40 && !PortOpen(); i++) await Task.Delay(500);
                Program.Log("Boot: port ready=" + PortOpen());

                // 先按已保存的主题定窗口底色，避免亮色主题启动时闪一下深色
                theme = ReadServerTheme();
                Program.Log("Boot: theme=" + theme + " pinned=" + settingsPinned);
                BackColor = ThemeBackdrop();
                if (webView != null) webView.DefaultBackgroundColor = ThemeBackdrop();

                // 上次是固定状态 → 这次启动直接挂回桌面层，不用再手动点一次图钉
                if (settingsPinned && !pinned) SetPinned(true);

                string dataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RemindersWidget", "WebView2");
                Directory.CreateDirectory(dataFolder);

                Program.Log("Boot: create env");
                CoreWebView2EnvironmentOptions envOpts = new CoreWebView2EnvironmentOptions();
                envOpts.AdditionalBrowserArguments = BROWSER_ARGS;
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, dataFolder, envOpts);
                Program.Log("Boot: env ok, ensure");
                await webView.EnsureCoreWebView2Async(env);
                webView.DefaultBackgroundColor = ThemeBackdrop();
                Program.Log("Boot: webview ready, bg=" + webView.DefaultBackgroundColor);

                // 低内存模式：小组件只有一屏静态列表，用内存换一点点响应速度很划算
                try
                {
                    webView.CoreWebView2.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Low;
                }
                catch (Exception mex) { Program.Log("LowMemory: " + mex.Message); }

                CoreWebView2Settings st = webView.CoreWebView2.Settings;
                st.AreDefaultContextMenusEnabled = false;
                st.AreBrowserAcceleratorKeysEnabled = false;

                // 页面里的外链（如 appleid.apple.com）交给系统浏览器
                webView.CoreWebView2.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs ev)
                {
                    try { Process.Start(new ProcessStartInfo(ev.Uri) { UseShellExecute = true }); } catch { }
                    ev.Handled = true;
                };

                webView.CoreWebView2.WebMessageReceived += OnWebMessage;

                // 页面加载完成后把「固定状态」补推给前端（恢复固定时按钮/光标要立刻对上）
                webView.CoreWebView2.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs ev)
                {
                    PushPinState();
                };

                // 页面第一帧之前就把主题写进去：亮色主题不会先闪一下深色
                string jsTheme = "try{var t='" + theme + "';document.documentElement.setAttribute('data-theme',t);localStorage.setItem('rw.theme',t);}catch(e){}";
                await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(jsTheme);

                webView.Source = new Uri(SERVER_URL);
                Program.Log("Boot: navigating");
            }
            catch (Exception ex)
            {
                Program.Log("Boot: " + ex);
                // WebView2 不可用 → 回退到 Edge 应用窗口
                DialogResult r = MessageBox.Show(
                    "无法初始化 WebView2：" + ex.Message + "\n\n是否改用 Edge 应用窗口打开小组件？",
                    "提醒事项小组件", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (r == DialogResult.Yes) OpenEdgeFallback();
            }
        }

        // ---------- 网页消息（固定 / 取消固定 / 拖动 / 隐藏） ----------
        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                object obj = ser.DeserializeObject(e.WebMessageAsJson);
                System.Collections.Generic.Dictionary<string, object> msg =
                    obj as System.Collections.Generic.Dictionary<string, object>;
                if (msg == null || !msg.ContainsKey("type")) return;
                string type = msg["type"] as string;
                if (type == "pin") SetPinned(true);
                else if (type == "unpin") SetPinned(false);
                else if (type == "drag") DragWindow();
                else if (type == "hide") Visible = false;
                else if (type == "theme")
                {
                    string v = msg.ContainsKey("value") ? (msg["value"] as string) : null;
                    SetTheme(v == "light" ? "light" : "dark");
                }
            }
            catch (Exception ex) { Program.Log("WebMessage: " + ex); }
        }

        private void DragWindow()
        {
            // 固定到桌面 = 锁定位置：固定状态下不响应拖动
            if (pinned) return;
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, IntPtr.Zero);
            SavePosition();
        }

        // ---------- 主题（页面切换明暗时同步窗口底色） ----------
        private void SetTheme(string next)
        {
            if (next != "light") next = "dark";
            if (next == theme) return;
            theme = next;
            ApplyWindowEffects();
            Program.Log("theme -> " + theme);
        }

        private string ReadServerTheme()
        {
            string t = "dark";
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(SERVER_URL + "api/settings");
                req.Timeout = 1500;
                req.ReadWriteTimeout = 1500;
                req.Method = "GET";
                using (WebResponse resp = req.GetResponse())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream()))
                {
                    JavaScriptSerializer ser = new JavaScriptSerializer();
                    Dictionary<string, object> root = ser.DeserializeObject(sr.ReadToEnd()) as Dictionary<string, object>;
                    if (root != null && root.ContainsKey("ui"))
                    {
                        Dictionary<string, object> ui = root["ui"] as Dictionary<string, object>;
                        if (ui != null && ui.ContainsKey("theme")) t = (ui["theme"] as string) == "light" ? "light" : "dark";
                        if (ui != null && ui.ContainsKey("pinned")) settingsPinned = Convert.ToBoolean(ui["pinned"]);
                    }
                }
            }
            catch (Exception ex) { Program.Log("ReadTheme: " + ex.Message); }
            return t;
        }

        /** 把「固定 / 取消固定」写回 settings.json，下次启动照上次状态恢复 */
        private static void PostPinned(bool pin)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(SERVER_URL + "api/settings");
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = 2500;
                req.ReadWriteTimeout = 2500;
                string body = "{\"ui\":{\"pinned\":" + (pin ? "true" : "false") + "}}";
                byte[] buf = Encoding.UTF8.GetBytes(body);
                req.ContentLength = buf.Length;
                using (Stream s = req.GetRequestStream()) s.Write(buf, 0, buf.Length);
                using (WebResponse r = req.GetResponse()) { }
                Program.Log("PostPinned: " + pin);
            }
            catch (Exception ex) { Program.Log("PostPinned: " + ex.Message); }
        }

        // ---------- 固定到桌面（挂到 WorkerW 桌面层） ----------
        private void SetPinned(bool pin)
        {
            if (pin == pinned) return;
            try
            {
                if (pin)
                {
                    IntPtr target = FindWorkerW();
                    savedStyle = GetWindowLongPtr(Handle, GWL_STYLE);
                    long style = savedStyle;
                    style |= WS_CHILD;
                    style &= ~WS_POPUP;
                    SetWindowLongPtr(Handle, GWL_STYLE, style);
                    SetParent(Handle, target);
                    pinned = true;
                }
                else
                {
                    SetParent(Handle, IntPtr.Zero);
                    long style = GetWindowLongPtr(Handle, GWL_STYLE);
                    style &= ~WS_CHILD;
                    style |= (savedStyle & WS_POPUP); // 无边框窗体原始为 WS_POPUP
                    SetWindowLongPtr(Handle, GWL_STYLE, style);
                    SetWindowPos(Handle, (IntPtr)0 /*HWND_TOP*/, 0, 0, 0, 0,
                        0x0002 | 0x0001 | 0x0040 /*NOMOVE|NOSIZE|SHOWWINDOW*/);
                    Activate();
                    pinned = false;
                }
                ApplyWindowEffects(); // SetParent 后重新应用窗口外观
                ApplyRoundRegion();
                if (miPin != null)
                {
                    miPin.Checked = pinned;
                    miPin.Text = pinned ? "取消固定（解锁后可拖动）" : "固定到桌面（锁定位置）";
                }
                PushPinState();
                if (pinned) SavePosition();
                bool np = pinned;
                Task.Run(delegate { PostPinned(np); });   // 记住状态，下次启动自动恢复
                Program.Log("SetPinned -> " + pinned);
            }
            catch (Exception ex) { Program.Log("SetPinned: " + ex); }
        }

        private void PushPinState()
        {
            try
            {
                if (webView != null && webView.CoreWebView2 != null)
                {
                    Task t = webView.CoreWebView2.ExecuteScriptAsync(
                        "window.setPinned && window.setPinned(" + (pinned ? "true" : "false") + ")");
                }
            }
            catch { }
        }

        /** 找到壁纸层 WorkerW（经典桌面挂件技术，与 Lively Wallpaper 同源） */
        private IntPtr FindWorkerW()
        {
            IntPtr progman = FindWindow("Progman", null);
            if (progman == IntPtr.Zero) { Program.Log("Progman not found"); return IntPtr.Zero; }

            // 通知 shell 生成 WorkerW（图标层与壁纸层分离）
            SendMessage(progman, WM_SPAWN_WORKER, IntPtr.Zero, IntPtr.Zero);

            IntPtr workerW = IntPtr.Zero;
            bool sawDefView = false;
            EnumWindows(delegate(IntPtr h, IntPtr l)
            {
                StringBuilder cls = new StringBuilder(256);
                GetClassName(h, cls, 256);
                string name = cls.ToString();
                if (name == "SHELLDLL_DefView") { sawDefView = true; return true; }
                if (sawDefView && name == "WorkerW") { workerW = h; return false; }
                return true;
            }, IntPtr.Zero);

            if (workerW == IntPtr.Zero)
            {
                Program.Log("WorkerW not found, fallback to Progman");
                return progman;
            }
            return workerW;
        }

        // ---------- 窗口外观（纯色卡片，无毛玻璃） ----------
        /// <summary>窗口底色与页面主题一致，加载瞬间不会闪色</summary>
        private Color ThemeBackdrop()
        {
            return theme == "light" ? Color.FromArgb(255, 255, 255) : Color.FromArgb(28, 28, 30);
        }

        private void ApplyWindowEffects()
        {
            try
            {
                BackColor = ThemeBackdrop();
                if (webView != null) webView.DefaultBackgroundColor = ThemeBackdrop();

                // Win11 圆角（DWMWCP_ROUND）
                int corner = 2;
                DwmSetWindowAttribute(Handle, 33, ref corner, 4);
                // 标题/边框配色跟随主题（不影响自绘内容）
                int darkTitle = theme == "light" ? 0 : 1;
                DwmSetWindowAttribute(Handle, 20, ref darkTitle, 4);
            }
            catch (Exception ex) { Program.Log("WindowEffects: " + ex); }
        }

        /// <summary>把窗口裁成 20px 圆角，贴合 iOS 小组件的外观</summary>
        private void ApplyRoundRegion()
        {
            try
            {
                float scale = 1f;
                using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f;
                int r = (int)(20 * scale);
                IntPtr rgn = CreateRoundRectRgn(0, 0, Width + 1, Height + 1, r * 2, r * 2);
                // 成功后由系统接管该 region，不要再 DeleteObject
                SetWindowRgn(Handle, rgn, true);
            }
            catch (Exception ex) { Program.Log("RoundRegion: " + ex); }
        }

        private static bool IsDarkTheme()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    if (k != null) return Convert.ToInt32(k.GetValue("AppsUseLightTheme", 1)) == 0;
                }
            }
            catch { }
            return true;
        }

        // ---------- 托盘 ----------
        private void InitTray()
        {
            ContextMenuStrip menu = new ContextMenuStrip();

            ToolStripMenuItem miShow = new ToolStripMenuItem("显示 / 隐藏小组件", null,
                delegate(object s, EventArgs e) { Visible = !Visible; });
            miPin = new ToolStripMenuItem("固定到桌面（锁定位置）", null,
                delegate(object s, EventArgs e) { SetPinned(!pinned); });
            ToolStripMenuItem miAuto = new ToolStripMenuItem("开机自动启动", null,
                delegate(object s, EventArgs e) { ToggleAutoStart((ToolStripMenuItem)s); });
            miAuto.Checked = IsAutoStart();
            ToolStripMenuItem miExit = new ToolStripMenuItem("退出", null,
                delegate(object s, EventArgs e) { Close(); });

            menu.Items.Add(miShow);
            menu.Items.Add(miPin);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(miAuto);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(miExit);

            tray = new NotifyIcon();
            tray.Icon = MakeIcon();
            tray.Text = "提醒事项小组件 V" + APP_VERSION;
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            tray.DoubleClick += delegate(object s, EventArgs e) { Visible = !Visible; };
        }

        private static Icon MakeIcon()
        {
            using (Bitmap bmp = new Bitmap(32, 32))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                // 与 assets/app.ico 同一套视觉：蓝色渐变圆角方块 + 白色对勾
                int pad = 1, box = 30, arc = 7, d = arc * 2;
                using (GraphicsPath p = new GraphicsPath())
                {
                    p.AddArc(pad, pad, d, d, 180, 90);
                    p.AddArc(pad + box - d, pad, d, d, 270, 90);
                    p.AddArc(pad + box - d, pad + box - d, d, d, 0, 90);
                    p.AddArc(pad, pad + box - d, d, d, 90, 90);
                    p.CloseFigure();
                    using (LinearGradientBrush bg = new LinearGradientBrush(
                        new Point(0, 0), new Point(32, 32),
                        Color.FromArgb(66, 161, 255), Color.FromArgb(0, 98, 212)))
                    {
                        g.FillPath(bg, p);
                    }
                }
                using (Pen pen = new Pen(Color.White, 3.6f))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    g.DrawLine(pen, 8.5f, 16.5f, 13.5f, 21.8f);
                    g.DrawLine(pen, 13.5f, 21.8f, 23.8f, 10.2f);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }

        // ---------- 单实例唤醒 ----------
        private void StartActivateListener()
        {
            try
            {
                _activateEvent = Program.CreateActivateEvent();
                Thread t = new Thread(ActivateLoop);
                t.IsBackground = true;
                t.Name = "activate-listener";
                t.Start();
                Program.Log("activate listener started");
            }
            catch (Exception ex) { Program.Log("activate listener: " + ex.Message); }
        }

        private void ActivateLoop()
        {
            while (true)
            {
                try
                {
                    if (!_activateEvent.WaitOne()) return;
                }
                catch { return; }

                // 事件来自后台线程，切回 UI 线程再动窗口
                try { BeginInvoke(new Action(RevealFromSecondInstance)); }
                catch (InvalidOperationException) { return; }   // 窗口句柄已释放
                catch { }
            }
        }

        private void RevealFromSecondInstance()
        {
            Program.Log("reveal from second instance");
            try
            {
                if (!Visible) Visible = true;
                Show();
                if (!pinned)
                {
                    if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                    Activate();
                    // TopMost 翻转是强制前置最可靠的办法，单纯 Activate 常被系统忽略
                    TopMost = true;
                    TopMost = false;
                    BringToFront();
                }
            }
            catch (Exception ex) { Program.Log("reveal: " + ex.Message); }
        }

        private static bool IsAutoStart()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Run"))
                {
                    return k != null && k.GetValue("RemindersWidget") != null;
                }
            }
            catch { return false; }
        }

        private void ToggleAutoStart(ToolStripMenuItem item)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Run"))
                {
                    if (item.Checked) k.DeleteValue("RemindersWidget", false);
                    else k.SetValue("RemindersWidget", "\"" + Application.ExecutablePath + "\"");
                    item.Checked = !item.Checked;
                }
            }
            catch (Exception ex) { Program.Log("AutoStart: " + ex); }
        }

        // ---------- 服务管理（无控制台窗口） ----------
        private static bool PortOpen()
        {
            try
            {
                using (TcpClient c = new TcpClient())
                {
                    c.Connect("127.0.0.1", SERVER_PORT);
                    return true;
                }
            }
            catch { return false; }
        }

        private static string FindNode()
        {
            // 安装版自带 node\node.exe（免安装 Node.js）；开发目录则退回系统 Node
            string exeDir = Application.StartupPath;
            string[] candidates = new string[]
            {
                Path.Combine(exeDir, @"node\node.exe"),
                Path.GetFullPath(Path.Combine(exeDir, @"..\node\node.exe")),
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
            };
            foreach (string c in candidates) if (File.Exists(c)) return c;
            return "node.exe"; // 尝试 PATH
        }

        private static string FindServerJs()
        {
            string exeDir = Application.StartupPath;
            string[] candidates = new string[]
            {
                Path.Combine(exeDir, @"..\server.js"),
                Path.Combine(exeDir, @"server.js"),
                Path.Combine(exeDir, @"..\..\server.js"),
                Path.Combine(Directory.GetCurrentDirectory(), "server.js"),
            };
            foreach (string c in candidates)
            {
                string full = Path.GetFullPath(c);
                if (File.Exists(full)) return full;
            }
            return null;
        }

        private static void EnsureServer()
        {
            if (PortOpen()) return;
            string script = FindServerJs();
            if (script == null)
            {
                Program.Log("server.js not found from " + Application.StartupPath);
                return;
            }
            try
            {
                // --max-semi-space-size=4：把 V8 新生代从 32MB 压到 8MB，服务进程 RSS 少 ~15MB
                ProcessStartInfo psi = new ProcessStartInfo(FindNode(),
                    "--max-semi-space-size=4 \"" + script + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;          // 关键：无任何控制台窗口
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.WorkingDirectory = Path.GetDirectoryName(script);
                Process p = Process.Start(psi);
                Program.Log("server started, pid=" + p.Id);
            }
            catch (Exception ex) { Program.Log("EnsureServer: " + ex); }
        }

        private static void OpenEdgeFallback()
        {
            string edge = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
            if (!File.Exists(edge)) edge = @"C:\Program Files\Microsoft\Edge\Application\msedge.exe";
            try
            {
                if (File.Exists(edge))
                    Process.Start(new ProcessStartInfo(edge,
                        "--app=" + SERVER_URL + " --window-size=420,760") { UseShellExecute = false });
                else
                    Process.Start(new ProcessStartInfo(SERVER_URL) { UseShellExecute = true });
            }
            catch (Exception ex) { Program.Log("EdgeFallback: " + ex); }
        }

        // ---------- 位置记忆 ----------
        private void SavePosition()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\RemindersWidget"))
                {
                    k.SetValue("X", Location.X.ToString());
                    k.SetValue("Y", Location.Y.ToString());
                }
            }
            catch { }
        }

        private void RestorePosition()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\RemindersWidget"))
                {
                    if (k == null) return;
                    int x = Convert.ToInt32(k.GetValue("X", int.MinValue));
                    int y = Convert.ToInt32(k.GetValue("Y", int.MinValue));
                    if (x != int.MinValue && y != int.MinValue)
                    {
                        // 确保落点在可见屏幕内
                        foreach (Screen s in Screen.AllScreens)
                        {
                            if (s.WorkingArea.Contains(new Point(x, y)))
                            {
                                Location = new Point(x, y);
                                return;
                            }
                        }
                    }
                }
            }
            catch { }
        }

        // ---------- 窗口事件 ----------
        private uint _taskbarCreatedMsg;

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            _taskbarCreatedMsg = RegisterWindowMessage("TaskbarCreated");
        }

        protected override void WndProc(ref Message m)
        {
            base.WndProc(ref m);
            // 资源管理器重启会销毁 WorkerW/Progman，导致固定失效 → 自动重新挂回桌面层
            if (_taskbarCreatedMsg != 0 && m.Msg == (int)_taskbarCreatedMsg && pinned)
            {
                Program.Log("explorer restarted, re-pinning");
                pinned = false;
                SetPinned(true);
            }
        }

        protected override void OnMove(EventArgs e)
        {
            base.OnMove(e);
            if (pinned) SavePosition();
        }

        /** 收进托盘时挂起 WebView2（渲染进程内存掉到 ~10MB），再显示时恢复 */
        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            if (webView == null || webView.CoreWebView2 == null) return;
            try
            {
                if (!Visible)
                {
                    webView.Visible = false;
                    Task<bool> t = webView.CoreWebView2.TrySuspendAsync();
                    Program.Log("webview suspend requested");
                }
                else
                {
                    webView.CoreWebView2.Resume();
                    webView.Visible = true;
                    Program.Log("webview resumed");
                }
            }
            catch (Exception ex) { Program.Log("VisibleChanged: " + ex.Message); }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            base.OnFormClosing(e);
            if (pinned)
            {
                // 先脱离桌面层，避免宿主进程退出时窗口成为孤儿
                try
                {
                    SetParent(Handle, IntPtr.Zero);
                    long style = GetWindowLongPtr(Handle, GWL_STYLE) & ~WS_CHILD;
                    SetWindowLongPtr(Handle, GWL_STYLE, style);
                }
                catch { }
            }
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
        }
    }
}
