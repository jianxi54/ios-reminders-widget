// 提醒事项小组件 · 安装程序
// 目标框架 .NET Framework 4.8（Windows 10 1809+ / Windows 11 自带），免管理员权限。
// 安装载荷 payload.zip 以嵌入资源方式打进本 exe，运行时解压到用户目录。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace RemindersSetup
{
    internal static class Program
    {
        public const string AppName = "提醒事项小组件";
        public const string AppId = "RemindersWidget";
        public const string ExeName = "RemindersWidget.exe";
        public const string RunValueName = "RemindersWidget";

        // WebView2 Evergreen Runtime 的固定产品 ID
        private const string WebView2ClientId = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

        public static readonly string DefaultDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            @"Programs\RemindersWidget");

        [STAThread]
        private static void Main(string[] args)
        {
            Args a = Args.Parse(args);

            if (a.Purge) { Purge(a); return; }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

#if UNINSTALLER
            // 同一份源码编译出的独立卸载器：不带安装载荷，任何调用都走卸载
            a.Uninstall = true;
            Uninstall(a);
            return;
#else
            if (a.Uninstall) { Uninstall(a); return; }

            // 静默安装：不显示界面，直接落地，便于脚本化部署与自动化测试
            if (a.Silent)
            {
                try
                {
                    Installer.Run(a.Dir, InstallOptions.From(a), null);
                    Environment.Exit(0);
                }
                catch (Exception ex)
                {
                    try
                    {
                        File.WriteAllText(Path.Combine(Path.GetTempPath(), "rw-setup-error.log"), ex.ToString());
                    }
                    catch { }
                    Environment.Exit(1);
                }
            }

            Application.Run(new InstallForm(a));
#endif
        }

        /* ---------------- 运行中的进程 ---------------- */

        public static void KillRunning()
        {
            try
            {
                foreach (Process p in Process.GetProcessesByName("RemindersWidget"))
                {
                    try { p.Kill(); p.WaitForExit(2000); } catch { }
                }
            }
            catch { }

            int pid = FindPortOwner(8642);
            if (pid > 0)
            {
                try { Process.GetProcessById(pid).Kill(); } catch { }
            }
            Thread.Sleep(500);
        }

        private static int FindPortOwner(int port)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("netstat", "-ano");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                using (Process p = Process.Start(psi))
                {
                    string outp = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(3000);
                    foreach (string raw in outp.Split('\n'))
                    {
                        string line = raw.Trim();
                        if (line.IndexOf(":" + port, StringComparison.Ordinal) < 0) continue;
                        if (line.IndexOf("LISTEN", StringComparison.OrdinalIgnoreCase) < 0) continue;
                        string[] parts = line.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length < 4) continue;
                        int pid;
                        if (int.TryParse(parts[parts.Length - 1], out pid)) return pid;
                    }
                }
            }
            catch { }
            return 0;
        }

        /* ---------------- 解压载荷 ---------------- */

        public static void ExtractPayload(string dir, Action<int> progress)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            {
                if (s == null) throw new InvalidOperationException("安装包损坏：缺少 payload.zip");

                using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
                {
                    long total = 0;
                    foreach (ZipArchiveEntry e in zip.Entries) total += Math.Max(0, e.Length);
                    if (total <= 0) total = 1;

                    string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
                    long done = 0;
                    int lastPct = -1;
                    byte[] buf = new byte[128 * 1024];

                    foreach (ZipArchiveEntry e in zip.Entries)
                    {
                        if (e.FullName.EndsWith("/")) continue;

                        string dest = Path.GetFullPath(Path.Combine(dir, e.FullName.Replace('/', '\\')));
                        if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue; // 防目录穿越

                        string parent = Path.GetDirectoryName(dest);
                        if (!Directory.Exists(parent)) Directory.CreateDirectory(parent);

                        using (Stream src = e.Open())
                        using (FileStream fs = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            int n;
                            while ((n = src.Read(buf, 0, buf.Length)) > 0)
                            {
                                fs.Write(buf, 0, n);
                                done += n;
                                if (progress != null)
                                {
                                    int pct = (int)(done * 100 / total);
                                    if (pct != lastPct) { lastPct = pct; progress(pct); }
                                }
                            }
                        }
                    }
                }
            }
        }

        /* ---------------- 快捷方式 ---------------- */

        public static void CreateShortcuts(string dir)
        {
            string target = Path.Combine(dir, @"host\" + ExeName);
            if (!File.Exists(target)) return;

            string startMenu = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk");

            string desktop = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk");

            CreateShortcut(startMenu, target, dir);
            CreateShortcut(desktop, target, dir);
        }

        private static void CreateShortcut(string lnkPath, string target, string workDir)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return;
                object shell = Activator.CreateInstance(shellType);
                object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                Type st = shortcut.GetType();
                st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
                st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workDir });
                st.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { target + ",0" });
                st.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { AppName });
                st.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            catch { }
        }

        public static void RemoveShortcuts()
        {
            try
            {
                string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk");
                string desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk");
                if (File.Exists(startMenu)) File.Delete(startMenu);
                if (File.Exists(desktop)) File.Delete(desktop);
            }
            catch { }
        }

        /* ---------------- 注册表 ---------------- */

        public static void WriteRegistry(string dir, string uninstaller)
        {
            const string uninstKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppId;
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(uninstKey))
            {
                k.SetValue("DisplayName", AppName);
                k.SetValue("DisplayVersion", BuildInfo.Version);
                k.SetValue("Publisher", "RemindersWidget");
                k.SetValue("DisplayIcon", Path.Combine(dir, @"host\" + ExeName) + ",0");
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", "\"" + uninstaller + "\" --uninstall");
                k.SetValue("QuietUninstallString", "\"" + uninstaller + "\" --uninstall --silent");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, DirSize(dir) / 1024), RegistryValueKind.DWord);
            }
        }

        public static void SetAutostart(bool on, string dir)
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (k == null) return;
                    if (on) k.SetValue(RunValueName, "\"" + Path.Combine(dir, @"host\" + ExeName) + "\"");
                    else if (k.GetValue(RunValueName) != null) k.DeleteValue(RunValueName, false);
                }
            }
            catch { }
        }

        public static string ReadInstalledDir()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppId))
                {
                    if (k == null) return null;
                    string d = k.GetValue("InstallLocation") as string;
                    if (!string.IsNullOrEmpty(d) && Directory.Exists(d)) return d;
                    string u = k.GetValue("UninstallString") as string;
                    if (!string.IsNullOrEmpty(u))
                    {
                        u = u.Trim();
                        if (u.StartsWith("\"")) u = u.Substring(1, u.IndexOf('"', 1) - 1);
                        else u = u.Split(' ')[0];
                        string dd = Path.GetDirectoryName(u);
                        if (!string.IsNullOrEmpty(dd) && Directory.Exists(dd)) return dd;
                    }
                }
            }
            catch { }
            return null;
        }

        public static string ReadInstalledVersion()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppId))
                {
                    if (k == null) return null;
                    return k.GetValue("DisplayVersion") as string;
                }
            }
            catch { }
            return null;
        }

        public static void RemoveRegistry()
        {
            try { Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppId, false); } catch { }
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (k != null && k.GetValue(RunValueName) != null) k.DeleteValue(RunValueName, false);
                }
            }
            catch { }
        }

        /* ---------------- WebView2 ---------------- */

        public static bool HasWebView2()
        {
            string[] paths = new string[]
            {
                @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\" + WebView2ClientId,
                @"SOFTWARE\Microsoft\EdgeUpdate\Clients\" + WebView2ClientId,
            };
            foreach (RegistryKey root in new RegistryKey[] { Registry.LocalMachine, Registry.CurrentUser })
            {
                foreach (string p in paths)
                {
                    try
                    {
                        using (RegistryKey k = root.OpenSubKey(p))
                        {
                            if (k == null) continue;
                            string pv = k.GetValue("pv") as string;
                            if (!string.IsNullOrEmpty(pv) && pv != "0.0.0.0") return true;
                        }
                    }
                    catch { }
                }
            }
            return false;
        }

        /* ---------------- 工具 ---------------- */

        public static long DirSize(string dir)
        {
            long total = 0;
            try
            {
                foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                {
                    try { total += new FileInfo(f).Length; } catch { }
                }
            }
            catch { }
            return total;
        }

        public static void DeleteTree(string dir)
        {
            for (int i = 0; i < 3; i++)
            {
                try
                {
                    if (!Directory.Exists(dir)) return;
                    Directory.Delete(dir, true);
                    return;
                }
                catch
                {
                    Thread.Sleep(400);
                    try
                    {
                        ProcessStartInfo psi = new ProcessStartInfo("cmd.exe",
                            "/c rmdir /s /q \"" + dir + "\"");
                        psi.UseShellExecute = false;
                        psi.CreateNoWindow = true;
                        Process.Start(psi).WaitForExit(4000);
                    }
                    catch { }
                }
            }
        }

        public static void SelfDelete()
        {
            try
            {
                string self = Application.ExecutablePath;
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe",
                    "/c ping -n 3 127.0.0.1 >nul & del /f /q \"" + self + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
            }
            catch { }
        }

        /* ---------------- 卸载 ---------------- */

        private static void Uninstall(Args a)
        {
            // 以注册表记录的安装位置为准（用户可能装在任意目录），参数里的路径只作兜底
            string dir = Program.ReadInstalledDir();
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) dir = a.Dir;
            if (string.IsNullOrEmpty(dir)) dir = Program.DefaultDir;

            if (!Directory.Exists(dir))
            {
                if (!a.Silent)
                {
                    MessageBox.Show("没有找到已安装的「" + AppName + "」。", "卸载",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                return;
            }

            if (!a.Silent)
            {
                DialogResult r = MessageBox.Show(
                    "确定要卸载「" + AppName + "」吗？\n\n" +
                    "· iCloud 里的提醒事项不会被删除\n" +
                    "· 本机的登录状态、设置与推送记录会被清除",
                    "卸载 " + AppName,
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
                if (r != DialogResult.OK) return;
            }

            // 卸载动作交给临时副本完成，避免删到自己所在的目录
            try
            {
                string tmp = Path.Combine(Path.GetTempPath(), "rw-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
                File.Copy(Application.ExecutablePath, tmp, true);
                ProcessStartInfo psi = new ProcessStartInfo(tmp,
                    "--purge --silent \"" + dir + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("卸载失败：" + ex.Message, "卸载", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            if (!a.Silent)
            {
                MessageBox.Show("正在卸载，稍后窗口会自动关闭。", "卸载",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        private static void Purge(Args a)
        {
            string dir = a.Dir;
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
            {
                dir = ReadInstalledDir() ?? DefaultDir;
            }

            Thread.Sleep(500);
            KillRunning();
            RemoveShortcuts();
            RemoveRegistry();

            // 本地数据：登录会话、设置、推送记录、WebView2 缓存
            try
            {
                string data = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RemindersWidget");
                KillRunning();
                DeleteTree(data);
            }
            catch { }

            DeleteTree(dir);

            if (!a.Silent)
            {
                MessageBox.Show("「" + AppName + "」已卸载。", "卸载完成",
                    MessageBoxButtons.OK, MessageBoxIcon.Information,
                    MessageBoxDefaultButton.Button1, MessageBoxOptions.DefaultDesktopOnly);
            }

            SelfDelete();
        }
    }

    /* ---------------- 安装流程（界面与静默共用） ---------------- */

    internal sealed class InstallOptions
    {
        public bool Shortcut = true;
        public bool Autostart = true;

        public static InstallOptions From(Args a)
        {
            InstallOptions o = new InstallOptions();
            o.Shortcut = !a.NoShortcut;
            o.Autostart = !a.NoAutostart;
            return o;
        }
    }

    internal static class Installer
    {
        public static void Run(string dir, InstallOptions opt, Action<int, string> report)
        {
            Action<int, string> r = report != null ? report : delegate (int p, string s) { };

            r(0, "正在准备目录…");
            Directory.CreateDirectory(dir);

            r(1, "正在关闭正在运行的旧版本…");
            Program.KillRunning();

            r(2, "正在解压文件…");
            Program.ExtractPayload(dir, delegate (int pct)
            {
                r(2 + pct * 88 / 100, "正在解压文件… " + pct + "%");
            });

            string uninstaller = Path.Combine(dir, "Uninstall.exe");
            if (!File.Exists(uninstaller))
            {
                // 兜底：载荷里缺少独立卸载器时，用安装器自身顶上
                try
                {
                    string self = Application.ExecutablePath;
                    if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(uninstaller), StringComparison.OrdinalIgnoreCase))
                        File.Copy(self, uninstaller, true);
                }
                catch { }
            }

            r(92, "正在创建快捷方式…");
            Program.RemoveShortcuts();
            if (opt != null && opt.Shortcut) Program.CreateShortcuts(dir);

            r(95, "正在写入卸载信息…");
            Program.WriteRegistry(dir, uninstaller);

            r(97, "正在设置开机启动…");
            Program.SetAutostart(opt == null || opt.Autostart, dir);

            r(100, "安装完成");
        }
    }

    /* ---------------- 参数 ---------------- */

    internal sealed class Args
    {
        public bool Silent;
        public bool NoShortcut;
        public bool NoAutostart;
        public bool NoLaunch;
        public bool Uninstall;
        public bool Purge;
        public string Dir;

        public static Args Parse(string[] argv)
        {
            Args a = new Args();
            a.Dir = Program.DefaultDir;
            if (argv == null) return a;

            for (int i = 0; i < argv.Length; i++)
            {
                string s = argv[i];
                if (s == null) continue;
                string lower = s.ToLowerInvariant();

                if (lower == "--silent" || lower == "/s") a.Silent = true;
                else if (lower == "--uninstall" || lower == "/uninstall") a.Uninstall = true;
                else if (lower == "--purge") a.Purge = true;
                else if (lower == "--no-shortcut") a.NoShortcut = true;
                else if (lower == "--no-autostart") a.NoAutostart = true;
                else if (lower == "--no-launch") a.NoLaunch = true;
                else if (lower.StartsWith("--dir=")) a.Dir = s.Substring(6).Trim('"');
                else if (lower == "--dir" && i + 1 < argv.Length) a.Dir = argv[++i].Trim('"');
                else if (Directory.Exists(s) && s.IndexOf('\\') > 0) a.Dir = s; // 拖入目录或直接传路径
            }
            if (string.IsNullOrEmpty(a.Dir)) a.Dir = Program.DefaultDir;
            return a;
        }
    }

    /* ---------------- 安装界面 ---------------- */

    internal sealed class InstallForm : Form
    {
        private readonly Args args;
        private TextBox txtDir;
        private CheckBox chkShortcut;
        private CheckBox chkAutostart;
        private CheckBox chkLaunch;
        private Label lblStatus;
        private Label lblHint;
        private ProgressBar bar;
        private Button btnInstall;
        private Button btnCancel;
        private bool working;
        private bool installed;

        public InstallForm(Args a)
        {
            args = a;

            Text = Program.AppName + " 安装程序";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(524, 428);
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 9F);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            PictureBox logo = new PictureBox();
            logo.Location = new Point(24, 22);
            logo.Size = new Size(48, 48);
            logo.SizeMode = PictureBoxSizeMode.Zoom;
            try { logo.Image = Icon.ExtractAssociatedIcon(Application.ExecutablePath).ToBitmap(); } catch { }
            Controls.Add(logo);

            Label title = new Label();
            title.Text = Program.AppName;
            title.Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(20, 20, 22);
            title.AutoSize = true;
            title.Location = new Point(84, 24);
            Controls.Add(title);

            Label sub = new Label();
            sub.Text = "在 Windows 桌面上同步、管理 iPhone 提醒事项  ·  " + BuildInfo.Version;
            sub.ForeColor = Color.FromArgb(120, 120, 128);
            sub.AutoSize = true;
            sub.Location = new Point(86, 56);
            Controls.Add(sub);

            Label line = new Label();
            line.BorderStyle = BorderStyle.Fixed3D;
            line.Location = new Point(24, 88);
            line.Size = new Size(476, 2);
            Controls.Add(line);

            Label l1 = new Label();
            l1.Text = "安装位置";
            l1.ForeColor = Color.FromArgb(60, 60, 67);
            l1.AutoSize = true;
            l1.Location = new Point(24, 104);
            Controls.Add(l1);

            txtDir = new TextBox();
            txtDir.Text = a.Dir;
            txtDir.Location = new Point(24, 128);
            txtDir.Size = new Size(388, 26);
            txtDir.BorderStyle = BorderStyle.FixedSingle;
            Controls.Add(txtDir);

            Button browse = new Button();
            browse.Text = "浏览…";
            browse.Location = new Point(420, 127);
            browse.Size = new Size(80, 28);
            browse.FlatStyle = FlatStyle.System;
            browse.Click += delegate
            {
                using (FolderBrowserDialog d = new FolderBrowserDialog())
                {
                    d.Description = "选择安装位置";
                    d.SelectedPath = txtDir.Text;
                    if (d.ShowDialog(this) == DialogResult.OK) txtDir.Text = d.SelectedPath;
                }
            };
            Controls.Add(browse);

            chkShortcut = MakeCheck("创建桌面快捷方式", 172, true);
            chkAutostart = MakeCheck("开机自动启动（推荐，随系统静默出现）", 198, true);
            chkLaunch = MakeCheck("安装完成后立即运行", 224, true);

            lblHint = new Label();
            lblHint.Location = new Point(24, 258);
            lblHint.Size = new Size(476, 40);
            lblHint.ForeColor = Color.FromArgb(120, 120, 128);
            lblHint.Font = new Font("Microsoft YaHei UI", 8.5F);

            string installedVersion = Program.ReadInstalledVersion();
            string webview = Program.HasWebView2() ? "" : "未检测到 WebView2 运行时，Windows 11 自带；Windows 10 请先安装后再使用。";
            if (!string.IsNullOrEmpty(installedVersion))
                lblHint.Text = "检测到已安装版本 " + installedVersion + "，继续将覆盖升级。";
            else
                lblHint.Text = webview;
            Controls.Add(lblHint);

            bar = new ProgressBar();
            bar.Location = new Point(24, 314);
            bar.Size = new Size(476, 6);
            bar.Style = ProgressBarStyle.Continuous;
            bar.Minimum = 0;
            bar.Maximum = 100;
            Controls.Add(bar);

            lblStatus = new Label();
            lblStatus.Text = "准备就绪";
            lblStatus.ForeColor = Color.FromArgb(120, 120, 128);
            lblStatus.AutoSize = true;
            lblStatus.Location = new Point(24, 326);
            Controls.Add(lblStatus);

            btnInstall = new Button();
            btnInstall.Text = "安装";
            btnInstall.Location = new Point(340, 366);
            btnInstall.Size = new Size(80, 32);
            btnInstall.FlatStyle = FlatStyle.System;
            btnInstall.Click += delegate
            {
                if (installed) { Close(); return; }
                StartInstall();
            };
            Controls.Add(btnInstall);

            btnCancel = new Button();
            btnCancel.Text = "取消";
            btnCancel.Location = new Point(428, 366);
            btnCancel.Size = new Size(80, 32);
            btnCancel.FlatStyle = FlatStyle.System;
            btnCancel.Click += delegate { Close(); };
            Controls.Add(btnCancel);

            ActiveControl = btnInstall;
        }

        private CheckBox MakeCheck(string text, int y, bool value)
        {
            CheckBox c = new CheckBox();
            c.Text = text;
            c.Location = new Point(24, y);
            c.AutoSize = true;
            c.Checked = value;
            c.ForeColor = Color.FromArgb(40, 40, 44);
            Controls.Add(c);
            return c;
        }

        private void StartInstall()
        {
            string dir = (txtDir.Text ?? "").Trim().Trim('"');
            if (dir.Length == 0) { MessageBox.Show("请填写安装位置。", "提示"); return; }
            try
            {
                dir = Path.GetFullPath(dir);
            }
            catch
            {
                MessageBox.Show("安装路径不合法。", "提示");
                return;
            }

            if (Directory.Exists(dir) && Directory.GetFileSystemEntries(dir).Length > 0)
            {
                // 允许覆盖升级；不是本程序的目录则提醒一次
                if (string.IsNullOrEmpty(Program.ReadInstalledDir()) ||
                    !string.Equals(Path.GetFullPath(Program.ReadInstalledDir()), dir, StringComparison.OrdinalIgnoreCase))
                {
                    DialogResult r = MessageBox.Show(
                        "目标目录不是空的，继续会覆盖同名文件：\n" + dir + "\n\n是否继续？",
                        "确认", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
                    if (r != DialogResult.OK) return;
                }
            }

            working = true;
            SetBusy(true);
            lblStatus.Text = "正在安装…";
            bar.Value = 0;

            Thread th = new Thread(delegate () { DoInstall(dir); });
            th.IsBackground = true;
            th.Start();
        }

        private void DoInstall(string dir)
        {
            try
            {
                InstallOptions opt = new InstallOptions();
                opt.Shortcut = chkShortcut.Checked;
                opt.Autostart = chkAutostart.Checked;

                Installer.Run(dir, opt, delegate (int p, string s) { Report(p, s); });
                Thread.Sleep(300);

                BeginInvoke((Action)delegate
                {
                    working = false;
                    installed = true;
                    lblStatus.Text = "安装完成";
                    btnInstall.Text = "完成";
                    btnCancel.Visible = false;
                    btnInstall.Enabled = true;

                    if (chkLaunch.Checked)
                    {
                        try
                        {
                            string target = Path.Combine(dir, @"host\" + Program.ExeName);
                            if (File.Exists(target))
                                Process.Start(new ProcessStartInfo(target, "") { WorkingDirectory = dir });
                        }
                        catch { }
                    }
                });
            }
            catch (Exception ex)
            {
                BeginInvoke((Action)delegate
                {
                    working = false;
                    SetBusy(false);
                    lblStatus.Text = "安装失败";
                    MessageBox.Show("安装失败：\n" + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                });
            }
        }

        private void Report(int pct, string text)
        {
            if (pct < 0) pct = 0;
            if (pct > 100) pct = 100;
            try
            {
                BeginInvoke((Action)delegate
                {
                    bar.Value = pct;
                    lblStatus.Text = text;
                });
            }
            catch { }
        }

        private void SetBusy(bool busy)
        {
            txtDir.Enabled = !busy;
            chkShortcut.Enabled = !busy;
            chkAutostart.Enabled = !busy;
            chkLaunch.Enabled = !busy;
            btnInstall.Enabled = !busy;
            foreach (Control c in Controls)
            {
                Button b = c as Button;
                if (b != null && b != btnInstall && b != btnCancel) b.Enabled = !busy;
            }
        }
    }
}
