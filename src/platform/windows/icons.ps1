# Renders Start-menu-quality icons for shell items (shell:AppsFolder\<AUMID> or an exe path).
# stdin: JSON [{ id, target }]
# stdout, one line per event, so the caller (icon-queue.js) knows which item is in progress:
#   start <id>          about to render it
#   ok <id> <dataUrl>   rendered
#   fail <id>           the shell has no icon for it
#   timeout <id>        the shell didn't answer within -itemMs; that item is abandoned, the rest go on
#   done
# Each item renders on its own background STA thread with a time limit, so one item the shell never
# answers can't hold up the batch, and the process still ends with such a thread stuck (see the end).
param([int]$itemMs = 5000)
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.IO; using System.Runtime.InteropServices; using System.Threading;
public static class ShellIcon {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { void GetImage(SIZE size, int flags, out IntPtr hbm); }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
  public static string Png(string path, int px) {
    IShellItemImageFactory f;
    SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
    IntPtr hbm; f.GetImage(new SIZE { cx = px, cy = px }, 0x1 /* BIGGERSIZEOK */, out hbm);
    try {
      // Copy raw 32bpp pixels so alpha survives (Image.FromHbitmap drops it).
      var src = Image.FromHbitmap(hbm);
      var bmp = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
      var rect = new Rectangle(0, 0, src.Width, src.Height);
      var sd = src.LockBits(rect, ImageLockMode.ReadOnly, src.PixelFormat);
      var dd = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      var row = new byte[src.Width * 4];
      for (int y = 0; y < src.Height; y++) {
        Marshal.Copy(new IntPtr(sd.Scan0.ToInt64() + (long)y * sd.Stride), row, 0, row.Length);
        Marshal.Copy(row, 0, new IntPtr(dd.Scan0.ToInt64() + (long)y * dd.Stride), row.Length);
      }
      src.UnlockBits(sd); bmp.UnlockBits(dd);
      var ms = new MemoryStream(); bmp.Save(ms, ImageFormat.Png);
      return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
    } finally { DeleteObject(hbm); }
  }
  // null = no icon; "" = no answer within ms (the thread is left behind, as a background thread).
  public static string TryPng(string path, int px, int ms) {
    string result = null;
    var t = new Thread(() => { try { result = Png(path, px); } catch { } });
    t.IsBackground = true;
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    return t.Join(ms) ? result : "";
  }
}
'@
$out = [Console]::Out
function say($line) { $out.WriteLine($line); $out.Flush() }
$items = [Console]::In.ReadToEnd() | ConvertFrom-Json
$stuck = $false
foreach ($i in $items) {
  say "start $($i.id)"
  $png = [ShellIcon]::TryPng([string]$i.target, 64, $itemMs)
  if ($png -eq $null) { say "fail $($i.id)" }
  elseif ($png -eq '') { say "timeout $($i.id)"; $stuck = $true }
  else { say "ok $($i.id) $png" }
}
say 'done'
# A thread left inside the shell can hang a normal shutdown (the CLR releasing its COM objects waits
# on it), so then end the process outright. Otherwise a normal exit, which is quick.
if ($stuck) { [Diagnostics.Process]::GetCurrentProcess().Kill() }
exit 0
