# =====================================================================
#  MICGAIN  --  bemeneti eszkozok hangerejenek olvasasa/allitasa (kozos modul)
# =====================================================================
#  Ezt dot-source-olja a `mikrofon-erosites.ps1` es a `diktal-auto.ps1`.
#
#  !VTABLE-TANULSAG (2026-08-09-en elbuktam rajta): a COM-interface metodusainak
#    SORRENDJE a vtable. Az IAudioEndpointVolume-ban a GetMasterVolumeLevelScalar es
#    a SetMute kozott PONTOSAN 4 metodus van; en 6 helykitoltot irtam oda, es igy a
#    "GetMute" hivasom valojaban VolumeStepUp-ot hivott: a diagnosztika MEGEMELTE a
#    hangerot, es kozben hamis "nemitva" erteket irt ki.
#    *EGY ELCSUSZOTT VTABLE NEM HIBAT DOB, HANEM HAZUDIK.*
#  ***KODOLAS: 100% ASCII (PS 5.1 ANSI-kent olvassa a .ps1-et).
# =====================================================================
if (-not ('MicGain' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class MicGain
{
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection col);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection { int GetCount(out int c); int Item(int i, out IMMDevice dev); }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out int c); int GetAt(int i, out PROPERTYKEY k);
    int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
  }
  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }

  // *A SORREND A VTABLE -- ne nyulj hozza (ld. a fejlec tanulsagat).
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr n);
    int UnregisterControlChangeNotify(IntPtr n);
    int GetChannelCount(out int c);
    int SetMasterVolumeLevel(float lvl, ref Guid g);
    int SetMasterVolumeLevelScalar(float lvl, ref Guid g);
    int GetMasterVolumeLevel(out float lvl);
    int GetMasterVolumeLevelScalar(out float lvl);
    int SetChannelVolumeLevel(int ch, float lvl, ref Guid g);
    int SetChannelVolumeLevelScalar(int ch, float lvl, ref Guid g);
    int GetChannelVolumeLevel(int ch, out float lvl);
    int GetChannelVolumeLevelScalar(int ch, out float lvl);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
    int GetVolumeStepInfo(out int step, out int cnt);
    int VolumeStepUp(ref Guid g);
    int VolumeStepDown(ref Guid g);
    int QueryHardwareSupport(out int mask);
    int GetVolumeRange(out float minDb, out float maxDb, out float incDb);
  }

  // ---------------------------------------------------------------------
  //  IPolicyConfig -- a RENDSZER alapertelmezett eszkozenek allitasa.
  //  Ez kell ahhoz, hogy MINDEN program (Zoom, Teams, bongeszo, Telegram...)
  //  ugyanazt a mikrofont hasznalja, ne csak a mi diktalasunk.
  //  !Nem dokumentalt interface. A METODUSOK SORRENDJE ES SZAMA a vtable --
  //    a SetDefaultEndpoint a 11., ezert elotte PONTOSAN 10 helykitolto kell.
  //    (Ma mar egyszer megbuktam elcsuszott vtable-on: nem hibat dob, HAZUDIK.)
  // ---------------------------------------------------------------------
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class CPolicyConfigClient { }

  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    int GetMixFormat(string id, out IntPtr fmt);              // 1
    int GetDeviceFormat(string id, bool def, out IntPtr fmt); // 2
    int ResetDeviceFormat(string id);                         // 3
    int SetDeviceFormat(string id, IntPtr end, IntPtr mix);   // 4
    int GetProcessingPeriod(string id, bool def, out long dp, out long mp); // 5
    int SetProcessingPeriod(string id, ref long p);           // 6
    int GetShareMode(string id, out IntPtr mode);             // 7
    int SetShareMode(string id, IntPtr mode);                 // 8
    int GetPropertyValue(string id, bool store, ref PROPERTYKEY k, out PROPVARIANT v); // 9
    int SetPropertyValue(string id, bool store, ref PROPERTYKEY k, ref PROPVARIANT v); // 10
    int SetDefaultEndpoint(string id, int role);              // 11  *EZ KELL
    int SetEndpointVisibility(string id, bool visible);       // 12
  }

  /// A `match` nevu BEMENETET a rendszer alapertelmezettjeve teszi MIND A HAROM
  /// szerepre (Console / Multimedia / Communications) -> minden program ezt latja.
  public static string SetDefault(string match)
  {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDeviceCollection col; en.EnumAudioEndpoints(1, 1, out col);
    int n; col.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IMMDevice d; col.Item(i, out d);
      string nm = Name(d);
      if (match != null && nm.IndexOf(match, StringComparison.OrdinalIgnoreCase) < 0) continue;
      string id; d.GetId(out id);
      var pc = (IPolicyConfig)(new CPolicyConfigClient());
      for (int role = 0; role < 3; role++) {
        int hr = pc.SetDefaultEndpoint(id, role);
        if (hr != 0) return "HIBA: SetDefaultEndpoint(role=" + role + ") -> 0x" + hr.ToString("X8");
      }
      return nm;
    }
    return "HIBA: nincs ilyen bemeneti eszkoz: " + match;
  }

  /// Ellenorzes: mi MOST az alapertelmezett bemenet, szerepenkent.
  public static string ReportDefaults()
  {
    var sb = new StringBuilder();
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    string[] rn = { "Console      ", "Multimedia   ", "Communications" };
    for (int role = 0; role < 3; role++) {
      IMMDevice d;
      if (en.GetDefaultAudioEndpoint(1, role, out d) != 0 || d == null) {
        sb.AppendLine("    " + rn[role] + " : (nincs)"); continue;
      }
      sb.AppendLine("    " + rn[role] + " : " + Name(d));
    }
    return sb.ToString();
  }

  // ===== AGC (automatikus erosites) -- 2026-08-09 =====
  // !EGY PELDANYBAN. Eloszor kulon fajlba tettem, es a ket Add-Type blokk
  // MINDKETTO definialta ugyanazokat a COM-tipusokat -> egy folyamatban a CLR
  // ket kulonbozo tipusnak latta oket, es a cast elhasalt ezzel az uzenettel:
  //   "Unable to cast object of type 'MMDeviceEnumerator' to type 'MMDeviceEnumerator'"
  // Pontosan az a hiba, amire a sajat kommentemben figyelmeztettem.
  // --- DeviceTopology: az eszkoz belso alkatreszei ---
  [ComImport, Guid("2A07407E-6497-4A18-9787-32F79BD0D98F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDeviceTopology {
    int GetConnectorCount(out uint c);
    int GetConnector(uint i, out IConnector conn);
    int GetSubunitCount(out uint c);
    int GetSubunit(uint i, out ISubunit su);
    int GetPartById(uint id, out IPart part);
    int GetDeviceId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetSignalPath(IntPtr from, IntPtr to, bool rejectMixed, out IntPtr parts);
  }
  [ComImport, Guid("82149A85-DBA6-4487-86BB-EA8F7FEFCC71"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISubunit { }

  // !Az ENDPOINT topologiaja jellemzoen URES (0 subunit) -- az alkatreszek az
  // ESZKOZ-OLDALI topologian ulnek. Oda a csatlakozon (IConnector) at lehet
  // atlepni: GetConnectedTo -> IPart -> GetTopologyObject. Elsore ezt kihagytam,
  // es ezert jelentett a szkript "0 alkatreszt" -- a sajat bejarasom hibaja volt,
  // nem az eszkoze.
  [ComImport, Guid("9c2c4058-23f5-41de-877a-df3af236a09e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IConnector {
    int GetType(out int type);
    int GetDataFlow(out int flow);
    int ConnectTo(IConnector to);
    int Disconnect();
    int IsConnected([MarshalAs(UnmanagedType.Bool)] out bool connected);
    int GetConnectedTo(out IConnector con);
    int GetConnectorIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetDeviceIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }

  [ComImport, Guid("AE2DE0E4-5BCA-4F2D-AA46-5D13F8FDB3A9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPart {
    int GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int GetLocalId(out uint id);
    int GetGlobalId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetPartType(out int type);
    int GetSubType(out Guid sub);
    int GetControlInterfaceCount(out uint c);
    int GetControlInterface(uint i, out IControlInterface ci);
    int EnumPartsIncoming(out IntPtr parts);
    int EnumPartsOutgoing(out IntPtr parts);
    int GetTopologyObject(out IDeviceTopology topo);
    int Activate(int ctx, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    int RegisterControlChangeCallback(ref Guid iid, IntPtr cb);
    int UnregisterControlChangeCallback(IntPtr cb);
  }
  [ComImport, Guid("45D37C3F-5140-444A-AE24-400789F3CBF3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IControlInterface {
    int GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int GetIID(out Guid iid);
  }
  [ComImport, Guid("85401FD4-6DE4-4b9d-9869-2D6753A82F3C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioAutoGainControl {
    int GetEnabled([MarshalAs(UnmanagedType.Bool)] out bool enabled);
    int SetEnabled([MarshalAs(UnmanagedType.Bool)] bool enable, ref Guid ctx);
  }


  /// Vegigjarja a bemeneti eszkozok alkatreszeit, es jelenti, hol talalt AGC-t.
  /// apply=true eseten ki is kapcsolja.
  public static string AgcScan(string match, bool apply)
  {
    var sb = new StringBuilder();
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDeviceCollection col; en.EnumAudioEndpoints(1, 1, out col);
    int n; col.GetCount(out n);
    var ctx = Guid.Empty;

    for (int i = 0; i < n; i++) {
     try {
      IMMDevice d; col.Item(i, out d);
      string nm = Name(d);
      if (!string.IsNullOrEmpty(match) &&
          nm.IndexOf(match, StringComparison.OrdinalIgnoreCase) < 0) continue;
      sb.AppendLine("  " + nm);

      object o; var tiid = typeof(IDeviceTopology).GUID;
      if (d.Activate(ref tiid, 1, IntPtr.Zero, out o) != 0 || o == null) {
        sb.AppendLine("      (a topologia nem elerheto)"); continue;
      }
      var topo = (IDeviceTopology)o;

      // Atlepes az ESZKOZ-OLDALI topologiara (ld. az IConnector fenti megjegyzeset).
      // Vedve: ha barmelyik COM-lepes elhasal, NEM visszuk el az egesz vizsgalatot --
      // inkabb az endpoint-topologiaval dolgozunk tovabb, es ezt meg is mondjuk.
      try {
        uint cnt; topo.GetConnectorCount(out cnt);
        sb.AppendLine("      csatlakozo: " + cnt);
        for (uint ci2 = 0; ci2 < cnt; ci2++) {
          IConnector conn; if (topo.GetConnector(ci2, out conn) != 0) continue;
          bool linked; if (conn.IsConnected(out linked) != 0 || !linked) continue;
          IConnector other; if (conn.GetConnectedTo(out other) != 0 || other == null) continue;
          var opart = other as IPart; if (opart == null) continue;
          IDeviceTopology dtopo;
          if (opart.GetTopologyObject(out dtopo) == 0 && dtopo != null) {
            topo = dtopo; sb.AppendLine("      -> atleptem az eszkoz-oldali topologiara"); break;
          }
        }
      } catch (Exception ex) {
        sb.AppendLine("      (az eszkoz-oldali topologia nem jarhato be: " + ex.Message + ")");
      }

      uint sc; topo.GetSubunitCount(out sc);
      sb.AppendLine("      belso alkatresz (subunit): " + sc);

      bool found = false;
      for (uint s = 0; s < sc; s++) {
        IPart part = null;
        try {
          ISubunit su; if (topo.GetSubunit(s, out su) != 0) continue;
          part = su as IPart;
        } catch (Exception ex) {
          sb.AppendLine("        [" + s + "] nem olvashato: " + ex.Message); continue;
        }
        if (part == null) continue;
        string pn = ""; part.GetName(out pn);

        // Mit tud ez az alkatresz? Vegigkerdezzuk a vezerlo-feluleteit.
        uint cc; part.GetControlInterfaceCount(out cc);
        var caps = new StringBuilder();
        for (uint c = 0; c < cc; c++) {
          IControlInterface ci; if (part.GetControlInterface(c, out ci) != 0) continue;
          string cn; ci.GetName(out cn);
          caps.Append((caps.Length > 0 ? ", " : "") + cn);
        }
        sb.AppendLine("        [" + s + "] " + pn + "   ->  " + (caps.Length > 0 ? caps.ToString() : "(nincs vezerlo)"));

        // !Az Activate SIKERT jelezhet ugy is, hogy a visszaadott objektum NEM
        // castolhato -- ilyenkor InvalidCastException repul, ami korabban elvitte
        // az egesz vizsgalatot a tobbi alkatresz elol. Alkatreszenkent kerites.
        try {
          object ao; var aiid = typeof(IAudioAutoGainControl).GUID;
          if (part.Activate(1, ref aiid, out ao) == 0 && ao != null) {
            var agc = ao as IAudioAutoGainControl;
            if (agc != null) {
              bool on; agc.GetEnabled(out on);
              found = true;
              sb.AppendLine("            *** AGC MEGTALALVA -- allapot: " + (on ? "BE" : "KI") + " ***");
              if (apply && on) {
                int hr = agc.SetEnabled(false, ref ctx);
                bool after; agc.GetEnabled(out after);
                sb.AppendLine("            kikapcsolas: hr=0x" + hr.ToString("X8")
                              + "  -> most: " + (after ? "MEG MINDIG BE" : "KI"));
              }
            }
          }
        } catch (Exception) { /* ez az alkatresz nem tud AGC-t -- normalis */ }
      }
      if (!found)
        sb.AppendLine("      => Ez az eszkoz NEM vezeti ki az AGC-t a Windowsnak.");
     } catch (Exception ex) {
      // !A gyujtott szoveget SOSE veszitjuk el egy kivetel miatt: eddig a hiba
      // elvitte az egesz kimenetet, es ugy nezett ki, mintha semmi nem futott volna.
      sb.AppendLine("      (megszakadt: " + ex.GetType().Name + " -- " + ex.Message + ")");
     }
    }
    return sb.ToString();
  }

  static string Name(IMMDevice d) {
    IPropertyStore ps; d.OpenPropertyStore(0, out ps);
    var k = new PROPERTYKEY();
    k.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.pid = 14;
    PROPVARIANT v; ps.GetValue(ref k, out v);
    return v.p != IntPtr.Zero ? Marshal.PtrToStringUni(v.p) : "(nev nelkul)";
  }

  static IAudioEndpointVolume Find(string match, out string found)
  {
    found = null;
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDeviceCollection col; en.EnumAudioEndpoints(1, 1, out col);   // capture, active
    int n; col.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IMMDevice d; col.Item(i, out d);
      string nm = Name(d);
      if (match != null && nm.IndexOf(match, StringComparison.OrdinalIgnoreCase) < 0) continue;
      object o; var iid = typeof(IAudioEndpointVolume).GUID;
      if (d.Activate(ref iid, 1, IntPtr.Zero, out o) != 0) continue;
      found = nm; return (IAudioEndpointVolume)o;
    }
    return null;
  }

  /// A `match` nevu eszkoz hangereje 0..100 (-1 ha nincs ilyen).
  public static double GetVolume(string match) {
    string nm; var v = Find(match, out nm);
    if (v == null) return -1;
    float s; v.GetMasterVolumeLevelScalar(out s);
    return Math.Round(s * 100.0, 1);
  }

  /// Beallitja 0..100-ra. Visszaadja az UJ erteket (-1 ha nincs ilyen eszkoz).
  public static double SetVolume(string match, double pct) {
    string nm; var v = Find(match, out nm);
    if (v == null) return -1;
    if (pct < 0) pct = 0; if (pct > 100) pct = 100;
    var g = Guid.Empty;
    v.SetMasterVolumeLevelScalar((float)(pct / 100.0), ref g);
    float s; v.GetMasterVolumeLevelScalar(out s);
    return Math.Round(s * 100.0, 1);
  }

  /// Minden aktiv bemenet maxra (a `mikrofon-erosites.ps1` hasznalja).
  public static string MaxAllInputs(bool apply)
  {
    var sb = new StringBuilder();
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDeviceCollection col; en.EnumAudioEndpoints(1, 1, out col);
    int n; col.GetCount(out n);
    var g = Guid.Empty;
    for (int i = 0; i < n; i++) {
      IMMDevice d; col.Item(i, out d);
      string nm = Name(d);
      object o; var iid = typeof(IAudioEndpointVolume).GUID;
      if (d.Activate(ref iid, 1, IntPtr.Zero, out o) != 0) { sb.AppendLine("  " + nm + ": nem elerheto"); continue; }
      var vol = (IAudioEndpointVolume)o;
      float before; vol.GetMasterVolumeLevelScalar(out before);
      bool mute; vol.GetMute(out mute);
      float mn, mx, inc; vol.GetVolumeRange(out mn, out mx, out inc);
      if (apply) { vol.SetMasterVolumeLevelScalar(1.0f, ref g); if (mute) vol.SetMute(false, ref g); }
      float after; vol.GetMasterVolumeLevelScalar(out after);
      float curDb; vol.GetMasterVolumeLevel(out curDb);
      sb.AppendLine("  " + nm);
      sb.AppendLine("      hangero: " + Math.Round(before*100) + "% -> " + Math.Round(after*100) + "%"
                    + "   nemitva volt: " + (mute ? "IGEN (feloldva)" : "nem"));
      sb.AppendLine("      dB: " + Math.Round(curDb,1) + "   (tartomany " + Math.Round(mn,1)
                    + " ... " + Math.Round(mx,1) + " dB)");
    }
    return sb.ToString();
  }
}
'@ -Language CSharp
}
