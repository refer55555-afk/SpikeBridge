using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

internal sealed class SetupWindow : Form
{
    private readonly Button installButton;
    private readonly Button helpButton;
    private readonly Button closeButton;
    private readonly Label statusLabel;

    internal SetupWindow()
    {
        Text = "Bridge 安装助手";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(620, 330);
        MinimumSize = new Size(620, 330);
        Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;

        var title = new Label {
            AutoSize = false,
            Location = new Point(28, 24),
            Size = new Size(564, 36),
            Font = new Font(Font.FontFamily, 16F, FontStyle.Bold),
            Text = "安装 Bridge 管理面板"
        };
        var explanation = new Label {
            AutoSize = false,
            Location = new Point(30, 72),
            Size = new Size(560, 92),
            Text = "本助手只在您点击安装按钮后，请求 Windows 管理员确认，并调用项目中已审核的安装动作。\r\n\r\n它不会启动或停止 Spike Bridge，不会更改通道任务，也不会自动确认任何权限请求。"
        };

        installButton = new Button {
            Location = new Point(30, 180),
            Size = new Size(250, 42),
            Text = "安装面板开机任务（需确认）",
            UseVisualStyleBackColor = true
        };
        helpButton = new Button {
            Location = new Point(294, 180),
            Size = new Size(142, 42),
            Text = "浏览器问题说明",
            UseVisualStyleBackColor = true
        };
        closeButton = new Button {
            Location = new Point(450, 180),
            Size = new Size(140, 42),
            Text = "关闭",
            UseVisualStyleBackColor = true
        };
        statusLabel = new Label {
            AutoSize = false,
            Location = new Point(30, 244),
            Size = new Size(560, 58),
            ForeColor = Color.FromArgb(70, 70, 70),
            Text = "尚未执行安装。"
        };

        installButton.Click += InstallButtonClick;
        helpButton.Click += HelpButtonClick;
        closeButton.Click += delegate { Close(); };
        AcceptButton = installButton;
        CancelButton = closeButton;
        Controls.AddRange(new Control[] { title, explanation, installButton, helpButton, closeButton, statusLabel });
    }

    private static ProcessStartInfo CreateInstallStartInfo()
    {
        string operatorFolder = Path.GetDirectoryName(Application.ExecutablePath);
        string script = Path.Combine(operatorFolder, "scripts", "system.ps1");
        if (!File.Exists(script))
            throw new FileNotFoundException("未找到已审核的安装脚本：" + script, script);

        string powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            @"WindowsPowerShell\v1.0\powershell.exe");
        if (!File.Exists(powershell))
            throw new FileNotFoundException("未找到 Windows PowerShell：" + powershell, powershell);

        var info = new ProcessStartInfo();
        info.FileName = powershell;
        info.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\" -Action startupEnable";
        info.WorkingDirectory = operatorFolder;
        info.UseShellExecute = true;
        info.Verb = "runas";
        info.WindowStyle = ProcessWindowStyle.Normal;
        return info;
    }

    private async void InstallButtonClick(object sender, EventArgs e)
    {
        installButton.Enabled = false;
        statusLabel.ForeColor = Color.FromArgb(70, 70, 70);
        statusLabel.Text = "正在等待 Windows 管理员确认和安装结果……";
        try
        {
            using (Process process = Process.Start(CreateInstallStartInfo()))
            {
                if (process == null)
                    throw new InvalidOperationException("Windows 未能启动安装进程。");
                await Task.Run((Action)process.WaitForExit);
                if (process.ExitCode != 0)
                    throw new InvalidOperationException("安装脚本执行失败，退出代码：" + process.ExitCode + "。面板任务可能尚未安装。");
            }

            statusLabel.ForeColor = Color.FromArgb(24, 116, 54);
            statusLabel.Text = "安装脚本已成功完成。请返回面板重新检查任务状态；此结果不代表面板或通道已经启动。";
            MessageBox.Show(this,
                "安装脚本已成功完成。\r\n\r\n请返回 Bridge 面板重新检查“SpikeBridge-Operator”任务状态。",
                "安装完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Win32Exception error)
        {
            string message = error.NativeErrorCode == 1223
                ? "您取消了 Windows 管理员确认，未执行安装。"
                : "无法请求 Windows 管理员确认，未完成安装：" + error.Message;
            ShowFailure(message);
        }
        catch (Exception error)
        {
            ShowFailure(error.Message);
        }
        finally
        {
            installButton.Enabled = true;
        }
    }

    private void ShowFailure(string message)
    {
        statusLabel.ForeColor = Color.FromArgb(176, 42, 42);
        statusLabel.Text = message;
        MessageBox.Show(this, message, "安装未完成", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private void HelpButtonClick(object sender, EventArgs e)
    {
        MessageBox.Show(this,
            "Bridge 面板不会关闭或绕过 Codex Browser 沙箱。浏览器能力会在面板和发布验收中独立显示为已连接、未连接或待核验。\r\n\r\n如果 Browser 再次异常，请先查看 Bridge 的系统维护与日志；只有明确的官方修复动作才应请求管理员权限。",
            "Browser 说明", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupWindow());
    }
}
