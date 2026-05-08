// cef-subprocess-wrapper.cs
// CEF 子进程包装器：在调用真正的 bootstrap.exe 之前注入 --bootstrap-module-name=libcef
//
// 问题：CEF 不会将 --bootstrap-module-name 开关转发给子进程，
// 导致 bootstrap.exe 报 "Missing module name" 错误并崩溃。
// 解决：用此包装器替代 bootstrap.exe 作为 browser_subprocess_path，
// 它会在命令行中注入 --bootstrap-module-name=libcef，然后调用真正的 bootstrap.exe。
//
// 编译: csc /out:cef-subprocess.exe /platform:x64 cef-subprocess-wrapper.cs
// 然后放在 Release/ 目录下，设置 browser_subprocess_path 指向此文件

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

class Program
{
    static int Main(string[] args)
    {
        // 找到同目录下的 bootstrap.exe
        string wrapperDir = AppDomain.CurrentDomain.BaseDirectory;
        string bootstrapPath = Path.Combine(wrapperDir, "bootstrap.exe");

        if (!File.Exists(bootstrapPath))
        {
            Console.Error.WriteLine("[CEF-Subprocess] ERROR: bootstrap.exe not found at: " + bootstrapPath);
            return 1;
        }

        // 检查是否已有 --bootstrap-module-name 参数
        bool hasModuleName = args.Any(a =>
            a.StartsWith("--bootstrap-module-name=", StringComparison.OrdinalIgnoreCase) ||
            a.Equals("--bootstrap-module-name", StringComparison.OrdinalIgnoreCase));

        // 构建新的参数列表
        var newArgs = new System.Collections.Generic.List<string>(args);
        if (!hasModuleName)
        {
            newArgs.Insert(0, "--bootstrap-module-name=libcef");
        }

        // 构建命令行字符串
        string cmdLine = "\"" + bootstrapPath + "\"";
        foreach (string arg in newArgs)
        {
            // 简单的引号转义：如果参数包含空格，用双引号括起来
            if (arg.Contains(' ') && !arg.StartsWith("\""))
            {
                cmdLine += " \"" + arg + "\"";
            }
            else
            {
                cmdLine += " " + arg;
            }
        }

        // 使用 CreateProcess 启动 bootstrap.exe
        var psi = new ProcessStartInfo
        {
            FileName = bootstrapPath,
            Arguments = string.Join(" ", newArgs.Select(a =>
                a.Contains(' ') && !a.StartsWith("\"") ? "\"" + a + "\"" : a)),
            UseShellExecute = false,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
            CreateNoWindow = true
        };

        // 继承当前进程的环境变量（包括 CEF_BOOTSTRAP_MODULE_NAME）
        foreach (System.Collections.DictionaryEntry env in Environment.GetEnvironmentVariables())
        {
            psi.Environment[env.Key.ToString()] = env.Value?.ToString() ?? "";
        }

        try
        {
            var process = new Process { StartInfo = psi };
            process.Start();
            process.WaitForExit();
            return process.ExitCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[CEF-Subprocess] ERROR: " + ex.Message);
            return 1;
        }
    }
}
