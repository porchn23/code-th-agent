' agent-app.vbs — เปิด Research Agent เป็นแอพบนเดสก์ท็อป (zero-dependency)
' ทำงาน 3 ขั้นเมื่อดับเบิลคลิก:
'   1) ถ้า server (port 8787) ยังไม่รัน → รัน `node server.js` แบบไม่โชว์หน้าต่าง (หน้าต่างดำไม่มีให้เห็น)
'   2) รอ server พร้อม (สูงสุด ~10 วินาที)
'   3) เปิด Microsoft Edge โหมด --app = หน้าต่างสแตนด์อโลน ไม่มี address bar (เหมือน app จริง)
'     ถ้าไม่เจอ Edge → เปิด browser default แทน (ยังใช้งานได้ แค่ไม่เนี้ยบ 100%)
Option Explicit
Dim sh, fso, baseDir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)

' ---- 1) server ยังไม่รัน → สั่งรันแบบซ่อน ให้ตัวมันจัดการต่อเอง ----
If Not ProbeOK() Then
  sh.Run "cmd /c cd /d """ & baseDir & """ && node server.js", 0, False
End If

' ---- 2) รอ server พร้อม ----
Dim tries
For tries = 0 To 20
  If ProbeOK() Then Exit For
  WScript.Sleep 500
Next

' ---- 3) เปิดหน้าต่างแอพ ----
Dim edge
edge = EdgeExe()
If edge <> "" Then
  sh.Run """" & edge & """ --app=http://localhost:8787", 1, False
Else
  sh.Run "cmd /c start """" ""http://localhost:8787""", 1, False
End If

' ตรวจว่า server ตอบ 200 จริงไหม (ชี้ที่ /api/playbook — เบา ไม่ต้อง key)
Function ProbeOK()
  Dim http
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.open "GET", "http://localhost:8787/api/playbook", False
  http.send
  If Err.Number = 0 And http.status = 200 Then
    ProbeOK = True
  Else
    ProbeOK = False
  End If
  On Error GoTo 0
End Function

' หา msedge.exe (Edge ในโรงงานบน Windows 10/11 มีอยู่แล้ว 99%)
Function EdgeExe()
  Dim p
  p = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
  If fso.FileExists(p) Then
    EdgeExe = p
    Exit Function
  End If
  p = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
  If fso.FileExists(p) Then EdgeExe = p Else EdgeExe = ""
End Function
