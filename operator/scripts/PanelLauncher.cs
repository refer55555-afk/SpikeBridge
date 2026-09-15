using System;
using System.IO;
using System.Diagnostics;
using System.Windows.Forms;
using System.Reflection;
[assembly: AssemblyTitle("Bridge")]
[assembly: AssemblyDescription("Spike Bridge 本机管理窗口")]
[assembly: AssemblyVersion("1.0.0.0")]
internal static class Program {
    [STAThread] static void Main() {
        try {
            string folder = Path.GetDirectoryName(Application.ExecutablePath);
            string script = Path.Combine(folder, "scripts", "Start-Panel.ps1");
            if (!File.Exists(script)) throw new Exception("未找到控制台启动程序。");
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
            var info = new ProcessStartInfo(powershell, "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\"");
            info.UseShellExecute = false; info.CreateNoWindow = true; info.RedirectStandardError = true;
            using (var process = Process.Start(info)) {
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if(process.ExitCode != 0) throw new Exception("控制台启动失败，请查看后台日志。\n" + error);
            }
        } catch(Exception error) { MessageBox.Show(error.Message, "Bridge", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }
}
