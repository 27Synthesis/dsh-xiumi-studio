// 秀米工作台 · 便携启动器（编译后就是 dist\秀米工作台.exe）
//
// 作用只有三条，全部是这台机器上真实踩过的坑：
//   1. 清掉 ELECTRON_RUN_AS_NODE —— DSH 环境里带着它，Electron 会把自己当 node 跑；
//   2. 补 --no-sandbox —— 不带这个参数，Chromium 在这套运行时上启动即 0x80000003；
//   3. 把 cwd 挪到 %TEMP% —— 输入法会往 cwd 丢 debug.log，别脏了程序目录。
// 图标用 csc /win32icon 打进本 exe（tools/make-icon.py 画的），所以资源管理器里看到的就是它。
//
// 只依赖 .NET Framework 自带的 System.Windows.Forms（Windows 10/11 自带 v4.8）。

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace XiumiStudio
{
    internal static class Launcher
    {
        private const string CoreExe = "dsh-xiumi.exe";

        [STAThread]
        private static int Main(string[] args)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string core = Path.Combine(baseDir, CoreExe);

            if (!File.Exists(core))
            {
                MessageBox.Show(
                    "找不到 " + CoreExe + "。\n\n它应该和本程序在同一个文件夹里。\n如果只拷了这一个 exe，请把整个文件夹一起拷过去。\n\n当前目录：" + baseDir,
                    "秀米工作台 · 启动失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 2;
            }

            var sb = new StringBuilder();
            bool hasNoSandbox = false;
            foreach (string a in args)
            {
                if (string.Equals(a, "--no-sandbox", StringComparison.OrdinalIgnoreCase)) hasNoSandbox = true;
            }
            if (!hasNoSandbox) sb.Append("--no-sandbox");
            foreach (string a in args)
            {
                if (sb.Length > 0) sb.Append(' ');
                sb.Append(QuoteArg(a));
            }

            var psi = new ProcessStartInfo(core, sb.ToString());
            psi.UseShellExecute = false;
            psi.WorkingDirectory = Path.GetTempPath();
            try { psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE"); }
            catch { /* 老 .NET 上极少数情况取不到，忽略 */ }

            try
            {
                using (Process p = Process.Start(psi))
                {
                    if (p == null) return 3;
                    // 跟着等：用户在任务管理器里关掉启动器就等于关掉程序，行为一致
                    p.WaitForExit();
                    return p.ExitCode;
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "启动 " + CoreExe + " 失败：\n\n" + ex.Message,
                    "秀米工作台 · 启动失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 4;
            }
        }

        // Windows 命令行不需要的引号就别加，路径里有空格才包双引号
        private static string QuoteArg(string a)
        {
            if (a == null) return "\"\"";
            if (a.Length == 0) return "\"\"";
            if (a.IndexOf(' ') < 0 && a.IndexOf('\t') < 0 && a.IndexOf('"') < 0 && a.IndexOf('&') < 0
                && a.IndexOf('^') < 0 && a.IndexOf('|') < 0 && a.IndexOf('<') < 0 && a.IndexOf('>') < 0)
                return a;
            return "\"" + a.Replace("\"", "\\\"") + "\"";
        }
    }
}
