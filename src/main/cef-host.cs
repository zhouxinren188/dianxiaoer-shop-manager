// cef-host.cs - CEF 宿主进程（C# 版本）
//
// 替代 Node.js 版本（cef-host.js），因为 Node.js 进程与 CEF Windows 消息循环不兼容。
// 在 Node.js 中所有消息循环方案（setImmediate, 紧密轮询, cef_run_message_loop）
// 都导致 CEF 窗口"未响应"，而 C# 进程中 CEF 正常工作。
//
// 编译: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /out:cef-host.exe /platform:x64 cef-host.cs
// 运行: cef-host.exe --hwnd=0xXXXX --url=URL --cef-dir=PATH [options]
//
// IPC 协议: stdin/stdout JSON 行协议（与 Node.js 版本兼容）
//   输入: {"id":1,"method":"navigate","params":{"url":"https://..."}}
//   输出: {"type":"response","id":1,"result":true}
//   输出: {"type":"event","event":"load_end","params":{...}}
//   输出: {"type":"ready"}

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

class CefHost
{
    // ======================== P/Invoke 声明 ========================

    [DllImport("libcef.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr cef_api_hash(int version, int entry);

    [DllImport("libcef.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int cef_api_version();

    [DllImport("libcef.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int cef_execute_process(IntPtr args, IntPtr app, IntPtr sandboxInfo);

    [DllImport("libcef.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int cef_initialize(IntPtr args, IntPtr settings, IntPtr app, IntPtr sandboxInfo);

    [DllImport("libcef.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern void cef_shutdown();

    [DllImport("libcef.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern void cef_do_message_loop_work();

    [DllImport("libcef.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int cef_browser_host_create_browser(
        IntPtr windowInfo, IntPtr client, IntPtr url,
        IntPtr settings, IntPtr extraInfo, IntPtr requestContext);

    [DllImport("libcef.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern int cef_string_utf16_set(IntPtr src, UIntPtr srcLen, IntPtr output, int copy);

    [DllImport("libcef.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern void cef_string_userfree_utf16_free(IntPtr str);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetModuleHandle(IntPtr lpModuleName);

    // Windows 消息泵 P/Invoke
    [DllImport("user32.dll")]
    static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

    [DllImport("user32.dll")]
    static extern bool TranslateMessage(ref MSG msg);

    [DllImport("user32.dll")]
    static extern IntPtr DispatchMessage(ref MSG msg);

    const uint PM_REMOVE = 1;
    const uint WM_QUIT = 0x0012;

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    // ======================== 委托类型 ========================

    delegate void AddRefDelegate(IntPtr self);
    delegate int ReleaseDelegate(IntPtr self);
    delegate int HasOneRefDelegate(IntPtr self);
    delegate int HasAtLeastOneRefDelegate(IntPtr self);
    delegate IntPtr GetHandlerDelegate(IntPtr self);
    delegate void OnContextInitializedDelegate(IntPtr self);
    delegate void OnScheduleMessagePumpWorkDelegate(IntPtr self, long delayMs);
    delegate void OnAfterCreatedDelegate(IntPtr self, IntPtr browser);
    delegate void OnLoadEndDelegate(IntPtr self, IntPtr browser, IntPtr frame, int httpStatusCode);
    delegate void OnAddressChangeDelegate(IntPtr self, IntPtr browser, IntPtr frame, IntPtr url);

    // vtable 调用委托
    delegate IntPtr GetHostDelegate(IntPtr self);
    delegate IntPtr GetMainFrameDelegate(IntPtr self);
    delegate void LoadUrlDelegate(IntPtr self, IntPtr url);
    delegate void ExecuteJavaScriptDelegate(IntPtr self, IntPtr code, IntPtr scriptUrl, int startLine);
    delegate IntPtr GetUrlDelegate(IntPtr self);
    delegate void CloseBrowserDelegate(IntPtr self, int forceClose);
    delegate IntPtr GetWindowHandleDelegate(IntPtr self);
    delegate void NotifyMoveOrResizeStartedDelegate(IntPtr self);

    // ======================== 全局状态 ========================

    static List<Delegate> _allDelegates = new List<Delegate>();
    static void KeepDelegate(Delegate d) { _allDelegates.Add(d); }

    static IntPtr gBrowserPtr = IntPtr.Zero;
    static IntPtr gBrowserHostPtr = IntPtr.Zero;
    static IntPtr gClientPtr = IntPtr.Zero;
    static IntPtr gAppPtr = IntPtr.Zero;
    static IntPtr gBrowserProcessHandlerPtr = IntPtr.Zero;
    static IntPtr gLifeSpanHandlerPtr = IntPtr.Zero;
    static IntPtr gLoadHandlerPtr = IntPtr.Zero;
    static IntPtr gDisplayHandlerPtr = IntPtr.Zero;
    static IntPtr gWindowInfoPtr = IntPtr.Zero;
    static IntPtr gBrowserSettingsPtr = IntPtr.Zero;
    static IntPtr gSettingsPtr = IntPtr.Zero;
    static IntPtr gMainArgsPtr = IntPtr.Zero;

    static bool gCefInitialized = false;
    static bool gBrowserCreated = false;
    static bool gContextInitialized = false;
    static bool gRunning = true;

    static long gParentHwnd = 0;
    static string gStartUrl = "about:blank";
    static string gCefDir = "";
    static string gCachePath = "";
    static string gSubprocessPath = "";
    static string gUserAgent = "";
    static string gLocale = "zh-CN";

    static ConcurrentQueue<Action> gActionQueue = new ConcurrentQueue<Action>();
    static object gStdoutLock = new object();

    // ======================== 辅助函数 ========================

    static void WriteInt64(IntPtr ptr, int offset, long value)
    {
        byte[] bytes = BitConverter.GetBytes(value);
        Marshal.Copy(bytes, 0, ptr + offset, 8);
    }
    static void WriteUInt32(IntPtr ptr, int offset, uint value)
    {
        byte[] bytes = BitConverter.GetBytes(value);
        Marshal.Copy(bytes, 0, ptr + offset, 4);
    }
    static void WriteInt32(IntPtr ptr, int offset, int value)
    {
        byte[] bytes = BitConverter.GetBytes(value);
        Marshal.Copy(bytes, 0, ptr + offset, 4);
    }
    static void WriteIntPtr(IntPtr ptr, int offset, IntPtr value)
    {
        byte[] bytes = BitConverter.GetBytes(value.ToInt64());
        Marshal.Copy(bytes, 0, ptr + offset, 8);
    }
    static long ReadInt64(IntPtr ptr, int offset)
    {
        byte[] bytes = new byte[8];
        Marshal.Copy(ptr + offset, bytes, 0, 8);
        return BitConverter.ToInt64(bytes, 0);
    }
    static IntPtr ReadIntPtr(IntPtr ptr, int offset)
    {
        byte[] bytes = new byte[8];
        Marshal.Copy(ptr + offset, bytes, 0, 8);
        return (IntPtr)BitConverter.ToInt64(bytes, 0);
    }

    static void WriteCefString(IntPtr target, int offset, string value)
    {
        if (value == null) return;
        // 分配 char16 数组
        byte[] charData = new byte[(value.Length + 1) * 2];
        for (int i = 0; i < value.Length; i++)
        {
            ushort ch = (ushort)value[i];
            charData[i * 2] = (byte)(ch & 0xFF);
            charData[i * 2 + 1] = (byte)(ch >> 8);
        }
        IntPtr strPtr = Marshal.AllocHGlobal(charData.Length);
        Marshal.Copy(charData, 0, strPtr, charData.Length);
        int setResult = cef_string_utf16_set(strPtr, new UIntPtr((uint)value.Length), target + offset, 1);
        Log("  cef_string_utf16_set('" + value.Substring(0, Math.Min(value.Length, 40)) + "'): " + setResult);
    }

    static string ReadCefStringUserfree(IntPtr cefStringUserfree)
    {
        if (cefStringUserfree == IntPtr.Zero) return "";
        try
        {
            // cef_string_utf16_t: { char16* str, size_t length, void (*dtor)(char16*) }
            IntPtr strPtr = Marshal.ReadIntPtr(cefStringUserfree, 0);
            long length = Marshal.ReadInt64(cefStringUserfree, 8); // size_t on x64 = 8 bytes
            if (strPtr == IntPtr.Zero || length <= 0) return "";
            return Marshal.PtrToStringUni(strPtr, (int)length);
        }
        finally
        {
            cef_string_userfree_utf16_free(cefStringUserfree);
        }
    }

    static void CreateRefCountedBase(IntPtr ptr, int structSize)
    {
        WriteInt64(ptr, 0, structSize);
        var addRef = new AddRefDelegate((self) => { });
        var release = new ReleaseDelegate((self) => { return 1; });
        var hasOneRef = new HasOneRefDelegate((self) => { return 1; });
        var hasAtLeastOneRef = new HasAtLeastOneRefDelegate((self) => { return 1; });
        KeepDelegate(addRef); KeepDelegate(release);
        KeepDelegate(hasOneRef); KeepDelegate(hasAtLeastOneRef);
        WriteIntPtr(ptr, 8, Marshal.GetFunctionPointerForDelegate(addRef));
        WriteIntPtr(ptr, 16, Marshal.GetFunctionPointerForDelegate(release));
        WriteIntPtr(ptr, 24, Marshal.GetFunctionPointerForDelegate(hasOneRef));
        WriteIntPtr(ptr, 32, Marshal.GetFunctionPointerForDelegate(hasAtLeastOneRef));
    }

    // ======================== 日志与 IPC ========================

    static StreamWriter gLogFile;

    static void Log(string msg)
    {
        if (gLogFile != null)
        {
            gLogFile.WriteLine(msg);
            gLogFile.Flush();
        }
        Console.Error.WriteLine("[CEF-Host] " + msg);
    }

    static void SendIpc(object msg)
    {
        string json = fastJson(msg);
        lock (gStdoutLock)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    static void SendError(string text) { SendIpc(new Dictionary<string, object> { { "type", "error" }, { "message", text } }); }
    static void SendEvent(string evt, object parms) { SendIpc(new Dictionary<string, object> { { "type", "event" }, { "event", evt }, { "params", parms ?? new Dictionary<string, object>() } }); }

    // 简单 JSON 序列化（避免依赖 System.Web.Extensions 等大库）
    static string fastJson(object obj)
    {
        if (obj == null) return "null";
        var str = obj as string;
        if (str != null) return "\"" + str.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t") + "\"";
        if (obj is bool) return (bool)obj ? "true" : "false";
        if (obj is int || obj is long || obj is double || obj is float)
        {
            var d = obj as double?;
            if (d.HasValue) return d.Value.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
            var f = obj as float?;
            if (f.HasValue) return f.Value.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
            return obj.ToString();
        }
        var dict = obj as IDictionary<string, object>;
        if (dict != null)
        {
            var parts = new List<string>();
            foreach (var kv in dict)
                parts.Add("\"" + kv.Key + "\":" + fastJson(kv.Value));
            return "{" + string.Join(",", parts) + "}";
        }
        var dictStr = obj as IDictionary<string, string>;
        if (dictStr != null)
        {
            var parts = new List<string>();
            foreach (var kv in dictStr)
                parts.Add("\"" + kv.Key + "\":" + fastJson(kv.Value));
            return "{" + string.Join(",", parts) + "}";
        }
        return "\"" + obj.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    // ======================== CEF 结构体创建 ========================

    static IntPtr CreateBrowserProcessHandler()
    {
        // cef_browser_process_handler_t: base(40) + 7 function pointers = 96 bytes
        int SIZE = 96;
        IntPtr ptr = Marshal.AllocHGlobal(SIZE);
        byte[] z = new byte[SIZE]; Marshal.Copy(z, 0, ptr, SIZE);
        CreateRefCountedBase(ptr, SIZE);

        var onContextInit = new OnContextInitializedDelegate((self) =>
        {
            Log("*** on_context_initialized called! ***");
            gContextInitialized = true;
            CreateBrowser();
        });
        KeepDelegate(onContextInit);
        WriteIntPtr(ptr, 48, Marshal.GetFunctionPointerForDelegate(onContextInit));

        var onSchedulePump = new OnScheduleMessagePumpWorkDelegate((self, delayMs) =>
        {
            // external_message_pump 模式下，CEF 告知需要消息泵工作
            // 主循环已经在持续调用 cef_do_message_loop_work，无需额外处理
        });
        KeepDelegate(onSchedulePump);
        WriteIntPtr(ptr, 72, Marshal.GetFunctionPointerForDelegate(onSchedulePump));

        return ptr;
    }

    static IntPtr CreateCefApp(IntPtr browserProcessHandler)
    {
        // cef_app_t: base(40) + 5 function pointers = 80 bytes
        int SIZE = 80;
        IntPtr ptr = Marshal.AllocHGlobal(SIZE);
        byte[] z = new byte[SIZE]; Marshal.Copy(z, 0, ptr, SIZE);
        CreateRefCountedBase(ptr, SIZE);

        var getBPH = new GetHandlerDelegate((self) =>
        {
            return browserProcessHandler;
        });
        KeepDelegate(getBPH);
        WriteIntPtr(ptr, 64, Marshal.GetFunctionPointerForDelegate(getBPH));

        return ptr;
    }

    static IntPtr CreateCefClient()
    {
        // cef_client_t: base(40) + 19 function pointers = 192 bytes
        int SIZE = 192;
        IntPtr ptr = Marshal.AllocHGlobal(SIZE);
        byte[] z = new byte[SIZE]; Marshal.Copy(z, 0, ptr, SIZE);
        CreateRefCountedBase(ptr, SIZE);

        IntPtr lifeSpanPtr = CreateLifeSpanHandler();
        IntPtr loadPtr = CreateLoadHandler();
        IntPtr displayPtr = CreateDisplayHandler();

        var getLifeSpan = new GetHandlerDelegate((self) => { return lifeSpanPtr; });
        var getLoad = new GetHandlerDelegate((self) => { return loadPtr; });
        var getDisplay = new GetHandlerDelegate((self) => { return displayPtr; });
        KeepDelegate(getLifeSpan); KeepDelegate(getLoad); KeepDelegate(getDisplay);

        // cef_client_t 偏移: get_display_handler=72, get_life_span_handler=144, get_load_handler=152
        WriteIntPtr(ptr, 72, Marshal.GetFunctionPointerForDelegate(getDisplay));
        WriteIntPtr(ptr, 144, Marshal.GetFunctionPointerForDelegate(getLifeSpan));
        WriteIntPtr(ptr, 152, Marshal.GetFunctionPointerForDelegate(getLoad));

        return ptr;
    }

    static IntPtr CreateLifeSpanHandler()
    {
        // cef_life_span_handler_t: base(40) + 6 function pointers = 88 bytes
        int SIZE = 88;
        IntPtr ptr = Marshal.AllocHGlobal(SIZE);
        byte[] z = new byte[SIZE]; Marshal.Copy(z, 0, ptr, SIZE);
        CreateRefCountedBase(ptr, SIZE);

        var onAfterCreated = new OnAfterCreatedDelegate((self, browser) =>
        {
            Log("*** on_after_created! browser=0x" + browser.ToString("X") + " ***");
            gBrowserPtr = browser;

            // 获取 browser_host（通过 vtable get_host 偏移 +48）
            IntPtr getHostFn = ReadIntPtr(browser, 48);
            var getHost = Marshal.GetDelegateForFunctionPointer<GetHostDelegate>(getHostFn);
            gBrowserHostPtr = getHost(browser);
            Log("  browser_host=0x" + gBrowserHostPtr.ToString("X"));

            gBrowserCreated = true;
            SendIpc(new Dictionary<string, object> { { "type", "ready" } });
        });
        KeepDelegate(onAfterCreated);
        WriteIntPtr(ptr, 64, Marshal.GetFunctionPointerForDelegate(onAfterCreated));

        var onBeforeClose = new OnAfterCreatedDelegate((self, browser) =>
        {
            Log("on_before_close");
            gBrowserPtr = IntPtr.Zero;
            gBrowserHostPtr = IntPtr.Zero;
            gRunning = false; // 关闭浏览器窗口时退出主循环
            SendEvent("before_close", new Dictionary<string, object>());
        });
        KeepDelegate(onBeforeClose);
        WriteIntPtr(ptr, 80, Marshal.GetFunctionPointerForDelegate(onBeforeClose));

        return ptr;
    }

    static IntPtr CreateLoadHandler()
    {
        // cef_load_handler_t: base(40) + 4 function pointers = 72 bytes
        int SIZE = 72;
        IntPtr ptr = Marshal.AllocHGlobal(SIZE);
        byte[] z = new byte[SIZE]; Marshal.Copy(z, 0, ptr, SIZE);
        CreateRefCountedBase(ptr, SIZE);

        var onLoadEnd = new OnLoadEndDelegate((self, browser, frame, httpStatusCode) =>
        {
            Log("on_load_end status=" + httpStatusCode);
            SendEvent("load_end", new Dictionary<string, object> { { "httpStatusCode", httpStatusCode } });
        });
        KeepDelegate(onLoadEnd);
        WriteIntPtr(ptr, 56, Marshal.GetFunctionPointerForDelegate(onLoadEnd));

        return ptr;
    }

    static IntPtr CreateDisplayHandler()
    {
        // cef_display_handler_t: base(40) + 13 function pointers = 144 bytes
        int SIZE = 144;
        IntPtr ptr = Marshal.AllocHGlobal(SIZE);
        byte[] z = new byte[SIZE]; Marshal.Copy(z, 0, ptr, SIZE);
        CreateRefCountedBase(ptr, SIZE);

        var onAddressChange = new OnAddressChangeDelegate((self, browser, frame, url) =>
        {
            // url 是 cef_string_t*（不是 userfree），直接读取
            string urlStr = "";
            if (url != IntPtr.Zero)
            {
                IntPtr strPtr = Marshal.ReadIntPtr(url, 0);
                long len = Marshal.ReadInt64(url, 8);
                if (strPtr != IntPtr.Zero && len > 0)
                    urlStr = Marshal.PtrToStringUni(strPtr, (int)len);
            }
            Log("on_address_change: " + urlStr);
            SendEvent("address_change", new Dictionary<string, string> { { "url", urlStr } });
        });
        KeepDelegate(onAddressChange);
        WriteIntPtr(ptr, 40, Marshal.GetFunctionPointerForDelegate(onAddressChange));

        return ptr;
    }

    // ======================== 创建浏览器 ========================

    static void CreateBrowser()
    {
        if (gBrowserCreated) return;
        Log("Creating browser...");

        const uint WS_CHILD = 0x40000000;
        const uint WS_CLIPCHILDREN = 0x02000000;
        const uint WS_CLIPSIBLINGS = 0x04000000;
        const uint WS_VISIBLE = 0x10000000;
        const uint WS_OVERLAPPEDWINDOW = 0x00CF0000;
        const int CW_USEDEFAULT = -2147483648;
        const int CEF_RUNTIME_STYLE_ALLOY = 1;

        // 1. cef_window_info_t (112 bytes)
        int WI_SIZE = 112;
        gWindowInfoPtr = Marshal.AllocHGlobal(WI_SIZE);
        byte[] wZ = new byte[WI_SIZE]; Marshal.Copy(wZ, 0, gWindowInfoPtr, WI_SIZE);
        WriteInt64(gWindowInfoPtr, 0, WI_SIZE);

        if (gParentHwnd != 0)
        {
            // SetAsChild 模式
            WriteUInt32(gWindowInfoPtr, 40, WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_VISIBLE);
            WriteInt32(gWindowInfoPtr, 44, 0);   // x
            WriteInt32(gWindowInfoPtr, 48, 0);   // y
            WriteInt32(gWindowInfoPtr, 52, 800);  // width
            WriteInt32(gWindowInfoPtr, 56, 600);  // height
            WriteIntPtr(gWindowInfoPtr, 64, (IntPtr)gParentHwnd); // parent_window
        }
        else
        {
            // SetAsPopup 模式
            WriteUInt32(gWindowInfoPtr, 40, WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_VISIBLE);
            WriteInt32(gWindowInfoPtr, 44, CW_USEDEFAULT);
            WriteInt32(gWindowInfoPtr, 48, CW_USEDEFAULT);
            WriteInt32(gWindowInfoPtr, 52, CW_USEDEFAULT);
            WriteInt32(gWindowInfoPtr, 56, CW_USEDEFAULT);
        }
        WriteInt32(gWindowInfoPtr, 104, CEF_RUNTIME_STYLE_ALLOY); // runtime_style

        // 2. URL cef_string_t
        IntPtr urlPtr = Marshal.AllocHGlobal(24);
        byte[] uZ = new byte[24]; Marshal.Copy(uZ, 0, urlPtr, 24);
        WriteCefString(urlPtr, 0, gStartUrl);

        // 3. cef_browser_settings_t (264 bytes)
        int BS_SIZE = 264;
        gBrowserSettingsPtr = Marshal.AllocHGlobal(BS_SIZE);
        byte[] bZ = new byte[BS_SIZE]; Marshal.Copy(bZ, 0, gBrowserSettingsPtr, BS_SIZE);
        WriteInt64(gBrowserSettingsPtr, 0, BS_SIZE);
        WriteInt32(gBrowserSettingsPtr, 204, 1); // javascript = STATE_ENABLED
        WriteInt32(gBrowserSettingsPtr, 236, 1); // local_storage = STATE_ENABLED
        WriteInt32(gBrowserSettingsPtr, 244, 1); // webgl = STATE_ENABLED
        WriteInt32(gBrowserSettingsPtr, 220, 1); // image_loading = STATE_ENABLED

        // 4. 创建 cef_client_t
        gClientPtr = CreateCefClient();

        // 5. cef_browser_host_create_browser
        int createResult = cef_browser_host_create_browser(
            gWindowInfoPtr, gClientPtr, urlPtr,
            gBrowserSettingsPtr, IntPtr.Zero, IntPtr.Zero);

        Log("cef_browser_host_create_browser result: " + createResult);
        if (createResult == 0)
        {
            Log("ERROR: create_browser returned 0 (failed)");
            SendError("cef_browser_host_create_browser failed");
        }
    }

    // ======================== Vtable 调用 ========================

    static IntPtr GetMainFrame()
    {
        if (gBrowserPtr == IntPtr.Zero) return IntPtr.Zero;
        try
        {
            // cef_browser_t::get_main_frame 偏移 +152
            IntPtr fn = ReadIntPtr(gBrowserPtr, 152);
            if (fn == IntPtr.Zero) return IntPtr.Zero;
            var getMainFrame = Marshal.GetDelegateForFunctionPointer<GetMainFrameDelegate>(fn);
            return getMainFrame(gBrowserPtr);
        }
        catch (Exception e) { Log("GetMainFrame error: " + e.Message); return IntPtr.Zero; }
    }

    static IntPtr GetBrowserHost()
    {
        if (gBrowserPtr == IntPtr.Zero) return IntPtr.Zero;
        try
        {
            // cef_browser_t::get_host 偏移 +48
            IntPtr fn = ReadIntPtr(gBrowserPtr, 48);
            if (fn == IntPtr.Zero) return IntPtr.Zero;
            var getHost = Marshal.GetDelegateForFunctionPointer<GetHostDelegate>(fn);
            return getHost(gBrowserPtr);
        }
        catch (Exception e) { Log("GetBrowserHost error: " + e.Message); return IntPtr.Zero; }
    }

    static void Navigate(string url)
    {
        IntPtr frame = GetMainFrame();
        if (frame == IntPtr.Zero) { Log("Navigate: no main frame"); return; }

        // 创建 URL cef_string_t
        IntPtr urlCefStr = Marshal.AllocHGlobal(24);
        byte[] z = new byte[24]; Marshal.Copy(z, 0, urlCefStr, 24);
        WriteCefString(urlCefStr, 0, url);

        // cef_frame_t::load_url 偏移 +144
        IntPtr fn = ReadIntPtr(frame, 144);
        if (fn == IntPtr.Zero) { Log("Navigate: load_url fn is null"); return; }
        var loadUrl = Marshal.GetDelegateForFunctionPointer<LoadUrlDelegate>(fn);
        loadUrl(frame, urlCefStr);
        Log("Navigated to: " + url);
    }

    static void ExecuteJavaScript(string code)
    {
        IntPtr frame = GetMainFrame();
        if (frame == IntPtr.Zero) { Log("ExecuteJavaScript: no main frame"); return; }

        // 创建 code cef_string_t
        IntPtr codeCefStr = Marshal.AllocHGlobal(24);
        byte[] z1 = new byte[24]; Marshal.Copy(z1, 0, codeCefStr, 24);
        WriteCefString(codeCefStr, 0, code);

        // cef_frame_t::execute_java_script 偏移 +152
        IntPtr fn = ReadIntPtr(frame, 152);
        if (fn == IntPtr.Zero) { Log("ExecuteJavaScript: fn is null"); return; }
        var execJs = Marshal.GetDelegateForFunctionPointer<ExecuteJavaScriptDelegate>(fn);
        execJs(frame, codeCefStr, IntPtr.Zero, 0);
    }

    static string GetUrl()
    {
        IntPtr frame = GetMainFrame();
        if (frame == IntPtr.Zero) return "";

        // cef_frame_t::get_url 偏移 +200
        IntPtr fn = ReadIntPtr(frame, 200);
        if (fn == IntPtr.Zero) return "";
        var getUrl = Marshal.GetDelegateForFunctionPointer<GetUrlDelegate>(fn);
        IntPtr urlUserfree = getUrl(frame);
        return ReadCefStringUserfree(urlUserfree);
    }

    static void CloseBrowser()
    {
        if (gBrowserHostPtr == IntPtr.Zero) return;
        try
        {
            // cef_browser_host_t::close_browser 偏移 +48
            IntPtr fn = ReadIntPtr(gBrowserHostPtr, 48);
            if (fn == IntPtr.Zero) return;
            var closeBrowser = Marshal.GetDelegateForFunctionPointer<CloseBrowserDelegate>(fn);
            closeBrowser(gBrowserHostPtr, 1); // force_close = true
            Log("Browser close requested");
        }
        catch (Exception e) { Log("CloseBrowser error: " + e.Message); }
    }

    /// <summary>
    /// 泵送 Windows 原生消息。CEF external_message_pump 模式下
    /// cef_do_message_loop_work() 只处理 CEF 任务，不处理 Windows 原生消息。
    /// 必须在每次 cef_do_message_loop_work() 之前调用，否则窗口会"未响应"。
    /// </summary>
    static void PumpWindowsMessages()
    {
        MSG msg;
        while (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE))
        {
            if (msg.message == WM_QUIT)
            {
                Log("WM_QUIT received");
                gRunning = false;
                return;
            }
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }

    static void ResizeBrowser()
    {
        if (gBrowserHostPtr == IntPtr.Zero || gParentHwnd == 0) return;
        try
        {
            // 获取父窗口客户区大小
            RECT clientRect;
            IntPtr parentHwnd = (IntPtr)gParentHwnd;
            if (!GetClientRect(parentHwnd, out clientRect)) return;
            int width = clientRect.Right - clientRect.Left;
            int height = clientRect.Bottom - clientRect.Top;

            // 获取浏览器窗口句柄
            // cef_browser_host_t::get_window_handle 偏移 +80
            IntPtr fn = ReadIntPtr(gBrowserHostPtr, 80);
            if (fn == IntPtr.Zero) return;
            var getWindowHandle = Marshal.GetDelegateForFunctionPointer<GetWindowHandleDelegate>(fn);
            IntPtr browserHwnd = getWindowHandle(gBrowserHostPtr);

            if (browserHwnd != IntPtr.Zero)
            {
                MoveWindow(browserHwnd, 0, 0, width, height, true);
            }

            // cef_browser_host_t::notify_move_or_resize_started 偏移 +392
            IntPtr fn2 = ReadIntPtr(gBrowserHostPtr, 392);
            if (fn2 != IntPtr.Zero)
            {
                var notifyResize = Marshal.GetDelegateForFunctionPointer<NotifyMoveOrResizeStartedDelegate>(fn2);
                notifyResize(gBrowserHostPtr);
            }
        }
        catch (Exception e) { Log("ResizeBrowser error: " + e.Message); }
    }

    // ======================== IPC 命令处理 ========================

    static void HandleIpcMessage(string line)
    {
        try
        {
            // 简单 JSON 解析
            var msg = ParseJson(line);
            if (msg == null) return;

            int id = msg.ContainsKey("id") ? Convert.ToInt32(msg["id"]) : 0;
            string method = msg.ContainsKey("method") ? msg["method"].ToString() : "";

            // 所有浏览器操作必须在主线程（CEF UI 线程）执行
            // 通过 Action 队列将操作投递到主线程
            switch (method)
            {
                case "navigate":
                    string navUrl = "";
                    {
                        var p1 = msg.ContainsKey("params") ? msg["params"] as Dictionary<string, object> : null;
                        if (p1 != null && p1.ContainsKey("url"))
                            navUrl = p1["url"].ToString();
                    }
                    gActionQueue.Enqueue(() =>
                    {
                        Navigate(navUrl);
                        SendIpc(new Dictionary<string, object> { { "type", "response" }, { "id", id }, { "result", true } });
                    });
                    break;

                case "evaluate":
                    string code = "";
                    {
                        var p2 = msg.ContainsKey("params") ? msg["params"] as Dictionary<string, object> : null;
                        if (p2 != null && p2.ContainsKey("code"))
                            code = p2["code"].ToString();
                    }
                    gActionQueue.Enqueue(() =>
                    {
                        ExecuteJavaScript(code);
                        SendIpc(new Dictionary<string, object> { { "type", "response" }, { "id", id }, { "result", "" } });
                    });
                    break;

                case "getUrl":
                    gActionQueue.Enqueue(() =>
                    {
                        string url = GetUrl();
                        SendIpc(new Dictionary<string, object> { { "type", "response" }, { "id", id }, { "result", url } });
                    });
                    break;

                case "close":
                    gActionQueue.Enqueue(() =>
                    {
                        SendIpc(new Dictionary<string, object> { { "type", "response" }, { "id", id }, { "result", true } });
                        CloseBrowser();
                        gRunning = false;
                    });
                    break;

                case "resize":
                    gActionQueue.Enqueue(() =>
                    {
                        ResizeBrowser();
                        SendIpc(new Dictionary<string, object> { { "type", "response" }, { "id", id }, { "result", true } });
                    });
                    break;

                case "ping":
                    SendIpc(new Dictionary<string, object> { { "type", "response" }, { "id", id }, { "result", "pong" } });
                    break;

                default:
                    SendIpc(new Dictionary<string, object> { { "type", "response" }, { "id", id }, { "error", "Unknown method: " + method } });
                    break;
            }
        }
        catch (Exception e)
        {
            Log("IPC error: " + e.Message);
        }
    }

    // ======================== 简单 JSON 解析 ========================

    static Dictionary<string, object> ParseJson(string json)
    {
        var result = new Dictionary<string, object>();
        json = json.Trim();
        if (json.Length < 2 || json[0] != '{' || json[json.Length - 1] != '}')
            return result;
        json = json.Substring(1, json.Length - 2); // 去掉 { }

        int i = 0;
        while (i < json.Length)
        {
            // 找 key
            i = SkipWhitespace(json, i);
            if (i >= json.Length) break;
            if (json[i] != '"') break;
            string key = ReadString(json, ref i);
            if (key == null) break;
            i = SkipWhitespace(json, i);
            if (i >= json.Length || json[i] != ':') break;
            i++;
            i = SkipWhitespace(json, i);
            if (i >= json.Length) break;
            object value = ReadValue(json, ref i);
            result[key] = value;
            i = SkipWhitespace(json, i);
            if (i < json.Length && json[i] == ',') i++;
        }
        return result;
    }

    static int SkipWhitespace(string s, int i)
    {
        while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        return i;
    }

    static string ReadString(string s, ref int i)
    {
        if (i >= s.Length || s[i] != '"') return null;
        i++; // skip opening "
        var sb = new System.Text.StringBuilder();
        while (i < s.Length)
        {
            if (s[i] == '\\')
            {
                i++;
                if (i >= s.Length) break;
                switch (s[i])
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 < s.Length)
                        {
                            string hex = s.Substring(i + 1, 4);
                            sb.Append((char)Convert.ToInt32(hex, 16));
                            i += 4;
                        }
                        break;
                    default: sb.Append(s[i]); break;
                }
            }
            else if (s[i] == '"') { i++; break; }
            else sb.Append(s[i]);
            i++;
        }
        return sb.ToString();
    }

    static object ReadValue(string s, ref int i)
    {
        if (i >= s.Length) return null;
        if (s[i] == '"') return ReadString(s, ref i);
        if (s[i] == '{')
        {
            // 找到匹配的 }
            int depth = 0;
            int start = i;
            while (i < s.Length)
            {
                if (s[i] == '{') depth++;
                else if (s[i] == '}') { depth--; if (depth == 0) { i++; break; } }
                else if (s[i] == '"') { i++; while (i < s.Length && s[i] != '"') { if (s[i] == '\\') i++; i++; } }
                i++;
            }
            string objJson = s.Substring(start, i - start);
            return ParseJson(objJson);
        }
        if (s[i] == 't') { i += 4; return true; } // true
        if (s[i] == 'f') { i += 5; return false; } // false
        if (s[i] == 'n') { i += 4; return null; } // null
        // 数字
        int numStart = i;
        while (i < s.Length && (char.IsDigit(s[i]) || s[i] == '-' || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '+'))
            i++;
        string numStr = s.Substring(numStart, i - numStart);
        long longVal;
        if (long.TryParse(numStr, out longVal)) return longVal;
        double dblVal;
        if (double.TryParse(numStr, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out dblVal)) return dblVal;
        return numStr;
    }

    // ======================== IPC 读取线程 ========================

    static void IpcThread()
    {
        try
        {
            // 读取 stdin，逐行解析 IPC 命令
            using (var reader = new StreamReader(Console.OpenStandardInput(), System.Text.Encoding.UTF8))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (!gRunning) break;
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    HandleIpcMessage(line);
                }
            }
        }
        catch (Exception e)
        {
            Log("IPC thread ended: " + e.Message);
        }
        // ★ stdin EOF 不退出主循环——生产环境中父进程关闭 stdin 意味着进程应退出，
        // 但测试模式下没有父进程连接 stdin，不应该因此立即退出。
        // 主循环会在以下情况退出：
        //   1. 收到 "close" IPC 命令
        //   2. 浏览器窗口被用户关闭（on_before_close 中设置 gRunning=false）
        //   3. Ctrl+C
        Log("IPC thread finished (stdin EOF). Main loop continues.");
    }

    // ======================== 命令行参数解析 ========================

    static void ParseArgs(string[] args)
    {
        foreach (string arg in args)
        {
            int eqIdx = arg.IndexOf('=');
            if (eqIdx <= 0) continue;
            string key = arg.Substring(2, eqIdx - 2); // skip --
            string val = arg.Substring(eqIdx + 1);

            switch (key)
            {
                case "hwnd":
                    gParentHwnd = val.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                        ? long.Parse(val.Substring(2), System.Globalization.NumberStyles.HexNumber)
                        : long.Parse(val);
                    break;
                case "url": gStartUrl = val; break;
                case "cef-dir": gCefDir = val; break;
                case "cache": gCachePath = val; break;
                case "subprocess": gSubprocessPath = val; break;
                case "user-agent": gUserAgent = val; break;
                case "locale": gLocale = val; break;
            }
        }
    }

    // ======================== Main ========================

    static int Main(string[] args)
    {
        // 日志文件
        string logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "cef-host.log");
        try { gLogFile = new StreamWriter(logPath, false); } catch { }

        Log("CEF Host (C#) starting...");
        Log("Command line: " + string.Join(" ", args));

        // 解析参数
        ParseArgs(args);

        if (string.IsNullOrEmpty(gCefDir))
        {
            // 尝试自动检测 CEF 目录
            string defaultDir = "C:\\Users\\Administrator\\cef-dist\\cef_binary_147.0.10+gd58e84d+chromium-147.0.7727.118_windows64_minimal";
            if (Directory.Exists(Path.Combine(defaultDir, "Release")))
                gCefDir = defaultDir;
        }

        Log("CEF dir: " + gCefDir);
        Log("Parent HWND: 0x" + gParentHwnd.ToString("X"));
        Log("URL: " + gStartUrl);

        if (string.IsNullOrEmpty(gCefDir))
        {
            SendError("Missing --cef-dir");
            return 1;
        }

        string releaseDir = Path.Combine(gCefDir, "Release");
        Environment.SetEnvironmentVariable("CEF_BOOTSTRAP_MODULE_NAME", "libcef");

        // 0. cef_api_hash — 必须在所有 CEF 调用之前
        Log("\n=== Calling cef_api_hash ===");
        IntPtr hashPtr = cef_api_hash(14700, 0);
        string hash = Marshal.PtrToStringAnsi(hashPtr);
        Log("cef_api_hash(14700, 0) = " + hash);
        int apiVer = cef_api_version();
        Log("cef_api_version() = " + apiVer);

        // 1. cef_main_args_t (8 bytes: HINSTANCE)
        IntPtr hInstance = GetModuleHandle(IntPtr.Zero);
        Log("HINSTANCE: 0x" + hInstance.ToString("X"));
        gMainArgsPtr = Marshal.AllocHGlobal(8);
        WriteIntPtr(gMainArgsPtr, 0, hInstance);

        // 2. 创建 cef_browser_process_handler_t 和 cef_app_t
        gBrowserProcessHandlerPtr = CreateBrowserProcessHandler();
        gAppPtr = CreateCefApp(gBrowserProcessHandlerPtr);
        Log("Created cef_app_t and cef_browser_process_handler_t");

        // 3. cef_execute_process — NULL app 避免子进程 CToCpp 崩溃
        Log("\nCalling cef_execute_process (NULL app)...");
        int execResult = cef_execute_process(gMainArgsPtr, IntPtr.Zero, IntPtr.Zero);
        Log("cef_execute_process: " + execResult);
        if (execResult >= 0)
        {
            Log("Subprocess, exiting.");
            return execResult;
        }

        // 4. 构造 cef_settings_t (448 bytes)
        int SETTINGS_SIZE = 448;
        gSettingsPtr = Marshal.AllocHGlobal(SETTINGS_SIZE);
        byte[] sZ = new byte[SETTINGS_SIZE]; Marshal.Copy(sZ, 0, gSettingsPtr, SETTINGS_SIZE);
        WriteInt64(gSettingsPtr, 0, SETTINGS_SIZE);
        WriteInt32(gSettingsPtr, 8, 1);   // no_sandbox
        WriteInt32(gSettingsPtr, 88, 0);  // multi_threaded_message_loop = 0
        WriteInt32(gSettingsPtr, 92, 1);  // external_message_pump = 1
        WriteInt32(gSettingsPtr, 96, 0);  // windowless_rendering_enabled
        WriteInt32(gSettingsPtr, 100, 0); // command_line_args_disabled = 0
        WriteInt32(gSettingsPtr, 152, 0); // persist_session_cookies
        WriteInt32(gSettingsPtr, 256, 1); // log_severity = VERBOSE
        WriteInt32(gSettingsPtr, 336, 0); // remote_debugging_port
        WriteInt32(gSettingsPtr, 436, 1); // disable_signal_handlers

        // 字符串字段
        if (string.IsNullOrEmpty(gSubprocessPath))
        {
            gSubprocessPath = Path.Combine(releaseDir, "cef-subprocess.exe");
            if (!File.Exists(gSubprocessPath))
                gSubprocessPath = Path.Combine(releaseDir, "bootstrap.exe");
        }
        WriteCefString(gSettingsPtr, 16, gSubprocessPath);  // browser_subprocess_path
        if (!string.IsNullOrEmpty(gCachePath))
            WriteCefString(gSettingsPtr, 104, gCachePath);  // cache_path
        WriteCefString(gSettingsPtr, 208, gLocale);         // locale
        WriteCefString(gSettingsPtr, 288, releaseDir);       // resources_dir_path
        WriteCefString(gSettingsPtr, 312, Path.Combine(releaseDir, "locales")); // locales_dir_path
        WriteCefString(gSettingsPtr, 352, "zh-CN,zh,en-US,en"); // accept_language_list
        if (!string.IsNullOrEmpty(gUserAgent))
            WriteCefString(gSettingsPtr, 160, gUserAgent);  // user_agent

        // 5. cef_initialize
        Log("\nCalling cef_initialize...");
        int initResult = cef_initialize(gMainArgsPtr, gSettingsPtr, gAppPtr, IntPtr.Zero);
        Log("cef_initialize result: " + initResult);
        if (initResult == 0)
        {
            Log("FAILED: cef_initialize returned 0");
            SendError("cef_initialize failed");
            return 1;
        }
        gCefInitialized = true;
        Log("CEF initialized successfully!");

        // 6. 等待 on_context_initialized
        Log("Pumping message loop (waiting for on_context_initialized)...");
        for (int i = 0; i < 200; i++)
        {
            PumpWindowsMessages();
            cef_do_message_loop_work();
            if (gContextInitialized) break;
            Thread.Sleep(16);
        }

        if (!gContextInitialized)
        {
            Log("on_context_initialized NOT called! Trying browser creation anyway...");
            CreateBrowser();
        }

        // 7. Ctrl+C 处理
        Console.CancelKeyPress += (sender, e) =>
        {
            e.Cancel = true;
            Log("Ctrl+C received, shutting down...");
            gRunning = false;
        };

        // 8. 启动 IPC 读取线程
        Thread ipcThread = new Thread(IpcThread);
        ipcThread.IsBackground = true;
        ipcThread.Start();

        // 9. 主消息循环
        Log("\nRunning message loop (with Windows message pump)...");
        while (gRunning)
        {
            // ★ 先泵送 Windows 原生消息（WM_PAINT, WM_TIMER 等）
            // 这是避免窗口"未响应"的关键！
            PumpWindowsMessages();
            if (!gRunning) break;

            cef_do_message_loop_work();

            // 处理 IPC 操作队列
            Action action;
            while (gActionQueue.TryDequeue(out action))
            {
                try { action(); } catch (Exception e) { Log("Action error: " + e.Message); }
            }

            Thread.Sleep(16);
        }

        // 10. 清理
        Log("Shutting down...");
        try { if (gCefInitialized) cef_shutdown(); } catch { }
        Log("Done.");

        if (gLogFile != null) { gLogFile.Close(); gLogFile = null; }
        return 0;
    }
}
