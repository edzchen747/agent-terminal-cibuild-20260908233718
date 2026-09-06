@echo off
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "OUT=%HERE%\out"

rem --- MSVC environment --------------------------------------------
set "VCVARS="
for %%p in (Community Professional Enterprise) do (
    if not defined VCVARS if exist "C:\Program Files\Microsoft Visual Studio\2022\%%p\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\%%p\VC\Auxiliary\Build\vcvars64.bat"
)
if not defined VCVARS (echo vcvars64.bat not found & exit /b 1)
call "%VCVARS%" >nul
if errorlevel 1 (echo vcvars failed & exit /b 1)

rem --- Windows SDK ---------------------------------------------------
set "SDK_VER="
for /d %%d in ("C:\Program Files (x86)\Windows Kits\10\include\*") do set "SDK_VER=%%~nxd"
if "%SDK_VER%"=="" (echo No SDK version & exit /b 1)
set "SDK_INC=C:\Program Files (x86)\Windows Kits\10\include\%SDK_VER%"
set "SDK_BIN=C:\Program Files (x86)\Windows Kits\10\bin\%SDK_VER%\x64"
set "INCLUDE=%SDK_INC%\um;%SDK_INC%\shared;%INCLUDE%"
echo SDK %SDK_VER%

rem --- midl ---------------------------------------------------------
rem /target NT100 and /robust are load bearing: `system_handle` is a late
rem NDR feature, and MIDL's default target silently emits an older wire
rem format. The console host marshals the handoff call with a proxy built
rem at NT100, so a lower target here makes EstablishPtyHandoff fail inside
rem the RPC layer before the stub ever dispatches.
rem This MIDL build rejects absolute and dot-dot relative source paths, so
rem run it from the source directory with the plain file name.
rem /Ocpf = C proxy code WITH interface registration: dlldata.c then
rem exports DllRegisterServer, which registers the IFs in the calling
rem process's NDR runtime. That in-process IF registration is what makes
rem the handoff IFs servable by a CoRegisterClassObject local-server
rem endpoint (without it, RpcServerRegisterIf(v3) fails with
rem RPC_S_INTERFACE_NOT_FOUND and cross-process activation faults).
if not exist "%OUT%" mkdir "%OUT%"
cd /d "%HERE%"
"%SDK_BIN%\midl.exe" /nologo /env x64 /target NT100 /robust /I "%SDK_INC%\shared" /I "%SDK_INC%\um" "ITerminalHandoff.idl"
if errorlevel 1 (echo MIDL failed & exit /b 1)

rem --- compile + link ----------------------------------------------
rem The DLL links dlldata (proxy data + registration routines) with the
rem MIDL proxy output. No /DPROXY: the unified file compiles complete
rem without it; the stub-side dispatch code is never taken by our
rem hand-crafted server objects.
cl /nologo /TC /c /O2 /DWIN32 /DNDEBUG /DREGISTER_PROXY_DLL "/DPROXY_CLSID_IS={0xa9328f6c,0x3412,0x4183,{0xa1,0x9e,0x16,0xe6,0x81,0x84,0x3b,0x92}}" "%HERE%\dlldata.c" /Fo"%OUT%\dlldata.obj"
if errorlevel 1 (echo cl dlldata failed & exit /b 1)
cl /nologo /TC /c /O2 /DWIN32 /DNDEBUG "%HERE%\ITerminalHandoff_p.c" /Fo"%OUT%\proxy.obj"
if errorlevel 1 (echo cl proxy failed & exit /b 1)
cl /nologo /TC /c /O2 /DWIN32 /DNDEBUG "%HERE%\ITerminalHandoff_i.c" /Fo"%OUT%\iid.obj"
if errorlevel 1 (echo cl iid failed & exit /b 1)
link /nologo /DLL /OUT:"%OUT%\agent-terminal-proxy.dll" /DEF:"%HERE%\agent-terminal-proxy.def" "%OUT%\dlldata.obj" "%OUT%\proxy.obj" "%OUT%\iid.obj" ole32.lib oleaut32.lib rpcrt4.lib
if errorlevel 1 (echo link failed & exit /b 1)
echo BUILT %OUT%\agent-terminal-proxy.dll
endlocal