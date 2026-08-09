# =====================================================================
#  MIKROFON-DIAGNOSZTIKA  --  MELYIK eszkozrol veszunk fel, es MEKKORA a hangero?
# =====================================================================
#  MIERT: 2026-08-09-en a diktalas "elnemult" -- a naplo szerint a jelcsucs
#  90%-rol 2.5-11%-ra esett 14:13 es 14:35 kozott. A recorder.ps1 a
#  WAVE_MAPPER-t (rendszer ALAPERTELMEZETT felvevo) hasznalja, tehat ha az
#  alapertelmezett eszkoz atvaltott (fejhallgato kihuzva -> webkamera mikrofonja),
#  akkor tavolrol, halkan vesz fel. Ez a szkript megmondja, MI a helyzet.
#
#  ***KODOLAS: ebben a fajlban SEMMI EKEZETES KARAKTER (PS 5.1 ANSI-kent olvassa).
#  ***COM: PowerShell 5.1 NEM tud metodust hivni nyers __ComObject-en -> MINDEN
#     COM-muvelet C#-on BELUL, es csak primitiv jon vissza. (Ketszer buktunk el rajta.)
# =====================================================================
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class MicDiag
{
  // ---------- waveIn: mit lat a felvevo API ----------
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct WAVEINCAPS {
    public short wMid; public short wPid; public int vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szPname;
    public int dwFormats; public short wChannels; public short wReserved1;
  }
  [DllImport("winmm.dll")] static extern int waveInGetNumDevs();
  [DllImport("winmm.dll", CharSet=CharSet.Unicode)]
  static extern int waveInGetDevCapsW(IntPtr id, ref WAVEINCAPS c, int size);

  public static string WaveInList()
  {
    var sb = new StringBuilder();
    int n = waveInGetNumDevs();
    sb.AppendLine("  waveIn eszkozok: " + n);
    for (int i = 0; i < n; i++) {
      var c = new WAVEINCAPS();
      waveInGetDevCapsW((IntPtr)i, ref c, Marshal.SizeOf(c));
      sb.AppendLine("    [" + i + "] " + c.szPname + "   (csatorna: " + c.wChannels + ")");
    }
    return sb.ToString();
  }

  // ---------- MMDevice: melyik az ALAPERTELMEZETT, es mekkora a hangero ----------
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out int c);
    int GetAt(int i, out PROPERTYKEY k);
    int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
  }
  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT {
    [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p;
  }
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int NotImpl1(); int NotImpl2();
    int GetChannelCount(out int c);
    int SetMasterVolumeLevel(float d, ref Guid g);
    int SetMasterVolumeLevelScalar(float d, ref Guid g);
    int GetMasterVolumeLevel(out float d);
    int GetMasterVolumeLevelScalar(out float d);
    // !A VTABLE SORRENDJE SZAMIT -- itt PONTOSAN 4 metodus van (Set/GetChannelVolumeLevel[Scalar]).
    // Elsore 6-ot irtam ide, es emiatt a "GetMute" hivasom valojaban VolumeStepUp-ot hivott:
    // a diagnosztika MEGEMELTE a mikrofon hangerejet szerepenkent 2%-kal (94->96->98%), a
    // "nemitva" ertek pedig szemet volt. Egy elcsuszott vtable NEM hibat dob, hanem HAZUDIK.
    int SetChannelVolumeLevel(int ch, float d, ref Guid g);
    int SetChannelVolumeLevelScalar(int ch, float d, ref Guid g);
    int GetChannelVolumeLevel(int ch, out float d);
    int GetChannelVolumeLevelScalar(int ch, out float d);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
    int GetVolumeStepInfo(out int step, out int stepCount);
    int VolumeStepUp(ref Guid g);
    int VolumeStepDown(ref Guid g);
    int QueryHardwareSupport(out int mask);
    int GetVolumeRange(out float minDb, out float maxDb, out float incDb);
  }

  static string FriendlyName(IMMDevice d)
  {
    IPropertyStore ps; d.OpenPropertyStore(0, out ps);
    var k = new PROPERTYKEY();
    k.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.pid = 14;  // DEVPKEY_Device_FriendlyName
    PROPVARIANT v; ps.GetValue(ref k, out v);
    return v.p != IntPtr.Zero ? Marshal.PtrToStringUni(v.p) : "(nev nelkul)";
  }

  public static string DefaultInput()
  {
    var sb = new StringBuilder();
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    // dataFlow: 0=render(kimenet) 1=capture(bemenet);  role: 0=Console 1=Multimedia 2=Communications
    string[] roleName = { "Console (ezt hasznalja a waveIn/WAVE_MAPPER)", "Multimedia", "Communications" };
    for (int role = 0; role < 3; role++) {
      IMMDevice dev;
      if (en.GetDefaultAudioEndpoint(1, role, out dev) != 0 || dev == null) {
        sb.AppendLine("    " + roleName[role] + ": (nincs)"); continue;
      }
      string id; dev.GetId(out id);
      sb.AppendLine("    " + roleName[role] + ":");
      sb.AppendLine("        " + FriendlyName(dev));
      sb.AppendLine("        id: " + id);

      object o; var iid = typeof(IAudioEndpointVolume).GUID;
      if (dev.Activate(ref iid, 1, IntPtr.Zero, out o) == 0) {
        var vol = (IAudioEndpointVolume)o;
        float lvl; vol.GetMasterVolumeLevelScalar(out lvl);
        bool mute; vol.GetMute(out mute);
        sb.AppendLine("        hangero: " + Math.Round(lvl * 100) + "%   nemitva: " + (mute ? "IGEN" : "nem"));
        // *A dB-tartomany arulja el, van-e ERSITES (boost) a lancban. Ha a maxDb 0.0 koruli,
        //   akkor NINCS boost aktivalva; egy +20/+30 dB-es boost a maxDb-t felviszi.
        float mn, mx, inc, cur;
        if (vol.GetVolumeRange(out mn, out mx, out inc) == 0 &&
            vol.GetMasterVolumeLevel(out cur) == 0)
          sb.AppendLine("        dB: jelenleg " + Math.Round(cur,1) + " dB   "
                        + "(tartomany " + Math.Round(mn,1) + " ... " + Math.Round(mx,1)
                        + " dB, lepes " + Math.Round(inc,1) + ")");
      }
    }
    return sb.ToString();
  }
}
'@ -Language CSharp

Write-Host ""
Write-Host "  ===== MIKROFON-DIAGNOSZTIKA =====" -ForegroundColor Cyan
Write-Host ""
Write-Host "  --- Amit a felvevo API lat ---" -ForegroundColor Yellow
Write-Host ([MicDiag]::WaveInList())
Write-Host "  --- ALAPERTELMEZETT bemeneti eszkoz (ezt veszi a WAVE_MAPPER) ---" -ForegroundColor Yellow
Write-Host ([MicDiag]::DefaultInput())
Write-Host "  A 2026-08-08-i beallitas szerint a HELYES eszkoz:" -ForegroundColor DarkGray
Write-Host "    Microphone (High Definition Audio Device)  = a FEJHALLGATOE" -ForegroundColor DarkGray
Write-Host "    id {0.0.1.00000000}.{91a35564-cf33-4c4e-9b2a-ebc9d6351092}" -ForegroundColor DarkGray
Write-Host "    A 'Mikrofon (Realtek USB2.0 MIC)' a WEBKAMERAE -- azt NEM akarjuk." -ForegroundColor DarkGray
Write-Host ""
