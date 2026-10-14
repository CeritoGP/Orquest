@echo off
setlocal EnableExtensions

title Orquest Bridge - Dashboard
rem Ejecuta este archivo con doble clic desde cualquier ubicacion.
cd /d "%~dp0"
set "ORQUEST_RUNNER=agy"
set "ORQUEST_ALLOWED_ROOTS=%CD%"

echo.
echo ==========================================
echo          ORQUEST BRIDGE
echo ==========================================
echo.
echo Preparando la configuracion local...
call npm.cmd run install:local
if errorlevel 1 goto :error

echo.
echo Aplicando la politica operativa segura de Antigravity...
node scripts\provision-agy-permissions.mjs --apply
if errorlevel 1 goto :error

echo.
echo Iniciando daemon local en esta terminal...
start "Orquest daemon" /b cmd /c "npm.cmd run dev:daemon"

echo.
echo Esta ventana permanecera abierta y mostrara el daemon y el dashboard.
echo Cuando aparezca "Local:", abre exactamente esa direccion en el navegador.
echo Normalmente sera: http://127.0.0.1:4318
echo.
echo Para detener Orquest: Ctrl+C en esta ventana.
echo.

call npm.cmd run dev:dashboard
goto :end

:error
echo.
echo No fue posible iniciar Orquest. Revisa el mensaje anterior.
pause
exit /b 1

:end
echo.
echo El dashboard se detuvo.
pause
exit /b 0



