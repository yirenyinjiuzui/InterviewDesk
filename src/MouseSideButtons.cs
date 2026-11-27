using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class MouseSideButtons
{
    delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct MouseData { public int x, y; public uint mouseData, flags, time; public UIntPtr extra; }
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint message, UIntPtr w, IntPtr l);
    static readonly HookProc callback = OnMouse;
    static readonly bool[] pressed = new bool[2], consumed = new bool[2];
    static readonly ConcurrentQueue<int> events = new ConcurrentQueue<int>();
    static readonly AutoResetEvent pending = new AutoResetEvent(false);
    static volatile int mask;
    static IntPtr hook;

    // Pair down/up so changing a binding while held never leaks a stray release.
    static bool Handle(int button, bool down)
    {
        if (down) {
            if (!pressed[button]) { pressed[button] = true; consumed[button] = (mask & (1 << button)) != 0; }
            return consumed[button];
        }
        bool swallow = consumed[button];
        if (pressed[button] && swallow && (mask & (1 << button)) != 0) { events.Enqueue(button + 1); pending.Set(); }
        pressed[button] = consumed[button] = false;
        return swallow;
    }
    static IntPtr OnMouse(int code, IntPtr message, IntPtr data)
    {
        int msg = message.ToInt32();
        if (code >= 0 && (msg == 0x20B || msg == 0x20C)) {
            uint button = ((MouseData)Marshal.PtrToStructure(data, typeof(MouseData))).mouseData >> 16;
            if ((button == 1 || button == 2) && Handle((int)button - 1, msg == 0x20B)) return new IntPtr(1);
        }
        return CallNextHookEx(hook, code, message, data);
    }
    [STAThread] static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test") {
            mask = 1;
            if (!Handle(0, true) || !Handle(0, true) || !Handle(0, false)) return 1;
            int button;
            if (!events.TryDequeue(out button) || button != 1 || !events.IsEmpty) return 2;
            if (Handle(1, true) || Handle(1, false) || !events.IsEmpty) return 3;
            Handle(0, true); mask = 0;
            if (!Handle(0, false) || !events.IsEmpty) return 4;
            Handle(1, true); mask = 2;
            if (Handle(1, false) || !events.IsEmpty) return 5;
            if (!Handle(1, true) || !Handle(1, false) || !events.TryDequeue(out button) || button != 2) return 6;
            Console.WriteLine("MOUSE_STATE_TEST_OK"); return 0;
        }
        try {
            mask = int.Parse(args[0]);
            uint thread = GetCurrentThreadId();
            hook = SetWindowsHookEx(14, callback, GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero) throw new Win32Exception();
            new Thread(() => { while (true) { pending.WaitOne(); int button; while (events.TryDequeue(out button)) Console.WriteLine(button); } }) { IsBackground = true }.Start();
            // Start stdin after the message queue exists, so EOF can always stop us.
            var timer = new System.Windows.Forms.Timer { Interval = 1 };
            timer.Tick += (s, e) => {
                timer.Stop(); timer.Dispose();
                new Thread(() => {
                    string line;
                    while ((line = Console.ReadLine()) != null) { int next; if (int.TryParse(line, out next) && next >= 0 && next <= 3) mask = next; }
                    PostThreadMessage(thread, 0x12, UIntPtr.Zero, IntPtr.Zero);
                }) { IsBackground = true }.Start();
                Console.WriteLine("ready");
            };
            timer.Start(); Application.Run(); return 0;
        } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
        finally { if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook); }
    }
}
