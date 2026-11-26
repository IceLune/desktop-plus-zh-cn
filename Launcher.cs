using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace DesktopPlusLocalization
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherWindow());
        }
    }

    internal sealed class LauncherWindow : Form
    {
        private readonly TextBox _installPath = new TextBox();
        private readonly Button _browse = new Button();
        private readonly Button _apply = new Button();
        private readonly Button _restore = new Button();
        private readonly Button _launch = new Button();
        private readonly Label _status = new Label();

        internal LauncherWindow()
        {
            Text = "Desktop Plus 简体中文";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            Font = new Font("Segoe UI", 10F);
            AutoScaleMode = AutoScaleMode.Font;
            ClientSize = new Size(535, 230);
            MinimumSize = new Size(495, 255);
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Padding = new Padding(16);

            var layout = new TableLayoutPanel
            {
                ColumnCount = 2,
                RowCount = 4,
                Dock = DockStyle.Fill
            };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

            var pathLabel = new Label { Text = "Desktop Plus 安装目录", AutoSize = true };
            layout.Controls.Add(pathLabel, 0, 0);
            layout.SetColumnSpan(pathLabel, 2);

            _installPath.Text = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DesktopPlus");
            _installPath.ReadOnly = true;
            _installPath.AccessibleName = pathLabel.Text;
            _installPath.Anchor = AnchorStyles.Left | AnchorStyles.Right;
            layout.Controls.Add(_installPath, 0, 1);
            ConfigureButton(_browse, "浏览…", Browse);
            layout.Controls.Add(_browse, 1, 1);

            var actions = new FlowLayoutPanel
            {
                AutoSize = true,
                WrapContents = false,
                Dock = DockStyle.Fill,
                Margin = new Padding(0, 12, 0, 0)
            };
            ConfigureButton(_apply, "应用汉化", async (sender, args) => await UpdateStatusAsync("apply"));
            ConfigureButton(_restore, "恢复英文", async (sender, args) => await UpdateStatusAsync("uninstall"));
            ConfigureButton(_launch, "启动 Desktop Plus", Launch);
            actions.Controls.AddRange(new Control[] { _apply, _restore, _launch });
            layout.Controls.Add(actions, 0, 2);
            layout.SetColumnSpan(actions, 2);

            _status.Dock = DockStyle.Fill;
            _status.Margin = new Padding(3, 12, 3, 3);
            layout.Controls.Add(_status, 0, 3);
            layout.SetColumnSpan(_status, 2);
            Controls.Add(layout);
            Shown += async (sender, args) => await UpdateStatusAsync("check");
        }

        private static void ConfigureButton(Button button, string label, EventHandler onClick)
        {
            button.Text = label;
            button.AutoSize = true;
            button.Padding = new Padding(8, 3, 8, 3);
            button.Click += onClick;
        }

        private async void Browse(object sender, EventArgs args)
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择存放 Desktop Plus 各版本的安装目录。";
                dialog.ShowNewFolderButton = false;
                dialog.SelectedPath = _installPath.Text;
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    _installPath.Text = dialog.SelectedPath;
                    await UpdateStatusAsync("check");
                }
            }
        }

        private async Task UpdateStatusAsync(string command)
        {
            var directory = _installPath.Text;
            SetActionsEnabled(false);
            _status.Text = "正在检查或更新安装…";
            try
            {
                _status.Text = await Task.Run(() => Worker.Run(command, directory));
                if (command != "check")
                {
                    _status.Text += "\r\n请完全退出并重新启动 Desktop Plus 以切换语言。";
                }
            }
            catch (Exception error)
            {
                _status.Text = error.Message;
            }
            finally
            {
                SetActionsEnabled(true);
            }
        }

        private void SetActionsEnabled(bool enabled)
        {
            _browse.Enabled = enabled;
            _apply.Enabled = enabled;
            _restore.Enabled = enabled;
            _launch.Enabled = enabled;
        }

        private void Launch(object sender, EventArgs args)
        {
            try
            {
                var executable = Path.Combine(_installPath.Text, "DesktopPlus.exe");
                if (!File.Exists(executable))
                {
                    executable = Worker.FindElectron(_installPath.Text);
                }
                var process = Process.Start(executable);
                if (process != null)
                {
                    process.Dispose();
                }
            }
            catch (Exception error)
            {
                _status.Text = error.Message;
            }
        }
    }

    internal static class Worker
    {
        private const string Prefix = "ZH-CN: ";
        private const string Script = "desktop-plus-zh-cn.mjs";
        private static readonly string[] Files = { Script, "installation.cjs", "runtime.cjs", "zh-CN.json" };

        internal static string FindElectron(string directory)
        {
            if (!Directory.Exists(directory))
            {
                throw new InvalidOperationException("找不到安装目录，请选择 Desktop Plus 的安装位置。");
            }
            var executable = Directory.EnumerateDirectories(directory, "app-*")
                .Where(path => Regex.IsMatch(Path.GetFileName(path), @"^app-\d+\.\d+\.\d+(?:-[a-z][a-z0-9-]*)?$", RegexOptions.IgnoreCase))
                .OrderByDescending(Directory.GetLastWriteTimeUtc)
                .Select(path => Path.Combine(path, "DesktopPlus.exe"))
                .FirstOrDefault(File.Exists);
            if (executable == null)
            {
                throw new InvalidOperationException("此目录中没有找到已安装的 Desktop Plus。");
            }
            return executable;
        }

        internal static string Run(string command, string directory)
        {
            var executable = FindElectron(directory);
            var temporary = Path.Combine(Path.GetTempPath(), "DesktopPlus-zh-CN-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temporary);
            try
            {
                foreach (var name in Files)
                {
                    using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                    using (var destination = File.Create(Path.Combine(temporary, name)))
                    {
                        source.CopyTo(destination);
                    }
                }

                var startInfo = new ProcessStartInfo
                {
                    FileName = executable,
                    Arguments = Quote(Path.Combine(temporary, Script)) + " " + command + " " + Quote(directory),
                    WorkingDirectory = temporary,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };
                startInfo.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
                startInfo.EnvironmentVariables["DESKTOP_PLUS_ZH_CN_GUI"] = "1";

                using (var process = Process.Start(startInfo))
                {
                    var output = process.StandardOutput.ReadToEndAsync();
                    var errors = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(15000))
                    {
                        throw new InvalidOperationException("等待 Desktop Plus 的脚本运行时响应超时。");
                    }
                    if (process.ExitCode != 0)
                    {
                        var message = errors.GetAwaiter().GetResult().Trim();
                        throw new InvalidOperationException(string.IsNullOrEmpty(message)
                            ? "无法运行汉化工具。"
                            : message);
                    }

                    var lines = output.GetAwaiter().GetResult()
                        .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                        .Where(line => line.StartsWith(Prefix, StringComparison.Ordinal))
                        .Select(line => line.Substring(Prefix.Length));
                    var status = string.Join(Environment.NewLine, lines);
                    if (string.IsNullOrEmpty(status))
                    {
                        throw new InvalidOperationException("此版本未提供可用的脚本运行时，无法应用语言设置。");
                    }
                    return status;
                }
            }
            finally
            {
                foreach (var name in Files)
                {
                    File.Delete(Path.Combine(temporary, name));
                }
                Directory.Delete(temporary);
            }
        }

        private static string Quote(string path)
        {
            // Double trailing backslashes so Windows does not escape the closing quote.
            return "\"" + Regex.Replace(path, @"(\\+)$", "$1$1") + "\"";
        }
    }
}
